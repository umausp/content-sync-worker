// world_feeds.mjs — dedicated WORLD/US-UK sourcing for the @AgyataWorld channel.
//
// The English channel is a tier-1 (US/UK/global) product, so it must NOT pull from
// Agyata's India-first feed. It builds a fixed 5-SLOT "Top 5" roundup, one story per
// editorial slot, from major Western wires (all verified reachable via Node fetch):
//   1. politics       — US/UK/global politics
//   2. breaking       — breaking / live world events (war, conflict, disasters)
//   3. crisis         — global economy / markets / fuel / money crises
//   4. entertainment  — film / OTT (Netflix, Prime) / trailers / reviews
//   5. facts          — science / physics / space / "did you know"
//
// Each slot has several sources so the SAME story is corroborated across outlets and
// we get a real image + clean headline. Pure RSS, $0, no keys.

import { llmChat, haveLlmKey } from './llm.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Clean display names for the "Source:" credit (raw RSS hosts read badly, e.g.
// "feeds.bbci.co.uk"). Falls back to the bare domain for anything unlisted.
const SOURCE_NAMES = {
  'bbci.co.uk': 'BBC',
  'bbc.co.uk': 'BBC',
  'nytimes.com': 'The New York Times',
  'theguardian.com': 'The Guardian',
  'skynews.com': 'Sky News',
  'aljazeera.com': 'Al Jazeera',
  'cnbc.com': 'CNBC',
  'dj.com': 'The Wall Street Journal',
  'wsj.com': 'The Wall Street Journal',
  'variety.com': 'Variety',
  'hollywoodreporter.com': 'The Hollywood Reporter',
  'sciencedaily.com': 'ScienceDaily',
  'nasa.gov': 'NASA',
};
function cleanSource(host) {
  const h = String(host || '').replace(/^www\./, '').replace(/^feeds?\./, '').replace(/^rss\./, '');
  for (const [dom, name] of Object.entries(SOURCE_NAMES)) if (h.endsWith(dom)) return name;
  return h;
}

