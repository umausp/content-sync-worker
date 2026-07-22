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
// ~44% of canvas width: rejects only genuinely tiny thumbnails (BBC ~240px) while
// keeping normal RSS photos (600-800px), which the cinematic blur backdrop upscales
// cleanly. Too high a bar was discarding real photos → gradient ("everything blue").
const MIN_IMG_WIDTH = Number(process.env.SHORTS_MIN_IMG_WIDTH || Math.round(VIDEO.width * 0.44));

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

// Upgrade a news-CDN thumbnail URL to a full-resolution variant. Most wires expose only
// a tiny thumbnail in RSS (BBC ichef serves a 240px crop; NYT serves mediumSquareAt3X),
// which the MIN_IMG_WIDTH gate rejects → the Short falls to the flat gradient. These
// CDNs render ANY size from the same path, so we rewrite the size token to get a real,
// full-frame news photo. Unknown hosts pass through untouched.
function upgradeImageUrl(url) {
  let u = String(url || '');
  // RSS sometimes leaves HTML entities in the URL (&amp; → &). Decode so query params
  // (and signatures) aren't broken.
  u = u.replace(/&amp;/g, '&');
  // BBC ichef: .../ace/standard/240/cpsprodpb/…  →  …/1536/cpsprodpb/…
  u = u.replace(/(ichef\.bbci\.co\.uk\/[^\s]*?\/)(\d{2,4})(\/cpsprodpb\/)/i, '$11536$3');
  // NYT static01: …-mediumSquareAt3X.jpg / -articleLarge / -mediumThreeByTwoNNN / -thumb…
  u = u.replace(
    /(static01\.nyt\.com\/[^\s]+)-(?:mediumSquareAt3X|articleLarge|jumbo|mediumThreeByTwo\d+|square\w*|thumb\w*|videoThumb\w*)(\.(?:jpg|jpeg|png|webp))/i,
    '$1-superJumbo$2',
  );
  // Guardian: the i.guim.co.uk CDN URL is SIGNED (?s=…), so changing ?width= gives a 401.
  // The ORIGINAL master lives unsigned at media.guim.co.uk/<hash> at full resolution —
  // rewrite to that (verified full-res, no signature needed).
  const guim = u.match(/i\.guim\.co\.uk\/img\/media\/([^?]+)/i);
  if (guim) u = `https://media.guim.co.uk/${guim[1]}`;
  // WordPress (Variety / Hollywood Reporter): strip ?resize=/?w=/?h= downscale params.
  u = u.replace(/(\/wp-content\/[^\s?]+)\?[^\s]*/i, '$1');
  return u;
}

async function tryStoryImage(story, outDir, seen, outFile = 'bg.png', imgUrl = null) {
  const url = upgradeImageUrl(imgUrl || story.imageUrl);
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (seen.has(`url:${url}`)) return null; // same photo already used by another story
  try {
    const buf = await fetchBuf(url);
    if (buf.length < 2000) return null; // too small to be a real photo
    const raw = join(outDir, `src-story-${outFile}`);
    await writeFile(raw, buf);
    // Reject low-res thumbnails so we don't ship a pixelated full-frame.
    if ((await imageWidth(raw)) < MIN_IMG_WIDTH) return null;
    seen.add(`url:${url}`);
    return await coverTo(raw, join(outDir, outFile));
  } catch {
    return null;
  }
}

