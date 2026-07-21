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
import { BRAND, PEXELS_KEY, PIXABAY_KEY, UNSPLASH_KEY, VIDEO } from './config.mjs';

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

// Minimum source width to use a story image full-frame — scaled to the CANVAS width so
// we don't ship a pixelated blow-up. Tiny RSS thumbnails (BBC ~240px) are rejected →
// pipeline falls to Pexels (hi-res, keyed on the runner) / gradient. We accept an image
// at ≥60% of canvas width (the cinematic backdrop's blur hides mild upscaling).
const MIN_IMG_WIDTH = Number(process.env.SHORTS_MIN_IMG_WIDTH || Math.round(VIDEO.width * 0.6));

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

async function tryStoryImage(story, outDir, seen) {
  const url = story.imageUrl;
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (seen.has(`url:${url}`)) return null; // same photo already used by another story
  try {
    const buf = await fetchBuf(url);
    if (buf.length < 2000) return null; // too small to be a real photo
    const raw = join(outDir, 'src-story');
    await writeFile(raw, buf);
    // Reject low-res thumbnails so we don't ship a pixelated full-frame.
    if ((await imageWidth(raw)) < MIN_IMG_WIDTH) return null;
    seen.add(`url:${url}`);
    return await coverTo(raw, join(outDir, 'bg.png'));
  } catch {
    return null;
  }
}

// Distinctive-word query from the story (drop stopwords/short tokens). Shared by all
// stock providers so they search the same terms.
function stockQuery(story) {
  return (
    String(story.title || story.hashtag || 'news')
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4)
      .join(' ') || 'news'
  );
}
// Orientation matches the canvas so we get portrait shots for Shorts, landscape for
// long-form (better cover, less cropping).
const ORIENT = VIDEO.landscape ? 'landscape' : 'portrait';

// Pick the first candidate URL whose identity ISN'T already in `seen`, so no two
// stories in the same video share an image. Records the chosen id in `seen`.
function pickUnused(candidates, seen) {
  for (const c of candidates) {
    if (!c?.id || !c?.src) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    return c.src;
  }
  return null;
}

async function downloadTo(src, outDir, name) {
  const buf = await fetchBuf(src);
  if (buf.length < 2000) return null;
  const raw = join(outDir, name);
  await writeFile(raw, buf);
  return coverTo(raw, join(outDir, 'bg.png'));
}

async function tryPexels(story, outDir, seen) {
  if (!PEXELS_KEY) return null;
  const q = stockQuery(story);
  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=${ORIENT}&per_page=15`,
      { headers: { Authorization: PEXELS_KEY, 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const cands = (j.photos || []).map((p) => ({
      id: `pexels:${p.id}`,
      src: VIDEO.landscape
        ? p.src?.landscape || p.src?.large2x || p.src?.original
        : p.src?.portrait || p.src?.large2x || p.src?.original,
    }));
    const src = pickUnused(cands, seen);
    return src ? await downloadTo(src, outDir, 'src-pexels') : null;
  } catch {
    return null;
  }
}

async function tryPixabay(story, outDir, seen) {
  if (!PIXABAY_KEY) return null;
  const q = stockQuery(story);
  try {
    const r = await fetch(
      `https://pixabay.com/api/?key=${encodeURIComponent(PIXABAY_KEY)}&q=${encodeURIComponent(q)}` +
        `&image_type=photo&orientation=${VIDEO.landscape ? 'horizontal' : 'vertical'}&safesearch=true&per_page=15&min_width=${VIDEO.width}`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const cands = (j.hits || []).map((h) => ({
      id: `pixabay:${h.id}`,
      src: h.largeImageURL || h.fullHDURL || h.webformatURL,
    }));
    const src = pickUnused(cands, seen);
    return src ? await downloadTo(src, outDir, 'src-pixabay') : null;
  } catch {
    return null;
  }
}

async function tryUnsplash(story, outDir, seen) {
  if (!UNSPLASH_KEY) return null;
  const q = stockQuery(story);
  try {
    const r = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}` +
        `&orientation=${VIDEO.landscape ? 'landscape' : 'portrait'}&per_page=15&content_filter=high`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}`, 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const cands = (j.results || []).map((p) => ({
      id: `unsplash:${p.id}`,
      src: p.urls?.raw ? `${p.urls.raw}&w=${BW}&fit=max` : p.urls?.full || p.urls?.regular,
    }));
    const src = pickUnused(cands, seen);
    return src ? await downloadTo(src, outDir, 'src-unsplash') : null;
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
// Chain: the story's OWN photo (best — real news image) → Pexels → Pixabay → Unsplash
// (more stock coverage = fewer gradient fallbacks) → branded gradient (always works).
// `seen` is a per-VIDEO Set of image identities so NO two stories share an image (user:
// "always use a different image for different story"); pass the same Set for every story
// in one video. Omit it (fresh Set) for a standalone render.
export async function resolveBackground(story, outDir, seen = new Set()) {
  await mkdir(outDir, { recursive: true });
  const story1 = await tryStoryImage(story, outDir, seen);
  if (story1) return { path: story1, kind: 'story' };
  const pex = await tryPexels(story, outDir, seen);
  if (pex) return { path: pex, kind: 'pexels' };
  const pix = await tryPixabay(story, outDir, seen);
  if (pix) return { path: pix, kind: 'pixabay' };
  const uns = await tryUnsplash(story, outDir, seen);
  if (uns) return { path: uns, kind: 'unsplash' };
  return { path: await brandFallback(outDir), kind: 'brand' };
}

export { BW, BH };
