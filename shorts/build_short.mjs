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
import { wordTimings } from './word_timing.mjs';
import { planShots } from './plan_shots.mjs';
// EN→HI via the offline m2m100 model (translate_hi.py) — see translateHindi() below.
import { buildWorldRoundup, buildTrendingStories, buildXTrendingStories, looksNonEnglish } from './world_feeds.mjs';
import { gatherNativeSources } from './native_feeds.mjs';
// Durable "already made a video of this story?" ledger (Upstash Redis) — separate from the
// website's CF news_dedup_claims. Locks a published story until it has a genuine update.
import {
  filterAlreadyMade,
  ledgerRecords,
  recentTopics,
  deprioritizeRecentTopics,
} from './video_ledger.mjs';

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

// ── REGION alternation (World channel) ──────────────────────────────────────
// User: "always create alternate with USA and Europe all countries" + "Europe-related
// long/short news → Europe playlist only" (and USA → USA playlist). Each RUN targets ONE
// region: a USA run pulls United-States trends; a Europe run rotates across European
// countries so "all countries" get covered over the hour. The region is decided upstream
// by the cron-pinger and passed in via WORLD_REGION (usa|europe); it also decides which
// YouTube playlist the upload joins. If unset (a manual run), we fall back to a wall-clock
// alternation so ad-hoc renders still alternate sensibly.
const US_GEOS = (process.env.WORLD_US_GEOS || 'US').split(',').map((g) => g.trim()).filter(Boolean);
// English-native geos only: the World channel is English-only now (no translation), so the
// "Europe" region pulls ENGLISH-language European sources (UK/Ireland). Non-English European
// countries (DE/FR/IT/ES/NL) are served by their own dedicated per-language channels instead.
const EU_GEOS = (process.env.WORLD_EU_GEOS || 'GB,IE').split(',').map((g) => g.trim()).filter(Boolean);
function resolveRegion() {
  const r = (process.env.WORLD_REGION || '').toLowerCase().trim();
  if (r === 'usa' || r === 'us') return 'usa';
  if (r === 'europe' || r === 'eu') return 'europe';
  // Fallback for manual runs: alternate by the 30-min half of the clock.
  return new Date().getUTCMinutes() < 30 ? 'usa' : 'europe';
}
// Geos to fetch trends from for a region. Europe rotates its country list by the clock so
// successive Europe runs lead with a DIFFERENT country (covering "all countries" across
// the hour) while each run only queries a light fan-out.
function regionGeos(region) {
  if (region === 'usa') return US_GEOS;
  const rot = Math.floor(new Date().getUTCMinutes() / 15) % EU_GEOS.length;
  const rotated = [...EU_GEOS.slice(rot), ...EU_GEOS.slice(0, rot)];
  return rotated.slice(0, Number(process.env.WORLD_EU_FANOUT || 3));
}

