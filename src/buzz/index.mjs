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

import { readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

// USER-CURATED KEYWORDS (keywords.txt at repo root). The user maintains this
// file; every run each line is searched on Google News EQUAL-WEIGHT with the
// auto Google-Trends terms (user's call: "both, equal weight"). This is the
// reliable steering lever — a curated topic returns real events, whereas raw
// Trends terms are noisy regional single-words. Format per line:
//   "keyword"            → generic (triage categorises)
//   "category: keyword"  → forces that desk
//   "# comment" / blank  → ignored
// Returns [{ q, category|null }]. Missing/empty file → [] (Trends still drives).
// Disable with BUZZ_KEYWORDS_FILE= (empty).
const VALID_CATS = new Set(['top', 'politics', 'business', 'world', 'sports', 'science', 'tech', 'entertainment', 'health', 'local']);
function loadKeywordProbes(log = () => {}) {
  const path = process.env.BUZZ_KEYWORDS_FILE ?? new URL('../../keywords.txt', import.meta.url).pathname;
  if (!path) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // no file → Trends-only, silently
  }
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-z]+):\s*(.+)$/i);
    if (m && VALID_CATS.has(m[1].toLowerCase())) {
      out.push({ q: m[2].trim(), category: m[1].toLowerCase() });
    } else {
      out.push({ q: line, category: null });
    }
  }
  log('buzz.keywords', { file: path, probes: out.length });
  return out;
}

