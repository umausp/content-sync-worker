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
import { buildChrome, buildKaraokeCaptions } from './frames.mjs';
import { resolveBackground, resolveBackgrounds, brandBackground } from './visuals.mjs';
import { renderSegment, concatWithMusic } from './render.mjs';
// EN→HI via the offline m2m100 model (translate_hi.py) — see translateHindi() below.
import { buildWorldRoundup, buildTrendingStories } from './world_feeds.mjs';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
// LONG-FORM mode (16:9, ~3.5min, 10 stories) = the higher-RPM monetization format.
// Triggered by SHORTS_ORIENTATION=landscape; defaults to 10 stories there.
const LONGFORM = process.env.SHORTS_ORIENTATION === 'landscape';
// SINGLE-STORY mode = the research-backed default for Shorts retention (one strong
// story, deep, ~25-35s beats a 5-roundup that drops viewers at each topic switch).
// SHORTS_SINGLE=0 restores the 5-story roundup. Long-form always does 10.
const SINGLE = !LONGFORM && process.env.SHORTS_SINGLE !== '0';
const STORY_COUNT = Number(process.env.SHORTS_STORY_COUNT || (LONGFORM ? 10 : SINGLE ? 1 : 5));

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
    JSON.stringify({
      items: stories.map((s) => ({ title: s.title, summary: s.summary, backstory: s.backstory || '' })),
      out: outPath,
    }),
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

// For a thread with prior updates, fetch the ORIGINAL development so the Short can give
// backstory. Sets story.backstory (English) — translated alongside the rest for bharat.
async function attachBackstory(story) {
  if (!story.hashtag || (story.updateCount || 0) < 2) return; // single-update = no arc
  try {
    const t = await getJson(`/news/stories/${encodeURIComponent(story.hashtag)}/thread`);
    const ups = t.updates || [];
    if (ups.length < 2) return;
    // Oldest update = how the story began. Use its short body/title as the backstory.
    const first = ups[ups.length - 1];
    let bs = String(first.body || first.title || '').replace(/\s+/g, ' ').trim();
    if (bs && bs.slice(0, 40) !== String(story.title).slice(0, 40)) {
      if (bs.length > 160) bs = `${bs.slice(0, 157).replace(/\s+\S*$/, '')}…`;
      story.backstory = bs;
    }
  } catch {
    /* best-effort — no backstory */
  }
}

// Merge two story lists, interleaving them while dropping cross-list duplicates (the
// same event can be both an editorial pick AND a Google trend). Word-overlap key so
// near-identical headlines from two paths count once. `primary` leads each pair.
function normKey(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).sort().slice(0, 8).join(' ');
}
function mergeByTitle(primary, secondary) {
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const k = normKey(s.title);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  // PRIMARY (the round-robin roundup — one per category first) leads, so a long-form
  // slice(0,10) is guaranteed to span EVERY category the user asked for (politics,
  // global, entertainment, tech, science, sports, health, weird/offbeat). Google-Trends
  // stories come AFTER, filling remaining slots — a curated-first, trend-topped mix.
  primary.forEach(add);
  secondary.forEach(add);
  return out;
}

