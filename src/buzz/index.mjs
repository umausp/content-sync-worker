// BUZZ ENGINE — the fix for "Twitter is buzzing about X but we don't have it".
//
// Our normal sources (publisher RSS + GDELT) can only surface a story AFTER an
// outlet writes an article — so we always lag the social buzz. This closes that
// gap CHEAPLY ($0, no auth) with a two-step Google pipeline:
//   1. Google TRENDS RSS → what India is SEARCHING RIGHT NOW (the buzz signal —
//      "ramayana movie", "harshad chopda", …). This is the closest free proxy to
//      Twitter/X trending; it spikes within minutes of a real event.
//   2. For each hot term → Google NEWS search RSS → the freshest articles about it,
//      each carrying a clean <source url> (outlet name + domain) + pubDate.
// The articles come back in the SAME shape as RSS/GDELT, tagged via='buzz', so they
// flow straight into cluster→corroboration→synth. A buzzing topic an outlet just
// covered now reaches us via Trends immediately, not whenever that outlet's own
// feed happens to carry it.
//
// Verified live (2026-07): Trends surfaced "ramayana movie" as a hot IN term and
// News search returned the fresh trailer-launch article. Reddit/Nitter were probed
// + REJECTED (bot-blocked / dead from a datacenter IP) — Google surfaces are the
// reliable $0 path.
//
// Env: BUZZ_ENABLED, BUZZ_GEO (IN), BUZZ_HL (en-IN), BUZZ_MAX_TERMS (10),
//      BUZZ_PER_TERM (5), BUZZ_EXTRA_QUERIES (comma list of always-on searches).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}
function tag(block, name) { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i')); return m ? decode(m[1]) : ''; }

async function getXml(url, timeoutMs = 10000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return null;
  return r.text();
}

// The trending SEARCH TERMS in a geo, right now. Google's newer /trending/rss path
// (the older /trends/trendingsearches/daily/rss 404s — verified). Returns [] on
// failure so the caller degrades to BUZZ_EXTRA_QUERIES only.
async function fetchTrendingTerms(opts) {
  const geo = opts.geo || 'IN';
  const xml = await getXml(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`).catch(() => null);
  if (!xml) { opts.log('buzz.trends_failed', { geo }); return []; }
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  // Drop generic/noise trending terms that pull junk (e.g. "video"/"वीडियो",
  // "wealth", bare numbers) — they return homepages/social links, not news events.
  const GENERIC = /^(video|वीडियो|photos|images|wealth|news|live|today|watch|game|movie|result|results|score|scores)$/i;
  const terms = [];
  for (const [, block] of items) {
    const t = tag(block, 'title');
    if (t && t.length > 2 && !GENERIC.test(t.trim())) terms.push(t);
  }
  opts.log('buzz.trends', { geo, terms: terms.length });
  return terms;
}

// Fresh articles for one search TERM via Google News search RSS. Each item has a
// clean "<source url=...>Outlet</source>" (name + domain) + pubDate. The <link> is
// a news.google.com redirect (opaque) — we keep it as the article URL (it resolves
// in a browser) but derive outlet + domain from the <source> tag for attribution.
async function fetchNewsForTerm(term, opts) {
  const hl = opts.hl || 'en-IN';
  const geo = opts.geo || 'IN';
  const ceid = `${geo}:${hl.split('-')[0]}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
  const xml = await getXml(url).catch(() => null);
  if (!xml) return [];
  const out = [];
  const perTerm = Number(opts.perTerm || 5);
  for (const [, block] of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, perTerm)) {
    let title = tag(block, 'title');
    const link = tag(block, 'link');
    const pub = tag(block, 'pubDate');
    const srcMatch = block.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    const sourceUrl = srcMatch ? srcMatch[1] : '';
    const sourceName = srcMatch ? decode(srcMatch[2]) : 'Google News';
    if (!title || !link) continue;
    // Skip non-article sources: social platforms + org homepages Trends sometimes
    // surfaces (facebook/x/instagram/youtube channel pages, party sites) — they're
    // not news events and pollute the pool.
    if (/(facebook|twitter|x|instagram|threads|tiktok|reddit)\.com|\.org$|bjp\.|inc\.in/i.test(sourceUrl)) continue;
    // Google News appends " - Outlet" to the title; strip it (we have the source).
    if (sourceName && title.endsWith(` - ${sourceName}`)) title = title.slice(0, -(sourceName.length + 3)).trim();
    out.push({
      title,
      url: link,
      sourceName,
      // Prefer the real publisher domain for the source link (favicons + attribution);
      // keep the GNews link as the tappable article URL.
      sourceUrl: sourceUrl || undefined,
      snippet: title, // GNews descriptions are HTML link lists — use the title; og-enrich later if needed
      imageUrl: null,
      publishedAt: pub ? new Date(pub).toISOString() : null,
      category: 'top',
      via: 'buzz',
      buzzTerm: term,
    });
  }
  return out;
}

// Fetch the buzzing news: trending terms (+ any always-on queries) → News search →
// merged, deduped-by-URL Article[]. Best-effort throughout ([] on total failure).
export async function fetchBuzz(opts = {}) {
  const log = opts.log || (() => {});
  const o = {
    geo: process.env.BUZZ_GEO || 'IN',
    hl: process.env.BUZZ_HL || 'en-IN',
    perTerm: Number(process.env.BUZZ_PER_TERM || 5),
    log,
  };
  const maxTerms = Number(process.env.BUZZ_MAX_TERMS || 10);
  const extra = (process.env.BUZZ_EXTRA_QUERIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const t0 = Date.now();

  const trending = await fetchTrendingTerms(o);
  const terms = [...new Set([...trending.slice(0, maxTerms), ...extra])];
  if (terms.length === 0) { log('buzz.no_terms', {}); return []; }

  // Fan out over terms (concurrency-capped), flatten, dedup by normalised URL.
  const CONC = Number(process.env.BUZZ_CONCURRENCY || 6);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < terms.length) {
      const term = terms[idx++];
      try { results.push(...(await fetchNewsForTerm(term, o))); } catch { /* skip a bad term */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, terms.length) }, worker));

  const seen = new Set();
  const deduped = [];
  for (const a of results) {
    const key = String(a.url || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }
  log('buzz.done', { terms: terms.length, trending: trending.length, extra: extra.length, articles: deduped.length, ms: Date.now() - t0 });
  return deduped;
}
