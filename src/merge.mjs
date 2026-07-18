#!/usr/bin/env node
// MERGE cron — cleans up the DUPLICATE BACKLOG. New stories now converge via the
// pipeline's entity hashtag, but the DB already holds ~25 "Sonam Wangchuk" / ~8
// "Vikram-1" stories from before that fix. This job:
//   1. reads recent published stories from the live feed (STORIES_URL),
//   2. clusters them by entity (same clusterByEntity the pipeline uses),
//   3. for each cluster with >1 story, picks a CANONICAL (most updates / oldest)
//      and MERGES the rest into it via the token-guarded /news/merge endpoint
//      (which reassigns updates/comments/likes/follows to the canonical thread).
// Idempotent + safe: a cluster already collapsed to one story is a no-op.
//
// Env: STORIES_URL, INGEST_URL (→ merge URL), NEWS_INGEST_TOKEN. MERGE_DRY_RUN=1
// to log the plan without merging.

import { clusterByEntity, sameEntityEvent } from './entity.mjs';
import { isSameStory } from './dedup.mjs';

// Generic/background entities — a cluster anchored ONLY on one of these is NOT a
// safe merge (e.g. six different "Modi" stories share only "modi"). Merging is
// DESTRUCTIVE, so we require a SPECIFIC anchor + a second confirmation.
const GENERIC = new Set(['modi', 'india', 'indian', 'bjp', 'congress', 'aap', 'rss', 'delhi', 'mumbai', 'parliament', 'centre', 'government', 'supremecourt', 'apple', 'japan', 'canada', 'us', 'china', 'pakistan', 'trump', 'scientists', 'july']);

const STORIES_URL = process.env.STORIES_URL || (process.env.INGEST_URL || '').replace(/\/ingest$/, '/stories');
const MERGE_URL = (process.env.INGEST_URL || '').replace(/\/ingest$/, '/merge');
const TOKEN = process.env.NEWS_INGEST_TOKEN || '';
const DRY = process.env.MERGE_DRY_RUN === '1';
const PAGES = Number(process.env.MERGE_PAGES || 6); // how many feed pages to scan
if (!STORIES_URL || !MERGE_URL || !TOKEN) { console.error('missing STORIES_URL / INGEST_URL / NEWS_INGEST_TOKEN'); process.exit(1); }

async function fetchRecent() {
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (const mode of ['latest', 'updated']) {
    cursor = null;
    for (let page = 0; page < PAGES; page++) {
      const url = `${STORIES_URL}?mode=${mode}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r || !r.ok) break;
      const j = await r.json();
      for (const s of j.items || []) {
        if (seen.has(s.hashtag)) continue;
        seen.add(s.hashtag);
        out.push({ hashtag: s.hashtag, title: s.title, updateCount: s.updateCount || 0, publishedAt: s.publishedAt || '' });
      }
      cursor = j.nextCursor;
      if (!cursor) break;
    }
  }
  return out;
}

async function merge(canonicalHashtag, duplicateHashtags) {
  if (DRY) return { ok: true, dry: true };
  try {
    const r = await fetch(MERGE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ canonicalHashtag, duplicateHashtags }),
      signal: AbortSignal.timeout(20000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function main() {
  const stories = await fetchRecent();
  console.log(`merge: scanned ${stories.length} recent stories`);
  const { clusters } = clusterByEntity(stories, (s) => s.title, 2);
  const dupClusters = clusters.filter((c) => c.items.length > 1);
  console.log(`found ${dupClusters.length} raw duplicate clusters; applying SAFE-MERGE guards…`);

  let mergedGroups = 0;
  let mergedStories = 0;
  let skippedUnsafe = 0;
  for (const c of dupClusters) {
    // SAFE-MERGE GUARD 1: the anchor entity must be SPECIFIC (multi-word, non-
    // generic). A cluster held together only by "Modi"/"Apple"/"Parliament" is
    // NOT one event — skip it (merging is destructive; a false merge corrupts a
    // real story). Require the canonical entity to be >1 word and not generic.
    const key = String(c.key || '').toLowerCase();
    const specific = /\s/.test(String(c.canonicalEntity || '')) && !GENERIC.has(key);
    if (!specific) { skippedUnsafe++; console.log(`  ⊘ skip [${c.canonicalEntity}] — generic anchor, not a safe merge (${c.items.length} stories)`); continue; }

    // canonical = the story with the MOST updates (the established thread), then
    // oldest (first published) as a tiebreak — merge the rest into it.
    const sorted = [...c.items].sort((a, b) => (b.updateCount - a.updateCount) || (a.publishedAt < b.publishedAt ? -1 : 1));
    const canon = sorted[0];
    // SAFE-MERGE GUARD 2: each dup must be the SAME EVENT as the canonical —
    // confirmed by EITHER word-overlap (isSameStory) OR shared-subject+shared-
    // event-word (sameEntityEvent, which catches "Kejriwal urges Wangchuk" ≈
    // "Tharoor appeals to Wangchuk"). This keeps DIFFERENT events about the same
    // person apart (Wangchuk hunger-strike vs Wangchuk Padma Shri) while still
    // collapsing the true dupes that word-overlap alone misses.
    const dups = sorted.slice(1).filter((s) => isSameStory(s.title, canon.title) || sameEntityEvent(s.title, canon.title)).map((s) => s.hashtag);
    const dropped = sorted.length - 1 - dups.length;
    if (dups.length === 0) { skippedUnsafe++; console.log(`  ⊘ skip [${c.canonicalEntity}] — no dup confirmed by word-overlap`); continue; }
    if (dropped > 0) console.log(`    (kept ${dropped} same-entity stories apart — different events)`);
    const res = await merge(canon.hashtag, dups);
    if (res.ok) {
      mergedGroups++;
      mergedStories += dups.length;
      console.log(`  ${DRY ? '[dry] ' : ''}✓ #${canon.hashtag} ← ${dups.length} dupes [${c.canonicalEntity}]: ${dups.slice(0, 4).join(', ')}${dups.length > 4 ? '…' : ''}`);
    } else {
      console.log(`  ✗ merge failed for #${canon.hashtag}: ${res.status || res.err}`);
    }
  }
  console.log(`\nMERGE DONE: ${mergedGroups} clusters collapsed, ${mergedStories} dup stories folded into threads${DRY ? ' (DRY RUN — nothing changed)' : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
