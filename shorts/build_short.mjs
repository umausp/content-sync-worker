// build_short.mjs — orchestrate one Shorts ROUNDUP end-to-end for a channel.
//
//   node shorts/build_short.mjs <world|bharat>
//
// Flow: gather the top N stories for the channel → for EACH story: craft natural
// full-sentence narration → Kokoro TTS (+ real-word timings) → resolve a cinematic
// background → build chrome + synced caption frames → render one clip. Then concat
// all clips + a low music bed → VALIDATE → stage MP4 + upload metadata for review.
//
//   • world  → 5-slot world/US-UK roundup (politics, breaking, global crisis,
//              entertainment/OTT, science/facts) from Western wires (world_feeds.mjs)
//   • bharat → top India stories from the Agyata feed, translated to Hinglish
//
// Fail-safe: a story that fails to render is skipped (the roundup still ships with the
// rest); the video is only staged if the final concat passes validation.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { API_BASE, PY, STAGE_DIR, WORK_DIR, MUSIC_DIR, channel } from './config.mjs';
import { buildChrome, buildCaption } from './frames.mjs';
import { resolveBackground } from './visuals.mjs';
import { renderSegment, concatWithMusic } from './render.mjs';
import { toHinglish } from './translate.mjs';
import { buildWorldRoundup } from './world_feeds.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const STORY_COUNT = Number(process.env.SHORTS_STORY_COUNT || 5);

async function getJson(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`API ${r.status} for ${path}`);
  return r.json();
}

// ── Story gathering, per channel ────────────────────────────────────────────
async function gatherStories(cfg) {
  if (cfg.id === 'world') {
    // Dedicated world/US-UK 5-slot roundup — NOT the India feed.
    const round = await buildWorldRoundup({ maxAgeH: Number(process.env.WORLD_MAX_AGE_H || 36) });
    return round.slice(0, STORY_COUNT);
  }
  // bharat: top India stories from the Agyata feed.
  const feed = await getJson(`/news/stories?mode=${cfg.apiMode}&limit=40`);
  const usable = (feed.items || []).filter((s) => s.title && s.summary && s.hashtag);
  const rank = (s) => (s.isBreaking ? -40 : 0) + (s.isLive ? -20 : 0);
  const picked = usable.sort((a, b) => rank(a) - rank(b)).slice(0, STORY_COUNT);
  // Translate each to Hinglish (fail-safe to English).
  for (const s of picked) {
    const t = await toHinglish(s.title, s.summary);
    s.title = t.title;
    s.summary = t.summary;
    s.badge = s.isBreaking ? 'BREAKING' : s.isLive ? 'LIVE' : (s.category || 'NEWS').toUpperCase();
  }
  return picked;
}

