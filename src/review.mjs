#!/usr/bin/env node
// REVIEW pipeline — the strict editorial gate between synth and D1. Nothing is
// published until it passes here. Runs on the GitHub runner right after
// pipeline.buildCandidates(). Three layers, in order:
//
//   1. VALIDATE  — hard checks on every field (real title, single valid
//      category, body length, no gossip/opinion/superlative titles, importance
//      floor, hashtag sanity). A candidate that fails ANY check is dropped with
//      a logged reason. This is what stops the "…" title + category-enum leak
//      + gossip that slipped through before.
//   2. DEDUP     — against stories ALREADY published (pulled from the live site
//      API) AND against others in THIS batch. Same-event → not a new story.
//   3. UPDATES   — a candidate that matches an already-published story REUSES
//      that story's hashtag, so ingest APPENDS it as an update to the existing
//      thread (ingest's own no-new-info guard then decides if it's a real
//      development). Genuinely new events create new stories.
//
// Only survivors are POSTed to the ingest endpoint.

import { buildCandidates, toIngestBody, CATEGORIES, isSameStory } from './pipeline.mjs';

const INGEST_URL = process.env.INGEST_URL || '';
const INGEST_TOKEN = process.env.NEWS_INGEST_TOKEN || '';
const STORIES_URL = process.env.STORIES_URL || INGEST_URL.replace(/\/ingest$/, '/stories');
const MIN_IMPORTANCE = Number(process.env.MIN_IMPORTANCE || 3);
// SELECTIVE PUBLISH BAR (how Google News actually gates — significance, not
// volume). A NEW front-page story must clear a HIGH bar: importance >= this AND
// corroboration >= this many distinct outlets. Everything below can still become
// an UPDATE to an existing thread, but does NOT spawn a new story. This is what
// turns "120 synthesized" into ~15-30 genuinely significant stories per cycle.
const PUBLISH_MIN_IMPORTANCE = Number(process.env.PUBLISH_MIN_IMPORTANCE || 4);
const PUBLISH_MIN_CORROBORATION = Number(process.env.PUBLISH_MIN_CORROBORATION || 2);
if (!INGEST_URL || !INGEST_TOKEN) { console.error('missing INGEST_URL / NEWS_INGEST_TOKEN'); process.exit(1); }

