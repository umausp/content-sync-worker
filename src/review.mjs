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

import { buildCandidates, toIngestBody, verifyFaithful, isNovelUpdate, expandSummary, isSameStory, healthCheck } from './pipeline.mjs';
import { normalizeCandidate, runGates } from './gates.mjs';

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
// NOVELTY gate for updates — LLM-check that a same-topic item adds NEW info before
// appending it to an existing story (else ignore). On by default; VERIFY_NOVELTY=0
// to disable (falls back to the old always-append behaviour).
const NOVELTY_CHECK = process.env.VERIFY_NOVELTY !== '0';
// Only verify when the source snippet is long enough to check against. A thin
// snippet (a slug/headline) lacks the article's entities, so the verifier would
// falsely flag accurate synthesis as "introducing new names". Below this, we trust
// the synthesis (gFactShape still guards invented numbers).
const VERIFY_MIN_SOURCE = Number(process.env.VERIFY_MIN_SOURCE || 160);
if (!INGEST_URL || !INGEST_TOKEN) { console.error('missing INGEST_URL / NEWS_INGEST_TOKEN'); process.exit(1); }

// The dedup REFERENCE SET — the already-published stories a new candidate is checked
// against so we don't republish the same event. This was a SINGLE page/mode (the API
// caps a page at 20 rows regardless of &limit, so ~40 total after cross-mode dedup);
// a story that scrolled past that tiny window re-published as "new" (user: "same news
// is repeating"). Now PAGINATED via the API's nextCursor for DEDUP_LOOKBACK_PAGES
// pages/mode. At ~20 rows/page and the live publish rate (~100/30min across all
// editions), 12 pages/mode ≈ the last ~1.5–2h — several buzz-cron cycles, so a story
// that re-surfaces reworded within a couple hours is now caught by title-dedup, not
// just the server's same-hashtag upsert. Bounded (2×pages calls) + best-effort: a
// failed/empty page stops that mode's paging (keeps what it already has). The server
// hashtag-upsert remains the deeper backstop for older re-surfacings.
async function fetchPublished() {
  const out = [];
  const pages = Number(process.env.DEDUP_LOOKBACK_PAGES || 12);
  try {
    for (const mode of ['latest', 'updated']) {
      let cursor = '';
      for (let page = 0; page < pages; page++) {
        const url = `${STORIES_URL}?mode=${mode}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) break;
        const j = await r.json();
        const items = j.items || [];
        for (const s of items) out.push({ hashtag: s.hashtag, title: s.title, summary: s.summary || '' });
        cursor = j.nextCursor || '';
        if (!cursor || items.length === 0) break; // no more pages
      }
    }
  } catch (e) { console.log('warn: dedup reference fetch failed:', e.message); }
  const seen = new Set();
  const deduped = out.filter((s) => (seen.has(s.hashtag) ? false : (seen.add(s.hashtag), true)));
  console.log(`dedup reference: ${deduped.length} published stories (${pages} pages/mode)`);
  return deduped;
}

async function post(body) {
  try {
    const r = await fetch(INGEST_URL, { method: 'POST', headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    // Surface WHY a publish failed (was silent → stories vanished with no clue).
    // Never log the response body/headers (avoid leaking anything token-adjacent).
    if (!r.ok) { console.log(`  ! ingest ${r.status} for #${body.hashtag}`); return { ok: false, created: false }; }
    // Read the backend's AUTHORITATIVE `created` flag. Ingest is upsert-by-hashtag:
    // `created:false` means it merely APPENDED an update to an existing story — even
    // when OUR title-dedup (isSameStory) missed it (reworded headline, dedup window
    // overflow, or a fail-open reference fetch). Breaking-push keys off this flag, so
    // a live story that resurfaces reworded can NEVER re-alert. The one residual case
    // — a reworded title that also yields a DIFFERENT entity hashtag — is a genuinely
    // separate thread in D1 (its own card), so a fresh alert there is correct, not spam.
    let created = false;
    try { const j = await r.json(); created = j?.created === true; } catch { /* body unreadable → treat as not-created (no push) */ }
    return { ok: true, created };
  } catch (e) { console.log(`  ! ingest error for #${body.hashtag}: ${e.message}`); return { ok: false, created: false }; }
}

// BREAKING-NEWS PUSH — when a genuinely breaking NEW story publishes, fire a
// lockscreen alert to all opt-in subscribers via the token-guarded gateway
// endpoint (same NEWS_INGEST_TOKEN we already hold). Best-effort: a push failure
// never blocks publishing. Gated by NEWS_PUSH=1 (off by default until subscribers
// exist) + capped per run so a burst of breaking stories can't spam users.
// Derive the breaking-push endpoint from the ingest URL. Explicit BREAKING_PUSH_URL
// env wins; else swap the /ingest suffix. ASSERT the derivation actually changed the
// URL — if INGEST_URL doesn't end in /ingest the regex is a no-op and we'd POST a
// push-shaped body to the ingest endpoint (silently 400s → zero alerts, no crash).
// Better to disable the feature loudly than silently no-op.
const BREAKING_PUSH_URL = process.env.BREAKING_PUSH_URL
  || (/\/ingest$/.test(INGEST_URL) ? INGEST_URL.replace(/\/ingest$/, '/breaking-push') : '');
const NEWS_PUSH_ON = process.env.NEWS_PUSH === '1' && !!BREAKING_PUSH_URL;
if (process.env.NEWS_PUSH === '1' && !BREAKING_PUSH_URL) {
  console.log('  ⚠ NEWS_PUSH=1 but cannot derive breaking-push URL (INGEST_URL lacks /ingest and no BREAKING_PUSH_URL) — breaking alerts DISABLED this run');
}
const NEWS_PUSH_MAX = Number(process.env.NEWS_PUSH_MAX || 3); // at most N alert ATTEMPTS/run
let breakingPushed = 0;
async function sendBreakingPush(c, body) {
  // Cap counts ATTEMPTS, not successes: a hung/erroring gateway must not make us fire
  // a 20s-timeout push for EVERY breaking story in the run (could add minutes). One
  // increment up-front bounds total attempts to NEWS_PUSH_MAX regardless of outcome.
  if (!NEWS_PUSH_ON || breakingPushed >= NEWS_PUSH_MAX) return;
  breakingPushed++;
  const hashtag = body.hashtag;
  try {
    const r = await fetch(BREAKING_PUSH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `🔴 ${c.title}`.slice(0, 120),
        body: (c.summary || '').slice(0, 200),
        url: `https://agyata.com/news/${encodeURIComponent(hashtag)}`,
        image: body.imageUrl || undefined,
        tag: `news_${hashtag}`.slice(0, 60),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) console.log(`  🔔 breaking-push sent for #${hashtag}`);
    else console.log(`  ! breaking-push ${r.status} for #${hashtag}`);
  } catch (e) { console.log(`  ! breaking-push error: ${e.message}`); }
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
  let newStory = 0, updated = 0, rejected = 0, batchDup = 0, verifyFail = 0, heldBar = 0, catCapped = 0, staleUpdate = 0;
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
    // Layer 0 — REPAIR (like a pro newsroom copy-desk): fix COSMETIC defects
    // (" | Outlet" suffix, trailing "…", body-echoes-title) BEFORE gating, so the
    // gates only reject GENUINE garbage, not fixable formatting. Was rejecting ~26
    // real stories/run for pipes/ellipses/echoes that a human editor just cleans up.
    normalizeCandidate(c);

    // Layer A — algorithmic gates. BUZZ/trending items get a longer stale window:
    // a topic people are searching RIGHT NOW is fresh even if Google News anchors it
    // to a 1-2 day-old article — the 24h clock was wrongly dropping live trends
    // (iPhone launch, Sensex, FIFA). MAX_AGE_H_BUZZ (default 72h) for via='buzz'.
    const maxAgeH = c.article?.via === 'buzz' ? MAX_AGE_H_BUZZ : MAX_AGE_H;
    const g = runGates(c, { nowMs, maxAgeH });
    if (g) { rejected++; bump(reasons, g.gate + ':' + g.reason); console.log(`  ✗ ${g.gate} [${g.reason}] ${(c.title || '').slice(0, 46)}`); continue; }

    // Layer B — DEDUP (both in-batch + vs already-published) runs BEFORE the
    // expensive LLM verify, so we never spend a fact-check on a story we're about to
    // drop as a duplicate or ignore as a non-novel update. (Cost-ordered like
    // Google/Reuters: cheap kills → dedup → bar → LLM verify last.)
    if (acceptedTitles.some((t) => isSameStory(c.title, t))) { batchDup++; console.log(`  ⊘ batch-dup ${c.title.slice(0, 46)}`); continue; }

    // Is this an update to an already-published story?
    const match = published.find((p) => isSameStory(c.title, p.title));
    // NOVELTY — if it matches a published story but adds NO material development,
    // IGNORE it now (before verify). Only real developments proceed as updates.
    if (match && NOVELTY_CHECK && Date.now() - verifyStart < VERIFY_BUDGET_MS) {
      const n = await isNovelUpdate(match, c);
      if (n && n.novel === false) {
        staleUpdate++; bump(reasons, 'update_not_novel');
        console.log(`  ⊘ not-novel [${n.reason}] ${c.title.slice(0, 44)}`);
        continue;
      }
    }

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

    // STRICT DESCRIPTION QUALITY — a card's description must be substantial. If the
    // synth summary came back thin (<160 chars), LLM-rewrite it to a fuller
    // 160-260-char description grounded in the story's own body+snippet (expansion,
    // not invention). Budget-shared; fail-safe (keeps the original if unavailable).
    // Skipped for video-native (the video is the content, caption is fine).
    if (!c.videoNative && Date.now() - verifyStart < VERIFY_BUDGET_MS) {
      const expanded = await expandSummary(c);
      if (expanded && expanded !== c.summary) c.summary = expanded;
    }

    const body = toIngestBody(c);
    if (match) {
      // (Novelty already checked above — a matched story here is a real development.)
      body.hashtag = match.hashtag;
      const r = await post(body);
      if (r.ok) { updated++; acceptedTitles.push(c.title); console.log(`  ↑ update #${match.hashtag} ← ${c.title.slice(0, 44)}`); }
      continue;
    }
    const r = await post(body);
    if (r.ok) {
      // r.created distinguishes a genuinely NEW story from a backend-side merge (a
      // reworded/duplicate title our dedup missed but the hashtag upsert caught).
      if (r.created) { newStory++; } else { updated++; }
      catCount[c.category || 'top'] = (catCount[c.category || 'top'] || 0) + 1; const via = c.article?.via || 'rss'; srcCount[via] = (srcCount[via] || 0) + 1; acceptedTitles.push(c.title);
      console.log(`  ${r.created ? '✓ new' : '↑ merged'} [${c.category}] via=${via} score${(Number(c.score)||0).toFixed(0)} corr${c.corr} imp${c.importance} #${c.hashtag} ${c.title.slice(0, 34)}`);
      // BREAKING → lockscreen alert. Fires ONLY on a truly-new breaking, well-
      // corroborated story (r.created) — never on a backend merge — so a live story
      // resurfacing under a reworded title can't re-alert. Rare + meaningful.
      if (r.created && c.signal === 'breaking' && c.corr >= PUBLISH_MIN_CORROBORATION) await sendBreakingPush(c, body);
    }
  }

  console.log(`\nREVIEW DONE candidates=${candidates.length} → new=${newStory} updated=${updated} | rejected=${rejected} verifyFail=${verifyFail} batchDup=${batchDup} heldBar=${heldBar} catCapped=${catCapped} notNovel=${staleUpdate}`);
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