// Generic, high-hit stock search terms per category — a HEADLINE fragment ("Burnham
// cuts electricity bills") almost never matches a stock library and returns nothing →
// gradient fallback (the "everything is blue" problem). Category terms reliably return
// a relevant, professional photo. One proper-noun entity from the title is prepended
// when present (e.g. a place/org) to keep it on-topic, then we fall back to the term.
const CATEGORY_TERMS = {
  politics: 'government parliament politics',
  breaking: 'breaking news press conference',
  crisis: 'stock market economy finance',
  business: 'stock market economy finance',
  entertainment: 'cinema movie premiere',
  tech: 'technology computer data',
  facts: 'science laboratory research',
  science: 'science laboratory research',
  sports: 'stadium sports athlete',
  health: 'hospital medicine healthcare',
  offbeat: 'world city people',
  top: 'news world city',
  world: 'world map globe',
};
// Ordered list of stock queries to try for a story: category term first (reliable hit),
// then a broad news fallback. Providers try each until one returns an unused photo.
function stockQueries(story) {
  const cat = String(story.category || story.slot || 'top').toLowerCase();
  const term = CATEGORY_TERMS[cat] || CATEGORY_TERMS.top;
  // A distinctive proper noun from the title (Capitalized word ≥4 chars) narrows it.
  const proper = String(story.title || '')
    .split(/\s+/)
    .find((w) => /^[A-Z][a-z]{3,}/.test(w) && !/^(The|This|That|With|From|After|Says)$/.test(w));
  const queries = [];
  if (proper) queries.push(`${proper} ${term.split(' ')[0]}`);
  queries.push(term);
  queries.push('news world');
  return queries;
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

async function downloadTo(src, outDir, name, outFile = 'bg.png') {
  const buf = await fetchBuf(src);
  if (buf.length < 2000) return null;
  const raw = join(outDir, name);
  await writeFile(raw, buf);
  return coverTo(raw, join(outDir, outFile));
}

// Each provider tries the story's ordered queries (category term → broad fallback)
// until one returns an UNUSED photo, so we rarely fall through to the gradient.
async function pexelsCandidates(q) {
  const r = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=${ORIENT}&per_page=15`,
    { headers: { Authorization: PEXELS_KEY, 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) return [];
  const j = await r.json();
  return (j.photos || []).map((p) => ({
    id: `pexels:${p.id}`,
    src: VIDEO.landscape
      ? p.src?.landscape || p.src?.large2x || p.src?.original
      : p.src?.portrait || p.src?.large2x || p.src?.original,
  }));
}
async function pixabayCandidates(q) {
  const r = await fetch(
    `https://pixabay.com/api/?key=${encodeURIComponent(PIXABAY_KEY)}&q=${encodeURIComponent(q)}` +
      `&image_type=photo&orientation=${VIDEO.landscape ? 'horizontal' : 'vertical'}&safesearch=true&per_page=15&min_width=${VIDEO.width}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) return [];
  const j = await r.json();
  return (j.hits || []).map((h) => ({ id: `pixabay:${h.id}`, src: h.largeImageURL || h.fullHDURL || h.webformatURL }));
}
async function unsplashCandidates(q) {
  const r = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}` +
      `&orientation=${VIDEO.landscape ? 'landscape' : 'portrait'}&per_page=15&content_filter=high`,
    { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}`, 'user-agent': UA }, signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((p) => ({
    id: `unsplash:${p.id}`,
    src: p.urls?.raw ? `${p.urls.raw}&w=${BW}&fit=max` : p.urls?.full || p.urls?.regular,
  }));
}

// Generic: try each query for a provider, return the first unused photo downloaded.
async function tryProvider(hasKey, candidatesFn, queries, seen, outDir, name, outFile = 'bg.png') {
  if (!hasKey) return null;
  for (const q of queries) {
    try {
      const src = pickUnused(await candidatesFn(q), seen);
      if (src) {
        const out = await downloadTo(src, outDir, name, outFile);
        if (out) return out;
      }
    } catch {
      /* try next query */
    }
  }
  return null;
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
  const queries = stockQueries(story);
  const pex = await tryProvider(!!PEXELS_KEY, pexelsCandidates, queries, seen, outDir, 'src-pexels');
  if (pex) return { path: pex, kind: 'pexels' };
  const pix = await tryProvider(!!PIXABAY_KEY, pixabayCandidates, queries, seen, outDir, 'src-pixabay');
  if (pix) return { path: pix, kind: 'pixabay' };
  const uns = await tryProvider(!!UNSPLASH_KEY, unsplashCandidates, queries, seen, outDir, 'src-unsplash');
  if (uns) return { path: uns, kind: 'unsplash' };
  return { path: await brandFallback(outDir), kind: 'brand' };
}

// A branded gradient background — for the hook + outro TITLE cards, which are NOT news
// stories and must NOT reuse a story's photo (that made story 1's image appear 3x).
export async function brandBackground(outDir) {
  await mkdir(outDir, { recursive: true });
  return { path: await brandFallback(outDir), kind: 'brand' };
}

// Resolve UP TO `count` DISTINCT canvas-sized background images for ONE story, so a
// single-story Short plays as a photo SEQUENCE (Ken-Burns + crossfade) instead of one
// static image (user ask). Order of preference:
//   1. the story's OWN images — story.imageUrl + any story.images[] / source images
//   2. top up with category stock (Pexels → Pixabay → Unsplash), each a fresh photo
// De-duped via `seen`. Always returns ≥1 (gradient fallback). Returns { paths[], kinds[] }.
export async function resolveBackgrounds(story, outDir, seen = new Set(), count = 3) {
  await mkdir(outDir, { recursive: true });
  const paths = [];
  const kinds = [];
  // 1) the story's own images — dedupe the URL list (imageUrl + images[]).
  const ownUrls = [...new Set([story.imageUrl, ...(story.images || [])].filter(Boolean))];
  for (const u of ownUrls) {
    if (paths.length >= count) break;
    const file = `bg-${paths.length}.png`;
    const p = await tryStoryImage(story, outDir, seen, file, u);
    if (p) { paths.push(p); kinds.push('story'); }
  }
  // 2) top up with stock — try each provider, each writing a fresh file.
  const queries = stockQueries(story);
  const providers = [
    [!!PEXELS_KEY, pexelsCandidates, 'src-pexels'],
    [!!PIXABAY_KEY, pixabayCandidates, 'src-pixabay'],
    [!!UNSPLASH_KEY, unsplashCandidates, 'src-unsplash'],
  ];
  let pi = 0;
  while (paths.length < count && pi < providers.length * 2) {
    const [hasKey, fn, nm] = providers[pi % providers.length];
    pi++;
    if (!hasKey) continue;
    const file = `bg-${paths.length}.png`;
    const p = await tryProvider(hasKey, fn, queries, seen, outDir, `${nm}-${paths.length}`, file);
    if (p) { paths.push(p); kinds.push(nm.replace('src-', '')); }
  }
  // 3) guarantee at least one background.
  if (!paths.length) {
    paths.push(await brandFallback(outDir));
    kinds.push('brand');
  }
  return { paths, kinds };
}

export { BW, BH };
