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

// Resolve a Google News RSS redirect (news.google.com/rss/articles/<id>) to the
// REAL publisher URL. GNews encrypts the id, but the article page carries a
// signature (data-n-a-sg) + timestamp (data-n-a-ts) that its own batchexecute
// endpoint uses to return the real URL — the only reliable way (verified). We need
// this so we can (a) fetch the publisher's og:IMAGE (GNews serves none) and (b)
// give the card the real article link + domain (better attribution/favicons).
// Best-effort: returns null on any failure → caller keeps the GNews link.
async function resolveGoogleNewsUrl(gnewsUrl, timeoutMs = 8000) {
  try {
    const m = gnewsUrl.match(/\/articles\/([^?]+)/);
    if (!m) return null;
    const id = m[1];
    const page = await fetch(gnewsUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!page.ok) return null;
    const html = await page.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/);
    const ts = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sg || !ts) return null;
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, ts[1], sg[1]]);
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const txt = await r.text();
    const real = txt.match(/https?:\/\/(?!news\.google)[^\\"\s]+/);
    return real ? real[0] : null;
  } catch {
    return null;
  }
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

// Parse Google News RSS <item>s → Article[]. Shared by the search feed and the
// top/section feeds (identical item shape). Each item has a clean
// "<source url=...>Outlet</source>" (name + domain) + pubDate; the <link> is a
// news.google.com redirect (opaque) that resolves in a browser — we keep it as the
// article URL but derive outlet + domain from <source> for attribution/favicons.
function parseNewsItems(xml, { category = 'top', buzzTerm = null, limit = 20 } = {}) {
  const out = [];
  for (const [, block] of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, limit)) {
    let title = tag(block, 'title');
    const link = tag(block, 'link');
    const pub = tag(block, 'pubDate');
    const srcMatch = block.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    const sourceUrl = srcMatch ? srcMatch[1] : '';
    const sourceName = srcMatch ? decode(srcMatch[2]) : 'Google News';
    if (!title || !link) continue;
    // Skip non-article sources: social platforms + org homepages Google sometimes
    // surfaces (facebook/x/instagram/party sites) — not news events, pollute the pool.
    if (/(facebook|twitter|x|instagram|threads|tiktok|reddit)\.com|\.org$|bjp\.|inc\.in/i.test(sourceUrl)) continue;
    // Google News appends " - Outlet" to the title; strip it (we have the source).
    if (sourceName && title.endsWith(` - ${sourceName}`)) title = title.slice(0, -(sourceName.length + 3)).trim();
    out.push({
      title,
      url: link,
      sourceName,
      sourceUrl: sourceUrl || undefined,
      snippet: title, // GNews descriptions are HTML link lists — use the title
      imageUrl: null,
      publishedAt: pub ? new Date(pub).toISOString() : null,
      category,
      via: 'buzz',
      buzzTerm,
    });
  }
  return out;
}

// Fresh articles for one search TERM via Google News search RSS.
async function fetchNewsForTerm(term, opts) {
  const hl = opts.hl || 'en-IN';
  const geo = opts.geo || 'IN';
  const ceid = `${geo}:${hl.split('-')[0]}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
  const xml = await getXml(url).catch(() => null);
  if (!xml) return [];
  return parseNewsItems(xml, { category: 'top', buzzTerm: term, limit: Number(opts.perTerm || 5) });
}

// Google News's OWN feeds — the broad "latest Google News" firehose the user asked
// for: the TOP-headlines feed + each SECTION topic feed. These carry the SAME event
// from MANY outlets (verified 38-70 items each), so they add real corroboration +
// section balance on top of the trend-driven search results. Each section maps to
// our category. All run in parallel; a dead feed just yields []. Off via
// BUZZ_GNEWS_FEEDS=0.
const GNEWS_SECTIONS = [
  { topic: null, category: 'top' }, // top headlines (no topic path)
  { topic: 'WORLD', category: 'world' },
  { topic: 'NATION', category: 'top' },
  { topic: 'BUSINESS', category: 'business' },
  { topic: 'TECHNOLOGY', category: 'tech' },
  { topic: 'ENTERTAINMENT', category: 'entertainment' },
  { topic: 'SPORTS', category: 'sports' },
  { topic: 'SCIENCE', category: 'science' },
  { topic: 'HEALTH', category: 'health' },
];
async function fetchGoogleNewsFeeds(opts) {
  const hl = opts.hl || 'en-IN';
  const geo = opts.geo || 'IN';
  const ceid = `${geo}:${hl.split('-')[0]}`;
  const perFeed = Number(process.env.BUZZ_GNEWS_PER_FEED || 12);
  const qs = `hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
  const lists = await Promise.all(
    GNEWS_SECTIONS.map(async ({ topic, category }) => {
      const url = topic
        ? `https://news.google.com/rss/headlines/section/topic/${topic}?${qs}`
        : `https://news.google.com/rss?${qs}`;
      const xml = await getXml(url).catch(() => null);
      return xml ? parseNewsItems(xml, { category, buzzTerm: null, limit: perFeed }) : [];
    }),
  );
  const arts = lists.flat();
  opts.log('buzz.gnews_feeds', { sections: GNEWS_SECTIONS.length, articles: arts.length });
  return arts;
}

