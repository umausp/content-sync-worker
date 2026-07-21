// build_short.mjs — orchestrate one Short end-to-end for a channel.
//
//   node scripts/shorts/build_short.mjs <world|bharat> [--hashtag <tag>]
//
// Flow: pick a hot story from the live API → craft caption-chunked narration →
// Kokoro TTS (+ real-word timings) → resolve background → build chrome + caption
// frames → ffmpeg composite → VALIDATE → stage MP4 + upload metadata for review.
//
// Deterministic + fail-safe: any stage failure throws with a clear reason; a Short is
// only staged if it passed render validation. Nothing uploads here (human gate first).

import { execFile } from 'node:child_process';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { API_BASE, PY, STAGE_DIR, WORK_DIR, MUSIC_DIR, channel } from './config.mjs';
import { buildChrome, buildCaption } from './frames.mjs';
import { resolveBackground } from './visuals.mjs';
import { renderShort } from './render.mjs';
import { toHinglish } from './translate.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function getJson(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`API ${r.status} for ${path}`);
  return r.json();
}

// Pick the freshest high-value story for this channel: prefer breaking/live, then the
// channel's category priority, then newest. Skips content-feed/evergreen tags.
function pickStory(items, cfg, forceTag) {
  const usable = items.filter((s) => s.title && s.summary && s.hashtag);
  if (forceTag) return usable.find((s) => s.hashtag === forceTag) || null;
  const rank = (s) => {
    let r = 0;
    if (s.isBreaking) r -= 100;
    if (s.isLive) r -= 60;
    const ci = cfg.categoryPriority.indexOf(s.category);
    r += ci === -1 ? 50 : ci * 5;
    return r;
  };
  return usable.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// Split a story into caption-sized narration chunks: a punchy hook, then the summary
// broken at sentence boundaries, then a short outro CTA. Each chunk becomes one on-screen
// caption synced to its own TTS audio.
function narrationChunks(story, cfg) {
  const hook = story.isBreaking
    ? (cfg.scriptLang === 'hi' ? 'बड़ी खबर।' : 'Breaking news.')
    : (cfg.scriptLang === 'hi' ? 'आज की बड़ी खबर।' : "Here's what's happening.");
  const title = String(story.title).replace(/\s+/g, ' ').trim();
  const summary = String(story.summary).replace(/\s+/g, ' ').trim();
  // Sentence split (handles Devanagari danda ।).
  const sents = summary.split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter(Boolean);
  // NOTE: the CTA is rendered as PERSISTENT chrome (bottom of every frame), so we do NOT
  // add it as a spoken/captioned chunk — that duplicated it on screen. Narration ends on
  // the last news sentence; the CTA stays visible throughout.
  const chunks = [hook, title, ...sents]
    .map((s) => s.trim())
    .filter(Boolean)
    // Keep total voice length Short-appropriate (~cap at 6 spoken chunks ≈ 30-45s).
    .slice(0, 6);
  return chunks;
}

function slug(d) {
  // caller passes a stable stamp; keep filesystem-safe
  return String(d).replace(/[^0-9A-Za-z-]/g, '-');
}

async function firstMusic() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(MUSIC_DIR)).filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f));
    return files.length ? join(MUSIC_DIR, files[0]) : null;
  } catch {
    return null; // no music dir → render narration-only (valid)
  }
}

