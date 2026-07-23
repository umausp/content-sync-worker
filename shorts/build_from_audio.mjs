// build_from_audio.mjs — make a karaoke-pop Short from EXTERNAL narration audio.
//
//   node shorts/build_from_audio.mjs <manifest.json> [world|bharat]
//
// This is the "video making is separate" seam (user's architecture): content, audio, and
// images are produced elsewhere; this stage ONLY turns supplied audio + text (+ images) into
// the finished karaoke-caption + image-synced video. It reuses the EXACT render path the
// World channel uses (align_audio.py → wordTimings → planShots → buildKaraokeCaptions →
// renderSegment → concatWithMusic), so a Hindi clip looks identical in style to a World clip.
//
// Manifest shape (all per-story; one clip per story, concatenated):
//   {
//     "channel": "bharat",                     // optional; CLI arg overrides; default bharat
//     "lang": "hi",                            // align/caption language hint (default from channel)
//     "stories": [
//       {
//         "audio": "/abs/narration.mp3",       // REQUIRED — the supplied narration for this story
//         "text":  "पूरा हिंदी कैप्शन टेक्स्ट…", // OPTIONAL — exact on-screen caption text (else transcript)
//         "title": "…", "headline": "…",       // OPTIONAL — persistent on-screen headline + chrome
//         "hashtag": "india", "badge": "ब्रेकिंग", "sourceName": "…",
//         "keywords":   "ISRO satellite launch",  // OPTIONAL but RECOMMENDED for Hindi —
//                                                  // ENGLISH search phrase. Google News returns
//                                                  // ~nothing for Devanagari queries, so this
//                                                  // drives the multi-source image research.
//         "titleEn":    "ISRO launches new comms satellite", // OPTIONAL — English title (used
//                                                  // for search + entity resolution if no keywords)
//         "geo": "IN", "hl": "en-IN",              // OPTIONAL — localise the news search
//         "images":     ["https://…", …],          // OPTIONAL — event photos (skips research)
//         "entityShots":[{ "name":"…", "url":"https://…" }]  // OPTIONAL — name→image for spoken-sync
//       }, …
//     ]
//   }
//
// If a story has NO images, we run the SAME research gather the World channel uses: derive
// English keywords → Google News (freshest window) → on-topic multi-source articles →
// harvest every outlet's OWN photos + entity portraits (recency + relevancy scored). This
// is NOT Wikidata-only — it LEADS with real news photos and falls back to entity portraits
// only when there's no coverage, exactly like the automated pipeline.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PY, STAGE_DIR, WORK_DIR, MUSIC_DIR, channel } from './config.mjs';
import { buildChrome } from './frames.mjs';
import { buildCaptionTrack } from './captions_fluid.mjs';
import { resolveBackgrounds } from './visuals.mjs';
import { renderSegment, concatWithMusic } from './render.mjs';
import { wordTimings } from './word_timing.mjs';
import { planShots } from './plan_shots.mjs';
import { entityImageMap, extractEntities } from './entity_images.mjs';
import { researchImagesForStory } from './world_feeds.mjs';

const execFileP = promisify(execFile);

function slug(d) {
  return String(d).replace(/[^0-9A-Za-z-]/g, '-');
}

// Align supplied audio → the { duration, segments:[{start,end,text}] } contract (same as
// kokoro_tts.py). Reuses align_audio.py (faster-whisper, CPU) so timings come from the REAL
// speech; when the story supplies caption text it is shown verbatim on screen.
async function alignAudio(story, lang, work, id) {
  const job = { audio: story.audio, text: story.text || '', lang: lang || null, out: join(work, `nar-${id}`) };
  await writeFile(join(work, `align-${id}.json`), JSON.stringify(job));
  await execFileP(PY, [join(process.cwd(), 'shorts', 'align_audio.py'), join(work, `align-${id}.json`)], {
    timeout: 300000,
  });
  return JSON.parse(await readFile(join(work, `nar-${id}.json`), 'utf-8'));
}

// If the story didn't ship images, gather them the SAME way the automated pipeline does —
// the RESEARCH PATH, not Wikidata-only (user: "you will FIRST find the news from those
// keywords and fetch the LATEST images from the latest articles with multi-source, recency,
// relevancy score. We had created a research pipeline — make sure you are using this too").
//
// So: derive English search keywords → Google News (freshest window) → on-topic
// multi-source articles → harvest every outlet's OWN photos + entity portraits. Then, if the
// research turned up nothing (obscure story / no coverage), fall back to entity portraits so
// the clip still has a real subject photo. Never blocks a render.
async function ensureImages(story) {
  if ((story.images && story.images.length) || (story.entityShots && story.entityShots.length)) return;

  // 1) RESEARCH PIPELINE — the primary source. `keywords`/`titleEn` (English) drive the
  //    search when the caption text is Hindi. `geo`/`hl` localise it (India/English default).
  try {
    const res = await researchImagesForStory(
      { title: story.title || '', titleEn: story.titleEn || story.keywords || '', searchKeywords: story.keywords || '' },
      {
        keywords: story.keywords || story.titleEn || null,
        geo: story.geo || process.env.SHORTS_RESEARCH_GEO || 'IN',
        hl: story.hl || process.env.SHORTS_RESEARCH_HL || 'en-IN',
      },
    );
    if (res.images.length || res.entityShots.length) {
      story.entityShots = res.entityShots;
      story.images = [...new Set([...(story.images || []), ...res.images, ...res.entityShots.map((p) => p.url)])];
      if (res.sourceName && !story.sourceName) story.sourceName = res.sourceName;
      if (res.images.length) return; // got real news photos → done
    }
  } catch {
    /* research is best-effort */
  }

  // 2) FALLBACK — entity portraits (Wikipedia/Wikidata/Commons) when research found no
  //    coverage. Uses keywords/titleEn (English) so entity resolution works for Hindi text.
  try {
    const forEntities = { title: story.titleEn || story.keywords || story.title || '', summary: story.text || '' };
    const entities = await extractEntities(forEntities, null);
    const emap = await entityImageMap(entities, { story: forEntities });
    if (emap.length) {
      story.entityShots = emap;
      story.images = [...new Set([...(story.images || []), ...emap.map((p) => p.url)])];
    }
  } catch {
    /* entity images are a bonus */
  }
}