export const WORLD_SLOTS = [
  {
    key: 'politics',
    label: 'POLITICS',
    feeds: [
      'https://feeds.bbci.co.uk/news/politics/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
      'https://www.theguardian.com/politics/rss',
      'https://feeds.skynews.com/feeds/rss/politics.xml',
    ],
  },
  {
    key: 'breaking',
    label: 'BREAKING',
    feeds: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
      'https://www.aljazeera.com/xml/rss/all.xml',
      'https://feeds.skynews.com/feeds/rss/world.xml',
    ],
  },
  {
    key: 'crisis',
    label: 'GLOBAL',
    feeds: [
      'https://feeds.bbci.co.uk/news/business/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
      'https://www.cnbc.com/id/100003114/device/rss/rss.html',
      'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    ],
  },
  {
    key: 'entertainment',
    label: 'ENTERTAINMENT',
    feeds: [
      'https://variety.com/feed/',
      'https://www.hollywoodreporter.com/feed/',
      'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      'https://www.theguardian.com/film/rss',
    ],
  },
  {
    key: 'tech',
    label: 'TECH',
    feeds: [
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',
    ],
  },
  {
    key: 'facts',
    label: 'SCIENCE',
    feeds: [
      'https://www.sciencedaily.com/rss/top/science.xml',
      'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
      'https://www.nasa.gov/news-release/feed/',
    ],
  },
  {
    key: 'sports',
    label: 'SPORTS',
    feeds: [
      'https://feeds.bbci.co.uk/sport/rss.xml',
      'https://www.espn.com/espn/rss/news',
      'https://www.skysports.com/rss/12040',
    ],
  },
  {
    key: 'health',
    label: 'HEALTH',
    feeds: [
      'https://feeds.bbci.co.uk/news/health/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
      'https://www.theguardian.com/society/health/rss',
    ],
  },
  {
    key: 'offbeat',
    label: 'TRENDING',
    feeds: [
      'https://www.theguardian.com/world/series/the-upside/rss',
      'https://feeds.arstechnica.com/arstechnica/index',
      'https://feeds.bbci.co.uk/news/world/rss.xml',
    ],
  },
];

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
function tagOf(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}
function stripHtml(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
// Best-effort image from an RSS item (media:content / media:thumbnail / enclosure / og in desc).
function imageOf(block) {
  const m =
    block.match(/<media:content[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
    block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) ||
    block.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
    block.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m && /^https:\/\//i.test(m[1]) ? m[1] : null;
}

// Pull the PUBLISHER'S OWN lead image from an article's OpenGraph/Twitter meta. This is
// the outlet's chosen hero photo — monetization-safe to show with a source credit —
// unlike the gstatic thumbnail Google Trends hands back (a Google-hosted crop we must
// NOT use). Returns an https URL or null.
function ogImage(html) {
  const h = String(html || '');
  const m =
    h.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
    h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
    h.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
  if (!m) return null;
  const url = decode(m[1]).trim();
  // Accept any https og:image (many CDNs serve images from extension-less paths).
  return /^https:\/\//i.test(url) ? url : null;
}

// Collect SEVERAL real photos from an article so a Short can play a proper photo
// SEQUENCE (user: "at least 5-10 images for a 50s video") instead of one static image.
// Pulls the og:image, then every reasonably-sized <img>/<figure> photo inside the
// article body — all the OUTLET'S OWN photos (monetization-safe, credited). Skips
// logos/sprites/tracking-pixels/icons/avatars by URL heuristics. Returns an ordered,
// deduped list of https image URLs.
function articleImages(html) {
  const h = String(html || '');
  const found = [];
  const push = (u) => {
    if (!u) return;
    let s = decode(u).trim();
    if (s.startsWith('//')) s = `https:${s}`;
    if (!/^https:\/\//i.test(s)) return;
    // Skip non-photo assets (logos, icons, sprites, tracking pixels, avatars) AND the
    // things that read as ADS in a news video (user: "long build added Ads in it"):
    //   • press-kit / product screenshots (vendor promo graphics with logos),
    //   • event/conference promo banners (e.g. TechCrunch "Disrupt2026"),
    //   • author/contributor headshots & "-copy" byline avatars,
    //   • generic promo/banner/sponsor/newsletter creatives.
    if (
      /\.svg(?:$|\?)|sprite|logo|icon|favicon|avatar|placeholder|pixel|1x1|blank|doubleclick|analytics/i.test(s) ||
      /press.?kit|product[-_]|screenshot|-copy|_copy|contributor|headshot|byline|disrupt|promo|banner|sponsor|newsletter|subscribe|advert|\bad[-_s]?\b/i.test(s) ||
      /[?&](?:w|width)=(?:\d{1,2}|1\d\d|2\d\d)\b/i.test(s) // tiny requested widths (≤299px) = thumbs/avatars
    )
      return;
    if (!found.includes(s)) found.push(s);
  };
  const og = ogImage(h);
  if (og) push(og);
  // Scope to the article body so we don't pull site-wide promo images.
  const container = (h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i) || [h])[0];
  // <img src>, plus lazy-loaded variants (data-src / data-lazy-src) common on news CDNs.
  for (const m of container.matchAll(/<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/gi)) push(m[1]);
  // <source srcset> (picture/responsive) — take the LAST (largest) candidate URL.
  for (const m of container.matchAll(/<source[^>]+srcset=["']([^"']+)["']/gi)) {
    const last = m[1].split(',').pop().trim().split(/\s+/)[0];
    if (/\.(?:jpe?g|png|webp)/i.test(last)) push(last);
  }
  return found.slice(0, 10);
}

async function fetchFeed(url) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const host = new URL(url).hostname.replace(/^www\./, '');
    const items = [];
    for (const [, block] of xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)) {
      const title = tagOf(block, 'title');
      let link = tagOf(block, 'link');
      if (!link) {
        const lm = block.match(/<link[^>]+href=["']([^"']+)["']/i);
        if (lm) link = lm[1];
      }
      const desc = stripHtml(tagOf(block, 'description') || tagOf(block, 'summary') || tagOf(block, 'content'));
      const pub = tagOf(block, 'pubDate') || tagOf(block, 'published') || tagOf(block, 'updated');
      if (!title || !link) continue;
      items.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: link,
        summary: desc.slice(0, 400),
        imageUrl: imageOf(block),
        sourceName: cleanSource(host),
        publishedAt: pub ? new Date(pub).toISOString() : null,
      });
    }
    return items;
  } catch {
    return [];
  }
}

// Video/gallery/live-blog pages have NO article prose (BBC /news/videos/… is just a
// player + an "enable JavaScript" notice), so a story that lands on one can't be
// enriched and ships thin. Detect them so ranking can prefer a real article URL.
function isThinUrl(url) {
  return /\/(?:videos?|av|gallery|galleries|in-pictures|live)\//i.test(String(url || ''));
}

// Word-overlap dedup key (so the same event from 2 outlets counts once).
function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).sort().slice(0, 8).join(' ');
}

