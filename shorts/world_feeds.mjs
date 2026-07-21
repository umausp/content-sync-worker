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

// Word-overlap dedup key (so the same event from 2 outlets counts once).
function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).sort().slice(0, 8).join(' ');
}

// Fetch one representative, corroborated, recent story PER SLOT → 5 stories.
// corroboration = how many of the slot's outlets ran a title-similar story (a light
// quality signal). Prefers items WITH an image + more corroboration + freshness.
export async function buildWorldRoundup({ maxAgeH = 36, perSlot = 1 } = {}) {
  const now = Date.now();
  const out = [];
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
        // rep = the cluster item that has an image (preferred) else the first
        const rep = c.items.find((i) => i.imageUrl) || c.items[0];
        const freshH = rep.publishedAt ? (now - Date.parse(rep.publishedAt)) / 3.6e6 : 99;
        return { rep, corr: c.sources.size, hasImg: !!rep.imageUrl, freshH, sources: [...c.sources] };
      })
      .sort((a, b) => {
        // AUTHENTICITY ranking: a real, current story with a photo beats an old/imageless
        // one. Score = corroboration + has-image + recency (all favour a genuine event).
        const score = (x) => x.corr * 3 + (x.hasImg ? 2 : 0) + Math.max(0, 6 - x.freshH / 6);
        const d = score(b) - score(a);
        if (d !== 0) return d;
        return a.freshH - b.freshH;
      });
    // Take the top `perSlot` distinct stories from this slot (1 for Shorts, 2 for
    // long-form → 10 stories across 5 slots).
    for (const pick of ranked.slice(0, perSlot)) {
      out.push({
        slot: slot.key,
        badge: slot.label,
        hashtag: slotHashtag(slot.key, pick.rep.title),
        title: pick.rep.title,
        summary: pick.rep.summary || pick.rep.title,
        imageUrl: pick.rep.imageUrl,
        sourceName: pick.rep.sourceName,
        sources: pick.sources,
        corr: pick.corr,
        category: slot.key,
      });
    }
  }
  return out;
}

function slotHashtag(slotKey, title) {
  const words = String(title)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return (words || slotKey).slice(0, 40);
}