// ── Cross-run DEDUP claim ────────────────────────────────────────────────────
// User (emphatic): in one hour we render 4 Shorts + 2 long-form, and "no news should
// duplicate". Those are SEPARATE, OVERLAPPING GitHub runs with no shared memory, so
// in-process dedup can't stop two runs picking the same hot story. Before rendering we
// CLAIM each candidate's normalized key against a durable D1 ledger (POST
// /news/dedup/claim, token-guarded): the ledger grants a key to exactly ONE run within
// the window and reports the rest as taken. We render only the granted stories. The
// claim is best-effort — if the API is unreachable we fall back to the local pick rather
// than ship nothing (a rare duplicate beats an empty channel), and log loudly.
// Extra candidates fetched beyond STORY_COUNT so a claimed-away lead has fallbacks.
const CLAIM_BUFFER = Number(process.env.SHORTS_CLAIM_BUFFER || (LONGFORM ? 8 : 5));
const CLAIM_WINDOW_H = Number(process.env.SHORTS_CLAIM_WINDOW_H || 2);
const INGEST_TOKEN = process.env.NEWS_INGEST_TOKEN || '';
async function claimStories(candidates, want, stamp) {
  // Key each candidate the SAME way mergeByTitle dedups within a run, so cross-run and
  // in-run dedup agree. Keep a candidate→key map to filter by the grant result.
  const keyed = candidates.map((s) => ({ s, key: normKey(s.title) })).filter((x) => x.key);
  if (!keyed.length) return candidates.slice(0, want);
  // LONG-FORM is a RECAP (user: "long form is generating less than 3 min"): it SHOULD be
  // allowed to revisit the day's biggest stories even if a Short already covered them —
  // that's what a recap is. The shared claim ledger was starving it (18 gathered → only 4
  // granted → 114s video) because the 15-min Shorts consume the hot keys first. So a
  // long-form run does NOT consult the ledger: it dedups only WITHIN its own set (already
  // done by mergeByTitle upstream) and renders the full STORY_COUNT. Override with
  // SHORTS_LONGFORM_CLAIM=1 to restore the old cross-run behaviour.
  if (LONGFORM && process.env.SHORTS_LONGFORM_CLAIM !== '1') {
    console.log(`[shorts] long-form recap — skipping cross-run claim, keeping top ${want} (recap may revisit Short stories by design)`);
    return candidates.slice(0, want);
  }
  if (!INGEST_TOKEN) {
    console.log('[shorts] NEWS_INGEST_TOKEN unset — skipping cross-run dedup claim (local pick only)');
    return candidates.slice(0, want);
  }
  const keys = [...new Set(keyed.map((x) => x.key))];
  let granted = null;
  try {
    const r = await fetch(`${API_BASE}/news/dedup/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}`, 'user-agent': UA },
      body: JSON.stringify({ keys, runId: stamp, windowHours: CLAIM_WINDOW_H }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`claim ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    granted = new Set(j.granted || []);
    console.log(`[shorts] dedup: requested ${keys.length} keys, granted ${granted.size}, taken ${(j.taken || []).length}`);
  } catch (e) {
    console.log(`[shorts] dedup claim failed (${e.message}) — proceeding with local pick`);
    return candidates.slice(0, want);
  }
  // Keep candidates whose key was granted to THIS run, in original (hotness) order — but at
  // most ONE story per key, so a run that gathered two same-key variants (bundle path) can't
  // render both even if the key was granted (the intra-video-dup guard at the claim layer).
  const usedKeys = new Set();
  const kept = [];
  for (const x of keyed) {
    if (!granted.has(x.key) || usedKeys.has(x.key)) continue;
    usedKeys.add(x.key);
    kept.push(x.s);
  }
  return kept.slice(0, want);
}

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
// CJK-SAFE (native channels): the old `[^a-z0-9 ]` strip wiped every char of a space-less
// non-Latin title (Japanese/Chinese) → EMPTY key → mergeByTitle/dedupeByTitle/claimStories
// all treat "" as skip → ALL Japanese stories silently dropped. Keep Unicode letters/numbers;
// when there are no ≥4-char Latin words to key on, fall back to the first 16 chars so the
// story still gets a stable near-exact key instead of vanishing. Mirrors world_feeds normTitle.
function normKey(t) {
  const norm = String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const key = norm.split(' ').filter((w) => w.length > 3).sort().slice(0, 8).join(' ');
  return key || norm.replace(/\s+/g, '').slice(0, 16);
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

// Significant-word token SET for a title (words > 3 chars, lowercased) — the basis for both
// the exact key and the fuzzy overlap check below.
function titleTokenSet(t) {
  return new Set(
    String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 3),
  );
}
// Jaccard overlap between two token sets (|∩| / |∪|), 0..1.
function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// Collapse one list to a single story per event, keeping the FIRST (highest-ranked)
// occurrence. The last-line-of-defence against "the same story appeared twice in one video":
// the research-bundle path skips mergeByTitle, and two trend sources can surface the same
// event with slightly different wording. Two passes:
//   1. EXACT normalized-title key (fast, catches punctuation/word-order variants).
//   2. FUZZY token overlap ≥ SAME_STORY_OVERLAP against stories already kept — catches
//      near-dups that share most significant words but differ by a token or two ("Powerball
//      jackpot climbs to $1.2B after no winner" vs "No winner: Powerball jackpot climbs to
//      $1.2B"). Threshold is high (0.7) so genuinely distinct stories are never merged.
// Applied at the candidate chokepoint in main() so it protects EVERY gather path. Preserves order.
const SAME_STORY_OVERLAP = Number(process.env.SHORTS_SAME_STORY_OVERLAP || 0.7);
function dedupeByTitle(stories) {
  const seenKeys = new Set();
  const keptSets = [];
  const out = [];
  for (const s of stories || []) {
    const k = normKey(s?.title);
    if (!k || seenKeys.has(k)) continue; // pass 1: exact
    const set = titleTokenSet(s?.title);
    if (keptSets.some((prev) => tokenOverlap(set, prev) >= SAME_STORY_OVERLAP)) continue; // pass 2: fuzzy
    seenKeys.add(k);
    keptSets.push(set);
    out.push(s);
  }
  return out;
}

// ── DEDICATED RESEARCH POOL (docs/research/world-<region>.json) ──────────────
// The research-world.yml workflow does the SLOW, deep work on its own timeout-free
// schedule (trend discovery → multi-outlet extract → LLM synth → verify) and commits a
// rich category bundle. The render just READS the freshest bundle and turns it into video
// — fast + reliable, no live-gather flakiness on the render's clock. Falls back to a live
// gather (below) only when no fresh bundle exists (user: dedicated research pool).
const RESEARCH_BUNDLE_MAX_AGE_H = Number(process.env.RESEARCH_BUNDLE_MAX_AGE_H || 4);
async function loadResearchBundle(region) {
  const path = join(process.cwd(), 'docs', 'research', `world-${region}.json`);
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null; // no bundle yet → live gather
  }
  const stories = Array.isArray(bundle.stories) ? bundle.stories.filter((s) => s && s.title && s.summary) : [];
  if (!stories.length) return null;
  // Freshness: a stale bundle would ship yesterday's news. If the pool hasn't run recently
  // enough, ignore it and gather live so the channel never goes stale.
  const gen = Date.parse(bundle.generatedAt || '');
  const ageH = Number.isFinite(gen) ? (Date.now() - gen) / 3.6e6 : Infinity;
  if (ageH > RESEARCH_BUNDLE_MAX_AGE_H) {
    console.log(`[shorts:world] research bundle for ${region} is ${ageH.toFixed(1)}h old (> ${RESEARCH_BUNDLE_MAX_AGE_H}h) — gathering live instead`);
    return null;
  }
  console.log(`[shorts:world] using research bundle ${region} (${stories.length} stories, ${ageH.toFixed(1)}h old, ${stories.filter((s) => s.verified).length} corroborated)`);
  return stories;
}

// Keep ONLY stories that are already ENGLISH — the World channel is English-native and we
// NO LONGER translate foreign text onto it (user: "short-world/longform will pick english
// only content"). Non-English source stories (DE/FR/IT/ES/NL/CJK/…) are DROPPED here; the
// dedicated per-language channels (short-FR/IT/ES etc.) produce native clips for those.
// looksNonEnglish covers Latin-script foreign languages AND every non-Latin script, so a
// foreign clip can never reach the English channel. Pure filter, no LLM cost.
function keepEnglish(stories) {
  const out = [];
  let dropped = 0;
  for (const s of stories || []) {
    if (looksNonEnglish(s?.title) || looksNonEnglish(s?.summary)) dropped++;
    else out.push(s);
  }
  if (dropped) console.log(`[shorts:world] english-guard dropped ${dropped} foreign stor${dropped === 1 ? 'y' : 'ies'} (no translation on the English channel)`);
  return out;
}

async function gatherStories(cfg) {
  if (cfg.id === 'world') {
    // Dedicated world/US-UK 9-slot roundup — NOT the India feed. Long-form pulls 2 per
    // slot; Shorts pull 1 per slot. The roundup is round-robin ordered (one per category
    // first) so slice(0, N) always spans ALL categories (politics…sports…science…).
    const perSlot = LONGFORM ? 2 : 1;
    // REGION for this run (usa | europe): decides which trend geos we pull from, so a USA
    // run leads with a US trend and a Europe run leads with a European one. The trend
    // sources are the region signal (the editorial roundup stays global as a backstop).
    const region = resolveRegion();
    const geos = regionGeos(region);
    console.log(`[shorts:world] region=${region} geos=${geos.join(',')}`);

    // FIRST CHOICE: the dedicated research pool's freshest bundle for this region. It's
    // already trend-ranked + multi-source-enriched + verified, so we can hand it straight
    // to the cross-run claim + render. SHORTS_RESEARCH_BUNDLE=0 forces a live gather.
    if (process.env.SHORTS_RESEARCH_BUNDLE !== '0') {
      const bundled = await loadResearchBundle(region);
      if (bundled && bundled.length) {
        // ENGLISH GUARD — the bundle is normally already English (research.mjs guards it),
        // but guard again here so an older bundle can't ship a foreign clip on this English
        // channel. Drops any story we can't confidently make English.
        const english = keepEnglish(bundled);
        const picked = english.slice(0, STORY_COUNT + CLAIM_BUFFER);
        picked.region = region;
        return picked;
      }
    }
    // Prefer FRESH news (18h window) so a 2-hourly channel feels current, not stale.
    // Enrich EVERY story — fetch the article body + LLM-synthesise a useful 2-3 sentence
    // brief (was gated to single/long-form, leaving the roundup thin → "content is very
    // less"). Applies to all formats now.
    const [round, gtrends, xtrends] = await Promise.all([
      buildWorldRoundup({
        maxAgeH: Number(process.env.WORLD_MAX_AGE_H || 18),
        perSlot,
        enrich: true,
      }),
      // GOOGLE TRENDS (region geos): what's actually being searched right now, resolved to
      // a real publisher article + the outlet's OWN og:image (never the gstatic thumbnail).
      // Adds genuine "trending now" stories the editorial slots miss. SINGLE mode pulls a
      // DEEPER pool per geo (many trends are thin/paywalled and get filtered) so there's a
      // real set to rank by heat and lead the Short with the hottest survivor.
      buildTrendingStories({ geos, perGeo: SINGLE ? 6 : LONGFORM ? 2 : 1, enrich: true }).catch(() => []),
      // X / TWITTER (region geos): what's trending on X right now (user: "latest trending
      // topics from X: Desktop"). Read from the live public X trend board, each hot term
      // resolved to its freshest matching publisher article (last 1h first, per the
      // trending mandate) + the outlet's OWN image — we never surface X posts/avatars
      // themselves (monetization/copyright). Off via WORLD_X_TRENDS=0. SINGLE mode probes
      // a deeper pool to find a lead-worthy survivor.
      process.env.WORLD_X_TRENDS === '0'
        ? Promise.resolve([])
        : buildXTrendingStories({ geos, perGeo: SINGLE ? 4 : LONGFORM ? 2 : 1, enrich: true }).catch(() => []),
    ]);
    // Merge the two live-buzz sources (X first — it's the freshest social pulse), deduped
    // by title so the SAME event trending on both X and Google Trends counts once.
    const trending = mergeByTitle(xtrends, gtrends);
    // MERGE — mode-aware ordering (fixes "why is it always Andy Burnham?": a single Short
    // was always merged[0] = the curated POLITICS slot #1, so trending stories never led):
    //   • SINGLE  → lead with the HOTTEST genuinely-trending story (X + Google Trends,
    //     ranked by heat). That's literally "what's trending right now" — the highest-
    //     retention pick, and it rotates every couple of hours so the channel isn't stuck
    //     on one topic. Curated stories back it up if the trend sources are unavailable.
    //   • LONGFORM/roundup → curated categories lead (so all 9 are covered), trends fill.
    const merged = SINGLE
      ? mergeByTitle(trending, round)
      : mergeByTitle(round, trending);
    // Return a CANDIDATE POOL (not just STORY_COUNT) so main() can claim keys against the
    // cross-run dedup ledger and fall back to the next-best story when the hottest was
    // already taken by an overlapping run. Buffer generously — trends churn fast.
    // ENGLISH GUARD — EU-geo trends can be German/French/Italian/etc.; translate to English
    // or drop (the "Italian title + garbled TTS" bug) before claim/render on this channel.
    const english = keepEnglish(merged);
    const picked = english.slice(0, STORY_COUNT + CLAIM_BUFFER);
    // Carry the run's region so main()/buildUploadMeta can tag meta.json → playlist.
    picked.region = region;
    return picked;
  }
  // NATIVE-LANGUAGE channels (de/nl/fr/jp/sv/no/da): the native mirror of the world gather.
  // Same three sources (native RSS roundup + native Google-Trends + native X-trends), same
  // SINGLE-leads-with-trend / roundup-leads-for-longform merge policy — but sourced + synthed
  // IN THE CHANNEL'S LANGUAGE (native_feeds), and with NO English guard (the whole point is
  // native content). No India feed, no translation.
  if (cfg.native) {
    const { round, gtrends, xtrends } = await gatherNativeSources(cfg.nativeLang, {
      perSlot: LONGFORM ? 2 : 1,
      perGeoTrends: SINGLE ? 6 : LONGFORM ? 2 : 1,
      perGeoX: SINGLE ? 4 : LONGFORM ? 2 : 1,
      maxAgeH: Number(process.env.WORLD_MAX_AGE_H || 18),
      xTrends: process.env.WORLD_X_TRENDS !== '0',
    });
    const trending = mergeByTitle(xtrends, gtrends);
    // SINGLE → lead with the hottest trend (highest retention); LONGFORM/roundup → curated
    // categories lead so all slots are covered, trends fill. Identical to the world policy.
    const merged = SINGLE ? mergeByTitle(trending, round) : mergeByTitle(round, trending);
    // Native channels have their OWN, non-overlapping playlists + audiences, so they don't
    // compete with world/bharat for the cross-run D1 claim; but two native runs of the SAME
    // language (a Short + a long-form in the same hour) still shouldn't dupe, so claimStories
    // in main() (keyed by normKey, now CJK-safe) still applies. Return the candidate pool.
    return merged.slice(0, STORY_COUNT + CLAIM_BUFFER);
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

// (Opening hook clip removed — the video starts directly on the first story now.)

// The closing CTA — SHORT + snappy (user: "outro should be small for subscribe for more").
// Just a quick "subscribe for more", no site URL recital, so the video ends cleanly.
function outroLine(cfg) {
  if (cfg.scriptLang === 'hi') return 'और खबरों के लिए Subscribe करें।';
  // Native channels: a short native "subscribe" from the channel's own subCta (already
  // written natively per language) so the spoken + on-screen outro matches the content.
  const NATIVE_OUTRO = {
    de: 'Abonnieren für mehr.', nl: 'Abonneer voor meer.', fr: 'Abonnez-vous pour plus.',
    ja: 'チャンネル登録お願いします。', sv: 'Prenumerera för mer.',
    no: 'Abonner for mer.', da: 'Abonner for mere.',
  };
  if (cfg.native) return NATIVE_OUTRO[cfg.scriptLang] || cfg.subCta || 'Subscribe.';
  return 'Subscribe for more.';
}

// Split a single spoken LINE into short clause chunks so Kokoro synthesises each in its
// own pass. A long one-shot generation DROPS its last few words (the "outro doesn't
// speak the last 3-5 words" bug — "…at agyata dot com" got cut). Stories never had this
// because they're already fed sentence-by-sentence; the hook + outro were passed whole.
// We break on sentence terminals AND clause boundaries (em-dash / comma), keeping each
// chunk a real fragment. Falls back to the whole line if it doesn't split.
function splitForTTS(line) {
  const clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = clean
    .split(/(?<=[.!?।])\s+|(?<=[。！？])\s*|\s+—\s+|\s+–\s+|,\s+(?=and\b|but\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.length ? chunks : [clean];
}

// Select COMPLETE sentences that fit a budget — NEVER truncate a sentence mid-word (the
// "every story ends with half a sentence" bug came from slicing a long sentence and
// tacking on "…"). We keep whole sentences up to `maxSentences` and a soft `maxWords`
// cap; a sentence that alone blows the word cap is dropped (not chopped) unless it's the
// only one — in which case we cut it back to its last COMPLETE clause (…, ; :) so the
// spoken line still ends cleanly rather than dangling.
function wordCount(s) {
  const str = String(s);
  // CJK (Japanese/Chinese) has no inter-word spaces, so a whitespace split counts a whole
  // sentence as ONE word and the maxWords budget goes inert. Approximate word count by
  // CJK-character span / 2 (Japanese averages ~2 chars per word) so the budget still bounds
  // clip length; add any interspersed Latin words (proper nouns/numbers) on top.
  const cjk = (str.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g) || []).length;
  if (cjk) {
    const latin = str.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjk / 2) + latin;
  }
  return str.split(/\s+/).filter(Boolean).length;
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
      const clauses = s.split(/(?<=[,;:—–])\s+|(?<=[、，；：])\s*/);
      let clip = '';
      for (const c of clauses) {
        if (wordCount(clip ? `${clip} ${c}` : c) > maxWords && clip) break;
        clip = clip ? `${clip} ${c}` : c;
      }
      // Drop a trailing dangling connector so it doesn't end on "and,"/"but,".
      clip = clip.replace(/[\s,;:—–]+$/, '').replace(/\s+(and|but|or|the|a|to|of|in|on|for|with)$/i, '');
      out.push(/[.!?।。！？]$/.test(clip) ? clip : `${clip}.`);
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
  // NARRATION vs ON-SCREEN TITLE (user: "TTS is saying first title and then description"):
  //   • SINGLE / LONG-FORM → the synthesised brief already leads with the headline fact,
  //     so speaking the raw wire title first just repeats it. Speak the brief DIRECTLY;
  //     the headline is shown persistently on screen instead (story.headline → buildChrome).
  //   • ROUNDUP (5-up) → each story gets ~9s, so the headline IS the content: keep it
  //     spoken (with at most one short context sentence).
  const out = SINGLE || LONGFORM ? [] : [title];
  // Split into sentences, keeping ONLY complete ones (must end in terminal punctuation)
  // — a trailing fragment with no terminal is dropped so narration never ends mid-thought.
  // CJK-aware: Japanese/Chinese end sentences with 。！？ and use NO trailing space, so we
  // split AFTER those (optional following space) as well as after Latin/Devanagari terminals.
  const sents = summary
    .split(/(?<=[.!?।])\s+|(?<=[。！？])\s*/)
    .map((s) => s.trim())
    .filter((s) => s && /[.!?।。！？]$/.test(s));
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
  const spoken = out.map((s) => s.trim()).filter(Boolean);
  // SAFETY: if the brief yielded no complete sentence (thin/paywalled source) and we
  // dropped the spoken title, fall back to speaking the headline so the clip isn't silent.
  if (!spoken.length) spoken.push(title);
  return spoken;
}

async function ttsForStory(sentences, cfg, work, id) {
  // TTS ENGINE dispatch. Kokoro speaks English/Hindi/French/Japanese (world/bharat/fr/jp);
  // the Piper channels (DE/NL/SV/NO/DA) go through piper_tts.py, which honours the EXACT
  // same job/output-JSON contract, so everything downstream (segments → word_timing →
  // captions) is engine-agnostic.
  const engine = cfg.ttsEngine || 'kokoro';
  const job = {
    chunks: sentences,
    lang: cfg.lang,
    voice: cfg.voice,
    espeakLang: cfg.espeakLang, // espeak-ng phonemization language
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
  const script = engine === 'piper' ? 'piper_tts.py' : 'kokoro_tts.py';
  await execFileP(PY, [join(process.cwd(), 'shorts', script), join(work, `tts-${id}.json`)], {
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
  const gathered = await gatherStories(cfg);
  if (!gathered.length) throw new Error('no usable stories found');
  // INTRA-VIDEO DEDUP (fixes "same story appeared twice in one video"): collapse candidates
  // sharing a normalized title BEFORE the ledger/claim, so one video never plays the same
  // event twice. Needed because the research-bundle path skips mergeByTitle and two trend
  // sources can carry the same event worded differently. Preserve the region tag.
  const candidates = dedupeByTitle(gathered);
  candidates.region = gathered.region;
  if (candidates.length < gathered.length) {
    console.log(`[shorts:${cfg.id}] intra-video dedup: ${gathered.length} → ${candidates.length} unique stories`);
  }
  // VIDEO-DEDUP: drop candidates we've ALREADY made a video of (durable Upstash ledger),
  // unless the story gained a genuine update since. Runs BEFORE the cross-run claim so we
  // don't spend claim slots on stories we'd skip anyway. Fail-open (never blanks the feed).
  const region0 = candidates.region;
  let pool = await filterAlreadyMade(candidates, { label: cfg.id });
  // TOPIC DIVERSITY: stories whose topic (football/politics/crime/…) aired in the last few
  // hours are pushed BEHIND fresh-topic ones so we don't post football after football after
  // football (user: "don't create same category/topic every run; maintain on Redis").
  // Re-order only — nothing dropped — so the channel never blanks if everything's on cooldown.
  const hotTopics = await recentTopics({ label: cfg.id });
  pool = deprioritizeRecentTopics(pool, hotTopics, { label: cfg.id });
  pool.region = region0;
  // CLAIM keys against the cross-run dedup ledger, then keep the first STORY_COUNT that
  // this run was granted — so 4 Shorts + 2 long-form in the same hour never share a story.
  const stories = await claimStories(pool, STORY_COUNT, stamp);
  stories.region = candidates.region; // preserve region across the claim filter
  if (!stories.length) throw new Error('no usable stories left after cross-run dedup claim');
  console.log(`[shorts:${cfg.id}] ${stories.length} stories:`);
  for (const s of stories) console.log(`   [${(s.badge || s.category || '').padEnd(13)}] ${s.title.slice(0, 60)}`);

  const work = join(WORK_DIR, cfg.id, stamp);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const segmentPaths = [];
  // Per-VIDEO image dedup: shared across the hook + every story so NO two segments use
  // the same photo (user: "always use a different image for different story").
  const seenImages = new Set();

  // NO INTRO CLIP — the video opens DIRECTLY on the first news story (user: "intro looks
  // bad now, delete that, directly start with the news"). The old branded hook title card
  // ("TODAY'S TOP / Here's the big story…") is gone; retention is better when the news
  // starts immediately rather than after a generic gradient card.

  // Render each story as its own clip.
  const rendered = []; // stories that actually produced a clip → recorded in the video ledger
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
      // Cap of DISTINCT photos per story. Stories now carry many real outlet photos (a big
      // event yields 20+), so allow a longer honest sequence — 1 image / perImgSec of narration,
      // bounded by how many the story actually has (resolveBackgrounds never pads with stock).
      const imgCap = Number(process.env.SHORTS_IMG_CAP || (SINGLE ? 16 : LONGFORM ? 6 : 4));
      const imgCount = Math.max(SINGLE ? 5 : 1, Math.min(imgCap, Math.round(timing.duration / perImgSec)));
      const bg = await resolveBackgrounds(story, join(work, `s${i}`), seenImages, imgCount);
      // Persistent on-screen headline (single/long-form): the viewer READS the title while
      // narration speaks only the brief — so the headline isn't lost by dropping it from
      // the spoken script. Roundup keeps the title spoken, so no on-screen headline there.
      const headline =
        SINGLE || LONGFORM
          ? String(story.title).replace(/\s+[–—|]\s+.*$/, '').replace(/\s+/g, ' ').trim()
          : '';
      const chrome = await buildChrome({ ...story, headline }, cfg, join(work, `s${i}`));
      const captions = [];
      for (let j = 0; j < timing.segments.length; j++) {
        const sg = timing.segments[j];
        captions.push(...(await buildKaraokeCaptions(sg.text, sg.start, sg.end, `${i}-${j}`, cfg, join(work, `s${i}`))));
      }
      // GAP 1 — image↔word sync: build the per-word timeline from the measured sentence
      // windows, then plan WHICH image is on screen WHEN so an entity photo appears the
      // moment its name is spoken (user: "right image at right time when it spells out on
      // TTS"). Falls back to even division when no entity name is spoken in this clip.
      const timeline = wordTimings(timing.segments);
      const shots = (bg.paths || []).map((p, k) => ({
        path: p,
        url: (bg.urls || [])[k] || null,
        kind: (bg.kinds || [])[k] || 'event',
      }));
      const bgWindows = planShots({
        shots,
        entityShots: story.entityShots || [],
        timeline,
        duration: timing.duration,
      });
      const clip = join(work, `clip-${i}.mp4`);
      await renderSegment({
        bgWindows,
        chromePath: chrome,
        captions,
        narrationWav: join(work, `nar-${i}.wav`),
        dur: timing.duration,
        outPath: clip,
      });
      segmentPaths.push(clip);
      rendered.push(story);
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
    // Split into clause chunks so Kokoro doesn't drop the last words (the CTA + site URL).
    const oTiming = await ttsForStory(splitForTTS(outroText), cfg, work, 'outro');
    if (oTiming.duration && oTiming.segments?.length) {
      const obg = await brandBackground(join(work, 'outro'));
      // FOLLOW badge, localized per channel (native channels get their own script's word).
      const FOLLOW_BADGE = {
        hi: 'देखते रहें', de: 'FOLGEN', nl: 'VOLG', fr: 'SUIVRE', ja: '登録',
        sv: 'FÖLJ', no: 'FØLG', da: 'FØLG',
      };
      const followBadge = FOLLOW_BADGE[cfg.scriptLang] || 'FOLLOW';
      const ochrome = await buildChrome(
        { hashtag: 'agyata', category: '', badge: followBadge },
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
  const meta = buildUploadMeta(stories, cfg, totalDur, stories.region);
  // Stash the {key, fp} records for the stories that ACTUALLY rendered, so upload.mjs marks
  // them in the video ledger only AFTER a successful upload (a failed upload never locks a
  // story). Keyed on normalized title + update-count fingerprint.
  meta.ledger = ledgerRecords(rendered.length ? rendered : stories);
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

// NATIVE-language upload metadata (de/nl/fr/jp/sv/no/da). All user-facing strings come from
// the channel config (label / ctaLine / subCta / hashtags) which are ALREADY written natively,
// plus the story's own native title + summary — so nothing here is English. Native channels are
// PLAYLISTS on @AgyataWorld, so they use the World subscribe link + go to `cfg.playlist`.
function buildNativeUploadMeta(stories, cfg, dur) {
  const n = stories.length;
  const lead = stories[0];
  const date = new Date().toISOString().slice(0, 10);
  const shortsSuffix = LONGFORM ? '' : ' #Shorts';
  const tag = String(lead.badge || lead.hashtag || '').replace(/^#/, '').toUpperCase();
  const suffix = SINGLE ? `${tag ? ` | ${tag}` : ''}${shortsSuffix}`
    : LONGFORM ? ` (${date})` : `${shortsSuffix}`;
  // Title: 🌐 + native lead headline + native tag, trimmed to YouTube's 100-char cap.
  const flag = '🌐';
  const budget = 99 - flag.length - 1 - suffix.length;
  let leadT = String(lead.title || '').replace(/\s+/g, ' ').trim();
  if (leadT.length > budget) leadT = `${leadT.slice(0, Math.max(0, budget - 1)).replace(/\s+\S*$/, '')}…`;
  const title = `${flag} ${leadT}${suffix}`.slice(0, 99);

  const sub = 'https://www.youtube.com/@AgyataWorld?sub_confirmation=1';
  // Hook = the native synthesized summary (SINGLE) or the native lead headline (roundup);
  // followed by native CTA + subscribe. Story list uses native titles + source names.
  const hook = SINGLE ? (lead.summary || lead.title) : leadT;
  const storyList = SINGLE ? [] : stories.map((s, i) => `${i + 1}. ${s.title}${s.sourceName ? ` — ${s.sourceName}` : ''}`);
  // Hashtag block: the channel's native tags + per-story category tags. cfg.hashtags already
  // carry '#'; category tags are appended bare-then-hashed.
  const catTags = [...new Set(stories.map((s) => (s.category || '').toLowerCase()).filter(Boolean))];
  const cfgTags = (cfg.hashtags || []).map((h) => h.replace(/^#/, ''));
  const hashtags = [...(LONGFORM ? cfgTags.filter((t) => t !== 'shorts') : cfgTags), ...catTags].slice(0, 15);
  const description = [
    hook,
    '',
    ...(storyList.length ? [...storyList, ''] : []),
    `📲 agyata.com`,
    `🔔 ${cfg.subCta}: ${sub}`,
    '',
    hashtags.map((h) => `#${h}`).join(' '),
  ].join('\n');

  return {
    channel: cfg.id,
    format: LONGFORM ? 'longform' : 'short',
    title,
    description: description.slice(0, 4900),
    tags: [...cfgTags, ...catTags, 'agyata'].filter(Boolean).slice(0, 20),
    categoryId: '25', // News & Politics
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    privacyStatus: process.env.SHORTS_PRIVACY || 'unlisted',
    durationSec: Math.round(dur),
    storyCount: n,
    uploadSecret: cfg.uploadSecret, // YT_REFRESH_TOKEN_WORLD (all native on @AgyataWorld)
    // Native channels go to a per-language playlist (DE/NL/FR/JP/SV/NO/DA) by NAME, resolved
    // in upload.mjs against the @AgyataWorld playlists. No region (that's the World USA/EU split).
    playlist: cfg.playlist || null,
    lang: cfg.scriptLang,
  };
}

function buildUploadMeta(stories, cfg, dur, region) {
  if (cfg.native) return buildNativeUploadMeta(stories, cfg, dur);
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
    // REGION (usa | europe) → upload.mjs adds the video to that region's YouTube playlist
    // (user: "Europe-related long/short news → Europe playlist only"). null for bharat.
    region: isWorld ? region || null : null,
  };
}

main().catch((e) => {
  console.error(`[shorts] FAILED: ${e.message}`);
  process.exit(1);
});