// Per-CATEGORY trend probes. Google News has topic RSS feeds + we add category
// "what's trending" search queries, so the buzz cron surfaces the hot item in EACH
// desk (not just whatever's #1 overall) → a balanced, always-fresh feed across
// entertainment/sports/tech/business/etc. Each maps to a category tag so the app's
// sections stay populated. Tunable via BUZZ_CATEGORIES (comma of key:query pairs).
const DEFAULT_CATEGORY_PROBES = [
  { category: 'entertainment', q: 'trending movie OR OTT OR web series OR trailer India' },
  { category: 'sports', q: 'trending cricket OR football OR match India today' },
  { category: 'tech', q: 'trending AI OR gadget OR smartphone OR app launch' },
  { category: 'business', q: 'trending stock OR IPO OR company OR economy India' },
  { category: 'politics', q: 'trending India politics OR election OR government today' },
  { category: 'world', q: 'trending world news today' },
];

// Fetch the buzzing news: (1) Google Trends "searched right now" terms, (2) per-
// category trend probes, (3) any always-on queries → Google News → merged, deduped
// Article[]. Best-effort throughout ([] on total failure).
export async function fetchBuzz(opts = {}) {
  const log = opts.log || (() => {});
  const o = {
    geo: process.env.BUZZ_GEO || 'IN',
    hl: process.env.BUZZ_HL || 'en-IN',
    perTerm: Number(process.env.BUZZ_PER_TERM || 5),
    log,
  };
  const maxTerms = Number(process.env.BUZZ_MAX_TERMS || 10);
  // ALWAYS-ON WATCH TERMS — the fix for "ramayana is buzzing on Twitter but Trends
  // doesn't list it". Google Trends only surfaces the last few HOURS' search spikes,
  // so SUSTAINED buzz (a film in its release window, an ongoing controversy) that
  // social media still talks about isn't a live search trend — and we'd never query
  // it. These are searched EVERY run regardless of Trends. Verified: "ramayana" has
  // 104 fresh GNews results right now but was absent from the Trends top-8. Curated
  // India evergreen-buzz seeds; extend/replace via BUZZ_EXTRA_QUERIES (comma list).
  const DEFAULT_WATCH = [
    'Ramayana movie Ranbir Kapoor', 'Bollywood box office', 'ICC cricket India',
    'IPL', 'Indian stock market Sensex Nifty', 'ISRO', 'Supreme Court India verdict',
    'iPhone OR Android launch India', 'OTT release this week India',
  ];
  const extraEnv = (process.env.BUZZ_EXTRA_QUERIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  // BUZZ_EXTRA_QUERIES REPLACES the defaults when set; BUZZ_WATCH_DEFAULT=0 disables
  // the built-in list (use only env). Otherwise defaults + any env additions.
  const extra = extraEnv.length ? extraEnv : (process.env.BUZZ_WATCH_DEFAULT === '0' ? [] : DEFAULT_WATCH);
  const withCategories = process.env.BUZZ_CATEGORIES !== '0'; // per-category probes (on by default)
  const t0 = Date.now();

  const results = [];
  // (1) Google News's OWN feeds (top + sections) — the broad "latest Google News"
  // firehose — run in PARALLEL with the trend-driven flow below. Off via
  // BUZZ_GNEWS_FEEDS=0. This is what carries the same event from MANY outlets →
  // corroboration + section balance the trend searches alone don't give.
  const gnewsP = process.env.BUZZ_GNEWS_FEEDS === '0' ? Promise.resolve([]) : fetchGoogleNewsFeeds(o).catch(() => []);

  // (2) Trend-driven: Google Trends "searched now" terms + always-on extras +
  // per-category probes → News search each. termCat maps term→desk.
  const trending = await fetchTrendingTerms(o);
  const termCat = new Map();
  for (const t of [...trending.slice(0, maxTerms), ...extra]) termCat.set(t, null);
  if (withCategories) for (const p of DEFAULT_CATEGORY_PROBES) if (!termCat.has(p.q)) termCat.set(p.q, p.category);
  const terms = [...termCat.keys()];

  const CONC = Number(process.env.BUZZ_CONCURRENCY || 6);
  let idx = 0;
  async function worker() {
    while (idx < terms.length) {
      const term = terms[idx++];
      const cat = termCat.get(term); // category-probe desk, or null for generic trends
      try {
        const arts = await fetchNewsForTerm(term, o);
        if (cat) for (const a of arts) a.category = cat; // stamp the probe's desk
        results.push(...arts);
      } catch { /* skip a bad term */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, terms.length)) }, worker));
  results.push(...(await gnewsP)); // fold in the Google News feed articles

  // Dedup by normalised URL (search + feeds overlap heavily on hot events).
  const seen = new Set();
  const deduped = [];
  for (const a of results) {
    const key = String(a.url || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  // RESOLVE + IMAGE ENRICH. GNews items have NO image and an opaque redirect link.
  // Resolve each to the real publisher URL, then fetch its og:image — so buzz cards
  // get the REAL article photo (+ a real article link + domain for attribution).
  // Concurrency-capped, best-effort (a failure keeps the GNews link, imageless →
  // the web's topical fallback covers it). Bounded to BUZZ_RESOLVE_MAX to keep the
  // 30-min cron fast. Off via BUZZ_RESOLVE=0.
  if (process.env.BUZZ_RESOLVE !== '0' && deduped.length) {
    const cap = Number(process.env.BUZZ_RESOLVE_MAX || 60);
    const targets = deduped.slice(0, cap);
    const conc = Number(process.env.BUZZ_RESOLVE_CONCURRENCY || 8);
    let ri = 0, resolved = 0, withImg = 0, withVid = 0;
    async function rworker() {
      while (ri < targets.length) {
        const a = targets[ri++];
        const real = await resolveGoogleNewsUrl(a.url).catch(() => null);
        if (!real) continue;
        a.url = real; // real publisher link (better than the GNews redirect)
        resolved++;
        try {
          const meta = await fetchOgMeta(real);
          if (meta.image) { a.imageUrl = meta.image; withImg++; }
          if (meta.video) { a.videoUrl = meta.video; withVid++; } // YouTube/embed → card plays it
        } catch { /* keep imageless → web fallback */ }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, targets.length)) }, rworker));
    log('buzz.resolve', { attempted: targets.length, resolved, withImage: withImg, withVideo: withVid });
  }

  log('buzz.done', { terms: terms.length, trending: trending.length, extra: extra.length, articles: deduped.length, withImage: deduped.filter((a) => a.imageUrl).length, ms: Date.now() - t0 });
  return deduped;
}

