// make_video.mjs — the FRIENDLY interface for "I'll give you audio, text and images, you
// render it." No hand-written JSON: pass plain flags, and this builds the manifest and calls
// the exact same karaoke-pop render the automated channels use (build_from_audio →
// align_audio.py → wordTimings → planShots → buildKaraokeCaptions → renderSegment).
//
// ── ONE story (the common case) ──────────────────────────────────────────────
//   node shorts/make_video.mjs \
//     --audio    ~/Desktop/sample.m4a \        # REQUIRED: your narration file
//     --text     "The full on-screen caption text." \   # what shows as karaoke captions
//     --headline "ISRO launches new satellite" \         # persistent top-of-frame title
//     --images   ~/Desktop/pic1.jpg,~/Desktop/pic2.jpg \ # local files OR https URLs (comma list)
//     --images-dir ~/Desktop/isro-photos \               # …or a whole folder of images
//     --channel  world \                                 # world (English) | bharat (Hindi)
//     --hashtag  isro --badge BREAKING --source "ISRO"
//
//   If you give NO --images/--images-dir, it runs the SAME research pipeline the auto
//   channels use (--keywords drives the news-photo search; recommended for Hindi text):
//     --keywords "ISRO satellite launch" --geo IN --hl en-IN
//
//   --text is optional: omit it and the aligner transcribes your audio for the captions.
//
// ── MANY stories in one video ────────────────────────────────────────────────
//   Pass --manifest file.json (the raw shape build_from_audio.mjs documents), OR call this
//   once per story and concat externally. For a quick multi-story run, --manifest is simplest.
//
// Output: a staged short.mp4 path is printed. Nothing is uploaded (this is render-only) — the
// upload workflow handles publishing + the Upstash dedup ledger.

import { readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, extname } from 'node:path';
import { buildFromManifest } from './build_from_audio.mjs';

// Parse --flag value / --flag=value / boolean --flag into a plain object.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true; // boolean flag
    }
  }
  return out;
}

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

// Expand --images (comma list of files/URLs) + --images-dir (a folder) into one ordered,
// de-duped list. Local paths are resolved to absolute so build_from_audio can read them
// regardless of the cwd it runs in.
async function collectImages(args) {
  const out = [];
  const push = (ref) => {
    const r = String(ref || '').trim();
    if (!r) return;
    const norm = /^https?:\/\//i.test(r) || r.startsWith('file://') ? r : isAbsolute(r) ? r : resolve(process.cwd(), r);
    if (!out.includes(norm)) out.push(norm);
  };
  if (args.images) String(args.images).split(',').forEach(push);
  if (args['images-dir']) {
    const dir = isAbsolute(args['images-dir']) ? args['images-dir'] : resolve(process.cwd(), args['images-dir']);
    const files = (await readdir(dir)).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
    for (const f of files) push(join(dir, f));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Multi-story: a raw manifest file passes straight through to the shared core.
  if (args.manifest) {
    const manifest = JSON.parse(await readFile(args.manifest, 'utf-8'));
    const staged = await buildFromManifest(manifest, args.channel);
    console.log(`\n✅ done → ${staged}`);
    return;
  }

  if (!args.audio) {
    console.error(
      'usage: node shorts/make_video.mjs --audio <file> [--text "…"] [--headline "…"]\n' +
        '        [--images a.jpg,b.jpg | --images-dir ./photos] [--keywords "search phrase"]\n' +
        '        [--channel world|bharat] [--hashtag x] [--badge X] [--source "Name"] [--geo IN] [--hl en-IN]\n' +
        '   or: node shorts/make_video.mjs --manifest file.json [--channel world|bharat]',
    );
    process.exit(1);
  }

  const audio = isAbsolute(args.audio) ? args.audio : resolve(process.cwd(), args.audio);
  const images = await collectImages(args);

  const story = {
    audio,
    text: args.text || '',
    title: args.title || args.headline || '',
    headline: args.headline || args.title || '',
    hashtag: args.hashtag || '',
    badge: args.badge || '',
    sourceName: args.source || '',
    keywords: args.keywords || '',
    titleEn: args.titleEn || args.keywords || '',
    geo: args.geo || '',
    hl: args.hl || '',
    images,
  };

  console.log(
    `[make_video] channel=${args.channel || 'bharat'} audio=${audio}\n` +
      `  images=${images.length ? `${images.length} supplied` : 'none → research pipeline'}` +
      `${args.keywords ? ` keywords="${args.keywords}"` : ''}`,
  );

  const staged = await buildFromManifest({ channel: args.channel, stories: [story] }, args.channel);
  console.log(`\n✅ done → ${staged}`);
}

main().catch((e) => {
  console.error(`[make_video] FAILED: ${e.message}`);
  process.exit(1);
});
