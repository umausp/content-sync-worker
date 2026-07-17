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
const PUBLISH_MIN_IMPORTANCE = Number(process.env.PUBLISH_MIN_IMPORTANCE || 4);
const PUBLISH_MIN_CORROBORATION = Number(process.env.PUBLISH_MIN_CORROBORATION || 2);
const MAX_AGE_H = Number(process.env.MAX_AGE_H || 36);
// Fact-verifier is OFF by default: it DOUBLES the LLM calls (a 2nd pass per
// publishing story) and the algorithmic fact-shape gate already catches invented
// numbers/quotes. Turn on with VERIFY_FAITHFUL=1 when runtime budget allows.
const VERIFY = process.env.VERIFY_FAITHFUL === '1';
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
  let newStory = 0, updated = 0, rejected = 0, batchDup = 0, verifyFail = 0, heldBar = 0;
  const reasons = {};

  for (const c of candidates) {
    // Layer A — algorithmic gates.
    const g = runGates(c, { nowMs, maxAgeH: MAX_AGE_H });
    if (g) { rejected++; bump(reasons, g.gate + ':' + g.reason); console.log(`  ✗ ${g.gate} [${g.reason}] ${(c.title || '').slice(0, 46)}`); continue; }

    // Layer B — in-batch dedup.
    if (acceptedTitles.some((t) => isSameStory(c.title, t))) { batchDup++; console.log(`  ⊘ batch-dup ${c.title.slice(0, 46)}`); continue; }

    // Layer C — is this an update to an already-published story?
    const match = published.find((p) => isSameStory(c.title, p.title));

    // Layer D — SELECTIVE PUBLISH BAR (cheap, runs BEFORE the expensive verifier
    // so we only fact-check items that will actually publish). Updates to a live
    // thread bypass the bar (developments are always welcome); a NEW story must
    // clear importance + corroboration.
    if (!match && (c.importance < PUBLISH_MIN_IMPORTANCE || c.corr < PUBLISH_MIN_CORROBORATION)) {
      heldBar++; bump(reasons, 'below_publish_bar');
      console.log(`  ▽ hold [imp${c.importance}<${PUBLISH_MIN_IMPORTANCE} | corr${c.corr}<${PUBLISH_MIN_CORROBORATION}] ${c.title.slice(0, 42)}`);
      continue;
    }

    // Layer E — LLM fact-consistency verifier (anti-hallucination), the EXPENSIVE
    // gate. Now runs ONLY on the ~15-30 items that cleared everything above, so a
    // second LLM call per item stays within the runner budget.
    if (VERIFY) {
      const v = await verifyFaithful(c);
      if (v && (!v.faithful || !v.sameEvent)) { verifyFail++; bump(reasons, 'verify:' + (!v.faithful ? 'unfaithful' : 'diff_event')); console.log(`  ✗ verify [${v.reason}] ${c.title.slice(0, 42)}`); continue; }
    }

    const body = toIngestBody(c);
    if (match) {
      body.hashtag = match.hashtag;
      if (await post(body)) { updated++; acceptedTitles.push(c.title); console.log(`  ↑ update #${match.hashtag} ← ${c.title.slice(0, 44)}`); }
      continue;
    }
    if (await post(body)) { newStory++; acceptedTitles.push(c.title); console.log(`  ✓ new [${c.category}] imp${c.importance} corr${c.corr} #${c.hashtag} ${c.title.slice(0, 40)}`); }
  }

  console.log(`\nREVIEW DONE candidates=${candidates.length} → new=${newStory} updated=${updated} | rejected=${rejected} verifyFail=${verifyFail} batchDup=${batchDup} heldBar=${heldBar}`);
  console.log(`  publish bar: importance>=${PUBLISH_MIN_IMPORTANCE} AND corroboration>=${PUBLISH_MIN_CORROBORATION}; verifier=${VERIFY ? 'on' : 'off'}`);
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
