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
import { extractArticle, fetchAndExtract, isAggregatorUrl } from '../src/extract.mjs';
import { extractEntities, entityImageMap } from './entity_images.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ── DEPTH TUNABLES (user: "if you find 60 sources then fetch 60 images / get MAXIMUM
// images for the story") ─────────────────────────────────────────────────────────
// The research pool is timeout-free, so it sets these HIGH via env to gather every
// reporting outlet's own photos; the fast render fallback keeps the modest defaults so a
// live gather stays quick. All bounded so a huge story (95 outlets) can't run away.
const MULTI_OUTLETS = Number(process.env.WORLD_X_MULTI || 8); // OTHER outlets we resolve per trend story
const MAX_SOURCE_URLS = Number(process.env.WORLD_MAX_SOURCE_URLS || 12); // distinct article URLs kept per story
const ENRICH_OUTLETS = Number(process.env.WORLD_ENRICH_OUTLETS || 8); // outlets enrichSummary extracts prose+images from
const MAX_STORY_IMAGES = Number(process.env.WORLD_MAX_STORY_IMAGES || 24); // story-own photos kept per story
const SYNTH_CORPUS_CHARS = Number(process.env.WORLD_SYNTH_CORPUS || 6000); // total prose fed to the LLM synth
const SYNTH_PER_OUTLET_CHARS = Number(process.env.WORLD_SYNTH_PER_OUTLET || 1200); // prose per outlet in the corpus
// Freshness ladder for researchImagesForStory (external-audio flow): try tightest window
// first so images come from the MOST RECENT coverage, widen only when a window is empty.
const RESEARCH_WINDOWS = (process.env.SHORTS_RESEARCH_WINDOWS || '6h,24h,72h,7d').split(',').map((w) => w.trim()).filter(Boolean);

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