// Channel-BRANDING/promo YouTube IDs some publishers declare in og:video /
// twitter:player on EVERY article page — they're not the story's video and mismatch
// every headline. Never attach these. Extend via BUZZ_PROMO_VIDEO_IDS (comma list).
const PROMO_VIDEO_IDS = new Set([
  'T50u-Ka1XAs', // Hindustan Times@100 — Voice Of The Nation (HT sitewide promo)
  ...(process.env.BUZZ_PROMO_VIDEO_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // NUMERIC entities first (hex + decimal), THEN named — and &amp; LAST so a
    // double-encoded "&amp;apos;" resolves cleanly (→ &apos; → '). &apos; was
    // MISSING → "&apos;Focus On…" leaked into titles.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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
// Generic/noise trend terms that pull junk (homepages/social links, not events).
const TREND_GENERIC = /^(video|वीडियो|photos|images|wealth|news|live|today|watch|game|movie|result|results|score|scores)$/i;
// UTILITY-SEARCH trends — people googling a tool/how-to, NOT a news event. These
// spike constantly ("aadhaar download", "pan card", "ration card status", exam
// results) and returned no real story → filter them out. (Live IN Trends is full
// of these.) Matches the whole term OR an obvious utility phrase within it.
const TREND_UTILITY = /\b(aadhaar|pan card|ration card|voter (id|list)|download|apply online|status check|admit card|answer key|hall ticket|result 20\d\d|scholarship|e-?shram|umang|digilocker|ipo gmp|login|password)\b/i;
// LANGUAGE gate. Agyata's editions are World (English) and Bharat (Hindi). There is
// NO Malayalam/Tamil/Kannada/Telugu/Bengali/Gujarati/Punjabi edition — yet raw IN
// Google Trends is dominated by bare regional-script search terms (actor names, TV
// serials, astrology in those scripts) whose searches return regional-language junk
// this feed can't publish and the English editor mis-judges. So we KEEP only text
// that is mostly Latin/English OR mostly Devanagari (Hindi/Marathi) and DROP other
// Indic scripts. Devanagari range ऀ-ॿ; the dropped scripts are enumerated.
// Bengali/Gurmukhi/Gujarati/Odia/Tamil/Telugu/Kannada/Malayalam letter ranges.
const OTHER_INDIC_SRC = '[\\u0980-\\u09FF\\u0A00-\\u0A7F\\u0A80-\\u0AFF\\u0B00-\\u0B7F\\u0B80-\\u0BFF\\u0C00-\\u0C7F\\u0C80-\\u0CFF\\u0D00-\\u0D7F]';
const OTHER_INDIC_G = new RegExp(OTHER_INDIC_SRC, 'g');
function languageUsable(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const letters = t.replace(/[^\p{L}]/gu, ''); // count only letters (ignore digits/punct)
  if (!letters) return true; // all digits/punct (e.g. a scoreline) — let other gates decide
  const otherIndic = (letters.match(OTHER_INDIC_G) || []).length;
  return otherIndic / letters.length < 0.3; // <30% non-Hindi-Indic script → usable
}
// A trend term is USABLE as a search seed only if it isn't generic/utility noise and
// is in a language we publish (English or Hindi). This is why "ജോജു ജോര്ജ്" /
// "மஹாஷனிமாற்றம்"-style regional trends — the bulk of raw IN Trends — stop leaking in.
function trendUsable(term) {
  const t = (term || '').trim();
  if (t.length <= 2) return false;
  if (TREND_GENERIC.test(t)) return false;
  if (TREND_UTILITY.test(t)) return false;
  if (!languageUsable(t)) return false;
  return true;
}
// ARTICLE-level junk beyond the term filters: astrology/prediction (in EN or Hindi
// transliteration — the term filter can't see these until the article title is back)
// and TV-serial episode pages (soap-opera episodes, not news). Applied to every buzz
// article title regardless of source.
const ARTICLE_JUNK = /\b(horoscope|rashifal|rashi|zodiac|kundli|kundali|astrolog|shani|numerolog|tarot|panchang|lucky (number|colour|color))\b|\b(ep\.?\s*#?\d+|episode\s*\d+|full episode|written update|season\s*\d+\s*(launch|promo)?)\b/i;

async function fetchTrendingTerms(opts) {
  const geo = opts.geo || 'IN';
  const xml = await getXml(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`).catch(() => null);
  if (!xml) { opts.log('buzz.trends_failed', { geo }); return []; }
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const terms = [];
  let dropped = 0;
  for (const [, block] of items) {
    const t = tag(block, 'title');
    if (!t) continue;
    if (trendUsable(t)) terms.push(t);
    else dropped++;
  }
  opts.log('buzz.trends', { geo, terms: terms.length, dropped });
  return terms;
}

// X (TWITTER) TRENDING TERMS — Pipeline 1's PRIMARY signal (user: "pick the trending
// topic from X ... and publish with google news etc"). trends24.in is a long-running
// free mirror of X's own "Trending" panel (no key, no auth). Each X trend is just a
// TERM/hashtag ("Netanyahu", "#Budget2026") — NOT a story — so, exactly like the
// Google-Trends path, we DON'T show any X/Twitter content. We hand each hot term to
// the SAME term→GoogleNews-search→resolve→og-image chain the rest of buzz uses, so a
// trend surfaces as the professionally-reported publisher article it points at
// (monetization-safe: outlet's OWN text + image, never a tweet/avatar/screenshot).
// trends24 uses country SLUGS; map the buzz geo. Returns [term, …]; [] on any failure
// so Pipeline 1 degrades to Google Trends + watch terms. Off via BUZZ_X_TRENDS=0.
const X_GEO_SLUG = {
  IN: 'india', US: 'united-states', GB: 'united-kingdom', worldwide: 'worldwide',
};
// Reuse the trend-term quality gate (generic/utility/regional-script) — an X board is
// also full of fandom/meme/utility tags a Google-News lookup would waste a call on.
async function fetchXTrendingTerms(opts) {
  const geo = (process.env.BUZZ_X_GEO || opts.geo || 'IN').trim();
  const slug = X_GEO_SLUG[geo] || geo.toLowerCase();
  let html = '';
  try {
    const r = await fetch(`https://trends24.in/${slug}/`, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { opts.log('buzz.x_trends_failed', { slug, status: r.status }); return []; }
    html = await r.text();
  } catch (e) {
    opts.log('buzz.x_trends_failed', { slug, err: e.message });
    return [];
  }
  // The FIRST <ol class=trend-card__list> is the most-recent snapshot (served attrs are
  // unquoted, so the class match tolerates optional quotes). Fall back to whole doc.
  const card = html.match(/<ol class="?trend-card__list"?>([\s\S]*?)<\/ol>/i);
  const scope = card ? card[1] : html;
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const m of scope.matchAll(/<a href="https:\/\/twitter\.com\/search\?q=[^"]*"\s+class="?trend-link"?>([^<]+)<\/a>/gi)) {
    const term = decode(m[1]).replace(/^#/, '').trim(); // drop the leading # so GNews searches the phrase
    const k = term.toLowerCase();
    if (!term || seen.has(k)) continue;
    if (!trendUsable(term)) { dropped++; continue; } // same generic/utility/regional gate as Google Trends
    seen.add(k);
    out.push(term);
  }
  opts.log('buzz.x_trends', { slug, terms: out.length, dropped });
  return out;
}

// Trends RSS carries FAR more than the term string: each <item> has 1-3
// <ht:news_item> blocks with a REAL publisher URL + title + source + a real IMAGE
// (<ht:news_item_picture>), plus the term's <ht:approx_traffic> (search volume).
// Reading these DIRECTLY is strictly better than our term→GoogleNews-search→resolve
// chain: real links + real images come FREE, no extra fetches. This yields the
// freshest, most-searched India stories with media attached. Junk/ad-ish trends
// (lottery/jackpot/result/horoscope/exam-result/betting — user: "some ads, filter
// out") are dropped. Returns Article[] tagged via='buzz'.
const TREND_JUNK = /\b(lottery|jackpot|satta|matka|result today|results? today|admit card|answer key|hall ticket|horoscope|rashifal|betting|casino|coupon|promo code|sarkari result|recruitment|vacancy|aadhaar download|pan card|ration card|voter (id|list)|apply online|status check|scholarship|digilocker)\b/i;

// STALE-TEMPLATE URL filter — the fix for "Cricbuzz always shows very old
// updates". Sports sites expose PERPETUAL template pages (live-scores, scorecards,
// fixtures, points tables, series landing) whose URL never changes, so once
// ingested they re-surface forever and read as stale ("...- Scorecard" with no
// real content). We are an RSS/news pipeline, not a live-score API — so instead of
// trying to keep a live score fresh, we DROP these template URLs and let the actual
// match REPORT articles (which are fresh + informative) surface instead.
const STALE_TEMPLATE_URL =
  /(cricbuzz\.com\/(live-cricket-scores|cricket-scorecard|cricket-match-facts|cricket-series|cricket-schedule)|espncricinfo\.com\/(series|live-cricket-score|ci\/engine\/match)|\/live-score|\/scorecard|\/points-table|\/live-blog|\/fixtures?\b|\/standings)/i;
// Title guard is DELIBERATELY narrow — only bare template labels, never news
// phrasings. "India announces squad…" / "…points table shake-up" are real stories,
// so 'squad'/'points table' are NOT here; we match the tail-label form only.
const STALE_TEMPLATE_TITLE = /(-\s*(scorecard|live\s?score|points\s?table)\s*$|\bfull\s+scorecard\b|\blive\s+cricket\s+score\b)/i;

// A buzz article is a stale template page (skip it) when its URL matches a known
// perpetual page, OR its title is a bare template label with no news verb.
function isStaleTemplate(url, title) {
  if (url && STALE_TEMPLATE_URL.test(url)) return true;
  // Title-only guard: "ZIM vs IND, 1st T20I ... - Scorecard" style labels.
  if (title && STALE_TEMPLATE_TITLE.test(title)) return true;
  return false;
}
async function fetchTrendingArticles(opts) {
  const geo = opts.geo || 'IN';
  const xml = await getXml(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`).catch(() => null);
  if (!xml) return [];
  const perTrend = Number(process.env.BUZZ_TREND_ARTICLES || 2); // top N attached articles per trend
  const out = [];
  for (const [, block] of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]) {
    const term = tag(block, 'title');
    if (!term || TREND_JUNK.test(term) || !trendUsable(term)) continue; // drop junk/ad/regional trends up front
    const traffic = tag(block, 'ht:approx_traffic'); // e.g. "10000+"
    const trafficN = Number((traffic || '').replace(/[^\d]/g, '')) || 0;
    const newsItems = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi)];
    let kept = 0;
    for (const [, ni] of newsItems) {
      if (kept >= perTrend) break;
      const title = tag(ni, 'ht:news_item_title');
      const url = tag(ni, 'ht:news_item_url');
      const img = tag(ni, 'ht:news_item_picture');
      const src = tag(ni, 'ht:news_item_source');
      if (!title || !url || !/^https?:\/\//i.test(url)) continue;
      if (TREND_JUNK.test(title) || ARTICLE_JUNK.test(title)) continue; // article-level junk filter
      if (!languageUsable(title)) continue; // non-EN/HI regional-script article
      if (isStaleTemplate(url, title)) continue; // drop perpetual scorecard/live-score pages
      out.push({
        title,
        url,
        sourceName: src || 'Google News',
        sourceUrl: url,
        snippet: title, // Trends gives no snippet; og-enrich can fill later if wanted
        imageUrl: img && /^https:\/\//i.test(img) ? img : null, // real article image, FREE
        publishedAt: null, // trend items are current by definition; freshness via the tab
        category: 'top',
        via: 'buzz',
        buzzTerm: term,
        trafficN, // search volume — a popularity signal (used to boost score)
      });
      kept++;
    }
  }
  opts.log('buzz.trend_articles', { articles: out.length, withImage: out.filter((a) => a.imageUrl).length });
  return out;
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
    if (isStaleTemplate(link, title)) continue; // drop perpetual scorecard/live-score pages
    // Article-level junk: astrology/horoscope + TV-serial episode pages ("… EP #610",
    // "written update") — a search term like a serial's actor pulls these; not news.
    if (ARTICLE_JUNK.test(title) || TREND_JUNK.test(title)) continue;
    // LANGUAGE: drop non-English/Hindi regional-script articles (no such edition).
    // A regional term/serial returns Malayalam/Tamil headlines our feed can't use.
    if (!languageUsable(title)) continue;
    // Skip non-article sources: social platforms + org homepages Google sometimes
    // surfaces (facebook/x/instagram/party sites) — not news events, pollute the pool.
    if (/(facebook|twitter|x|instagram|threads|tiktok|reddit)\.com|\.org$|bjp\.|inc\.in/i.test(sourceUrl)) continue;
    // LOW-TRUST source filter (#5 quality — reliable news only). Google News is
    // already well-curated (verified: 101/102 outlets reputable), so this just drops
    // the occasional content-farm/blog/aggregator that slips in. Opt out: BUZZ_TRUST=0.
    if (process.env.BUZZ_TRUST !== '0' && /blogspot|wordpress|\.medium\.com|substack|\.info\b|\bblog\b|gossip|\bviral\b|clickb|content-?farm|sarkari|jagranjosh|freejobalert/i.test(`${sourceUrl} ${sourceName}`)) continue;
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

// YOUTUBE TRENDING — real trending VIDEOS (user: "video improves quality; where's
// the YouTube trending RSS?"). Google's own Trending channel RSS
// (channel UCBR8-60-B28hp2BmDPdntcQ) returns 15 items each with <yt:videoId> +
// <media:thumbnail> — no scraping. Each becomes a video-first article (videoUrl set
// to the canonical watch URL, imageUrl to the YT thumbnail). Off via BUZZ_YT=0.
// Note: YouTube's global trending skews US/creator content; keep the count modest
// so it garnishes the feed with video rather than dominating the India news mix.
// YouTube channels to pull trending VIDEO from (user: news + creator mix). Each is
// {id, category, perChannel}. INDIA NEWS channels (verified live: NDTV/India Today/
// Aaj Tak/WION/Republic/Zee/The Hindu) give relevant news video; the GLOBAL trending
// channel adds creator/entertainment variety. Override the whole set via
// BUZZ_YT_CHANNELS ("id:category,id:category,..."); per-channel cap BUZZ_YT_PER_CHANNEL.
const YT_CHANNELS = [
  { id: 'UCZFMm1mMw0F81Z37aaEzTUA', category: 'top' }, // NDTV
  { id: 'UCYPvAwZP8pZhSMW8qs7cVCw', category: 'top' }, // India Today
  { id: 'UCt4t-jeY85JegMlZ-E5UWtA', category: 'top' }, // Aaj Tak (Hindi)
  { id: 'UC_gUM8rL-Lrg6O3adPW9K1g', category: 'world' }, // WION
  { id: 'UCwqusr8YDwM-3mEYTDeJHzw', category: 'top' }, // Republic
  { id: 'UCIvaYmXn910QMdemBG3v1pQ', category: 'top' }, // Zee News
  { id: 'UCI_7rpgXm-AQY62ZaE87dIw', category: 'top' }, // The Hindu
  { id: 'UCBR8-60-B28hp2BmDPdntcQ', category: 'entertainment' }, // YouTube global Trending (creator mix)
];
function ytChannels() {
  const env = (process.env.BUZZ_YT_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.length) return YT_CHANNELS;
  return env.map((pair) => { const [id, category] = pair.split(':'); return { id, category: category || 'top' }; });
}

// RECENT-only window for YouTube video (user: "all recent only"). A trending clip
// stops being buzz fast; default 24h. Older channel uploads are skipped.
const YT_MAX_AGE_H = Number(process.env.BUZZ_YT_MAX_AGE_H || 24);
// Parse ONE channel's RSS → video-native articles. `perChannel` caps how many we
// KEEP (so no single channel floods) after recency + junk filtering.
function parseYouTubeFeed(xml, category, perChannel) {
  const out = [];
  const cutoff = Date.now() - YT_MAX_AGE_H * 3.6e6;
  for (const [, block] of [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]) {
    if (out.length >= perChannel) break;
    const vid = (block.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
    const title = tag(block, 'title');
    const pub = tag(block, 'published');
    const thumb = (block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) || [])[1];
    const author = (block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i) || [])[1];
    const desc = (block.match(/<media:description>([\s\S]*?)<\/media:description>/i) || [])[1];
    if (!vid || !title) continue;
    // RECENT ONLY — skip anything older than the window.
    const pubMs = pub ? Date.parse(pub) : NaN;
    if (!Number.isNaN(pubMs) && pubMs < cutoff) continue;
    // Skip 24x7 LIVE-stream loops + shorts/podcast-y noise (not discrete news video).
    if (/\bLIVE TV\b|24x7|live stream|#shorts|full episode|podcast/i.test(title)) continue;
    const body = desc ? decode(desc).replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    out.push({
      title,
      url: `https://www.youtube.com/watch?v=${vid}`,
      sourceName: author ? decode(author) : 'YouTube',
      sourceUrl: 'https://www.youtube.com',
      snippet: body && body.length > 40 ? body : title,
      imageUrl: thumb && /^https:\/\//i.test(thumb) ? thumb : `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      videoUrl: `https://www.youtube.com/watch?v=${vid}`, // VIDEO-FIRST
      publishedAt: pub ? new Date(pub).toISOString() : null,
      category,
      via: 'buzz',
      buzzTerm: null,
      // A video IS the content — no article body to synthesise. Publish directly
      // (extractive) + relax the body gates.
      videoNative: true,
    });
  }
  return out;
}

// Fetch trending video from all configured channels (India news + global), parallel.
// Video is MIXED into the feed, not flooding it: per-channel cap (BUZZ_YT_PER_CHANNEL,
// default 2) AND a GLOBAL cap (BUZZ_YT_TOTAL, default 10) — round-robin across
// channels so the total is spread (not all from one channel), keeping the feed
// mostly text news with video as a garnish.
async function fetchYouTubeTrending(opts) {
  const channels = ytChannels();
  const perChannel = Number(process.env.BUZZ_YT_PER_CHANNEL || 2);
  const total = Number(process.env.BUZZ_YT_TOTAL || 10);
  const lists = await Promise.all(
    channels.map(async ({ id, category }) => {
      const xml = await getXml(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`).catch(() => null);
      return xml ? parseYouTubeFeed(xml, category, perChannel) : [];
    }),
  );
  // Round-robin interleave so the global cap draws EVENLY across channels (one from
  // each, then a second from each, …) rather than exhausting the first channel.
  const out = [];
  for (let i = 0; out.length < total; i++) {
    let added = false;
    for (const list of lists) {
      if (list[i]) { out.push(list[i]); added = true; if (out.length >= total) break; }
    }
    if (!added) break; // all lists exhausted
  }
  opts.log('buzz.youtube', { channels: channels.length, videos: out.length, cap: total });
  return out;
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
  // YouTube trending videos (video-first items) — also in parallel. Off via BUZZ_YT=0.
  const ytP = process.env.BUZZ_YT === '0' ? Promise.resolve([]) : fetchYouTubeTrending(o).catch(() => []);
  // TRENDS ATTACHED ARTICLES — read the real publisher URLs + IMAGES already inside
  // the Trends RSS (fresher + images FREE, no search/resolve). Off via BUZZ_TREND_ARTICLES=0.
  const trendArtP = process.env.BUZZ_TREND_ARTICLES === '0' ? Promise.resolve([]) : fetchTrendingArticles(o).catch(() => []);

  // (2) Trend-driven: X (Twitter) trending terms + Google Trends "searched now" terms +
  // always-on extras + per-category probes → News search each. termCat maps term→desk.
  // X TRENDS LEAD (user: Pipeline 1 = "pick the trending topic from X"): we prepend the
  // live X board so its hottest terms are searched first; Google Trends + watch terms
  // fill behind it. Off via BUZZ_X_TRENDS=0. Both are the SAME free term→GNews chain.
  const xTrends = process.env.BUZZ_X_TRENDS === '0' ? [] : await fetchXTrendingTerms(o).catch(() => []);
  const maxXTerms = Number(process.env.BUZZ_X_MAX_TERMS || 12);
  const trending = await fetchTrendingTerms(o);
  const termCat = new Map();
  for (const t of [...xTrends.slice(0, maxXTerms), ...trending.slice(0, maxTerms), ...extra]) termCat.set(t, null);
  if (withCategories) for (const p of DEFAULT_CATEGORY_PROBES) if (!termCat.has(p.q)) termCat.set(p.q, p.category);
  // (2b) USER-CURATED KEYWORDS (keywords.txt) — searched EQUAL-WEIGHT with Trends
  // (user: "both, equal weight"). Each carries its own desk when the line prefixed
  // one (else null → triage categorises). This is the primary steering lever; the
  // curated topic set is far cleaner than raw IN Trends terms. Off via
  // BUZZ_KEYWORDS_FILE= (empty). A curated term overrides a same-string trend's
  // null desk so the user's category wins.
  const keywordProbes = process.env.BUZZ_KEYWORDS === '0' ? [] : loadKeywordProbes(log);
  for (const p of keywordProbes) if (!termCat.has(p.q) || p.category) termCat.set(p.q, p.category);
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
  results.push(...(await ytP)); // fold in YouTube trending videos (video-first)
  results.push(...(await trendArtP)); // fold in Trends' attached articles (real URL + image)

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

  log('buzz.done', { terms: terms.length, xTrends: xTrends.length, trending: trending.length, extra: extra.length, articles: deduped.length, withImage: deduped.filter((a) => a.imageUrl).length, ms: Date.now() - t0 });
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

    // VIDEO — STRICT: only the page's OWN DECLARED video. Anything else (bare links,
    // <iframe> embeds) is UNRELIABLE — publisher pages carry promo/recommended/
    // sidebar embeds unrelated to the story (verified mismatches: "Hindustan Times@100"
    // via a scattered link; "Meet Mayo..." via a single in-body iframe on an
    // indiantelevision.com Lava article). So we trust ONLY the two signals where the
    // page explicitly says "THIS is my video": og:video / twitter:player, and JSON-LD
    // VideoObject. The iframe heuristic is REMOVED — a lone in-body iframe is still
    // often a promo. Better NO video than a WRONG one. ytUrl() → canonical or null.
    const ytUrl = (s) => {
      const m = String(s || '').match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?[^"'\s<]*v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
      if (!m || !m[1]) return null;
      // PROMO DENYLIST — publishers put a CHANNEL-BRANDING video in og:video/
      // twitter:player (e.g. HT's "Hindustan Times@100" = T50u-Ka1XAs), which is NOT
      // the article's video and mismatches EVERY story. Never attach these.
      if (PROMO_VIDEO_IDS.has(m[1])) return null;
      return `https://www.youtube.com/watch?v=${m[1]}`;
    };
    let video = null;
    // 1. og:video / twitter:player (the article's declared video)
    for (const key of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player']) {
      const v = metaContent(html, key);
      if (!v) continue;
      const yt = ytUrl(v);
      if (yt) { video = yt; break; }
      if (/^https:\/\/[^\s"']+\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(v)) { video = v; break; }
    }
    // 2. JSON-LD VideoObject (embedUrl or contentUrl) — structured, article-scoped.
    if (!video) {
      const vo = html.match(/"@type"\s*:\s*"VideoObject"[\s\S]{0,600}?"(?:embedUrl|contentUrl)"\s*:\s*"([^"]+)"/i);
      video = ytUrl(vo && vo[1]) || (vo && /^https:\/\/[^\s"']+\.(?:mp4|webm|m3u8)/i.test(vo[1]) ? vo[1] : null);
    }
    return { image, video };
  } catch {
    return { image: null, video: null };
  }
}
