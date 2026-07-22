// extract.mjs — the shared, best-in-class ARTICLE EXTRACTOR for the whole pipeline
// (news + shorts + longform). ONE place that turns a fetched article's raw HTML into
// clean prose + the publisher's OWN, story-relevant photos. Replaces the fragile
// hand-rolled <p>-regex that leaked bylines / "read more" / cookie notices and produced
// the repeated-word summaries the user reported.
//
// STRATEGY (best $0 algorithm, researched 2026-07-22):
//   1) JSON-LD  — parse <script type="application/ld+json"> for a schema.org
//      NewsArticle/Article `articleBody`. This is the publisher's OWN clean prose (no
//      nav/ads/boilerplate), needs NO DOM, and is the single most reliable source WHEN
//      present (NDTV, Indian Express, most schema.org publishers expose it).
//   2) Readability — @extractus/article-extractor (Mozilla Readability over the light
//      linkedom DOM — no jsdom, no headless browser, ~2s CI install). Content-score +
//      link-density heuristic; returns clean text + lead image + inline figures.
//   3) og/meta — last-ditch og:description + og:image (kept only as a floor).
//
// IMAGES: only the publisher's OWN, story-relevant photos. og:image is the editorial
// hero; in-body images are accepted ONLY if served from the SAME base domain as the
// hero (ads/widgets live on third-party hosts → excluded). A belt-list of known ad hosts
// backs it up. User: "images should be strictly related to story not any other. if you
// dont have it is fine" — so we return [] rather than anything off-topic.
//
// Fail-open everywhere: any failure returns null/[] and the caller keeps its fallback.

// @extractus/article-extractor is loaded LAZILY + OPTIONALLY. The shorts workflows don't
// always `npm install` (they were pure Node built-ins historically), and a missing package
// must NOT crash this module — JSON-LD + og:description still produce a good body without
// it. So we dynamic-import on first use and cache the result (the fn, or null if absent).
let _extractFromHtml; // undefined = not yet tried; null = tried + unavailable; fn = loaded
async function getExtractFromHtml() {
  if (_extractFromHtml !== undefined) return _extractFromHtml;
  try {
    const mod = await import('@extractus/article-extractor');
    _extractFromHtml = mod.extractFromHtml || null;
  } catch {
    _extractFromHtml = null; // package not installed on this runner — JSON-LD/og carry it
  }
  return _extractFromHtml;
}

const MIN_BODY = Number(process.env.EXTRACT_MIN_BODY || 400); // chars to trust a body