// ── Layer 1: validation ─────────────────────────────────────────────────────
// Title-level reject patterns (belt-and-braces on top of the synth charter):
// gossip, opinion/prediction, unverifiable superlatives, clickbait.
const REJECT_TITLE = [
  /\b(spotted|dating|loves|crush|throwback|opens up|breaks silence|reacts to|slams|trolled|fan[s]? react)\b/i,
  /\b(could|should|may|might|set to (shine|impress)|predicts|tipped to|likely to win|hopes to)\b/i,
  /\b(shocking|you won'?t believe|goes viral|watch:|mind[- ]blowing|jaw[- ]dropping)\b/i,
  /\b(biggest ever|highest[- ]grossing|record[- ]breaking|most[- ]watched)\b/i,
];
const BAD_TITLE = /^[\s.\-–—…]*$|^(untitled|news|update|test)$/i;

function validate(c) {
  const title = (c.title || '').trim();
  // real title
  if (title.length < 12) return 'title_too_short';
  if (BAD_TITLE.test(title)) return 'placeholder_title';
  if (/\|/.test(title)) return 'title_has_pipe';
  if (/\.\.\.$|…$/.test(title)) return 'title_trailing_ellipsis';
  // single valid category (the enum-leak defect)
  if (!CATEGORIES.includes(c.category)) return 'bad_category:' + c.category;
  // body
  const body = (c.body || '').trim();
  if (body.length < 60) return 'body_too_short';
  const sentences = body.split(/[.!?]\s/).filter((s) => s.trim().length > 10).length;
  if (sentences < 2) return 'body_too_few_sentences';
  // summary
  if ((c.summary || '').trim().length < 20) return 'summary_too_short';
  // hashtag sanity
  if (!/^[A-Za-z][\p{L}\p{N}_]{5,59}$/u.test(c.hashtag || '')) return 'bad_hashtag';
  // importance floor + editorial skip
  if (c.skip) return 'editor_skip';
  if (c.importance < MIN_IMPORTANCE) return 'below_min_importance';
  // reject-title patterns (gossip/opinion/superlative/clickbait)
  for (const re of REJECT_TITLE) if (re.test(title)) return 'reject_pattern:' + re.source.slice(0, 20);
  // no fabricated numbers check: body must not invent a source we don't have
  if (!c.article?.url || !/^https?:\/\//i.test(c.article.url)) return 'no_source_url';
  return null; // passes
}

// ── Layer 2 data: already-published stories (for dedup + updates) ────────────
async function fetchPublished() {
  const out = [];
  try {
    for (const mode of ['latest', 'updated']) {
      const r = await fetch(`${STORIES_URL}?mode=${mode}&limit=50`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const s of j.items || []) out.push({ hashtag: s.hashtag, title: s.title });
    }
  } catch (e) { console.log('warn: could not fetch published for dedup:', e.message); }
  // de-dup the reference list itself by hashtag
  const seen = new Set();
  return out.filter((s) => (seen.has(s.hashtag) ? false : (seen.add(s.hashtag), true)));
}

async function post(body) {
  try {
    const r = await fetch(INGEST_URL, { method: 'POST', headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const candidates = await buildCandidates();
  const published = await fetchPublished();
  console.log(`review: ${candidates.length} candidates, ${published.length} already-published for dedup`);

  const acceptedTitles = []; // in-batch dedup
  let published_new = 0, updated = 0, rejected = 0, dupdropped = 0;
  const reasons = {};

  for (const c of candidates) {
    // Layer 1: validate
    const bad = validate(c);
    if (bad) { rejected++; reasons[bad.split(':')[0]] = (reasons[bad.split(':')[0]] || 0) + 1; console.log(`  ✗ reject [${bad}] ${(c.title || '').slice(0, 50)}`); continue; }

    // Layer 2: in-batch dedup (same event twice this run → keep first)
    if (acceptedTitles.some((t) => isSameStory(c.title, t))) { dupdropped++; console.log(`  ⊘ batch-dup ${c.title.slice(0, 50)}`); continue; }

    // Layer 3: updates — does this match an ALREADY-published story?
    const match = published.find((p) => isSameStory(c.title, p.title));
    const body = toIngestBody(c);
    if (match) {
      // A development on a LIVE thread is always welcome (keeps stories evolving).
      // Reuse the published story's hashtag → ingest appends as an UPDATE (its
      // no-new-info guard decides if it's a real development).
      body.hashtag = match.hashtag;
      if (await post(body)) { updated++; acceptedTitles.push(c.title); console.log(`  ↑ update #${match.hashtag} ← ${c.title.slice(0, 46)}`); }
      continue;
    }

    // NEW story → must clear the SELECTIVE publish bar (significance + corroboration).
    // This is the Google-News gate: we do NOT publish every synthesised item as a
    // new front-page story — only genuinely significant, corroborated events.
    if (c.importance < PUBLISH_MIN_IMPORTANCE || c.corr < PUBLISH_MIN_CORROBORATION) {
      rejected++;
      reasons.below_publish_bar = (reasons.below_publish_bar || 0) + 1;
      console.log(`  ▽ hold [imp${c.importance}<${PUBLISH_MIN_IMPORTANCE} or corr${c.corr}<${PUBLISH_MIN_CORROBORATION}] ${c.title.slice(0, 44)}`);
      continue;
    }
    if (await post(body)) { published_new++; acceptedTitles.push(c.title); console.log(`  ✓ new [${c.category}] imp${c.importance} corr${c.corr} #${c.hashtag} ${c.title.slice(0, 42)}`); }
  }

  console.log(`\nREVIEW DONE candidates=${candidates.length} new=${published_new} updated=${updated} rejected=${rejected} batch-dups=${dupdropped}`);
  console.log(`  publish bar: importance>=${PUBLISH_MIN_IMPORTANCE} AND corroboration>=${PUBLISH_MIN_CORROBORATION}`);
  console.log('reject reasons:', JSON.stringify(reasons));
}
main().catch((e) => { console.error(e); process.exit(1); });
