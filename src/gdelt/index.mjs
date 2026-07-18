// GDELT source — public entry point. Strategy (grounded in live probing):
//   1. Try the DOC API ArtList (real titles + images, one call). Best data.
//   2. If it's throttled/failing (429 on shared IPs is common), fall back to the
//      GKG raw file on the unthrottled CDN (URL-slug titles, still usable).
// Returns Article[] in the SAME shape the RSS path produces, so GDELT articles
// merge straight into the pipeline's clustering + corroboration pool — a GDELT
// outlet covering the same event as an RSS outlet simply raises that cluster's
// corroboration count (which is the whole point: more independent sources).
//
// Env: GDELT_QUERY, GDELT_MAX, GDELT_TIMESPAN, GDELT_FORCE_GKG (skip DOC, test).

import { fetchDocArtList } from './doc.mjs';
import { fetchGkg } from './gkg.mjs';
import { enrichArticles } from './ogfetch.mjs';

export async function fetchGdelt(opts = {}) {
  const log = opts.log || (() => {});
  const query = opts.query || process.env.GDELT_QUERY || 'sourcecountry:IN sourcelang:english';
  const max = Number(opts.max || process.env.GDELT_MAX || 250);
  const timespan = opts.timespan || process.env.GDELT_TIMESPAN || '1h';
  const t0 = Date.now();

  let articles = [];
  let source = 'none';

  if (process.env.GDELT_FORCE_GKG !== '1') {
    const doc = await fetchDocArtList({ query, max, timespan, log });
    if (doc.ok && doc.articles.length > 0) {
      articles = doc.articles;
      source = 'doc';
    } else {
      log('gdelt.doc_unavailable_falling_back', { status: doc.status });
    }
  }

  if (articles.length === 0) {
    articles = await fetchGkg({ max, log });
    if (articles.length > 0) source = 'gkg';
  }

  // Dedup by normalised URL (both surfaces can carry the same link).
  const seen = new Set();
  let deduped = [];
  for (const a of articles) {
    const key = normalizeUrl(a.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  // ENRICH: fetch each article's real og:title + og:description + og:image. The
  // DOC path already has clean titles (skip enrichment there — save the fetches);
  // the GKG path has only slug titles + no snippet, so enrich those for quality.
  // Best-effort: 403/timeout keeps the slug title. Off with GDELT_ENRICH=0.
  if (process.env.GDELT_ENRICH !== '0' && source === 'gkg' && deduped.length > 0) {
    deduped = await enrichArticles(deduped, { concurrency: Number(process.env.GDELT_ENRICH_CONCURRENCY || 8), log });
  }

  log('gdelt.done', { source, articles: deduped.length, enriched: deduped.filter((a) => a.enriched).length, ms: Date.now() - t0 });
  return deduped;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return (url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}