// Pull a meta/link content value by property/name — tolerant of ATTRIBUTE ORDER
// (content before OR after property=), which a single regex misses and is a common
// reason og:image "isn't found" on real pages. Returns the trimmed value or null.
function metaContent(html, key) {
  // property/name="key" ... content="val"   AND   content="val" ... property/name="key"
  const k = key.replace(/[:]/g, '\\:');
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*?\\scontent=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?\\s(?:property|name)=["']${k}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m && m[1] ? m[1].trim() : null;
}

// Normalise an extracted image URL: decode entities, allow protocol-relative (//x)
// by forcing https, reject data:/non-http. https-only (mixed-content safe).
function cleanImg(u) {
  if (!u) return null;
  let s = u.replace(/&amp;/g, '&').trim();
  if (s.startsWith('//')) s = 'https:' + s;
  if (s.startsWith('http://')) s = 'https://' + s.slice(7); // upgrade (most CDNs serve https)
  return /^https:\/\/.+\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(s) || /^https:\/\//i.test(s) ? s : null;
}

// Fetch article IMAGE + any YOUTUBE/VIDEO from a resolved publisher URL, ONE request.
// Robust image extraction — tries, in order: og:image(:url/:secure_url),
// twitter:image(:src), <link rel=image_src>, JSON-LD "image", then the first large
// content <img>. Returns { image, video } (either may be null). Timeout-bounded.
async function fetchOgMeta(url, timeoutMs = 7000) {
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        // Browser-like headers cut bot-blocks that otherwise return a stub w/o og tags.
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { image: null, video: null };
    const html = (await r.text()).slice(0, 400000);

    // IMAGE — ordered fallbacks (og is best; the rest catch partial-tagged pages).
    let image =
      cleanImg(metaContent(html, 'og:image:secure_url')) ||
      cleanImg(metaContent(html, 'og:image:url')) ||
      cleanImg(metaContent(html, 'og:image')) ||
      cleanImg(metaContent(html, 'twitter:image')) ||
      cleanImg(metaContent(html, 'twitter:image:src'));
    if (!image) {
      const lnk = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
      image = cleanImg(lnk && lnk[1]);
    }
    if (!image) {
      // JSON-LD: "image":"..." or "image":["..."] or "image":{"url":"..."}
      const ld = html.match(/"image"\s*:\s*(?:\[\s*)?(?:\{[^}]*?"url"\s*:\s*)?["'](https?:\/\/[^"']+)["']/i);
      image = cleanImg(ld && ld[1]);
    }

    // YOUTUBE first (most common embedded article video), then og:video.
    const yt = html.match(/(?:youtube\.com\/(?:watch\?[^"'\s<]*v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    let video = yt && yt[1] ? `https://www.youtube.com/watch?v=${yt[1]}` : null;
    if (!video) {
      const v = metaContent(html, 'og:video:secure_url') || metaContent(html, 'og:video:url') || metaContent(html, 'og:video');
      if (v && (/youtube\.com|youtu\.be/i.test(v) || /^https:\/\/[^\s"']+\.(?:mp4|webm|m3u8)/i.test(v))) {
        video = /youtube\.com|youtu\.be/i.test(v) ? v.replace(/\/embed\/([A-Za-z0-9_-]{11})/, '/watch?v=$1') : v;
      }
    }
    return { image, video };
  } catch {
    return { image: null, video: null };
  }
}