// NOTE: article image + prose extraction now lives in the SHARED src/extract.mjs
// (JSON-LD articleBody → Readability → og; publisher-own, ad-filtered images). The old
// hand-rolled ogImage/baseDomain/AD_HOST/articleImages/articleProse copies were removed so
// there's ONE extractor — a second divergent image filter is what let a Google-ads image
// slip through before. enrichSummary calls extractArticle/fetchAndExtract instead.

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
    // Tolerate ATTRIBUTES on the item/entry tag — RDF/RSS-1.0 feeds (Deutsche Welle,
    // Asahi Shimbun, many news.rdf feeds) open items as `<item rdf:about="…">`, which a
    // bare `<item>` match skips entirely → 0 items (silently dropped a whole feed). The
    // `(?:\s[^>]*)?` allows the attrs while still not matching `<items>`/`<itemList>`.
    for (const [, block] of xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)) {
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

// Word-overlap dedup key (so the same event from 2 outlets counts once). CJK-SAFE: the old
// `[^a-z0-9 ]` strip wiped every character of a space-less non-Latin title (Japanese/Chinese),
// leaving an EMPTY key — which the callers treat as "skip", so ALL Japanese editorial stories
// were silently dropped. Keep Unicode letters/numbers; when there are no ≥4-char Latin words to
// key on (a CJK title), fall back to the first 16 chars of the normalized string so the story
// still gets a stable (near-exact-match) cluster key instead of vanishing.
function normTitle(t) {
  const norm = String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const key = norm.split(' ').filter((w) => w.length > 3).sort().slice(0, 8).join(' ');
  return key || norm.replace(/\s+/g, '').slice(0, 16);
}
// Shared "this text ends on a sentence boundary" test — accepts Latin (. ! ?), Devanagari (।)
// AND CJK (。！？) terminators so the quality gates below don't reject a perfectly complete
// Japanese/Chinese brief just because it ends in 。 instead of a full stop.
function endsSentence(s) {
  return /[.!?।。！？]$/.test(String(s || '').trim());
}

// Fetch one representative, corroborated, recent story PER SLOT → 5 stories.
// corroboration = how many of the slot's outlets ran a title-similar story (a light
// quality signal). Prefers items WITH an image + more corroboration + freshness.
export async function buildWorldRoundup({ maxAgeH = 36, perSlot = 1, enrich = false, slots = WORLD_SLOTS, lang = null, depth = 'normal' } = {}) {
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
  for (const slot of slots) {
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
        // Every distinct REAL ARTICLE url in the cluster (rep first, then the other
        // outlets that covered the SAME event). enrichSummary harvests each page's OWN
        // photos, so a story yields several genuine event images (user: "fetch original
        // story related images only") instead of one + generic stock padding.
        const sourceUrls = [...new Set([rep.url, ...c.items.map((i) => i.url)]
          .filter((u) => u && /^https?:\/\//i.test(u) && !isThinUrl(u)))].slice(0, MAX_SOURCE_URLS);
        return {
          rep,
          images,
          sourceUrls,
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
        sourceUrls: pick.sourceUrls, // all outlet article URLs → harvest each one's own photos
        sourceName: pick.rep.sourceName,
        sources: pick.sources,
        corr: pick.corr,
        category: slot.key,
        // RECENCY signal for ranking downstream (hours since publish; lower = fresher).
        publishedAt: pick.rep.publishedAt || null,
        freshH: pick.freshH,
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
  const cols = slots.map((s) => buckets.get(s.key) || []);
  const maxDepth = Math.max(0, ...cols.map((c) => c.length));
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const col of cols) if (col[depth]) out.push(col[depth]);
  }
  // ENRICH the summaries: RSS gives only ~1 sentence (~120 chars) — too thin for a
  // 20-35s single-story Short. Fetch each picked article and append real body
  // paragraphs so there's enough script. Parallel + best-effort (keeps the RSS summary
  // on any failure). Only bother when a fuller script is wanted (single/long-form). `lang`
  // (null = English) makes the synth write IN THAT LANGUAGE for the native channels.
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s, { lang, depth })));
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
  return makeHashtag(term, 'Trending');
}
export async function buildTrendingStories({ geos = TRENDS_GEOS, perGeo = 3, enrich = true, lang = null, depth = 'normal' } = {}) {
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
      // Drop syndication aggregators (AOL/MSN/Yahoo/…): Google-Trends `<ht:news_item_url>`
      // is a DIRECT publisher URL, so an aggregator that covered the trend lands here as
      // both the rep and a corroborating sourceUrl — and its re-hosted photo isn't original
      // story art (user: "avoid aol.com"). Filter at the source so neither rep nor sourceUrls
      // can be an aggregator.
      })).filter((n) => n.title && /^https?:\/\//i.test(n.url) && !isAggregatorUrl(n.url) && !isAggregatorUrl(n.source));
      if (!newsItems.length) continue;
      const rep = newsItems.find((n) => !isThinUrl(n.url)) || newsItems[0];
      const key = normTitle(rep.title);
      if (!key || usedTitles.has(key)) continue;
      usedTitles.add(key);
      taken++;
      // SAME-EVENT gate: Google groups a trend's articles by TERM, which can span several
      // distinct events. Keep only the ones whose headline reports the SAME event as the rep,
      // so we don't harvest an unrelated article's og:image into this story's photo sequence.
      const sameEventItems = newsItems.filter((n) => n === rep || sameEvent(rep.title, n.title, term));
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
        // Every SAME-EVENT trend-backing outlet's article → harvest each one's OWN photos
        // (this event's real images), so trending Shorts get a genuine, on-topic photo set.
        sourceUrls: [...new Set(sameEventItems.map((n) => n.url).filter((u) => u && /^https?:\/\//i.test(u) && !isThinUrl(u)))].slice(0, MAX_SOURCE_URLS),
        sourceName: cleanSource(new URL(rep.url).hostname),
        sources: [...new Set(sameEventItems.map((n) => n.source).filter(Boolean))],
        corr: sameEventItems.length,
        category: 'offbeat',
        trend: term,
        traffic,
        // Google-Trends "trending now" is current by construction → treat as fresh so it
        // ranks alongside the freshest editorial/X stories.
        freshH: 1,
        geo,
      });
    }
  }
  // Hottest trends first (highest search volume), then MORE-corroborated (covered by more
  // outlets = a bigger, more real story) so a single Short leads with the genuinely
  // biggest story of the moment — and ties (many trends read "200+") break on substance,
  // not RSS order, so the lead varies with the news cycle instead of sticking on one item.
  out.sort((a, b) => (b.traffic || 0) - (a.traffic || 0) || (b.corr || 0) - (a.corr || 0));
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s, { lang, depth })));
  // Drop trends we couldn't turn into a REAL story. A single Short leads with a trend, so
  // it must have (1) a publisher image AND (2) a brief that actually gained body beyond
  // the headline — many trends point at JS-rendered pages (CNN) with 0 extractable prose,
  // where the "summary" is just the title echoed back. Require ≥40 chars of NEW text over
  // the title so we never narrate a bare headline (or a scraped share-widget) as a story.
  return out.filter((s) => {
    if (!s.imageUrl || !s.summary) return false;
    const grew = s.summary.trim().length - (s.title || '').trim().length;
    return s.summary.length > 120 && grew > 40 && endsSentence(s.summary);
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
const X_GEO_SLUG = {
  US: 'united-states', GB: 'united-kingdom', IE: 'ireland', CA: 'canada', AU: 'australia',
  DE: 'germany', FR: 'france', IT: 'italy', ES: 'spain', NL: 'netherlands', IN: 'india',
  JP: 'japan', SE: 'sweden', NO: 'norway', DK: 'denmark',
};
// English channel: X trends are resolved to news via ENGLISH Google-News locales (the World
// channel ships English only). The DE/FR/IT/ES/NL entries here are en-GB ON PURPOSE — the
// World channel wants ENGLISH coverage of a German trend, not German articles.
const X_GEO_HL = {
  US: 'en-US', GB: 'en-GB', IE: 'en-IE', CA: 'en-CA', AU: 'en-AU',
  DE: 'en-GB', FR: 'en-GB', IT: 'en-GB', ES: 'en-GB', NL: 'en-GB', IN: 'en-IN',
  JP: 'en-US', SE: 'en-GB', NO: 'en-GB', DK: 'en-GB',
};
// NATIVE channels resolve a geo's X trends to news in the geo's OWN language (so a German
// channel gets German articles about a German trend). native_feeds.mjs passes hl explicitly,
// but this is the per-geo default. `no`→Norwegian Bokmål, `nb` also accepted by Google News.
const X_GEO_HL_NATIVE = {
  DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', JP: 'ja', SE: 'sv', NO: 'no', DK: 'da',
};
// Fandom/meme/utility trends that never resolve to a real news event — X's board is full
// of them (stan armies, K-pop tags, "Good Morning", game titles). Skip so we don't waste
// a Google-News lookup and never lead a Short with noise.
const X_JUNK = /^(good (morning|night|wednesday|monday|tuesday|thursday|friday|saturday|sunday)|happy \w+|gm|gn|rip|lmao|tbt|fyp|day\s?\d+)$/i;
// Keep on-language trends + drop meme/utility spam. The World channel is English, so it
// requires mostly-Latin terms (`nonLatinOk=false`) to skip CJK/other-script fandom spam. A
// NATIVE non-Latin channel (Japanese) passes `nonLatinOk=true` so its own-script trends —
// which the 70%-Latin gate would wrongly reject — survive; the X_JUNK meme filter still runs.
function xTermUsable(term, nonLatinOk = false) {
  const s = String(term || '').replace(/^#/, '').trim();
  if (s.length < 2 || X_JUNK.test(s)) return false;
  if (nonLatinOk) return true; // native non-Latin channel: accept its own script
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters) {
    const latin = (letters.match(/\p{Script=Latin}/gu) || []).length;
    if (latin / letters.length < 0.7) return false; // <70% Latin → not our language
  }
  return true;
}
// The live X "Trending" board for a geo, in trend-rank order (hottest first). Parses the
// newest snapshot card. Returns [term, term, …]; [] on any failure (source degrades to
// the Google-Trends + editorial roundup). `nonLatinOk` relaxes the Latin-only term filter
// for native non-Latin (Japanese) channels.
async function fetchXTrends(geo, nonLatinOk = false) {
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
    if (!term || seen.has(k) || !xTermUsable(term, nonLatinOk)) continue;
    seen.add(k);
    out.push(term);
  }
  return out;
}

// Search Google News for a term's freshest real articles within a freshness `when`
// window (default 1h — "last 1 hour or less" per the trending mandate), strip the
// " - Publisher" suffix, drop thin (video/live) pages. Returns [{title,url,source}].
async function newsSearch(term, geo, hl, when = '1h') {
  const ceid = `${geo}:${hl.split('-')[0]}`;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${term} when:${when}`)}` +
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
    const sourceTag = block.match(/<source([^>]*)>([\s\S]*?)<\/source>/i);
    const source = decode((sourceTag || [])[2] || '').trim();
    const sourceUrl = decode(((sourceTag || [])[1] || '').match(/url=["']([^"']+)["']/i)?.[1] || '');
    const title = rawTitle.replace(/\s+-\s+[^-]+$/, '').trim(); // drop trailing " - Source"
    // Drop syndication aggregators (AOL/MSN/Yahoo/…) — they re-host other outlets' photos,
    // so their image isn't original story art (user: "avoid aol.com"). The Google-News
    // `link` ALWAYS points at news.google before resolve (which itself matches the
    // aggregator host!), so we must NOT gate on it here — that would drop every item.
    // Gate on the <source url=…> attribute (the real publisher domain) and, as a belt, the
    // display name. resolveGoogleNewsUrl() rejects any aggregator the redirect lands on.
    if (isAggregatorUrl(sourceUrl) || isAggregatorUrl(source)) continue;
    if (title && /^https?:\/\//i.test(link) && !isThinUrl(link)) items.push({ title, url: link, source });
  }
  return items;
}
// Freshness ladder: X trends are meant to be VERY current, so try the tightest window
// first (last 1 hour), only widening if that's empty. `WORLD_X_WINDOWS` overrides the
// ladder (comma-list, e.g. "1h,3h"). Returns the first non-empty result set + the window
// that produced it, so callers can favour truly-fresh hits.
const X_WINDOWS = (process.env.WORLD_X_WINDOWS || '1h,3h,12h').split(',').map((w) => w.trim()).filter(Boolean);
async function newsSearchFresh(term, geo, hl) {
  for (const when of X_WINDOWS) {
    const items = await newsSearch(term, geo, hl, when);
    if (items.length) return { items, when };
  }
  return { items: [], when: null };
}
// An article is on-topic for a trend only if the trend term (minus '#') actually appears
// in the headline — kills the "Thor → unrelated Bachelor story" mismatch where a bare
// word matched a coincidental article.
function titleMatchesTerm(term, title) {
  const t = term.replace(/^#/, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const T = String(title).toLowerCase();
  if (!t) return false;
  if (t.includes(' ')) return T.includes(t); // multi-word phrase → substring
  // Latin `\b` word boundaries don't exist between CJK characters, so a whole-word regex on a
  // Japanese/Chinese term never matches. For a term that ISN'T plain Latin (has CJK/other
  // script), fall back to substring containment — the only meaningful test without word breaks.
  if (!/^[\p{Script=Latin}\p{N}]+$/u.test(t)) return T.includes(t);
  return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(T); // whole word
}
// Significant words of a headline (≥4 chars, minus filler/glue words) — the tokens that
// identify WHICH event a headline is about. Unicode-aware (keep accented Latin + other
// scripts so the sameEvent gate works on native-language headlines, not just ASCII).
function titleTokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !TAG_STOP.has(w)),
  );
}
// Do two headlines report the SAME event? Sharing the trend term alone is NOT enough — a
// single hot word ("California", a celebrity name) matches dozens of UNRELATED stories, and
// harvesting each of their og:images is exactly how a non-wildfire story ended up narrated
// over wildfire photos (user report). Require real overlap BEYOND the trend term: ≥2 shared
// significant words, at least one of which is NOT part of the term itself. Err strict — a
// dropped genuine source just means fewer photos (fine); a false match pollutes the video.
function sameEvent(repTitle, otherTitle, term = '') {
  const a = titleTokens(repTitle);
  const b = titleTokens(otherTitle);
  if (!a.size || !b.size) return false;
  const termWords = new Set(
    String(term || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3),
  );
  let shared = 0;
  let sharedNonTerm = 0;
  for (const w of a) {
    if (b.has(w)) {
      shared++;
      if (!termWords.has(w)) sharedNonTerm++;
    }
  }
  return shared >= 2 && sharedNonTerm >= 1;
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
    if (!real) return null;
    if (isAggregatorUrl(real[0])) return null; // resolved to an aggregator (AOL/MSN/Yahoo) → skip
    return real[0];
  } catch {
    return null;
  }
}

