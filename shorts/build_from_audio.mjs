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
//         "images":     ["https://…", …],      // OPTIONAL — event photos (from the research pipeline)
//         "entityShots":[{ "name":"…", "url":"https://…" }]  // OPTIONAL — name→image for spoken-sync
//       }, …
//     ]
//   }
//
// If a story has NO images, we run the SAME research gather (enrichSummary photo + entity
// resolution) the World channel uses — so this is not Wikidata-only; it leads with real news
// photos and adds entity portraits, exactly like the automated pipeline.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PY, STAGE_DIR, WORK_DIR, MUSIC_DIR, channel } from './config.mjs';
import { buildChrome, buildKaraokeCaptions } from './frames.mjs';
import { resolveBackgrounds } from './visuals.mjs';
import { renderSegment, concatWithMusic } from './render.mjs';
import { wordTimings } from './word_timing.mjs';
import { planShots } from './plan_shots.mjs';
import { entityImageMap, extractEntities } from './entity_images.mjs';

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

// If the story didn't ship images, gather them the SAME way the pipeline does: extract the
// key entities from the caption text/title and resolve name→image (research-pipeline photos
// flow through story.images upstream; here we top up entity portraits). Never blocks a render.
async function ensureImages(story) {
  if ((story.images && story.images.length) || (story.entityShots && story.entityShots.length)) return;
  try {
    const entities = await extractEntities({ title: story.title || '', summary: story.text || '' }, null);
    const emap = await entityImageMap(entities, { story: { title: story.title, summary: story.text } });
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

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('usage: build_from_audio.mjs <manifest.json> [world|bharat]');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  const channelId = process.argv[3] || manifest.channel || 'bharat';
  const cfg = channel(channelId);
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

      const captions = [];
      for (let j = 0; j < timing.segments.length; j++) {
        const sg = timing.segments[j];
        captions.push(...(await buildKaraokeCaptions(sg.text, sg.start, sg.end, `${i}-${j}`, cfg, join(work, `s${i}`))));
      }

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
        captions,
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
  await cp(outMp4, join(stageDir, 'short.mp4'));
  console.log(`[audio:${cfg.id}] ✓ staged → ${join(stageDir, 'short.mp4')} (${totalDur.toFixed(1)}s)`);
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

main().catch((e) => {
  console.error(`[audio] FAILED: ${e.message}`);
  process.exit(1);
});
