#!/usr/bin/env node
// REVIEW pipeline — the gold-standard editorial gate between synth and D1.
// Nothing publishes until it clears EVERY gate. Modeled on how real newsrooms
// filter (Google SOURCERANK+Prominence, BBC editorial standards, Reuters Tracer
// verification). Order = cheap→expensive so most rejects cost nothing:
//
//   Layer A  ALGORITHMIC GATES (gates.mjs, per candidate):
//     structure · spam/PR · clickbait · gossip · opinion · superlative ·
//     safety/sensitive · staleness · language-quality · fact-shape
//   Layer B  DEDUP — vs already-published (live API) AND in-batch (isSameStory)
//   Layer C  UPDATES — same-event as a published story → append update (reuse
//            hashtag), does NOT spawn a new story
//   Layer D  LLM FACT-CONSISTENCY VERIFIER (pipeline.verifyFaithful) — 2nd LLM
//            pass, only on survivors: rejects hallucinated/unfaithful synthesis
//   Layer E  SELECTIVE PUBLISH BAR — a NEW story needs importance>=PUBLISH_MIN
//            AND corroboration>=PUBLISH_MIN_CORROBORATION (Google significance
//            gate). Turns "100 synthesised" into ~15-30 genuinely significant.
//
// Only survivors POST to the ingest endpoint.

import { buildCandidates, toIngestBody, verifyFaithful, isSameStory, healthCheck } from './pipeline.mjs';
import { runGates } from './gates.mjs';

const INGEST_URL = process.env.INGEST_URL || '';
const INGEST_TOKEN = process.env.NEWS_INGEST_TOKEN || '';
const STORIES_URL = process.env.STORIES_URL || INGEST_URL.replace(/\/ingest$/, '/stories');
// Objective significance floor — the PRIMARY publish signal (score = source-rank
// + freshness + corroboration×3). ~11 = a fresh mid-rank story with 1 corroborator
// or a top desk alone; well-corroborated events score much higher. Tune per feed.
const PUBLISH_MIN_SCORE = Number(process.env.PUBLISH_MIN_SCORE || 11);
const PUBLISH_MIN_IMPORTANCE = Number(process.env.PUBLISH_MIN_IMPORTANCE || 4); // kept for scoop override + logging
const PUBLISH_MIN_CORROBORATION = Number(process.env.PUBLISH_MIN_CORROBORATION || 2);
// A single-source SCOOP this important publishes even at corr=1 (GDELT primary
// may surface a major event from one outlet first). Set to 6 to disable.
const PUBLISH_SOLO_IMPORTANCE = Number(process.env.PUBLISH_SOLO_IMPORTANCE || 5);
const MAX_AGE_H = Number(process.env.MAX_AGE_H || 36);
// Trending/buzz items stay fresh longer — a live search trend is current even when
// its anchor article is a day or two old. Prevents the 24h clock from dropping
// genuinely-trending stories (see buzz cron staleness leak).
const MAX_AGE_H_BUZZ = Number(process.env.MAX_AGE_H_BUZZ || 72);
// Fact-verifier ON by default but BUDGET-CAPPED (see Layer E): it verifies the
// highest-scored survivors until VERIFY_BUDGET_MS is spent, then lets the rest
// publish unverified (still guarded by gFactShape). This gives the anti-
// hallucination check on the stories that matter most without the timeout risk of
// verifying all. Set VERIFY_FAITHFUL=0 to disable entirely.
const VERIFY = process.env.VERIFY_FAITHFUL !== '0';
const VERIFY_BUDGET_MS = Number(process.env.VERIFY_BUDGET_MS || 4 * 60 * 1000); // ~4 min of verify total
// Only verify when the source snippet is long enough to check against. A thin
// snippet (a slug/headline) lacks the article's entities, so the verifier would
// falsely flag accurate synthesis as "introducing new names". Below this, we trust
// the synthesis (gFactShape still guards invented numbers).
const VERIFY_MIN_SOURCE = Number(process.env.VERIFY_MIN_SOURCE || 160);
if (!INGEST_URL || !INGEST_TOKEN) { console.error('missing INGEST_URL / NEWS_INGEST_TOKEN'); process.exit(1); }

async function fetchPublished() {
  const out = [];
  try {
    for (const mode of ['latest', 'updated']) {
      const r = await fetch(`${STORIES_URL}?mode=${mode}&limit=50`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const s of j.items || []) out.push({ hashtag: s.hashtag, title: s.title });
    }
  } catch (e) { console.log('warn: dedup reference fetch failed:', e.message); }
  const seen = new Set();
  return out.filter((s) => (seen.has(s.hashtag) ? false : (seen.add(s.hashtag), true)));
}

