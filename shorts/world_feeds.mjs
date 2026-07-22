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
  const out = [];
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
    let taken = 0;
    for (const pick of ranked) {
      if (taken >= perSlot) break;
      const key = normTitle(pick.rep.title);
      if (usedTitles.has(key)) continue; // already in another slot → skip to next-best
      usedTitles.add(key);
      taken++;
      out.push({
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
  }
  // ENRICH the summaries: RSS gives only ~1 sentence (~120 chars) — too thin for a
  // 20-35s single-story Short. Fetch each picked article and append real body
  // paragraphs so there's enough script. Parallel + best-effort (keeps the RSS summary
  // on any failure). Only bother when a fuller script is wanted (single/long-form).
  if (enrich) await Promise.all(out.map((s) => enrichSummary(s)));
  return out;
}

// Fetch an article and extend its summary with real body paragraphs (no LLM, $0). Keeps
// the story on-topic + factual; strips boilerplate (cookie/subscribe/newsletter lines).
// Article prose only (scoped to <article>/<main>, boilerplate + nav stripped) — same
// hardening as the main pipeline so we never scrape "Skip to content / Home News Sport".
function articleProse(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const container = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  const BP = /cookie|subscri|sign ?up|newsletter|advertisement|©|all rights reserved|skip to content|accessibility help|your account|more menu|follow us|read more|most read|homepage|enable ?javascript|to play this video|video can ?(?:'?t|not) be played|this content is not available|your browser (?:does|is)|playback|please (?:enable|update|upgrade)|we(?:'| ha)ve sent|check your (?:inbox|email)|getty images|photograph:|image (?:source|caption)|reuters\/|associated press/i;
  return [...container.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => {
      if (t.length < 60 || BP.test(t)) return false;
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
async function enrichSummary(story) {
  if (!story.url || !/^https?:\/\//i.test(story.url)) return;
  try {
    const r = await fetch(story.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return;
    const paras = articleProse(await r.text());
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
      const synth = await llmChat(prompt, { maxTokens: 260, temperature: 0.3 });
      const clean = (synth || '').replace(/[#*_`>\[\]{}]/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length >= 120) {
        story.summary = clean;
        return;
      }
    }

    // Extractive fallback: RSS lead + distinct body paragraphs, capped ~620 chars.
    const seen = new Set();
    const parts = [story.summary, ...paras].filter((p) => {
      const k = (p || '').slice(0, 40).toLowerCase();
      if (!p || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    let full = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (full.length > 620) full = `${full.slice(0, 617).replace(/\s+\S*$/, '')}…`;
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
  ('will would could should says say said after before amid over into from with that this ' +
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