// Build "what's trending on X right now" stories for the World channel. Reads the live X
// trend board per geo (rank = heat), resolves each hot term to its freshest matching
// publisher article, then enriches to the outlet's own image + prose. Same monetization-
// safe shape as buildTrendingStories. `perGeo` = how many trends to CONVERT per geo (we
// probe a deeper pool because many trends are fandom/meme noise). Fail-open → [].
// `lang` (null = English World channel) switches trend→news resolution to the geo's OWN
// language (native channels) and relaxes the Latin-only trend filter for non-Latin scripts.
export async function buildXTrendingStories({ geos = X_GEOS, perGeo = 4, probe = 16, enrich = true, lang = null, depth = 'normal' } = {}) {
  const usedTitles = new Set();
  const out = [];
  const nonLatinOk = lang === 'ja'; // Japanese trends are their own script — don't Latin-filter
  for (const geo of geos) {
    // NATIVE channel: resolve trends to news in the geo's own language (de/fr/ja/sv/no/da);
    // World channel: resolve to English coverage of the trend.
    const hl = lang ? (X_GEO_HL_NATIVE[geo] || lang) : (X_GEO_HL[geo] || 'en-US');
    const trends = await fetchXTrends(geo, nonLatinOk);
    if (!trends.length) continue;
    let rank = 0;
    let taken = 0;
    for (const term of trends.slice(0, probe)) {
      rank++;
      if (taken >= perGeo) break;
      const { items, when } = await newsSearchFresh(term, geo, hl);
      if (!items.length) continue;
      // ALL articles whose HEADLINE contains the trend term = the outlets covering this
      // event (on-topic). The FIRST is the representative; the rest are corroborating
      // sources whose OWN photos we also want (user: "if more than 1 source reported this
      // they must have their own images — gather those").
      const onTopic = items.filter((i) => titleMatchesTerm(term, i.title));
      const hit = onTopic[0];
      if (!hit) continue;
      const key = normTitle(hit.title);
      if (!key || usedTitles.has(key)) continue;
      usedTitles.add(key);
      const real = await resolveGoogleNewsUrl(hit.url);
      if (!real) continue;
      // MULTI-SOURCE: resolve the OTHER on-topic outlets' Google-News links to real
      // publisher URLs (deduped by outlet, capped) so enrichSummary can harvest each one's
      // og:image + prose — a genuine multi-photo sequence + corroborated brief for the
      // trend, instead of a single-source story with one image. Best-effort, parallel.
      const seenSrc = new Set([cleanSource(new URL(real).hostname)]);
      const others = [];
      for (const it of onTopic.slice(1)) {
        // SAME-EVENT gate: sharing the trend term is NOT enough (one hot word matches many
        // unrelated stories → their off-topic photos leaked into the video, e.g. wildfire
        // images on a non-wildfire story). Only keep outlets whose headline genuinely
        // reports the SAME event as the rep.
        if (!sameEvent(hit.title, it.title, term)) continue;
        const src = (it.source || '').toLowerCase().trim();
        if (src && seenSrc.has(src)) continue; // one article per outlet
        if (src) seenSrc.add(src);
        others.push(it);
        if (others.length >= MULTI_OUTLETS) break;
      }
      const resolvedOthers = (await Promise.all(others.map((it) => resolveGoogleNewsUrl(it.url).catch(() => null))))
        .filter((u) => u && u !== real && !isThinUrl(u));
      const sourceUrls = [...new Set([real, ...resolvedOthers])].slice(0, MAX_SOURCE_URLS);
      // Distinct outlet names actually on this story (rep + same-event others only, so the
      // corroboration count reflects outlets on THIS event — not any headline sharing the term).
      const sourceNames = [...new Set([
        hit.source || cleanSource(new URL(real).hostname),
        ...onTopic.slice(1).filter((i) => sameEvent(hit.title, i.title, term)).map((i) => i.source).filter(Boolean),
      ])];
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
        // Every on-topic outlet's real article URL → enrichSummary harvests each one's own
        // photos of THIS event (BBC + NYT + …), so a trending Short gets a real photo set.
        sourceUrls,
        sourceName: hit.source || cleanSource(new URL(real).hostname),
        sources: sourceNames,
        corr: sourceNames.length, // DISTINCT OUTLETS, not the raw search-result count
        category: 'offbeat',
        trend: term,
        // Heat ∝ trend rank on the board (no reliable tweet-count in the markup): a small
        // deterministic score so the hottest X trend can lead a single Short.
        traffic: Math.max(0, 100000 - rank * 1000),
        // RECENCY: the freshness window that produced the hit (1h/3h/12h). The tighter the
        // window, the more current the story — a proxy for "how recent" for ranking.
        whenWindow: when,
        freshH: when === '1h' ? 0.5 : when === '3h' ? 2 : 8,
        geo,
        viral: true,
      });
    }
  }
  out.sort((a, b) => (b.traffic || 0) - (a.traffic || 0) || (b.corr || 0) - (a.corr || 0));
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s, { lang, depth })));
  // Same strict gate as Google-Trends: a real publisher image AND a brief that genuinely
  // grew past the headline (JS-rendered pages that echo the title back are dropped).
  return out.filter((s) => {
    if (!s.imageUrl || !s.summary) return false;
    const grew = s.summary.trim().length - (s.title || '').trim().length;
    return s.summary.length > 120 && grew > 40 && endsSentence(s.summary);
  });
}