// Fetch one representative, corroborated, recent story PER SLOT → 5 stories.
// corroboration = how many of the slot's outlets ran a title-similar story (a light
// quality signal). Prefers items WITH an image + more corroboration + freshness.
export async function buildWorldRoundup({ maxAgeH = 36, perSlot = 1, enrich = false } = {}) {
  const now = Date.now();
  // Collect picks PER SLOT into buckets, then INTERLEAVE round-robin at the end so a
  // downstream slice(0, N) always spans EVERY category (was: fixed slot order meant a
  // 10-story long-form filled up on politics/breaking/… and never reached sports/
  // science/health/trending). buckets[slotKey] = [pick, pick, …] in rank order.
  const buckets = new Map();
  // Cross-slot dedup: the SAME event can match two slots (e.g. 'Trump tariffs' fits both
  // BREAKING and GLOBAL). Track normalized titles already taken so no story repeats
  // across slots — each slot picks the best story NOT already used.
  const usedTitles = new Set();
  for (const slot of WORLD_SLOTS) {
    const all = (await Promise.all(slot.feeds.map(fetchFeed))).flat();
    // cluster by normalized title to count corroboration + keep the best-imaged rep
    const clusters = new Map();
    for (const it of all) {
      const ageH = it.publishedAt ? (now - Date.parse(it.publishedAt)) / 3.6e6 : 0;
      if (it.publishedAt && ageH > maxAgeH) continue;
      const k = normTitle(it.title);
      if (!k) continue;
      const c = clusters.get(k) || { items: [], sources: new Set() };
      c.items.push(it);
      c.sources.add(it.sourceName);
      clusters.set(k, c);
    }
    const ranked = [...clusters.values()]
      .map((c) => {
        // rep = a REAL ARTICLE (not a video/gallery page) with an image, preferred; then
        // any article; then any item with an image; else the first. This keeps the story
        // on a page that actually HAS body prose so enrichSummary can build a real brief.
        const rep =
          c.items.find((i) => i.imageUrl && !isThinUrl(i.url)) ||
          c.items.find((i) => !isThinUrl(i.url)) ||
          c.items.find((i) => i.imageUrl) ||
          c.items[0];
        const freshH = rep.publishedAt ? (now - Date.parse(rep.publishedAt)) / 3.6e6 : 99;
        // ALL distinct images across the cluster's outlets → feeds the multi-image
        // sequence so a story shows several real photos of the SAME event.
        const images = [...new Set(c.items.map((i) => i.imageUrl).filter(Boolean))];
        return {
          rep,
          images,
          corr: c.sources.size,
          hasImg: !!rep.imageUrl,
          thin: isThinUrl(rep.url),
          freshH,
          sources: [...c.sources],
        };
      })
      .sort((a, b) => {
        // AUTHENTICITY ranking: a real, current story with a photo beats an old/imageless
        // one. Score = corroboration + has-image + recency (all favour a genuine event).
        // Weight RECENCY more so the feed feels current: fresher (lower freshH) scores
        // higher, plus corroboration + a real image. A thin (video/gallery) page is
        // penalised so an enrichable ARTICLE wins when the event is on both.
        const score = (x) =>
          x.corr * 2 + (x.hasImg ? 2 : 0) + (x.thin ? -4 : 0) + Math.max(0, 10 - x.freshH / 2);
        const d = score(b) - score(a);
        if (d !== 0) return d;
        return a.freshH - b.freshH;
      });
    // Take the top `perSlot` stories from this slot that HAVEN'T already been used by an
    // earlier slot (skip cross-slot duplicates like the same Trump story in 2 slots).
    const bucket = [];
    for (const pick of ranked) {
      if (bucket.length >= perSlot) break;
      const key = normTitle(pick.rep.title);
      if (usedTitles.has(key)) continue; // already in another slot → skip to next-best
      usedTitles.add(key);
      bucket.push({
        slot: slot.key,
        badge: slot.label,
        hashtag: slotHashtag(slot.key, pick.rep.title),
        title: pick.rep.title,
        summary: pick.rep.summary || pick.rep.title,
        url: pick.rep.url,
        imageUrl: pick.rep.imageUrl,
        images: pick.images, // all distinct source images → multi-image sequence
        sourceName: pick.rep.sourceName,
        sources: pick.sources,
        corr: pick.corr,
        category: slot.key,
      });
    }
    if (bucket.length) buckets.set(slot.key, bucket);
  }
  // INTERLEAVE round-robin across slots: one story per category first (politics,
  // breaking, global, entertainment, tech, science, sports, health, trending), THEN a
  // second pass, etc. So a downstream slice(0, N) — e.g. 10 stories for long-form —
  // spans EVERY category instead of filling up on the first few slots. Slot order in
  // WORLD_SLOTS sets the priority of the first pass.
  const out = [];
  const cols = WORLD_SLOTS.map((s) => buckets.get(s.key) || []);
  const maxDepth = Math.max(0, ...cols.map((c) => c.length));
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const col of cols) if (col[depth]) out.push(col[depth]);
  }
  // ENRICH the summaries: RSS gives only ~1 sentence (~120 chars) — too thin for a
  // 20-35s single-story Short. Fetch each picked article and append real body
  // paragraphs so there's enough script. Parallel + best-effort (keeps the RSS summary
  // on any failure). Only bother when a fuller script is wanted (single/long-form).
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s)));
  return out;
}

