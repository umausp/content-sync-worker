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
import { resolveBackground, brandBackground } from './visuals.mjs';
import { renderSegment, concatWithMusic } from './render.mjs';
// EN→HI via the offline m2m100 model (translate_hi.py) — see translateHindi() below.
import { buildWorldRoundup } from './world_feeds.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
// LONG-FORM mode (16:9, ~3.5min, 10 stories) = the higher-RPM monetization format.
// Triggered by SHORTS_ORIENTATION=landscape; defaults to 10 stories there, 5 for Shorts.
const LONGFORM = process.env.SHORTS_ORIENTATION === 'landscape';
const STORY_COUNT = Number(process.env.SHORTS_STORY_COUNT || (LONGFORM ? 10 : 5));

async function getJson(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`API ${r.status} for ${path}`);
  return r.json();
}

// ── Story gathering, per channel ────────────────────────────────────────────
// Batch-translate stories EN→HI via the offline m2m100 model (translate_hi.py). Returns
// an array aligned to `stories`: [{ title, summary, translated }] or null on total failure.
async function translateHindi(stories) {
  const dir = join(WORK_DIR, 'bharat', '_tr');
  await mkdir(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  const outPath = join(dir, 'out.json');
  await writeFile(
    jobPath,
    JSON.stringify({ items: stories.map((s) => ({ title: s.title, summary: s.summary })), out: outPath }),
  );
  try {
    await execFileP(PY, [join(process.cwd(), 'shorts', 'translate_hi.py'), jobPath], { timeout: 300000 });
    const res = JSON.parse(await readFile(outPath, 'utf-8'));
    return res.items || stories.map(() => null);
  } catch (e) {
    console.log(`[shorts:bharat] translate_hi failed (${e.message}); keeping English`);
    return stories.map(() => null);
  }
}

async function gatherStories(cfg) {
  if (cfg.id === 'world') {
    // Dedicated world/US-UK 5-slot roundup — NOT the India feed. Long-form pulls 2 per
    // slot (→10 stories); Shorts pull 1 per slot (→5).
    const perSlot = LONGFORM ? 2 : 1;
    // Prefer FRESH news (18h window) so a 2-hourly channel feels current, not stale.
    const round = await buildWorldRoundup({ maxAgeH: Number(process.env.WORLD_MAX_AGE_H || 18), perSlot });
    return round.slice(0, STORY_COUNT);
  }
  // bharat: a DIVERSE India slate from the Agyata feed — one story per category so a
  // bulletin isn't all-politics (editor's mix: top/politics, business, entertainment,
  // sports, tech, science, world, health). Breaking/live float up within that.
  const feed = await getJson(`/news/stories?mode=${cfg.apiMode}&limit=60`);
  const usable = (feed.items || []).filter((s) => s.title && s.summary && s.hashtag);
  const BHARAT_SLATE = ['top', 'politics', 'business', 'entertainment', 'sports', 'tech', 'science', 'world', 'health'];
  const rank = (s) => (s.isBreaking ? -40 : 0) + (s.isLive ? -20 : 0);
  const byRank = [...usable].sort((a, b) => rank(a) - rank(b));
  const picked = [];
  const usedCats = new Set();
  // First pass: one story per slate category (in slate order) for diversity.
  for (const cat of BHARAT_SLATE) {
    if (picked.length >= STORY_COUNT) break;
    const s = byRank.find((x) => (x.category || 'top') === cat && !picked.includes(x));
    if (s) { picked.push(s); usedCats.add(cat); }
  }
  // Second pass: fill any remaining slots with the next best stories (breaking-first).
  for (const s of byRank) {
    if (picked.length >= STORY_COUNT) break;
    if (!picked.includes(s)) picked.push(s);
  }
  // Translate to Hindi with the OFFLINE m2m100 model (MIT, no API, no rate limits).
  const CAT_HI = { top: 'खबर', politics: 'राजनीति', business: 'बिज़नेस', entertainment: 'मनोरंजन', sports: 'खेल', tech: 'टेक', science: 'विज्ञान', world: 'विश्व', health: 'सेहत' };
  const translated = await translateHindi(picked);
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i];
    const t = translated[i];
    if (t) {
      s.title = t.title;
      s.summary = t.summary;
    }
    // Hindi badge (English category labels look wrong on a Hindi channel).
    s.badge = s.isBreaking ? 'ब्रेकिंग' : s.isLive ? 'लाइव' : CAT_HI[(s.category || 'top').toLowerCase()] || 'खबर';
  }
  const okCount = translated.filter((t) => t?.translated).length;
  if (okCount < picked.length) {
    console.log(`[shorts:bharat] ⚠ translation: ${okCount}/${picked.length} translated to Hindi (m2m100); the rest kept English`);
  } else {
    console.log(`[shorts:bharat] translated ${okCount}/${picked.length} stories to Hindi (m2m100)`);
  }
  return picked;
}