// ── Natural narration for ONE story ──────────────────────────────────────────
// Full sentences (not isolated fragments) so Kokoro's prosody flows naturally. The
// caption for each sentence is timed to that sentence's audio. Returns the list of
// caption-sized sentences to speak+show for this story.
function storySentences(story, cfg, index) {
  // Clean common wire-title cruft: trailing " – Outlet / live / updates" tails.
  const title = String(story.title)
    .replace(/\s+[–—|]\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = String(story.summary).replace(/\s+/g, ' ').trim();
  // Budget each story to ~9-10s so 5 stories land under YouTube's 60s Short cap.
  // The headline is the star; add ONE short context clause only if the title is brief,
  // and always trim at a word boundary. (A 5-story Short ≈ 50s at this budget.)
  const lead = cfg.scriptLang === 'hi' ? `खबर ${index + 1}.` : `Story ${index + 1}.`;
  const out = [`${lead} ${title}`];
  if (title.length < 70) {
    let ctx = summary.split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter(Boolean)[0] || '';
    if (ctx.length > 120) ctx = `${ctx.slice(0, 117).replace(/\s+\S*$/, '')}…`;
    if (ctx) out.push(ctx);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function ttsForStory(sentences, cfg, work, id) {
  const job = {
    chunks: sentences,
    lang: cfg.lang,
    voice: cfg.voice,
    speed: Number(process.env.SHORTS_TTS_SPEED || 0.94), // slightly slower = clearer
    out: join(work, `nar-${id}`),
  };
  await writeFile(join(work, `tts-${id}.json`), JSON.stringify(job));
  await execFileP(PY, [join(process.cwd(), 'shorts', 'kokoro_tts.py'), join(work, `tts-${id}.json`)], {
    timeout: 180000,
  });
  return JSON.parse(await readFile(join(work, `nar-${id}.json`), 'utf-8'));
}

function slug(d) {
  return String(d).replace(/[^0-9A-Za-z-]/g, '-');
}

async function firstMusic() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(MUSIC_DIR)).filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f));
    return files.length ? join(MUSIC_DIR, files[0]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const channelId = process.argv[2];
  const cfg = channel(channelId);
  const stamp = slug(process.env.SHORTS_STAMP || 'local-run');

  console.log(`[shorts:${cfg.id}] gathering top ${STORY_COUNT} stories…`);
  const stories = await gatherStories(cfg);
  if (!stories.length) throw new Error('no usable stories found');
  console.log(`[shorts:${cfg.id}] ${stories.length} stories:`);
  for (const s of stories) console.log(`   [${(s.badge || s.category || '').padEnd(13)}] ${s.title.slice(0, 60)}`);

  const work = join(WORK_DIR, cfg.id, stamp);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  // Each story renders as its own clip (story 1 leads with "Story 1." so the roundup
  // reads as a countdown — no separate intro clip needed, which keeps concat clean).
  const segmentPaths = [];

  // Render each story as its own clip.
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    try {
      const sentences = storySentences(story, cfg, i);
      const timing = await ttsForStory(sentences, cfg, work, i);
      if (!timing.duration || !timing.segments?.length) throw new Error('no TTS timing');

      const bg = await resolveBackground(story, join(work, `s${i}`));
      const chrome = await buildChrome(story, cfg, join(work, `s${i}`));
      const captions = [];
      for (let j = 0; j < timing.segments.length; j++) {
        const png = await buildCaption(timing.segments[j].text, `${i}-${j}`, cfg, join(work, `s${i}`));
        captions.push({ png, start: timing.segments[j].start, end: timing.segments[j].end });
      }
      const clip = join(work, `clip-${i}.mp4`);
      await renderSegment({
        bgPath: bg.path,
        chromePath: chrome,
        captions,
        narrationWav: join(work, `nar-${i}.wav`),
        dur: timing.duration,
        outPath: clip,
      });
      segmentPaths.push(clip);
      console.log(`[shorts:${cfg.id}]   ✓ story ${i + 1} clip (${timing.duration.toFixed(1)}s, bg=${bg.kind})`);
    } catch (e) {
      console.log(`[shorts:${cfg.id}]   ✗ story ${i + 1} skipped: ${e.message}`);
    }
  }
  if (!segmentPaths.length) throw new Error('all story clips failed to render');

  // Concat clips + low music bed → final validated MP4.
  const totalDur = await sumDurations(segmentPaths);
  const music = await firstMusic();
  const outMp4 = join(work, 'short.mp4');
  console.log(`[shorts:${cfg.id}] concat ${segmentPaths.length} clips (~${totalDur.toFixed(0)}s, music=${!!music})…`);
  await concatWithMusic({ segmentPaths, musicPath: music, outPath: outMp4, totalDur });

  // Stage MP4 + upload metadata.
  const stageDir = join(STAGE_DIR, cfg.id, stamp);
  await mkdir(stageDir, { recursive: true });
  await cp(outMp4, join(stageDir, 'short.mp4'));
  const meta = buildUploadMeta(stories, cfg, totalDur);
  await writeFile(join(stageDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[shorts:${cfg.id}] ✓ staged → ${join(stageDir, 'short.mp4')} (${totalDur.toFixed(1)}s)`);
  console.log(`[shorts:${cfg.id}] title: ${meta.title}`);
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

function buildUploadMeta(stories, cfg, dur) {
  const tagLine = cfg.hashtags.join(' ');
  const lead = stories[0];
  const isWorld = cfg.id === 'world';
  const title = (isWorld ? `Top ${stories.length}: ${lead.title}` : `टॉप ${stories.length}: ${lead.title}`).slice(0, 95);
  const lines = [
    isWorld ? `Today's top ${stories.length} world stories:` : `आज की टॉप ${stories.length} खबरें:`,
    '',
    ...stories.map((s, i) => `${i + 1}. ${s.title}`),
    '',
    cfg.ctaLine + ' https://agyata.com',
    '',
    tagLine,
  ];
  return {
    channel: cfg.id,
    title,
    description: lines.join('\n').slice(0, 4900),
    tags: cfg.hashtags.map((h) => h.replace('#', '')).concat(stories.map((s) => s.category)).filter(Boolean).slice(0, 20),
    categoryId: '25',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    privacyStatus: 'private',
    durationSec: Math.round(dur),
    storyCount: stories.length,
    uploadSecret: cfg.uploadSecret,
  };
}

main().catch((e) => {
  console.error(`[shorts] FAILED: ${e.message}`);
  process.exit(1);
});