// Google Trends "trending now" RSS → real, searched-RIGHT-NOW stories for the US + UK.
// This is the "check Google Trends for what's hot in USA/Europe" ask. Each trend item
// carries the REAL publisher article URLs that made it trend (Politico/Fox/BBC/…), plus
// a gstatic thumbnail we deliberately IGNORE (Google-hosted crop — copyright/monetization
// risk). We keep the publisher article URL and let enrichSummary pull the OUTLET'S OWN
// og:image + body prose downstream — 100% monetization-safe.
const TRENDS_GEOS = (process.env.WORLD_TRENDS_GEOS || 'US,GB').split(',').map((g) => g.trim()).filter(Boolean);
function trendTag(term) {
  const words = String(term).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !TAG_STOP.has(w.toLowerCase()));
  const pick = words.slice(0, 2);
  if (!pick.length) return 'Trending';
  return pick.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').slice(0, 24);
}
export async function buildTrendingStories({ geos = TRENDS_GEOS, perGeo = 3, enrich = true } = {}) {
  const usedTitles = new Set();
  const out = [];
  for (const geo of geos) {
    let xml = '';
    try {
      const r = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
        headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,*/*' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      xml = await r.text();
    } catch {
      continue;
    }
    let taken = 0;
    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      if (taken >= perGeo) break;
      const term = decode((item.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
      if (!term) continue;
      // Search heat: "20000+" → 20000. Lets the caller lead a single Short with the
      // genuinely HOTTEST story instead of always the same editorial politics slot.
      const traffic = Number(
        (decode((item.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/i) || [])[1] || '')
          .replace(/[^0-9]/g, '')) || 0,
      );
      // Each trend lists the articles that made it trend. Pick the first REAL article
      // (skip video/gallery/live pages that carry no prose) as the story's source.
      const newsItems = [...item.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi)].map(([, ni]) => ({
        title: decode((ni.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim(),
        url: decode((ni.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/i) || [])[1] || '').trim(),
        source: decode((ni.match(/<ht:news_item_source>([\s\S]*?)<\/ht:news_item_source>/i) || [])[1] || '').trim(),
      })).filter((n) => n.title && /^https?:\/\//i.test(n.url));
      if (!newsItems.length) continue;
      const rep = newsItems.find((n) => !isThinUrl(n.url)) || newsItems[0];
      const key = normTitle(rep.title);
      if (!key || usedTitles.has(key)) continue;
      usedTitles.add(key);
      taken++;
      out.push({
        slot: 'trending',
        badge: 'TRENDING',
        hashtag: trendTag(term),
        title: rep.title,
        // NO imageUrl / images — enrichSummary pulls the publisher's own og:image (we
        // never use the gstatic <ht:news_item_picture> thumbnail: copyright/monetization).
        summary: rep.title,
        url: rep.url,
        imageUrl: null,
        images: [],
        sourceName: cleanSource(new URL(rep.url).hostname),
        sources: [...new Set(newsItems.map((n) => n.source).filter(Boolean))],
        corr: newsItems.length,
        category: 'offbeat',
        trend: term,
        traffic,
        geo,
      });
    }
  }
  // Hottest trends first (highest search volume), then MORE-corroborated (covered by more
  // outlets = a bigger, more real story) so a single Short leads with the genuinely
  // biggest story of the moment — and ties (many trends read "200+") break on substance,
  // not RSS order, so the lead varies with the news cycle instead of sticking on one item.
  out.sort((a, b) => (b.traffic || 0) - (a.traffic || 0) || (b.corr || 0) - (a.corr || 0));
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s)));
  // Drop trends we couldn't turn into a REAL story. A single Short leads with a trend, so
  // it must have (1) a publisher image AND (2) a brief that actually gained body beyond
  // the headline — many trends point at JS-rendered pages (CNN) with 0 extractable prose,
  // where the "summary" is just the title echoed back. Require ≥40 chars of NEW text over
  // the title so we never narrate a bare headline (or a scraped share-widget) as a story.
  return out.filter((s) => {
    if (!s.imageUrl || !s.summary) return false;
    const grew = s.summary.trim().length - (s.title || '').trim().length;
    return s.summary.length > 120 && grew > 40 && /[.!?]$/.test(s.summary.trim());
  });
}

// ─── X / TWITTER trending topics (user: "latest trending topics from X: Desktop") ───
// X killed its free trends API, so we read the LIVE public X trend board for a geo from
// trends24.in (a long-running free mirror of X's own "Trending" panel — no key, no auth).
// Each X trend is just a TERM/hashtag (#XMen97, "Netanyahu"), NOT a story — so, exactly
// like the Google-Trends path, we resolve each hot term to a REAL, fresh publisher
// article via Google News search, then enrichSummary pulls the OUTLET'S OWN og:image +
// body prose. We NEVER show X/Twitter content itself (no embeds, no user photos) — only
// the professionally-reported news the trend points at, which is monetization-safe.
const X_GEOS = (process.env.WORLD_X_GEOS || 'US,GB').split(',').map((g) => g.trim()).filter(Boolean);
// trends24 uses country SLUGS, not ISO codes. Map the geos we use; unknown → lowercased.
const X_GEO_SLUG = { US: 'united-states', GB: 'united-kingdom', IN: 'india', CA: 'canada', AU: 'australia' };
const X_GEO_HL = { US: 'en-US', GB: 'en-GB', IN: 'en-IN', CA: 'en-CA', AU: 'en-AU' };
// Fandom/meme/utility trends that never resolve to a real news event — X's board is full
// of them (stan armies, K-pop tags, "Good Morning", game titles). Skip so we don't waste
// a Google-News lookup and never lead a Short with noise.
const X_JUNK = /^(good (morning|night|wednesday|monday|tuesday|thursday|friday|saturday|sunday)|happy \w+|gm|gn|rip|lmao|tbt|fyp|day\s?\d+)$/i;
// Keep mostly-Latin trends (World channel is English); drop CJK/other-script fandom spam.
function xTermUsable(term) {
  const s = String(term || '').replace(/^#/, '').trim();
  if (s.length < 3 || X_JUNK.test(s)) return false;
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters) {
    const latin = (letters.match(/\p{Script=Latin}/gu) || []).length;
    if (latin / letters.length < 0.7) return false; // <70% Latin → not our language
  }
  return true;
}
// The live X "Trending" board for a geo, in trend-rank order (hottest first). Parses the
// newest snapshot card. Returns [term, term, …]; [] on any failure (source degrades to
// the Google-Trends + editorial roundup).
async function fetchXTrends(geo) {
  const slug = X_GEO_SLUG[geo] || geo.toLowerCase();
  let html = '';
  try {
    const r = await fetch(`https://trends24.in/${slug}/`, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    html = await r.text();
  } catch {
    return [];
  }
  // The FIRST <ol class=trend-card__list> is the most-recent snapshot (attrs are unquoted
  // in the served HTML, so the class match tolerates optional quotes).
  const card = html.match(/<ol class="?trend-card__list"?>([\s\S]*?)<\/ol>/i);
  const scope = card ? card[1] : html;
  const out = [];
  const seen = new Set();
  for (const m of scope.matchAll(/<a href="https:\/\/twitter\.com\/search\?q=[^"]*"\s+class="?trend-link"?>([^<]+)<\/a>/gi)) {
    const term = decode(m[1]).trim();
    const k = term.toLowerCase();
    if (!term || seen.has(k) || !xTermUsable(term)) continue;
    seen.add(k);
    out.push(term);
  }
  return out;
}

// Search Google News for a term's freshest real articles (last 2 days), strip the
// " - Publisher" suffix, drop thin (video/live) pages. Returns [{title,url,source}].
async function newsSearch(term, geo, hl) {
  const ceid = `${geo}:${hl.split('-')[0]}`;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${term} when:2d`)}` +
    `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(geo)}&ceid=${encodeURIComponent(ceid)}`;
  let xml = '';
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,*/*' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    xml = await r.text();
  } catch {
    return [];
  }
  const items = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const rawTitle = decode((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = decode((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    const source = decode((block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '').trim();
    const title = rawTitle.replace(/\s+-\s+[^-]+$/, '').trim(); // drop trailing " - Source"
    if (title && /^https?:\/\//i.test(link) && !isThinUrl(link)) items.push({ title, url: link, source });
  }
  return items;
}
// An article is on-topic for a trend only if the trend term (minus '#') actually appears
// in the headline — kills the "Thor → unrelated Bachelor story" mismatch where a bare
// word matched a coincidental article.
function titleMatchesTerm(term, title) {
  const t = term.replace(/^#/, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const T = String(title).toLowerCase();
  if (!t) return false;
  if (t.includes(' ')) return T.includes(t); // multi-word phrase → substring
  return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(T); // whole word
}
// Resolve a Google News RSS redirect (news.google.com/rss/articles/<id>) to the REAL
// publisher URL — the article page carries a signature the batchexecute endpoint needs.
// enrichSummary then pulls the outlet's og:image + prose from the real page. Best-effort.
async function resolveGoogleNewsUrl(gnewsUrl) {
  try {
    const m = gnewsUrl.match(/\/articles\/([^?]+)/);
    if (!m) return /^https?:\/\/(?!news\.google)/i.test(gnewsUrl) ? gnewsUrl : null;
    const id = m[1];
    const page = await fetch(gnewsUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
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
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const txt = await r.text();
    const real = txt.match(/https?:\/\/(?!news\.google)[^\\"\s]+/);
    return real ? real[0] : null;
  } catch {
    return null;
  }
}

// Build "what's trending on X right now" stories for the World channel. Reads the live X
// trend board per geo (rank = heat), resolves each hot term to its freshest matching
// publisher article, then enriches to the outlet's own image + prose. Same monetization-
// safe shape as buildTrendingStories. `perGeo` = how many trends to CONVERT per geo (we
// probe a deeper pool because many trends are fandom/meme noise). Fail-open → [].
export async function buildXTrendingStories({ geos = X_GEOS, perGeo = 4, probe = 16, enrich = true } = {}) {
  const usedTitles = new Set();
  const out = [];
  for (const geo of geos) {
    const hl = X_GEO_HL[geo] || 'en-US';
    const trends = await fetchXTrends(geo);
    if (!trends.length) continue;
    let rank = 0;
    let taken = 0;
    for (const term of trends.slice(0, probe)) {
      rank++;
      if (taken >= perGeo) break;
      const items = await newsSearch(term, geo, hl);
      if (!items.length) continue;
      // First article whose HEADLINE actually contains the trend term (on-topic).
      const hit = items.find((i) => titleMatchesTerm(term, i.title));
      if (!hit) continue;
      const key = normTitle(hit.title);
      if (!key || usedTitles.has(key)) continue;
      usedTitles.add(key);
      const real = await resolveGoogleNewsUrl(hit.url);
      if (!real) continue;
      taken++;
      out.push({
        slot: 'trending',
        badge: 'VIRAL', // distinct from Google-Trends' TRENDING chip — this is X buzz
        hashtag: trendTag(term),
        // NO imageUrl yet — enrichSummary pulls the publisher's OWN og:image (never an X
        // avatar/screenshot: copyright/monetization). summary seeded from the headline;
        // the strict gate below drops it unless enrichment grows a real brief.
        title: hit.title,
        summary: hit.title,
        url: real,
        imageUrl: null,
        images: [],
        sourceName: hit.source || cleanSource(new URL(real).hostname),
        sources: [hit.source].filter(Boolean),
        corr: items.length,
        category: 'offbeat',
        trend: term,
        // Heat ∝ trend rank on the board (no reliable tweet-count in the markup): a small
        // deterministic score so the hottest X trend can lead a single Short.
        traffic: Math.max(0, 100000 - rank * 1000),
        geo,
        viral: true,
      });
    }
  }
  out.sort((a, b) => (b.traffic || 0) - (a.traffic || 0) || (b.corr || 0) - (a.corr || 0));
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s)));
  // Same strict gate as Google-Trends: a real publisher image AND a brief that genuinely
  // grew past the headline (JS-rendered pages that echo the title back are dropped).
  return out.filter((s) => {
    if (!s.imageUrl || !s.summary) return false;
    const grew = s.summary.trim().length - (s.title || '').trim().length;
    return s.summary.length > 120 && grew > 40 && /[.!?]$/.test(s.summary.trim());
  });
}

// Fetch an article and extend its summary with real body paragraphs (no LLM, $0). Keeps
// the story on-topic + factual; strips boilerplate (cookie/subscribe/newsletter lines).
// Article prose only (scoped to <article>/<main>, boilerplate + nav stripped) — same
// hardening as the main pipeline so we never scrape "Skip to content / Home News Sport".
function articleProse(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Drop non-body chrome: nav/header/footer/aside/form AND figure/figcaption (photo
    // captions like "Roger Rogoff talks with CNN affiliate KING…" are NOT article prose)
    // and buttons (share widgets: "Facebook Tweet Email Link Copied!"). These leaked into
    // narration when there was no LLM and the extractive path scraped them as a "sentence".
    .replace(/<(nav|header|footer|aside|form|figure|figcaption|button)[\s\S]*?<\/\1>/gi, ' ');
  const container = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  const BP = /cookie|subscri|sign ?up|newsletter|advertisement|©|all rights reserved|skip to content|accessibility help|your account|more menu|follow us|read more|most read|homepage|enable ?javascript|to play this video|video can ?(?:'?t|not) be played|this content is not available|your browser (?:does|is)|playback|please (?:enable|update|upgrade)|we(?:'| ha)ve sent|check your (?:inbox|email)|getty images|photograph:|image (?:source|caption)|hide caption|\bpool\b.*\bcaption\b|reuters\/|associated press|see all topics|related (?:topics|articles)|facebook|tweet|whatsapp|link copied|copy link|share this|most viewed|sign in|log ?in|talks with .* affili/i;
  // Byline / timestamp / engagement-metadata lines that sit ABOVE the body on many sites
  // ("Manchester United reporter Published 2 hours ago", "Matt Oliver is The Telegraph's
  // Industry Editor…", "17 comments"). They're grammatical so they survive the BP filter,
  // but they're not story prose — drop them so narration is pure article body. Also:
  //   • AUTHOR BIOS ("Dominic covers the biggest stories… winners at the MHP 30 To Watch
  //     Awards") — a first-name-led "X covers/writes/reports…" or "…Awards in 20NN" bio;
  //   • VIDEO-PLAYER labels the extractive path scraped as a paragraph ("Video Dan Dakich
  //     reacts to… | Don't @ Me w/Dan Dakich") — a leading "Video "/"Watch:" or a "| show"
  //     divider from an embedded-clip caption.
  const META = /^\s*(?:by |published |updated |\d+ comments?\b|\d+ min read|last modified|video\b|watch:?\s)|\b(?:is|was) (?:the |a |an )?[A-Z][\w'’]* (?:[A-Z][\w'’]* )*(?:editor|reporter|correspondent|columnist|writer)\b|^[A-Z][a-z]+ (?:covers|writes|reports on|is a|has (?:broken|covered)) |\bTo Watch Awards\b| \| (?:Don'?t @|[A-Z][\w'’]* w\/)|\bpublished \d|\b\d+ hours? ago\b|\bBST\b|\bGMT\b|\bEDT\b/i;
  return [...container.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => {
      if (t.length < 60 || BP.test(t) || META.test(t)) return false;
      const w = t.split(/\s+/);
      if (w.length < 10 || !/[.!?]/.test(t)) return false;
      const cap = w.filter((x) => /^[A-Z][a-z]*$/.test(x)).length;
      return cap / w.length <= 0.6; // not a Capitalised nav strip
    });
}

// Fetch the article body and build a genuinely USEFUL summary. Preferred path: LLM
// SYNTHESIS across the story's sources into a clean, factual 2-3 sentence brief (the
// "research from multiple sources, make useful content" ask). Fallback: extractive body
// paragraphs. $0, fail-open (keeps the RSS lead on any failure).
export async function enrichSummary(story) {
  if (!story.url || !/^https?:\/\//i.test(story.url)) return;
  try {
    const r = await fetch(story.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return;
    const html = await r.text();
    // MONETIZATION-SAFE IMAGES: harvest the PUBLISHER'S OWN photos from the article we're
    // already fetching — the og:image plus in-body <img>/<figure> photos. These are the
    // outlet's chosen images (safe to show with a credit), unlike the gstatic thumbnail
    // Google Trends hands back. Gives a Short enough real photos to play a SEQUENCE (user:
    // "at least 5-10 images for a 50s video") instead of one static frame.
    const arts = articleImages(html);
    if (arts.length) {
      if (!story.imageUrl) story.imageUrl = arts[0];
      story.images = [...new Set([story.imageUrl, ...(story.images || []), ...arts].filter(Boolean))];
    }
    const paras = articleProse(html);
    if (!paras.length) return;
    const body = paras.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2200);

    // LLM synthesis (free providers). Turns raw body into a tight, informative brief a
    // viewer actually learns from — who/what/where/why/impact — no fluff, no markup.
    if (haveLlmKey()) {
      const outlets = (story.sources || []).slice(0, 4).join(', ');
      const prompt =
        'You are a sharp broadcast news writer. Using ONLY the facts in the source text ' +
        'below, write a punchy, informative 2-3 sentence brief (about 45-70 words) for a ' +
        'short news video. Lead with the most important fact; include the key who/what/' +
        'where and the number, date or consequence that matters. Neutral, factual, no ' +
        'hype, no opinion, no fabrication. Plain text only — NO markdown, hashtags, ' +
        'brackets, quotes or emoji. Do not mention "the article".\n\n' +
        `HEADLINE: ${story.title}\n` +
        (outlets ? `REPORTED BY: ${outlets}\n` : '') +
        `SOURCE TEXT: ${body}`;
      const synth = await llmChat(prompt, { maxTokens: 320, temperature: 0.3 });
      let clean = (synth || '').replace(/[#*_`>\[\]{}]/g, '').replace(/\s+/g, ' ').trim();
      // If the model stopped mid-sentence (hit the token cap), drop the trailing partial
      // so the brief always ends on a complete sentence.
      if (clean && !/[.!?]$/.test(clean)) {
        const cut = clean.replace(/\s+\S*$/, '');
        const lastEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
        if (lastEnd > 80) clean = cut.slice(0, lastEnd + 1).trim();
      }
      if (clean.length >= 120) {
        story.summary = clean;
        return;
      }
    }

    // Extractive fallback: RSS lead + distinct body paragraphs, then trimmed to WHOLE
    // sentences (never chopped mid-word — that produced narration ending on half a
    // sentence). We take complete sentences up to ~700 chars.
    // Only seed with the RSS lead if it's a REAL sentence — a bare HEADLINE (no ending
    // punctuation, as Google-Trends stories carry) would glue onto the first body
    // sentence and echo the title into the narration. In that case start from the body.
    const seed = /[.!?]$/.test(String(story.summary || '').trim()) ? story.summary : null;
    const seen = new Set();
    const parts = [seed, ...paras].filter((p) => {
      const k = (p || '').slice(0, 40).toLowerCase();
      if (!p || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    // Keep only complete sentences (end in . ! ? …) up to the char budget.
    const sentences = joined.split(/(?<=[.!?])\s+/).filter((s) => /[.!?]$/.test(s.trim()));
    let full = '';
    for (const s of sentences) {
      if (full.length + s.length > 700 && full) break;
      full = full ? `${full} ${s}` : s;
    }
    full = full.trim();
    if (full.length > (story.summary || '').length) story.summary = full;
  } catch {
    /* keep the RSS summary */
  }
}

// A clean, category-level fallback tag so a story ALWAYS has a sensible hashtag even
// when the headline yields no strong keyword (killed the "#WillBurnhamFund" nonsense —
// gluing the first 3 headline words made junk). Prefer a real proper-noun/keyword from
// the title; else use the slot's evergreen tag.
const SLOT_TAGS = {
  politics: 'Politics',
  breaking: 'BreakingNews',
  crisis: 'Economy',
  entertainment: 'Entertainment',
  tech: 'Tech',
  facts: 'Science',
  sports: 'Sports',
  health: 'Health',
  offbeat: 'Trending',
};
// Stopwords that make bad tags (verbs/fillers/glue words a headline leads with).
const TAG_STOP = new Set(
  ('the and for but not are was were has have had its his her our out off per via ' +
    'will would could should says say said after before amid over into from with that this ' +
    'their there here what when where which while about among across your ours have been being ' +
    'more most many much some such than then they them here news video watch live latest update ' +
    'first last next best worst plan plans deal talks warns urges calls faces sets gets')
    .split(/\s+/),
);
function slotHashtag(slotKey, title) {
  // Prefer PROPER NOUNS (capitalised words mid-sentence, e.g. names/places/orgs) — the
  // most tag-worthy tokens — then any other strong keyword. Skip leading fillers.
  const raw = String(title).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const proper = raw.filter(
    (w, i) => i > 0 && /^[A-Z][a-z]{2,}$/.test(w) && !TAG_STOP.has(w.toLowerCase()),
  );
  const keywords = raw.filter((w) => w.length > 3 && !TAG_STOP.has(w.toLowerCase()));
  const pick = (proper.length ? proper : keywords).slice(0, 2);
  if (!pick.length) return SLOT_TAGS[slotKey] || 'News';
  const tag = pick.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return tag.slice(0, 24);
}