// The opening HOOK — a short, punchy line to grab attention in the first seconds.
function hookLine(cfg, count) {
  if (cfg.scriptLang === 'hi') {
    return LONGFORM
      ? `आज की ${count} सबसे बड़ी खबरें — शुरू करते हैं।`
      : `आज की टॉप ${count} खबरें — देखिए।`;
  }
  return LONGFORM
    ? `Here are the ${count} biggest world stories today.`
    : `Today's top ${count} world stories — let's go.`;
}

// The closing CTA — subscribe + drive to the site. Short + long variants.
function outroLine(cfg) {
  if (cfg.scriptLang === 'hi') {
    return LONGFORM
      ? 'ऐसी और खबरों के लिए चैनल को Subscribe करें, और पूरी खबरें पढ़िए agyata.com पर।'
      : 'Subscribe करें और पूरी खबरें पढ़िए agyata dot com पर।';
  }
  return LONGFORM
    ? 'For more world news every day, subscribe to the channel — and read the full stories at agyata dot com.'
    : 'Subscribe for daily world news, and read more at agyata dot com.';
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
  // Start DIRECTLY with the news headline — no "Story N." prefix (spoken or captioned).
  const out = [title];
  const sents = summary.split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter(Boolean);
  if (LONGFORM) {
    // Long-form (16:9, ~3.5min) has time for real context: up to 2 sentences per story,
    // less aggressively trimmed — this is the higher-RPM monetization format.
    for (const s of sents.slice(0, 2)) out.push(s.length > 240 ? `${s.slice(0, 237).replace(/\s+\S*$/, '')}…` : s);
  } else {
    // Shorts: budget ~9-10s/story so 5 land under YouTube's 60s cap. Headline is the
    // star; add ONE short context clause only when the title is brief.
    if (title.length < 70) {
      let ctx = sents[0] || '';
      if (ctx.length > 120) ctx = `${ctx.slice(0, 117).replace(/\s+\S*$/, '')}…`;
      if (ctx) out.push(ctx);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function ttsForStory(sentences, cfg, work, id) {
  const job = {
    chunks: sentences,
    lang: cfg.lang,
    voice: cfg.voice,
    espeakLang: cfg.espeakLang, // espeak-ng phonemization language (en-us / hi)
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

  const segmentPaths = [];
  // Per-VIDEO image dedup: shared across the hook + every story so NO two segments use
  // the same photo (user: "always use a different image for different story").
  const seenImages = new Set();

  // 1-5s HOOK clip: the video opens with a punchy spoken+captioned hook (top-creator
  // pattern — grab attention in the first seconds) before the stories start.
  try {
    const hookText = hookLine(cfg, stories.length);
    const hookTiming = await ttsForStory([hookText], cfg, work, 'hook');
    if (hookTiming.duration && hookTiming.segments?.length) {
      // Hook is a TITLE card — branded gradient, NOT a story photo (reusing story 1's
      // image here made it appear 3x / look like a repeated story). No story badge/tag.
      const hbg = await brandBackground(join(work, 'hook'));
      const hchrome = await buildChrome(
        { hashtag: 'agyata', category: '', badge: cfg.scriptLang === 'hi' ? 'आज की खबरें' : "TODAY'S TOP" },
        cfg,
        join(work, 'hook'),
      );
      const hcaps = [];
      for (let j = 0; j < hookTiming.segments.length; j++) {
        const png = await buildCaption(hookTiming.segments[j].text, `hook-${j}`, cfg, join(work, 'hook'));
        hcaps.push({ png, start: hookTiming.segments[j].start, end: hookTiming.segments[j].end });
      }
      const hclip = join(work, 'clip-hook.mp4');
      await renderSegment({ bgPath: hbg.path, chromePath: hchrome, captions: hcaps, narrationWav: join(work, 'nar-hook.wav'), dur: hookTiming.duration, outPath: hclip });
      segmentPaths.push(hclip);
      console.log(`[shorts:${cfg.id}]   ✓ hook clip (${hookTiming.duration.toFixed(1)}s)`);
    }
  } catch (e) {
    console.log(`[shorts:${cfg.id}]   (hook skipped: ${e.message})`);
  }

  // Render each story as its own clip.
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    try {
      const sentences = storySentences(story, cfg, i);
      const timing = await ttsForStory(sentences, cfg, work, i);
      if (!timing.duration || !timing.segments?.length) throw new Error('no TTS timing');

      const bg = await resolveBackground(story, join(work, `s${i}`), seenImages);
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

  // OUTRO end-card: a branded closing beat with a spoken + captioned call-to-action
  // (subscribe + agyata.com). Standard top-creator pattern; boosts subs + site traffic.
  try {
    const outroText = outroLine(cfg);
    const oTiming = await ttsForStory([outroText], cfg, work, 'outro');
    if (oTiming.duration && oTiming.segments?.length) {
      const obg = await brandBackground(join(work, 'outro'));
      const ochrome = await buildChrome(
        { hashtag: 'agyata', category: '', badge: cfg.scriptLang === 'hi' ? 'देखते रहें' : 'FOLLOW' },
        cfg,
        join(work, 'outro'),
      );
      const ocaps = [];
      for (let j = 0; j < oTiming.segments.length; j++) {
        const png = await buildCaption(oTiming.segments[j].text, `outro-${j}`, cfg, join(work, 'outro'));
        ocaps.push({ png, start: oTiming.segments[j].start, end: oTiming.segments[j].end });
      }
      const oclip = join(work, 'clip-outro.mp4');
      await renderSegment({ bgPath: obg.path, chromePath: ochrome, captions: ocaps, narrationWav: join(work, 'nar-outro.wav'), dur: oTiming.duration, outPath: oclip });
      segmentPaths.push(oclip);
      console.log(`[shorts:${cfg.id}]   ✓ outro clip (${oTiming.duration.toFixed(1)}s)`);
    }
  } catch (e) {
    console.log(`[shorts:${cfg.id}]   (outro skipped: ${e.message})`);
  }

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
  const isWorld = cfg.id === 'world';
  const n = stories.length;
  const lead = stories[0];
  // UTC date label (Date is unavailable in workflow scripts but this runs in Node/CI).
  const date = new Date().toISOString().slice(0, 10);

  // TITLE — hooky, front-loaded, emoji, under YouTube's 100-char cap. Shorts append
  // #Shorts (aids Shorts classification); long-form must NOT. Build with a budget so the
  // lead title is trimmed (not the suffix) — never chop the #Shorts tag mid-word.
  const flag = isWorld ? '🌍' : '🇮🇳';
  const suffix = isWorld
    ? LONGFORM ? ` | Top ${n} World News Today (${date})` : ` | Top ${n} World News${LONGFORM ? '' : ' #Shorts'}`
    : LONGFORM ? ` | आज की टॉप ${n} खबरें (${date})` : ` | आज की टॉप खबरें${LONGFORM ? '' : ' #Shorts'}`;
  const budget = 99 - flag.length - 1 - suffix.length;
  let leadT = lead.title;
  if (leadT.length > budget) leadT = `${leadT.slice(0, Math.max(0, budget - 1)).replace(/\s+\S*$/, '')}…`;
  const title = `${flag} ${leadT}${suffix}`.slice(0, 99);

  // DESCRIPTION — hook + numbered stories WITH source + timestamps-ready + CTA links +
  // subscribe + hashtags. First 2 lines matter most (shown above the fold / in search).
  const sub = isWorld
    ? 'https://www.youtube.com/@AgyataWorld?sub_confirmation=1'
    : 'https://www.youtube.com/@agyata_dot_com?sub_confirmation=1';
  const hook = isWorld
    ? `The ${n} biggest world news stories today, ${date} — fast, neutral, sourced. Politics, breaking, business, tech, entertainment, sports & science in one quick recap.`
    : `आज की ${n} सबसे बड़ी खबरें (${date}) — तेज़, निष्पक्ष और भरोसेमंद। राजनीति, बिज़नेस, मनोरंजन, खेल और टेक — एक साथ।`;
  const storyList = stories.map((s, i) => `${i + 1}. ${s.title}${s.sourceName ? ` — ${s.sourceName}` : ''}`);
  const seoTail = isWorld
    ? ['📲 Full stories & live updates: https://agyata.com', `🔔 Subscribe for daily world news: ${sub}`]
    : ['📲 पूरी खबरें: https://agyata.com', `🔔 रोज़ की खबरों के लिए Subscribe करें: ${sub}`];
  // A rich, relevant hashtag block (YouTube uses the FIRST 3 as the clickable tags above
  // the title). Category-aware + evergreen news tags.
  const catTags = [...new Set(stories.map((s) => (s.category || '').toLowerCase()).filter(Boolean))];
  const baseTags = isWorld
    ? ['worldnews', 'breakingnews', 'news', 'todaynews', 'globalnews']
    : ['हिंदीन्यूज़', 'breakingnews', 'indianews', 'taazakhabar', 'news'];
  const hashtags = [...(LONGFORM ? [] : ['shorts']), ...baseTags, ...catTags].slice(0, 15);
  const description = [
    hook,
    '',
    isWorld ? "🗞️ In this recap:" : '🗞️ इस बुलेटिन में:',
    ...storyList,
    '',
    ...seoTail,
    '',
    hashtags.map((h) => `#${h}`).join(' '),
    '',
    isWorld
      ? 'Agyata News brings you fast, neutral, sourced news from around the world, every day.'
      : 'Agyata News — भारत और दुनिया की खबरें, तेज़ और निष्पक्ष।',
  ].join('\n');

  return {
    channel: cfg.id,
    format: LONGFORM ? 'longform' : 'short',
    title,
    description: description.slice(0, 4900),
    // YouTube tags (metadata, ≤500 chars total): keywords + category + per-story terms.
    tags: [...baseTags, ...catTags, isWorld ? 'world news today' : 'aaj ki taaza khabar', 'daily news recap', 'agyata']
      .filter(Boolean)
      .slice(0, 20),
    categoryId: '25', // News & Politics
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    // UNLISTED: auto-uploaded but not publicly discoverable — you bulk-flip the good
    // ones to public in YouTube Studio (protects monetization + a review safety net).
    privacyStatus: process.env.SHORTS_PRIVACY || 'unlisted',
    durationSec: Math.round(dur),
    storyCount: n,
    uploadSecret: cfg.uploadSecret,
  };
}

main().catch((e) => {
  console.error(`[shorts] FAILED: ${e.message}`);
  process.exit(1);
});
