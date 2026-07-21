// visuals.mjs — resolve the background image for a Short.
//
// Priority: (1) the story's own image (best — it's the real news photo), (2) a Pexels
// stock photo matching the story keywords (free, commercial-safe), (3) a branded
// gradient fallback so a Short ALWAYS renders even with no image + no Pexels key.
//
// The chosen image is downloaded and letter-safe pre-scaled to COVER a 1080×1920 frame
// (ffmpeg's zoompan then adds slow motion). We over-scale to 1.2× so the Ken-Burns zoom
// never reveals an edge.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BRAND, PEXELS_KEY, VIDEO } from './config.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Over-scaled cover dims so zoompan (up to ~1.15×) never shows a black edge.
const BW = Math.round(VIDEO.width * 1.2);
const BH = Math.round(VIDEO.height * 1.2);

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Scale+crop any input image to exactly BWxBH (cover), via ffmpeg (handles jpg/png/webp).
//
// PROFESSIONAL BACKGROUND TREATMENT (the quality fix): we don't drop the raw source
// photo behind the caption. Instead we build a "cinematic backdrop" — a subtly BLURRED
// + DARKENED cover layer with a SHARP, slightly-smaller version composited on top.
// Why: (1) the big caption text always reads clearly over the darkened blur; (2) any
// source-image chyron / competitor watermark / on-screen text becomes an unobtrusive
// abstract backdrop instead of a distracting (or off-brand) hard edge — this is exactly
// the look pro faceless news Shorts use. The sharp inset keeps the actual news photo
// recognizable. Falls back to a plain cover if the two-layer filter ever errors.
async function coverTo(srcPath, outPath) {
  const filter =
    // blurred, darkened full-bleed base…
    `[0:v]scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},` +
    `gblur=sigma=28,eq=brightness=-0.18:saturation=0.9[bgblur];` +
    // …sharp inset (90% width) centered on top…
    `[0:v]scale=${Math.round(BW * 0.94)}:${Math.round(BH * 0.94)}:force_original_aspect_ratio=increase,` +
    `crop=${Math.round(BW * 0.94)}:${Math.round(BH * 0.94)}[fg];` +
    `[bgblur][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[out]`;
  try {
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', srcPath,
      '-filter_complex', filter, '-map', '[out]',
      '-frames:v', '1', outPath,
    ]);
  } catch {
    // Fallback: plain cover (never fail the whole render over the fancy treatment).
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', `scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},format=yuv420p`,
      '-frames:v', '1', outPath,
    ]);
  }
  return outPath;
}

// Minimum source width to use a story image full-frame. RSS thumbnails below this
// (e.g. BBC's ~240px feed images) look pixelated blown up to 1080w, so we reject them
// and let the pipeline fall to Pexels (hi-res) / gradient instead.
const MIN_IMG_WIDTH = Number(process.env.SHORTS_MIN_IMG_WIDTH || 640);

async function imageWidth(path) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width',
      '-of', 'default=nw=1:nk=1', path,
    ]);
    return Number(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

async function tryStoryImage(story, outDir) {
  const url = story.imageUrl;
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const buf = await fetchBuf(url);
    if (buf.length < 2000) return null; // too small to be a real photo
    const raw = join(outDir, 'src-story');
    await writeFile(raw, buf);
    // Reject low-res thumbnails so we don't ship a pixelated full-frame.
    if ((await imageWidth(raw)) < MIN_IMG_WIDTH) return null;
    return await coverTo(raw, join(outDir, 'bg.png'));
  } catch {
    return null;
  }
}

async function tryPexels(story, outDir) {
  if (!PEXELS_KEY) return null;
  // Query from the story's distinctive words (drop stopwords/short tokens).
  const q = String(story.title || story.hashtag || 'news')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .join(' ') || 'news';
  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=5`,
      { headers: { Authorization: PEXELS_KEY, 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const photo = (j.photos || [])[0];
    const src = photo?.src?.portrait || photo?.src?.large2x || photo?.src?.original;
    if (!src) return null;
    const buf = await fetchBuf(src);
    const raw = join(outDir, 'src-pexels');
    await writeFile(raw, buf);
    return await coverTo(raw, join(outDir, 'bg.png'));
  } catch {
    return null;
  }
}

// Branded gradient fallback (always succeeds) — never let a Short fail for lack of image.
async function brandFallback(outDir) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${BH}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.accent}"/>
      <stop offset="1" stop-color="${BRAND.bgBottom}"/>
    </linearGradient></defs>
    <rect width="${BW}" height="${BH}" fill="${BRAND.bgTop}"/>
    <rect width="${BW}" height="${BH}" fill="url(#g)" opacity="0.55"/>
  </svg>`;
  const svgPath = join(outDir, 'bg.svg');
  await writeFile(svgPath, svg);
  const out = join(outDir, 'bg.png');
  await execFileP('rsvg-convert', ['-w', String(BW), '-h', String(BH), '-o', out, svgPath]);
  return out;
}

// Resolve the best available background → bg.png (BWxBH). Returns { path, kind }.
export async function resolveBackground(story, outDir) {
  await mkdir(outDir, { recursive: true });
  const story1 = await tryStoryImage(story, outDir);
  if (story1) return { path: story1, kind: 'story' };
  const pex = await tryPexels(story, outDir);
  if (pex) return { path: pex, kind: 'pexels' };
  return { path: await brandFallback(outDir), kind: 'brand' };
}

export { BW, BH };