async function main() {
  const channelId = process.argv[2];
  const forceTag = process.argv.includes('--hashtag')
    ? process.argv[process.argv.indexOf('--hashtag') + 1]
    : null;
  const cfg = channel(channelId);
  // Stable stamp passed via env (workflows set it); fallback to a fixed label locally.
  const stamp = slug(process.env.SHORTS_STAMP || 'local-run');

  console.log(`[shorts:${cfg.id}] fetching stories…`);
  const feed = await getJson(`/news/stories?mode=${cfg.apiMode}&limit=40`);
  const story = pickStory(feed.items || [], cfg, forceTag);
  if (!story) throw new Error('no usable story found');
  console.log(`[shorts:${cfg.id}] picked #${story.hashtag} — ${story.title.slice(0, 60)}`);

  // India channel: translate the English story → Hinglish (Devanagari + English proper
  // nouns) so captions + narration are in Hindi. Fail-safe: keeps English on any failure.
  // The English (world) channel skips this entirely.
  if (cfg.scriptLang === 'hi') {
    const t = await toHinglish(story.title, story.summary);
    story.title = t.title;
    story.summary = t.summary;
    console.log(`[shorts:${cfg.id}] hinglish: ${t.translated ? 'translated' : 'FALLBACK to English (no LLM key/failed)'}`);
  }

  const work = join(WORK_DIR, cfg.id, stamp);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  // 1. narration chunks → Kokoro TTS
  const chunks = narrationChunks(story, cfg);
  const job = { chunks, lang: cfg.lang, voice: cfg.voice, out: join(work, 'narration') };
  await writeFile(join(work, 'tts_job.json'), JSON.stringify(job));
  console.log(`[shorts:${cfg.id}] TTS ${chunks.length} chunks (${cfg.lang}/${cfg.voice})…`);
  await execFileP(PY, [join(process.cwd(), 'shorts', 'kokoro_tts.py'), join(work, 'tts_job.json')], {
    timeout: 180000,
  });
  const timing = JSON.parse(await (await import('node:fs/promises')).readFile(join(work, 'narration.json'), 'utf-8'));
  const dur = timing.duration;
  const segs = timing.segments;
  if (!dur || !segs?.length) throw new Error('TTS produced no timing');

  // 2. background
  console.log(`[shorts:${cfg.id}] background…`);
  const bg = await resolveBackground(story, work);
  console.log(`[shorts:${cfg.id}] background: ${bg.kind}`);

  // 3. frames: chrome + one caption per segment (mapped to its [start,end])
  const chrome = await buildChrome(story, cfg, work);
  const captions = [];
  for (let i = 0; i < segs.length; i++) {
    const png = await buildCaption(segs[i].text, i, cfg, work);
    captions.push({ png, start: segs[i].start, end: segs[i].end });
  }

  // 4. render + validate
  const music = await firstMusic();
  const outMp4 = join(work, 'short.mp4');
  console.log(`[shorts:${cfg.id}] rendering ${dur.toFixed(1)}s (music=${!!music})…`);
  await renderShort({
    bgPath: bg.path,
    chromePath: chrome,
    captions,
    narrationWav: join(work, 'narration.wav'),
    musicPath: music,
    dur,
    outPath: outMp4,
  });

  // 5. stage: MP4 + upload metadata for the human-approve gate
  const stageDir = join(STAGE_DIR, cfg.id, stamp);
  await mkdir(stageDir, { recursive: true });
  await cp(outMp4, join(stageDir, 'short.mp4'));
  const meta = buildUploadMeta(story, cfg, dur, bg.kind);
  await writeFile(join(stageDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[shorts:${cfg.id}] ✓ staged → ${join(stageDir, 'short.mp4')} (${dur.toFixed(1)}s)`);
  console.log(`[shorts:${cfg.id}] title: ${meta.title}`);
}

function buildUploadMeta(story, cfg, dur, bgKind) {
  const tagLine = cfg.hashtags.join(' ');
  const title = `${story.isBreaking ? '🔴 ' : ''}${story.title}`.slice(0, 95);
  const desc = [
    story.summary,
    '',
    cfg.ctaLine + ' https://agyata.com',
    '',
    tagLine,
  ].join('\n');
  return {
    channel: cfg.id,
    title,
    description: desc,
    tags: cfg.hashtags.map((h) => h.replace('#', '')).concat([story.category, story.hashtag]).filter(Boolean),
    categoryId: '25', // News & Politics
    // AI-disclosure: we use synthetic narration → declare altered content (cost-free,
    // policy-safe). Not impersonating a real person, but honest disclosure is correct.
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    privacyStatus: 'private', // human flips to public on approval / after audit
    sourceStory: `https://agyata.com/news/${story.hashtag}`,
    durationSec: Math.round(dur),
    background: bgKind,
    uploadSecret: cfg.uploadSecret,
  };
}

main().catch((e) => {
  console.error(`[shorts] FAILED: ${e.message}`);
  process.exit(1);
});
