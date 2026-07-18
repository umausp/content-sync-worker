// Article metadata enrichment — fetch the REAL headline + description + image
// from an article page's Open Graph / <title> tags. GDELT gives us URLs (and, in
// the raw GKG path, only slug-derived titles); this upgrades them to the outlet's
// actual headline + a real snippet the LLM can synthesise from.
//
// Best-effort by design: many outlets 403 a bot UA (verified: aninews.in blocks,
// businesstoday.in allows). On any failure (403/timeout/no-og) we KEEP the
// existing slug title — enrichment only ever improves, never breaks. Runs with a
// concurrency cap so N page-fetches don't stall the run.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

function meta(html, prop) {
  // property="og:x" or name="og:x", attribute order-agnostic.
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m?.[1] ? decodeEntities(m[1]).trim() : '';
}
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Fetch one article's og metadata. Returns {} on any failure (caller keeps slug).
export async function fetchOgMeta(url, timeoutMs = 6000) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return {};
    // Only read the <head> — abort the body to save bandwidth/time.
    const html = (await r.text()).slice(0, 60000);
    const title = meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]{6,})<\/title>/i)?.[1] ? decodeEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)[1]) : '');
    const description = meta(html, 'og:description') || meta(html, 'description');
    const image = meta(html, 'og:image');
    return { title, description, image };
  } catch {
    return {};
  }
}

// Enrich an array of articles in place-ish (returns new array) with a concurrency
// cap. Each article keeps its slug title unless a REAL og:title is found; a real
// og:description becomes the snippet (much better synth input than the slug).
export async function enrichArticles(articles, opts = {}) {
  const concurrency = opts.concurrency || 8;
  const timeoutMs = opts.timeoutMs || 6000;
  const log = opts.log || (() => {});
  let enriched = 0;
  let idx = 0;
  const out = articles.slice();
  async function worker() {
    while (idx < out.length) {
      const i = idx++;
      const a = out[i];
      const og = await fetchOgMeta(a.url, timeoutMs);
      if (og.title && og.title.length >= 12 && !/^\d+\s+(forbidden|not found)|access denied/i.test(og.title)) {
        // Real headline — strip a trailing " | Outlet" / " - Outlet" site suffix.
        out[i] = {
          ...a,
          title: og.title.replace(/\s*[|\-–—]\s*[^|\-–—]{2,30}$/,'').trim().slice(0, 300) || a.title,
          snippet: (og.description && og.description.length > 30 ? og.description : a.snippet).slice(0, 400),
          imageUrl: a.imageUrl || (og.image && /^https:\/\//i.test(og.image) ? og.image : null),
          enriched: true,
        };
        enriched++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  log('gdelt.enrich', { total: out.length, enriched });
  return out;
}