// ─── RESEARCH IMAGES FOR AN EXTERNALLY-SCRIPTED STORY (the Hindi / external-audio flow) ───
// The user supplies audio + Hindi caption text; there is NO source URL. But the images must
// still come from the RESEARCH PIPELINE, not Wikidata alone (user: "you will FIRST find the
// news from those keywords and fetch the LATEST images from the latest articles with
// multi-source, recency, relevancy score"). So: derive ENGLISH search keywords from the
// story (Google News returns ~nothing for Devanagari queries but a full, dated result set
// for the English phrasing — verified), search the freshest window that has hits, keep the
// on-topic multi-source articles, RANK by recency + relevancy, then run enrichSummary in
// imagesOnly mode to harvest every outlet's OWN photos + entity portraits. Returns
// { images, entityShots, sources, sourceName } — never throws (fail-open to no images).
//
// `keywords` (optional) overrides the derived query; `geo`/`hl` localise the search
// (defaults IN/en-IN for the India channel — India outlets, English text, monetization-safe).
export async function researchImagesForStory(story, {
  keywords = null, geo = 'IN', hl = 'en-IN', maxOutlets = MULTI_OUTLETS,
} = {}) {
  const result = { images: [], entityShots: [], sources: [], sourceName: null };
  try {
    // 1) ENGLISH search phrase. Prefer an explicit keyword string; else the English title
    //    (title may be Hindi — the caller can pass keywords). Strip punctuation/quotes.
    const query = String(keywords || story.searchKeywords || story.titleEn || story.title || '')
      .replace(/["'#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (query.length < 3) return result;

    // 2) FRESHEST-FIRST search: try the tightest window that returns articles (recency).
    //    Widen only when empty so we lead with the most current coverage.
    let items = [];
    let usedWindow = null;
    for (const when of RESEARCH_WINDOWS) {
      const found = await newsSearch(query, geo, hl, when);
      if (found.length) { items = found; usedWindow = when; break; }
    }
    if (!items.length) return result;

    // 3) RELEVANCY: keep only articles whose headline genuinely overlaps the query subject
    //    (≥1 significant query word in the headline) so a broad keyword can't drag in an
    //    unrelated story's photos. The first survivor is the representative.
    const qTokens = titleTokens(query);
    const onTopic = items.filter((it) => {
      const h = titleTokens(it.title);
      for (const w of qTokens) if (h.has(w)) return true;
      return qTokens.size === 0; // no significant query tokens → accept (rare)
    });
    const ranked = onTopic.length ? onTopic : items;
    const rep = ranked[0];
    if (!rep) return result;

    // 4) MULTI-SOURCE: resolve the TOP on-topic articles (one per outlet) to real publisher
    //    URLs. For a broad research keyword ("ISRO satellite launch") each fresh article can
    //    be a DIFFERENT recent story, so we do NOT hard-gate on same-event-as-the-rep (that
    //    starves the pool to one outlet, and if that outlet is a slow govt site we get zero
    //    photos — the exact blank-frame bug). Instead we take the freshest N distinct outlets
    //    on the topic and harvest each one's OWN photos; enrichSummary dedupes + caps them.
    const seenSrc = new Set();
    const picks = [];
    for (const it of ranked) {
      const src = (it.source || '').toLowerCase().trim();
      if (src && seenSrc.has(src)) continue;
      if (src) seenSrc.add(src);
      picks.push(it);
      if (picks.length >= maxOutlets) break;
    }
    const resolved = (await Promise.all(picks.map((it) => resolveGoogleNewsUrl(it.url).catch(() => null))))
      .map((u, i) => ({ url: u, src: picks[i].source }))
      .filter((x) => x.url && !isThinUrl(x.url));
    if (!resolved.length) return result;
    result.sourceName = resolved[0].src || cleanSource(new URL(resolved[0].url).hostname);
    const sourceUrls = [...new Set(resolved.map((x) => x.url))].slice(0, MAX_SOURCE_URLS);
    result.sources = resolved.map((x) => (x.src || '').toLowerCase().trim()).filter(Boolean);

    // 5) HARVEST the real photos + entity portraits — the research pipeline's own gather,
    //    images-only so it never rewrites the user's Hindi script. lead url = first resolved;
    //    if it fails to fetch, enrichSummary still pulls the OTHER outlets' photos (resilient).
    const probe = {
      url: sourceUrls[0], sourceUrls, sourceName: result.sourceName,
      title: story.titleEn || picks[0].title, summary: story.titleEn || picks[0].title, images: [], imageUrl: null,
    };
    await enrichSummary(probe, { imagesOnly: true });
    result.images = probe.images || [];
    result.entityShots = probe.entityShots || [];
    console.log(`[research-images] "${query}" → ${result.images.length} photos from ${resolved.length} outlet(s) (window=${usedWindow})`);
  } catch (e) {
    console.log(`[research-images] failed: ${e.message}`);
  }
  return result;
}


// ── ENGLISH GUARD (the "Italian title/content" bug) ────────────────────────────────
// The World channel researches EU geos (DE/FR/IT/ES/NL), so a picked story's raw RSS
// title or an extractive-fallback summary can be in another language — which then shows
// on-screen AND is fed to English TTS (garbled speech, user report). We detect non-English
// text and rewrite it to English with the LLM ladder. Fail-open: if we CAN'T confidently
// make it English (no LLM key / call fails), the caller drops the story rather than ship a
// foreign clip on an English channel.

// Common non-English function words + diacritics. English almost never contains these, so
// a hit is a strong signal the text is foreign (cheap, no dependency, no false-positive on
// proper nouns which lack these grammatical markers).
const FOREIGN_MARKERS = /\b(der|die|das|und|nicht|über|für|ich|wird|sich|auch|dass|dem|den|mit|von|ist|eine|einen|le|la|les|des|une|dans|pour|avec|est|sont|qui|que|sur|au|aux|du|il|elle|nous|vous|ils|el|los|las|una|con|por|para|como|más|pero|este|esta|het|een|van|voor|niet|zijn|met|dat|ook)\b/i;
const DIACRITICS = /[àâäçéèêëîïôöùûüÿœßà-ÿĀ-ſ]/i; // includes ß + accents
// NON-LATIN SCRIPTS — the biggest leak. A World (English) headline NEVER contains these, so
// even ONE such character is a definitive "this is foreign" signal. The old detector only
// knew Latin-script languages (German/French/Spanish function words + accents), so Chinese,
// Japanese, Korean, Cyrillic, Arabic, Hebrew, Greek, Thai, Devanagari etc. sailed straight
// through untranslated onto the English channel. Covers the major world scripts by block.
const NON_LATIN =
  /[Ͱ-ϿЀ-ӿԀ-ԯԱ-֏֐-׿؀-ۿ܀-ݏݐ-ݿऀ-ॿঀ-৿਀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ฀-๿ༀ-࿿က-႟ᄀ-ᇿ぀-ヿ㄀-ㄯ㄰-㆏㐀-䶿一-鿿ꀀ-꓏가-힯豈-﫿･-ￜ]/;
// Latin letters (incl. accented) — used for the ratio catch-all below.
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/g;
// Is this text likely NOT English? (used before we decide to translate/drop). Foreign if:
//   1) it contains ANY non-Latin script character (Chinese/Cyrillic/Arabic/Devanagari/…), OR
//   2) it hits a Latin-script foreign function word, OR
//   3) it has a meaningful density of accented Latin characters, OR
//   4) it has letters but almost none are Latin (a script this detector doesn't enumerate).
export function looksNonEnglish(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (NON_LATIN.test(t)) return true; // any non-Latin script → definitely foreign
  if (FOREIGN_MARKERS.test(t)) return true;
  const acc = (t.match(DIACRITICS) || []).length;
  if (acc >= 2 && acc / t.length > 0.01) return true; // a couple of accents on a short headline
  // Catch-all: a string with real letters but hardly any Latin ones is a non-enumerated
  // foreign script. Guard on having some letters so digit/symbol-only strings stay English.
  const letters = (t.match(/\p{L}/gu) || []).length;
  const latin = (t.match(LATIN_LETTER) || []).length;
  return letters >= 4 && latin / letters < 0.5;
}
// Translate a single field to natural English via the LLM ladder. Returns null on failure
// (so the caller can decide to drop the story). Kept short + factual — headlines/briefs.
async function toEnglish(text, kind = 'text') {
  const t = String(text || '').trim();
  if (!t || !haveLlmKey()) return null;
  const prompt =
    `Translate the following news ${kind} into natural, idiomatic ENGLISH. Output ONLY the ` +
    `English translation — no quotes, no notes, no language label, nothing else. If it is ` +
    `already English, return it unchanged. Keep proper nouns, numbers and dates. Neutral news ` +
    `register.\n\n${t}`;
  const out = (await llmChat(prompt, { maxTokens: 300, temperature: 0.2 }).catch(() => null) || '')
    .replace(/[`*_>#\[\]{}"]/g, '').replace(/\s+/g, ' ').trim();
  if (!out || looksNonEnglish(out)) return null; // translation failed / still foreign
  return out;
}
// Ensure a story's on-screen + spoken text is ENGLISH (World channel). Mutates title +
// summary in place. Returns true if the story is safe to ship, false if it must be dropped
// (foreign text we couldn't translate). English stories pass through untouched + cost-free.
export async function ensureEnglishStory(story) {
  if (!story) return false;
  const titleForeign = looksNonEnglish(story.title);
  const summaryForeign = looksNonEnglish(story.summary);
  if (!titleForeign && !summaryForeign) return true; // already English — no LLM call
  if (titleForeign) {
    const en = await toEnglish(story.title, 'headline');
    if (!en) return false;
    story.title = en;
  }
  if (summaryForeign) {
    const en = await toEnglish(story.summary, 'summary');
    if (!en) return false;
    story.summary = en;
  }
  return true;
}

// Drop consecutive duplicate sentences + immediate word repeats ("the the", "said said")
// from LLM/extractive output — the "repeated words" the user reported. Keeps meaning,
// only removes accidental echoes.
function dedupeText(s) {
  let t = String(s || '')
    .replace(/\b(\w{3,})(\s+\1\b)+/gi, '$1') // "said said" → "said" (words ≥3 chars)
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a sentence that repeats the previous one (case/space-insensitive).
  const sents = t.split(/(?<=[.!?।])\s+/);
  const out = [];
  const seen = new Set();
  for (const sent of sents) {
    const k = sent.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(sent);
  }
  return out.join(' ').trim();
}

// Fetch the article body and build a genuinely USEFUL summary. RESEARCH-GRADE path (user:
// "do real hard work on content generation"): extract CLEAN prose from the rep article
// AND every OTHER outlet that covered the same event (shared src/extract.mjs — JSON-LD
// articleBody → Readability → og), then SYNTHESISE a corroborated, non-repetitive brief
// across ALL of them with the NVIDIA-first LLM ladder. Images come from the same extractor
// (publisher-own, ad-filtered). Fallback: extractive from the clean prose. $0, fail-open.
// `imagesOnly` (used by the external-audio / Hindi flow): harvest the publisher photos +
// entity portraits for a story whose SCRIPT is already supplied (the user's Hindi audio +
// caption text). We must NOT run the LLM synth / extractive fallback in that mode — that
// would overwrite the user's exact Hindi text with an English rewrite. So we return right
// after the image-gathering steps, leaving story.summary untouched.
// Human language name (for the synth prompt) keyed by our channel lang code. null/absent =
// the English World channel. The NATIVE channels tell the LLM to write the brief IN THIS
// LANGUAGE (no translation to English), matching the on-screen native title + native TTS.
const LANG_NAME = {
  de: 'German', nl: 'Dutch', fr: 'French', ja: 'Japanese',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', it: 'Italian', es: 'Spanish', hi: 'Hindi',
};
// `depth` tunes how much brief the LLM writes. 'deep' (single-story Shorts, where the whole
// ~30-45s video is ONE story) asks for 4-6 sentences / ~90-130 words so the clip has real
// substance and runs long enough to sequence many images; the default (roundup/long-form,
// where each story is one beat of many) keeps the tight 2-3 sentence / 45-75 word brief.
const DEPTH_SPEC = {
  deep: { sentences: '4 to 6', words: 'about 90-130 words', maxTokens: 800 },
  normal: { sentences: '2 to 3', words: 'about 45-75 words', maxTokens: 500 },
};
export async function enrichSummary(story, { imagesOnly = false, lang = null, depth = 'normal' } = {}) {
  if (!story.url || !/^https?:\/\//i.test(story.url)) return;
  try {
    // 1) Extract the representative article — clean prose + publisher-own images (already
    //    ad-filtered + same-domain-gated inside extractArticle). RESILIENT: a slow/broken rep
    //    (e.g. a govt site that times out) must NOT abort the whole harvest — we still want the
    //    OTHER outlets' photos. So fetch the rep in its own try/catch and fall through to the
    //    multi-source gather with empty rep text/images if it fails.
    let rep = { text: '', images: [] };
    try {
      const r = await fetch(story.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
      if (r.ok) rep = (await extractArticle(story.url, await r.text())) || rep;
    } catch { /* rep fetch failed — the other outlets below can still supply photos */ }
    if (rep.images.length) {
      if (!story.imageUrl) story.imageUrl = rep.images[0];
      story.images = [...new Set([story.imageUrl, ...(story.images || []), ...rep.images].filter(Boolean))];
    }

    // 2) RESEARCH ACROSS OUTLETS — pull clean prose + images from every OTHER source that
    //    covered this event (story.sourceUrls). More angles → a fuller, corroborated brief
    //    and MAXIMUM genuine photos OF THIS STORY (user: "if you find 60 sources then fetch
    //    60 images / get maximum images for the story"). Best-effort, parallel, skips the rep.
    const others = (story.sourceUrls || []).filter((u) => u && u !== story.url).slice(0, ENRICH_OUTLETS);
    const bodies = [{ src: story.sourceName || cleanSource(new URL(story.url).hostname), text: rep.text }];
    if (others.length) {
      const extracted = await Promise.all(others.map((u) => fetchAndExtract(u, { ua: UA, timeoutMs: 10000 })));
      for (let i = 0; i < extracted.length; i++) {
        const e = extracted[i];
        if (!e) continue;
        // Every outlet's OWN photos of this event → the multi-image sequence. Keep them all
        // (deduped); only the final MAX_STORY_IMAGES cap trims, so a big story with many
        // outlets yields many real photos instead of stopping at the first few.
        if (e.images.length) story.images = [...new Set([...(story.images || []), ...e.images].filter(Boolean))];
        if (e.text && e.text.length > 200) {
          let src = 'source';
          try { src = cleanSource(new URL(others[i]).hostname); } catch { /* keep */ }
          bodies.push({ src, text: e.text });
        }
      }
    }
    if (story.images?.length) story.images = story.images.slice(0, MAX_STORY_IMAGES);

    // ENTITY IMAGES (user: "if news is about an actress in a film, fetch the actress + the
    // film image; research a related image when a keyword appears"). The outlet photos above
    // cover the EVENT; now RESEARCH the key named entities (person/film/place/team/company)
    // and fetch a real, license-safe photo OF each (Wikipedia lead image / Wikidata P18 —
    // Commons CC/PD, monetization-safe). APPENDED after the event photos so the sequence
    // still LEADS with the news image, then shows who/what it's about. Fail-open.
    try {
      const entities = await extractEntities(story, haveLlmKey() ? llmChat : null);
      story.entities = entities.slice(0, 6); // persisted in bundle for the render caption layer
      // Pass the story so each entity resolves to its IN-THE-NEWS sense (user: "Odyssey
      // should give the Odyssey MOVIE, not the poem") — context-scored Wikidata disambiguation.
      const emap = await entityImageMap(entities, { story });
      if (emap.length) {
        // NAME→IMAGE pairs so the renderer can show each photo the moment its name is spoken
        // (Gap 1). Kept distinct from event photos; also merged into images[] as a fallback.
        story.entityShots = emap; // [{ name, url }]
        story.entityImages = emap.map((p) => p.url); // legacy flat list (still consumed downstream)
        story.images = [...new Set([...(story.images || []), ...story.entityImages].filter(Boolean))];
      }
    } catch { /* entity images are a bonus — never block enrichment */ }

    // IMAGES-ONLY: the external-audio flow supplied its own script (the user's Hindi text),
    // so stop here — we've gathered the event photos + entity portraits and must NOT rewrite
    // story.summary with an English synth.
    if (imagesOnly) return;

    // Combine the outlets' clean prose into ONE research corpus (labelled by outlet so the
    // model can corroborate across ALL of them → a single, well-sourced summary), capped so
    // the prompt stays within the model's context + fast.
    const corpus = bodies
      .filter((b) => b.text && b.text.length > 120)
      .map((b) => `[${b.src}] ${b.text.slice(0, SYNTH_PER_OUTLET_CHARS)}`)
      .join('\n\n')
      .slice(0, SYNTH_CORPUS_CHARS);
    if (!corpus) return;

    // 3) LLM SYNTHESIS across all sources — the NVIDIA-first ladder (shorts/llm.mjs). A
    //    tight, factual brief a viewer learns from; corroborate across outlets, no repeats.
    if (haveLlmKey()) {
      const outlets = [...new Set(bodies.map((b) => b.src))].slice(0, 8).join(', ');
      const langName = lang ? LANG_NAME[lang] : null;
      // `spec` sets the brief's length. 'deep' (single-story Shorts) → 4-6 sentences / ~90-130
      // words so the whole 30-45s clip has real substance; default → tight 2-3 sentence brief.
      const spec = DEPTH_SPEC[depth] || DEPTH_SPEC.normal;
      const lenClause = `${spec.sentences} COMPLETE sentences (${spec.words})`;
      const coverClause =
        depth === 'deep'
          ? 'Fully develop the story: after the lead, add the key background, the specific ' +
            'numbers/dates/names, and what happens next — enough that a viewer needs no other ' +
            'source. '
          : 'Fully cover the story in those sentences so a viewer needs no more. ';
      const prompt = langName
        // NATIVE channel: write the brief IN THAT LANGUAGE. The sources may already be in it
        // (native feeds) or in another language (a trend resolved to mixed coverage) — either
        // way the OUTPUT must be idiomatic <langName>, matching the native title + native TTS.
        ? `You are a sharp broadcast news writer for a ${langName}-language news channel. Below are ` +
          'excerpts from MULTIPLE outlets reporting the SAME event (they may be in ' +
          `${langName} or another language). Cross-check them and write ONE punchy, informative ` +
          `brief of ${lenClause} to be READ ALOUD in a short ` +
          `news video. WRITE ENTIRELY IN ${langName.toUpperCase()} — natural, idiomatic, native ` +
          `${langName}; translate any foreign facts into ${langName}; NEVER output English (or any ` +
          'other language) words except unavoidable proper nouns. Lead with the most important ' +
          'fact; include the key who/what/where and the number, date or consequence that matters; ' +
          'add one line of context or what happens next. Each sentence MUST be complete and end ' +
          'with proper terminal punctuation — NEVER stop mid-sentence or trail off. ' +
          coverClause +
          'Prefer facts that AGREE across outlets; ignore any that ' +
          'contradict. Neutral, factual, no hype, no opinion, no fabrication, NO repeated words ' +
          'or sentences. Plain text only — NO markdown, hashtags, brackets, quotes or emoji. Do ' +
          'not mention "the article" or the outlet names.\n\n' +
          `HEADLINE: ${story.title}\n` +
          (outlets ? `REPORTED BY: ${outlets}\n` : '') +
          `SOURCES:\n${corpus}`
        : 'You are a sharp broadcast news writer for an ENGLISH-language channel. Below are ' +
          'excerpts from MULTIPLE outlets reporting the SAME event; SOME MAY BE IN ANOTHER ' +
          'LANGUAGE (German, French, Italian, Spanish, Dutch, etc.). Cross-check them and write ' +
          `ONE punchy, informative brief of ${lenClause} to be ` +
          'READ ALOUD in a short news video. WRITE ENTIRELY IN ENGLISH — translate any foreign ' +
          'facts into natural English; NEVER output any non-English words. Lead with the most ' +
          'important fact; include the key who/what/where and the number, date or consequence ' +
          'that matters; add one line of context or what happens next. Each sentence MUST be ' +
          'complete and end with a full stop — NEVER stop mid-sentence or trail off. ' +
          coverClause +
          'Prefer facts that AGREE across ' +
          'outlets; ignore any that contradict. Neutral, factual, no hype, no opinion, no ' +
          'fabrication, NO repeated words or sentences. Plain text only — NO markdown, hashtags, ' +
          'brackets, quotes or emoji. Do not mention "the article" or the outlet names.\n\n' +
          `HEADLINE: ${story.title}\n` +
          (outlets ? `REPORTED BY: ${outlets}\n` : '') +
          `SOURCES:\n${corpus}`;
      // Roomy token budget so the brief is NEVER cut off mid-sentence by the cap (the real
      // cause of "it stops in the middle") — the length is governed by the prompt/spec.
      const synth = await llmChat(prompt, { maxTokens: spec.maxTokens });
      let clean = dedupeText((synth || '').replace(/[#*_`>\[\]{}]/g, '').replace(/\s+/g, ' ').trim());
      // COMPLETENESS GUARD: if it doesn't end on terminal punctuation, drop the trailing
      // partial back to the last COMPLETE sentence. If there's no earlier sentence boundary
      // at all (one run-on that got cut), reject the fragment rather than ship a half-thought.
      // CJK-aware: 。！？ and Devanagari । count as sentence ends too (native briefs).
      if (clean && !endsSentence(clean)) {
        const cut = clean.replace(/\s+\S*$/, '');
        const lastEnd = Math.max(
          cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'),
          cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('।'),
        );
        clean = lastEnd >= 40 ? cut.slice(0, lastEnd + 1).trim() : '';
      }
      // Japanese/Chinese have no spaces, so a complete 2-3 sentence brief is far SHORTER in
      // characters than a 120-char Latin one. Use a lower floor for space-less scripts so a
      // genuine native brief isn't rejected as "too thin".
      const minLen = lang === 'ja' ? 40 : 120;
      if (clean.length >= minLen) {
        story.summary = clean;
        return;
      }
    }

    // 4) Extractive fallback from the CLEAN corpus — RSS lead (only if a real sentence) +
    //    distinct sentences, deduped, complete sentences only, up to ~700 chars. CJK-aware:
    //    split on 。！？ too (space-less scripts) and accept them as sentence terminators.
    const seed = endsSentence(String(story.summary || '').trim()) ? story.summary : null;
    const joined = dedupeText([seed, rep.text].filter(Boolean).join(' '));
    const sentences = joined.split(/(?<=[.!?。！？])\s*/).filter((s) => endsSentence(s.trim()) && s.trim().length > 1);
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
    'first last next best worst plan plans deal talks warns urges calls faces sets gets ' +
    // Common ROLE/DESCRIPTOR nouns that lead a headline and get title-cased by convention
    // (not the entity itself) — so "Actor Jackie…" tags #Jackie, not #ActorJackie.
    'actor actress star singer author writer director player captain coach president minister ' +
    'governor senator mayor ceo chief officer report study poll video watch photos')
    .split(/\s+/),
);
// Build a clean #Hashtag from a headline/term. Picks the single most tag-worthy ENTITY: the
// longest CONTIGUOUS run of capitalised words — a real name/place/org phrase like "Jackie
// Chan", "New York", "Elon Musk" — capped at 2 words, stop-words stripped. Falls back to the
// strongest keyword, then `fallback`.
//
// WHY CONTIGUOUS (the #JackieBald fix): the old code took the first two proper nouns found
// ANYWHERE in the title and glued them, so "Actor Jackie goes Bald…" produced the nonsense
// "#JackieBald" (Jackie + Bald aren't adjacent) and "Jackie Chan…" produced "#Chan" (a
// mid-sentence-only filter dropped the lead name). A contiguous run only ever joins words that
// actually sit together, so it yields "#JackieChan" and never invents a phrase.
export function makeHashtag(text, fallback = 'News') {
  const toks = String(text || '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // A proper-noun token: starts uppercase (incl. all-caps acronyms like ISRO/NASA), not a stop word.
  const isProper = (w) => /^[\p{Lu}][\p{L}\p{N}]*$/u.test(w) && !TAG_STOP.has(w.toLowerCase());
  // Longest contiguous run of proper-noun tokens (first wins on a tie).
  let best = [];
  let cur = [];
  for (const w of toks) {
    if (isProper(w)) {
      cur.push(w);
      if (cur.length > best.length) best = cur.slice();
    } else {
      cur = [];
    }
  }
  let pick = best.slice(0, 2);
  // No capitalised entity → strongest keywords (adjacent order preserved).
  if (!pick.length) pick = toks.filter((w) => w.length > 3 && !TAG_STOP.has(w.toLowerCase())).slice(0, 2);
  if (!pick.length) return fallback;
  // Preserve all-caps acronyms (ISRO), title-case everything else, then glue.
  const cap = (w) => (/^[\p{Lu}]{2,6}$/u.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return pick.map(cap).join('').slice(0, 24);
}

function slotHashtag(slotKey, title) {
  return makeHashtag(title, SLOT_TAGS[slotKey] || 'News');
}