// ── entity decode (handles the &amp;#039; double-encoding common in JSON-LD) ──
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#039': "'", '#34': '"' };
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&([a-z0-9#]+);/gi, (m, e) => (e.toLowerCase() in NAMED ? NAMED[e.toLowerCase()] : m));
}
const stripTags = (h = '') => decodeEntities(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ── image domain gate (shared with shorts/world_feeds.articleImages) ──────────
// Registrable-ish base domain (eTLD+1 heuristic): last 2 labels, or 3 when the SLD is a
// public suffix like co/com (…bbci.co.uk → bbci.co.uk).
export function baseDomain(host) {
  const p = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const sld = p[p.length - 2];
  const useThree = /^(co|com|org|net|gov|ac|edu|or|go|ne)$/.test(sld) && p[p.length - 1].length <= 3;
  return p.slice(useThree ? -3 : -2).join('.');
}
// Third-party ad / tracking / analytics / social-widget image hosts → never story art.
export const AD_HOST =
  /doubleclick|googlesyndication|googleadservices|google-?analytics|googletagmanager|gstatic|adservice|adsystem|adnxs|amazon-adsystem|taboola|outbrain|criteo|scorecardresearch|quantserve|2mdn|zedo|pubmatic|rubiconproject|\bopenx\b|smartadserver|teads|sharethrough|indexww|casalemedia|moatads|adsafeprotected|bidswitch|360yield|mgid|revcontent|zergnet|gravatar|fbcdn|facebook\.com\/tr|connect\.facebook|analytics\.|\bpixel\.|\bads?\d*\.|\btrack(?:er|ing)?\./i;
// Non-photo / promo asset path patterns (logos, avatars, banners, tiny thumbs).
const BAD_PATH =
  /\.svg(?:$|\?)|sprite|logo|icon|favicon|avatar|placeholder|pixel|1x1|blank|press.?kit|product[-_]|screenshot|-copy|_copy|contributor|headshot|byline|disrupt|promo|banner|sponsor|newsletter|subscribe|advert|\bad[-_s]?\b/i;

// Normalise + gate ONE image URL against the publisher's own domain. Returns the clean
// https URL, or null if it's an ad / off-domain / non-photo asset. pubDomain '' = accept
// any (used when we couldn't learn the hero domain — the path blocklist still guards).
export function acceptImage(u, pubDomain = '') {
  if (!u) return null;
  let s = decodeEntities(String(u)).trim();
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https:\/\//i.test(s)) return null;
  let host = '';
  try { host = new URL(s).hostname; } catch { return null; }
  if (AD_HOST.test(host) || AD_HOST.test(s)) return null;
  if (pubDomain && baseDomain(host) !== pubDomain) return null;
  if (BAD_PATH.test(s)) return null;
  if (/[?&](?:w|width)=(?:\d{1,2}|1\d\d|2\d\d)\b/i.test(s)) return null; // tiny ≤299px
  return s;
}

// ── og:image / twitter:image (the editorial hero) ─────────────────────────────
export function ogImage(html) {
  const h = String(html || '');
  const m =
    h.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
    h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
    h.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
  if (!m) return null;
  const url = decodeEntities(m[1]).trim();
  return /^https:\/\//i.test(url) ? url : null;
}
function ogDescription(html) {
  const h = String(html || '');
  const m =
    h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// ── STEP 1: JSON-LD NewsArticle.articleBody (no DOM, fastest, often cleanest) ──
function jsonLdArticle(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const types = [].concat(n['@type'] || []);
      const isArticle = types.some((t) => /Article/i.test(String(t)));
      if (isArticle && typeof n.articleBody === 'string' && n.articleBody.trim().length >= MIN_BODY) {
        const images = [].concat(n.image || []).map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
        return {
          title: stripTags(n.headline || ''),
          text: decodeEntities(n.articleBody).replace(/\s+/g, ' ').trim(),
          images,
          lang: n.inLanguage || '',
          via: 'jsonld',
        };
      }
    }
  }
  return null;
}

// ── STEP 2: Readability (article-extractor over linkedom) ─────────────────────
async function readabilityArticle(html, url) {
  try {
    const extractFromHtml = await getExtractFromHtml();
    if (!extractFromHtml) return null; // package not installed → skip to og floor
    const a = await extractFromHtml(html, url);
    if (!a || !a.content) return null;
    const text = stripTags(a.content);
    if (text.length < 120) return null; // stub / paywall interstitial
    const inline = [...a.content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    return {
      title: stripTags(a.title || ''),
      text,
      images: [a.image, ...inline].filter(Boolean),
      lang: a.lang || '',
      via: 'readability',
    };
  } catch {
    return null;
  }
}

// ── PUBLIC: extract clean {title, text, images[], lang, via} from prefetched HTML ──
// Pass the HTML you already fetched (no extra request). url is used for absolute-URL
// resolution + the publisher-domain image gate. Returns null only if NOTHING usable.
export async function extractArticle(url, html) {
  const h = String(html || '');
  if (!h) return null;

  // Learn the publisher's editorial image domain from og:image (trusted host).
  const hero = ogImage(h);
  let pubDomain = '';
  if (hero) { try { pubDomain = baseDomain(new URL(hero).hostname); } catch { /* keep '' */ } }

  // Body: JSON-LD → Readability → og:description floor.
  const primary = jsonLdArticle(h) || (await readabilityArticle(h, url));
  const text = primary?.text || ogDescription(h);
  if (!text) return null;

  // Images: hero first, then the winner's images, gated to the publisher's own domain +
  // ad-filtered. Deduped, capped. Empty is acceptable (caller falls back to brand card).
  const raw = [hero, ...(primary?.images || [])];
  const images = [];
  for (const u of raw) {
    const ok = acceptImage(u, pubDomain);
    if (ok && !images.includes(ok)) images.push(ok);
    if (images.length >= 10) break;
  }

  return {
    title: primary?.title || '',
    text,
    images,
    lang: primary?.lang || '',
    via: primary?.via || 'og',
  };
}

// ── PUBLIC: fetch + extract in one call (best-effort, timed) ──────────────────
export async function fetchAndExtract(url, { timeoutMs = 12000, ua } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await extractArticle(url, await r.text());
  } catch {
    return null;
  }
}
