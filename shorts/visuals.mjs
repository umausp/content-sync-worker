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
async function coverTo(srcPath, outPath) {
  await execFileP('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', srcPath,
    '-vf', `scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},format=yuv420p`,
    '-frames:v', '1', outPath,
  ]);
  return outPath;
}

async function tryStoryImage(story, outDir) {
  const url = story.imageUrl;
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const buf = await fetchBuf(url);
    if (buf.length < 2000) return null; // too small to be a real photo
    const raw = join(outDir, 'src-story');
    await writeFile(raw, buf);
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