async function firstMusic() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(MUSIC_DIR)).filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f));
    if (!files.length) return null;
    const want = process.env.SHORTS_MUSIC;
    const pick = (want && files.find((f) => f === want)) || files.find((f) => /beat|energ/i.test(f)) || files.sort()[0];
    return join(MUSIC_DIR, pick);
  } catch {
    return null;
  }
}

// Build a finished video from a manifest OBJECT (audio + text [+ images] per story). This is
// the reusable core; both the file entry (build_from_audio.mjs <manifest.json>) and the
// friendly flag CLI (make_video.mjs) call it. Returns the staged short.mp4 path.
export async function buildFromManifest(manifest, channelId) {
  const cfg = channel(channelId || manifest.channel || 'bharat');
  const lang = manifest.lang || cfg.scriptLang;
  const stamp = slug(process.env.SHORTS_STAMP || 'audio-run');
  const stories = Array.isArray(manifest.stories) ? manifest.stories.filter((s) => s && s.audio) : [];
  if (!stories.length) throw new Error('manifest has no stories with an audio file');

  const work = join(WORK_DIR, `${cfg.id}-audio`, stamp);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const segmentPaths = [];
  const seenImages = new Set();
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    try {
      const timing = await alignAudio(story, lang, work, i);
      if (!timing.duration || !timing.segments?.length) throw new Error('no timing from aligner');
      await ensureImages(story);

      // Same image budget heuristic as the automated pipeline.
      const perImgSec = Number(process.env.SHORTS_SEC_PER_IMG || 5);
      const imgCap = Number(process.env.SHORTS_IMG_CAP || 12);
      const imgCount = Math.max(3, Math.min(imgCap, Math.round(timing.duration / perImgSec)));
      const bg = await resolveBackgrounds(story, join(work, `s${i}`), seenImages, imgCount);

      const headline = story.headline || story.title || '';
      const chrome = await buildChrome({ ...story, headline }, cfg, join(work, `s${i}`));

      // PREMIUM FLUID CAPTIONS — this seam renders supplied text VERBATIM (no translation).
      // Montserrat-only, big + bold, ≤2 lines, with smooth per-frame eased word-pop (a single
      // alpha .mov overlaid once) — not the discrete hard-cut PNGs the automated channels use.
      const captionTrack = await buildCaptionTrack(timing.segments, cfg, join(work, `s${i}`, 'caps'), {
        dur: timing.duration,
      });

      // Gap 1 image↔word sync — identical to build_short.mjs.
      const timeline = wordTimings(timing.segments);
      const shots = (bg.paths || []).map((p, k) => ({
        path: p,
        url: (bg.urls || [])[k] || null,
        kind: (bg.kinds || [])[k] || 'event',
      }));
      const bgWindows = planShots({ shots, entityShots: story.entityShots || [], timeline, duration: timing.duration });

      const clip = join(work, `clip-${i}.mp4`);
      await renderSegment({
        bgWindows,
        chromePath: chrome,
        captionTrack,
        narrationWav: join(work, `nar-${i}.wav`), // align_audio.py wrote the clean WAV here
        dur: timing.duration,
        outPath: clip,
      });
      segmentPaths.push(clip);
      console.log(`[audio:${cfg.id}]   ✓ story ${i + 1} clip (${timing.duration.toFixed(1)}s, ${bg.paths.length} imgs)`);
    } catch (e) {
      console.log(`[audio:${cfg.id}]   ✗ story ${i + 1} skipped: ${e.message}`);
    }
  }
  if (!segmentPaths.length) throw new Error('all clips failed to render');

  const totalDur = await sumDurations(segmentPaths);
  const music = await firstMusic();
  const outMp4 = join(work, 'short.mp4');
  console.log(`[audio:${cfg.id}] concat ${segmentPaths.length} clips (~${totalDur.toFixed(0)}s, music=${!!music})…`);
  await concatWithMusic({ segmentPaths, musicPath: music, outPath: outMp4, totalDur });

  const stageDir = join(STAGE_DIR, `${cfg.id}-audio`, stamp);
  await mkdir(stageDir, { recursive: true });
  const staged = join(stageDir, 'short.mp4');
  await cp(outMp4, staged);
  console.log(`[audio:${cfg.id}] ✓ staged → ${staged} (${totalDur.toFixed(1)}s)`);
  return staged;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('usage: build_from_audio.mjs <manifest.json> [world|bharat]');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  await buildFromManifest(manifest, process.argv[3]);
}

async function sumDurations(paths) {
  let total = 0;
  for (const p of paths) {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p,
    ]);
    total += Number(String(stdout).trim()) || 0;
  }
  return total;
}

// Run the file entry only when invoked directly (node shorts/build_from_audio.mjs <manifest>);
// importing this module (e.g. make_video.mjs, tests) must NOT kick off a render.
if (fileURLToPath(import.meta.url) === (process.argv[1] || '')) {
  main().catch((e) => {
    console.error(`[audio] FAILED: ${e.message}`);
    process.exit(1);
  });
}