async function gatherStories(cfg) {
  if (cfg.id === 'world') {
    // Dedicated world/US-UK 9-slot roundup — NOT the India feed. Long-form pulls 2 per
    // slot; Shorts pull 1 per slot. The roundup is round-robin ordered (one per category
    // first) so slice(0, N) always spans ALL categories (politics…sports…science…).
    const perSlot = LONGFORM ? 2 : 1;
    // Prefer FRESH news (18h window) so a 2-hourly channel feels current, not stale.
    // Enrich EVERY story — fetch the article body + LLM-synthesise a useful 2-3 sentence
    // brief (was gated to single/long-form, leaving the roundup thin → "content is very
    // less"). Applies to all formats now.
    const [round, trending] = await Promise.all([
      buildWorldRoundup({
        maxAgeH: Number(process.env.WORLD_MAX_AGE_H || 18),
        perSlot,
        enrich: true,
      }),
      // GOOGLE TRENDS (US + GB): what's actually being searched right now, resolved to a
      // real publisher article + the outlet's OWN og:image (never the gstatic thumbnail).
      // Adds genuine "trending now" stories the editorial slots miss.
      buildTrendingStories({ perGeo: LONGFORM ? 2 : 1, enrich: true }).catch(() => []),
    ]);
    // MERGE: interleave the roundup with trending (cross-deduped by normalized title) so
    // both editorial coverage AND live search trends make the cut. Roundup leads (curated
    // categories), then a trending story, alternating — slice keeps the mix balanced.
    const merged = mergeByTitle(round, trending);
    return merged.slice(0, STORY_COUNT);
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
  // BACKSTORY: for a story that's an UPDATE to an existing thread (updateCount > 1),
  // pull the ORIGINAL development from its thread so the Short can remind the viewer how
  // it began ("यह मामला तब शुरू हुआ जब… अब…") — connects returning viewers to the arc.
  await Promise.all(picked.map((s) => attachBackstory(s)));
  // Translate to Hindi with the OFFLINE m2m100 model (MIT, no API, no rate limits).
  const CAT_HI = { top: 'खबर', politics: 'राजनीति', business: 'बिज़नेस', entertainment: 'मनोरंजन', sports: 'खेल', tech: 'टेक', science: 'विज्ञान', world: 'विश्व', health: 'सेहत' };
  const translated = await translateHindi(picked);
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i];
    const t = translated[i];
    if (t) {
      s.title = t.title;
      s.summary = t.summary;
      if (t.backstory) s.backstory = t.backstory;
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
// SINGLE mode has ONE story, so "top 1 stories" reads wrong — use a curiosity hook that
// teases the story instead. `lead` is the lead story (for the single-story tease).
function hookLine(cfg, count, lead) {
  if (SINGLE) {
    // Curiosity tease built from the story itself — no bogus count.
    if (cfg.scriptLang === 'hi') return `ये है आज की बड़ी खबर — पूरा जानिए।`;
    return `Here's the big story you need to know right now.`;
  }
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

// Select COMPLETE sentences that fit a budget — NEVER truncate a sentence mid-word (the
// "every story ends with half a sentence" bug came from slicing a long sentence and
// tacking on "…"). We keep whole sentences up to `maxSentences` and a soft `maxWords`
// cap; a sentence that alone blows the word cap is dropped (not chopped) unless it's the
// only one — in which case we cut it back to its last COMPLETE clause (…, ; :) so the
// spoken line still ends cleanly rather than dangling.
function wordCount(s) {
  return String(s).split(/\s+/).filter(Boolean).length;
}
function pickWholeSentences(sents, { maxSentences, maxWords }) {
  const out = [];
  let words = 0;
  for (const s of sents) {
    if (out.length >= maxSentences) break;
    const w = wordCount(s);
    // A single over-long sentence: keep it only if nothing chosen yet, trimmed to its
    // last complete clause boundary so it still ends on punctuation (never mid-word).
    if (w > maxWords) {
      if (out.length) break; // we already have enough; don't append a giant one
      const clauses = s.split(/(?<=[,;:—–])\s+/);
      let clip = '';
      for (const c of clauses) {
        if (wordCount(clip ? `${clip} ${c}` : c) > maxWords && clip) break;
        clip = clip ? `${clip} ${c}` : c;
      }
      // Drop a trailing dangling connector so it doesn't end on "and,"/"but,".
      clip = clip.replace(/[\s,;:—–]+$/, '').replace(/\s+(and|but|or|the|a|to|of|in|on|for|with)$/i, '');
      out.push(/[.!?।]$/.test(clip) ? clip : `${clip}.`);
      break;
    }
    if (words + w > maxWords && out.length) break;
    out.push(s);
    words += w;
  }
  return out;
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
  // Split into sentences, keeping ONLY complete ones (must end in terminal punctuation)
  // — a trailing fragment with no ./!/? is dropped so narration never ends mid-thought.
  const sents = summary
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && /[.!?।]$/.test(s));
  // BACKSTORY line for evolving threads — a short "here's how it started" recap so a
  // returning viewer connects the update to the arc. Placed after the headline, before
  // the latest development. Only in single/long-form (roundup has no room).
  if ((SINGLE || LONGFORM) && story.backstory) {
    const lead = cfg.scriptLang === 'hi' ? `पृष्ठभूमि: ${story.backstory}` : `The background: ${story.backstory}`;
    out.push(lead);
  }
  if (LONGFORM) {
    // Long-form (16:9): 2-3 COMPLETE sentences per story (the higher-RPM format).
    out.push(...pickWholeSentences(sents, { maxSentences: 3, maxWords: 55 }));
  } else if (SINGLE) {
    // Single-story Short: it's the ONLY story, so give real depth — up to 4 COMPLETE
    // sentences within a word budget to fill ~30-45s and land the payoff.
    out.push(...pickWholeSentences(sents, { maxSentences: 4, maxWords: 75 }));
  } else {
    // 5-story roundup: budget ~9-10s/story so 5 land under 60s. Headline is the star;
    // add ONE short COMPLETE context sentence only when the title is brief.
    if (title.length < 70) {
      const [ctx] = pickWholeSentences(sents, { maxSentences: 1, maxWords: 28 });
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
    // PACE: faceless-news Shorts retain best at ~160-175 WPM. Measured end-to-end on
    // this build (per-sentence synth adds slight padding vs raw text): 1.22× ≈ 162 WPM
    // real (brisk energetic broadcast) — 1.02× read as sluggish (~150). Hindi Kokoro is
    // denser/needs more clarity, so run it a hair slower. Env-overridable per run.
    speed: Number(process.env.SHORTS_TTS_SPEED || (cfg.lang === 'h' ? 1.14 : 1.22)),
    // Tighter inter-sentence breath so the delivery feels punchy, not plodding (was
    // 0.32s → felt slow between lines). ~0.18s keeps sentences distinct without dead air.
    gap: Number(process.env.SHORTS_TTS_GAP || 0.18),
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
    if (!files.length) return null;
    // Prefer the high-energy BEAT bed (US/UK Shorts style) — SHORTS_MUSIC overrides,
    // else a filename containing 'beat', else the first track.
    const want = process.env.SHORTS_MUSIC;
    const pick =
      (want && files.find((f) => f === want)) ||
      files.find((f) => /beat|energ/i.test(f)) ||
      files.sort()[0];
    return join(MUSIC_DIR, pick);
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
    const hookText = hookLine(cfg, stories.length, stories[0]);
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
        const sg = hookTiming.segments[j];
        hcaps.push(...(await buildKaraokeCaptions(sg.text, sg.start, sg.end, `hook-${j}`, cfg, join(work, 'hook'))));
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

      // MULTI-IMAGE: show ~1 image every 5s of the story, sequenced + crossfaded, so the
      // clip is a lively photo SEQUENCE, not one static frame (user: "at least 5-10
      // images for a 50s video"). Uses the story's OWN article photos first (harvested in
      // enrichSummary), then tops up with category stock. SINGLE stories get more images
      // (the whole video is one story) than a 10-up roundup where each story is brief.
      const perImgSec = Number(process.env.SHORTS_SEC_PER_IMG || (SINGLE ? 5 : 7));
      const imgCap = SINGLE ? 10 : 4;
      const imgCount = Math.max(SINGLE ? 5 : 1, Math.min(imgCap, Math.round(timing.duration / perImgSec)));
      const bg = await resolveBackgrounds(story, join(work, `s${i}`), seenImages, imgCount);
      const chrome = await buildChrome(story, cfg, join(work, `s${i}`));
      const captions = [];
      for (let j = 0; j < timing.segments.length; j++) {
        const sg = timing.segments[j];
        captions.push(...(await buildKaraokeCaptions(sg.text, sg.start, sg.end, `${i}-${j}`, cfg, join(work, `s${i}`))));
      }
      const clip = join(work, `clip-${i}.mp4`);
      await renderSegment({
        bgPaths: bg.paths,
        chromePath: chrome,
        captions,
        narrationWav: join(work, `nar-${i}.wav`),
        dur: timing.duration,
        outPath: clip,
      });
      segmentPaths.push(clip);
      console.log(`[shorts:${cfg.id}]   ✓ story ${i + 1} clip (${timing.duration.toFixed(1)}s, ${bg.paths.length} imgs: ${bg.kinds.join('+')})`);
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
        const sg = oTiming.segments[j];
        ocaps.push(...(await buildKaraokeCaptions(sg.text, sg.start, sg.end, `outro-${j}`, cfg, join(work, 'outro'))));
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

// Outlet names for "Reported by:" — the world feed gives string sources, the India feed
// gives {name,url} objects. Normalize both to a clean, de-duped list of names (avoids
// "Reported by: [object Object]").
function sourceLabels(sources) {
  return [
    ...new Set(
      (sources || [])
        .map((s) => (typeof s === 'string' ? s : s && (s.name || s.sourceName)) || '')
        .map((s) => String(s).trim())
        .filter(Boolean),
    ),
  ];
}

function buildUploadMeta(stories, cfg, dur) {
  const isWorld = cfg.id === 'world';
  const n = stories.length;
  const lead = stories[0];
  // UTC date label (Date is unavailable in workflow scripts but this runs in Node/CI).
  const date = new Date().toISOString().slice(0, 10);

  // TITLE — hooky, front-loaded, emoji, under YouTube's 100-char cap. Format-aware:
  // a SINGLE story gets a punchy standalone headline (no "Top 5" — there's one story);
  // a roundup gets the "Top N" framing. Shorts append #Shorts; long-form must NOT.
  const flag = isWorld ? '🌍' : '🇮🇳';
  const shortsSuffix = LONGFORM ? '' : ' #Shorts';
  let suffix;
  if (SINGLE) {
    // Standalone: a light category/urgency tag + #Shorts, no roundup framing.
    const tag = (lead.badge || lead.category || 'News').toString().toUpperCase();
    suffix = isWorld ? ` | ${tag}${shortsSuffix}` : ` | ${tag}${shortsSuffix}`;
  } else if (isWorld) {
    suffix = LONGFORM ? ` | Top ${n} World News Today (${date})` : ` | Top ${n} World News${shortsSuffix}`;
  } else {
    suffix = LONGFORM ? ` | आज की टॉप ${n} खबरें (${date})` : ` | आज की टॉप खबरें${shortsSuffix}`;
  }
  const budget = 99 - flag.length - 1 - suffix.length;
  let leadT = lead.title;
  if (leadT.length > budget) leadT = `${leadT.slice(0, Math.max(0, budget - 1)).replace(/\s+\S*$/, '')}…`;
  const title = `${flag} ${leadT}${suffix}`.slice(0, 99);

  // DESCRIPTION — hook + numbered stories WITH source + timestamps-ready + CTA links +
  // subscribe + hashtags. First 2 lines matter most (shown above the fold / in search).
  const sub = isWorld
    ? 'https://www.youtube.com/@AgyataWorld?sub_confirmation=1'
    : 'https://www.youtube.com/@agyata_dot_com?sub_confirmation=1';
  const leadSources = sourceLabels(lead.sources);
  const reportedByLabel = isWorld ? 'Reported by' : 'स्रोत';
  const hook = SINGLE
    ? // Single story: lead the description with the story's own synthesized summary +
      // the outlets that reported it — a genuinely informative blurb, not boilerplate.
      `${lead.summary || lead.title}${leadSources.length ? `\n\n${reportedByLabel}: ${leadSources.slice(0, 5).join(', ')}.` : ''}`
    : isWorld
      ? `The ${n} biggest world news stories today, ${date} — fast, neutral, sourced. Politics, breaking, business, tech, entertainment, sports & science in one quick recap.`
      : `आज की ${n} सबसे बड़ी खबरें (${date}) — तेज़, निष्पक्ष और भरोसेमंद। राजनीति, बिज़नेस, मनोरंजन, खेल और टेक — एक साथ।`;
  const storyList = SINGLE ? [] : stories.map((s, i) => `${i + 1}. ${s.title}${s.sourceName ? ` — ${s.sourceName}` : ''}`);
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
    ...(storyList.length ? [isWorld ? '🗞️ In this recap:' : '🗞️ इस बुलेटिन में:', ...storyList, ''] : []),
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
