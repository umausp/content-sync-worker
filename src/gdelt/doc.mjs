// GDELT DOC 2.0 API — ArtList mode. THE primary GDELT surface: it's the only one
// that returns a REAL headline (`title`) + `socialimage` + `domain` + `language`
// + `sourcecountry`, already filtered to a query, in ONE call (verified: 191
// India-English articles / 22 domains / 152 with images in a single request).
//
// The catch (verified live): the rate limit is a PER-IP soft-ban, not a clean
// 1-req/5s bucket — a burst trips a multi-minute cooldown, and GitHub's shared
// egress IPs may already be partially throttled by other users. So: ONE call per
// run, retry with exponential backoff on 429, and if it stays blocked the caller
// falls back to the GKG surface (gkg.mjs). Never parallelise or hammer this.
//
// Response shape (locked from a live capture):
//   { articles: [ { url, url_mobile, title, seendate:"YYYYMMDDTHHMMSSZ",
//                   socialimage, domain, language, sourcecountry } ] }

const DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const UA = 'Mozilla/5.0 (compatible; agyata-newsbot/1.0; +https://agyata.com)';

// Parse GDELT's seendate "YYYYMMDDTHHMMSSZ" → ISO 8601, or null.
function parseSeendate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : iso;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one ArtList page. opts: { query, max, timespan, retries, backoffMs, log }.
// Returns { ok, articles, status } — ok:false means throttled/failed (fall back).
export async function fetchDocArtList(opts = {}) {
  const query = opts.query || 'sourcecountry:IN sourcelang:english';
  const max = Math.min(Math.max(opts.max || 250, 1), 250); // API hard cap = 250
  const timespan = opts.timespan || '1h';
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 12000; // 429 = back off MINUTES, not seconds
  const log = opts.log || (() => {});

  const url =
    `${DOC_URL}?query=${encodeURIComponent(query)}` +
    `&mode=ArtList&format=json&sort=datedesc&maxrecords=${max}&timespan=${encodeURIComponent(timespan)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = backoffMs * attempt; // 12s, 24s, 36s — linear, patient
      log('gdelt.doc.backoff', { attempt, waitMs: wait });
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 429) { log('gdelt.doc.429', { attempt }); continue; }
      if (!res.ok) { log('gdelt.doc.http', { status: res.status }); return { ok: false, status: res.status, articles: [] }; }
      const text = await res.text();
      // GDELT sometimes returns HTTP 200 with an HTML error page for a bad query.
      if (!text.trim().startsWith('{')) { log('gdelt.doc.nonjson', {}); return { ok: false, status: 200, articles: [] }; }
      const j = JSON.parse(text);
      const articles = (j.articles || [])
        .map((a) => normalizeDocArticle(a))
        .filter(Boolean);
      log('gdelt.doc.ok', { count: articles.length });
      return { ok: true, status: 200, articles };
    } catch (e) {
      log('gdelt.doc.error', { attempt, err: e.message });
      // network/timeout — retry within the loop
    }
  }
  return { ok: false, status: 429, articles: [] };
}

// Map one ArtList JSON object → the shared Article shape used by the pipeline.
function normalizeDocArticle(a) {
  const title = String(a?.title || '').trim();
  const url = String(a?.url || '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const img = a?.socialimage && /^https:\/\//i.test(a.socialimage) ? a.socialimage : null;
  return {
    title,
    url,
    sourceName: outletFromDomain(a?.domain),
    snippet: title, // ArtList gives no body; title is enough for clustering/scoring
    imageUrl: img,
    publishedAt: parseSeendate(a?.seendate),
    category: 'top', // GDELT has no genre; caller/quota treats these as general
    via: 'gdelt-doc',
  };
}

// Readable outlet name from a bare domain (GDELT gives domains, not names).
function outletFromDomain(domain) {
  const host = String(domain || '').replace(/^www\./, '');
  if (!host) return 'GDELT';
  const map = {
    'thehindu.com': 'The Hindu', 'indianexpress.com': 'The Indian Express',
    'hindustantimes.com': 'Hindustan Times', 'timesofindia.indiatimes.com': 'Times of India',
    'ndtv.com': 'NDTV', 'livemint.com': 'Mint', 'news18.com': 'News18',
    'indiatoday.in': 'India Today', 'zeenews.india.com': 'Zee News', 'dnaindia.com': 'DNA India',
    'business-standard.com': 'Business Standard', 'economictimes.indiatimes.com': 'Economic Times',
    'moneycontrol.com': 'Moneycontrol', 'bbc.com': 'BBC', 'bbc.co.uk': 'BBC',
    'theguardian.com': 'The Guardian', 'aljazeera.com': 'Al Jazeera', 'reuters.com': 'Reuters',
    'apnews.com': 'AP', 'nytimes.com': 'New York Times', 'firstpost.com': 'Firstpost',
    'scroll.in': 'Scroll', 'thewire.in': 'The Wire', 'theprint.in': 'ThePrint',
    'deccanherald.com': 'Deccan Herald',
  };
  for (const [d, n] of Object.entries(map)) if (host.endsWith(d)) return n;
  const w = host.split('.')[0] || 'source';
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export { parseSeendate, outletFromDomain };