async function post(body) {
  try {
    const r = await fetch(INGEST_URL, { method: 'POST', headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    // Surface WHY a publish failed (was silent → stories vanished with no clue).
    // Never log the response body/headers (avoid leaking anything token-adjacent).
    if (!r.ok) console.log(`  ! ingest ${r.status} for #${body.hashtag}`);
    return r.ok;
  } catch (e) { console.log(`  ! ingest error for #${body.hashtag}: ${e.message}`); return false; }
}

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

async function main() {
  const nowMs = Date.now();
  // FAIL-FAST: verify the model answers before doing any work. A broken model/
  // endpoint now fails in seconds with a clear message, instead of the loop
  // hanging until GitHub's 30-min timeout cancels the job (the old failure mode).
  const h = await healthCheck();
  console.log(`model health: ok=${h.ok} ${h.ms}ms ${h.error ? 'error=' + h.error : 'sample=' + JSON.stringify(h.sample)}`);
  if (!h.ok) { console.error('model unhealthy — aborting before synth'); process.exit(1); }

  const candidates = await buildCandidates();
  const published = await fetchPublished();
  console.log(`review: ${candidates.length} candidates, ${published.length} already-published for dedup`);

  const acceptedTitles = [];
  let newStory = 0, updated = 0, rejected = 0, batchDup = 0, verifyFail = 0, heldBar = 0, catCapped = 0;
  const reasons = {};
  // FRONT-PAGE DIVERSITY: no single category may exceed CAT_CAP_FRACTION of NEW
  // stories, so one hot topic (politics, or GDELT's 'top' bucket) can't swamp the
  // feed. Candidates are score-sorted, so the best of each category lands first.
  // Cap applies only to NEW stories (updates to live threads always go through).
  const CAT_CAP_FRACTION = Number(process.env.CAT_CAP_FRACTION || 0.4);
  const CAT_CAP_MIN = Number(process.env.CAT_CAP_MIN || 6); // don't cap tiny runs
  const catCount = {};
  const srcCount = {}; // published-by-source (gdelt-doc/gdelt-gkg/rss) for quality A/B
  const verifyStart = Date.now(); // verify budget clock starts at the review loop

  for (const c of candidates) {
    // Layer A — algorithmic gates. BUZZ/trending items get a longer stale window:
    // a topic people are searching RIGHT NOW is fresh even if Google News anchors it
    // to a 1-2 day-old article — the 24h clock was wrongly dropping live trends
    // (iPhone launch, Sensex, FIFA). MAX_AGE_H_BUZZ (default 72h) for via='buzz'.
    const maxAgeH = c.article?.via === 'buzz' ? MAX_AGE_H_BUZZ : MAX_AGE_H;
    const g = runGates(c, { nowMs, maxAgeH });
    if (g) { rejected++; bump(reasons, g.gate + ':' + g.reason); console.log(`  ✗ ${g.gate} [${g.reason}] ${(c.title || '').slice(0, 46)}`); continue; }

    // Layer B — in-batch dedup.
    if (acceptedTitles.some((t) => isSameStory(c.title, t))) { batchDup++; console.log(`  ⊘ batch-dup ${c.title.slice(0, 46)}`); continue; }

    // Layer C — is this an update to an already-published story?
    const match = published.find((p) => isSameStory(c.title, p.title));

    // Layer D — SELECTIVE PUBLISH BAR, keyed on the OBJECTIVE SIGNIFICANCE SCORE,
    // not the 3B model's importance guess. Rationale (quality review): the score
    // = source-rank + freshness + corroboration×3 is our most RELIABLE signal;
    // the LLM importance is noisy (a 3B clusters everything at 3-4). So the gate
    // is: significance score >= PUBLISH_MIN_SCORE, with corroboration as the spine.
    // A NEW story publishes if EITHER:
    //   • it clears the score bar AND has ≥2 corroborating outlets (the norm), OR
    //   • it's a strong single-source SCOOP: high objective score AND the model
    //     flags it important (PUBLISH_SOLO_IMPORTANCE) — so a real exclusive isn't
    //     suppressed just for lacking a second outlet yet.
    // Updates to a live thread always bypass the bar (developments are welcome).
    const score = Number(c.score) || 0;
    const meetsScore = score >= PUBLISH_MIN_SCORE;
    const corroborated = c.corr >= PUBLISH_MIN_CORROBORATION;
    const scoop = c.corr < PUBLISH_MIN_CORROBORATION && c.importance >= PUBLISH_SOLO_IMPORTANCE && score >= PUBLISH_MIN_SCORE - 2;
    if (!match && !((meetsScore && corroborated) || scoop)) {
      heldBar++; bump(reasons, 'below_publish_bar');
      console.log(`  ▽ hold [score${score.toFixed(0)}<${PUBLISH_MIN_SCORE} | corr${c.corr}<${PUBLISH_MIN_CORROBORATION} | imp${c.importance}] ${c.title.slice(0, 40)}`);
      continue;
    }

    // FRONT-PAGE DIVERSITY CAP — a NEW story in an already-saturated category is
    // held so one topic can't dominate. Skipped for updates + small runs.
    if (!match) {
      const cat = c.category || 'top';
      const publishedNew = newStory; // NEW stories accepted so far
      const cap = Math.max(CAT_CAP_MIN, Math.ceil((publishedNew + 1) * CAT_CAP_FRACTION));
      if ((catCount[cat] || 0) >= cap && publishedNew >= CAT_CAP_MIN) {
        catCapped++; bump(reasons, 'category_cap:' + cat);
        console.log(`  ▤ cap [${cat} ${catCount[cat]}>=${cap}] ${c.title.slice(0, 40)}`);
        continue;
      }
    }

    // Layer E — LLM fact-consistency verifier (anti-hallucination). BUDGET-AWARE +
    // ONLY WHEN THE SOURCE IS SUBSTANTIAL. Critical fix: the verifier compares the
    // synthesis to the source SNIPPET. For GKG / thin-snippet articles the snippet
    // is often just the (slug-derived) title, so it lacks the real entities — and
    // the verifier then FALSELY rejects an ACCURATE story ("introduces Shashi
    // Tharoor / Yogi Adityanath not in source") simply because the thin source text
    // never contained them. That was dropping good stories. So: skip verification
    // unless the source snippet is long enough to meaningfully verify against
    // (VERIFY_MIN_SOURCE chars) AND materially longer than the title. Invented
    // NUMBERS are still caught by the algorithmic gFactShape regardless.
    const srcLen = (c.article?.snippet || '').trim().length;
    const titleLen = (c.title || '').length;
    const verifiable = srcLen >= VERIFY_MIN_SOURCE && srcLen > titleLen + 40;
    if (VERIFY && verifiable && Date.now() - verifyStart < VERIFY_BUDGET_MS) {
      const v = await verifyFaithful(c);
      if (v && (!v.faithful || !v.sameEvent)) { verifyFail++; bump(reasons, 'verify:' + (!v.faithful ? 'unfaithful' : 'diff_event')); console.log(`  ✗ verify [${v.reason}] ${c.title.slice(0, 42)}`); continue; }
    }

    const body = toIngestBody(c);
    if (match) {
      body.hashtag = match.hashtag;
      if (await post(body)) { updated++; acceptedTitles.push(c.title); console.log(`  ↑ update #${match.hashtag} ← ${c.title.slice(0, 44)}`); }
      continue;
    }
    if (await post(body)) { newStory++; catCount[c.category || 'top'] = (catCount[c.category || 'top'] || 0) + 1; const via = c.article?.via || 'rss'; srcCount[via] = (srcCount[via] || 0) + 1; acceptedTitles.push(c.title); console.log(`  ✓ new [${c.category}] via=${via} score${(Number(c.score)||0).toFixed(0)} corr${c.corr} imp${c.importance} #${c.hashtag} ${c.title.slice(0, 34)}`); }
  }

  console.log(`\nREVIEW DONE candidates=${candidates.length} → new=${newStory} updated=${updated} | rejected=${rejected} verifyFail=${verifyFail} batchDup=${batchDup} heldBar=${heldBar} catCapped=${catCapped}`);
  console.log('  published by category:', JSON.stringify(catCount));
  console.log('  published by source:', JSON.stringify(srcCount), `(SOURCE_MODE=${process.env.SOURCE_MODE || 'both'})`);
  console.log(`  publish bar: score>=${PUBLISH_MIN_SCORE} AND corroboration>=${PUBLISH_MIN_CORROBORATION} (or scoop: imp>=${PUBLISH_SOLO_IMPORTANCE}); verifier=${VERIFY ? `on (budget ${(VERIFY_BUDGET_MS / 60000).toFixed(0)}m)` : 'off'}`);
  console.log('  reject reasons:', JSON.stringify(reasons));

  // FAIL LOUD on total failure: if we HAD candidates but published nothing (all
  // posts errored, e.g. bad token / ingest down), exit non-zero so the run shows
  // RED instead of a green "success" that silently published nothing. A genuinely
  // quiet news cycle (0 candidates) is not a failure.
  if (candidates.length > 0 && newStory === 0 && updated === 0) {
    console.error('published 0 of >0 candidates — likely ingest/auth failure');
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
