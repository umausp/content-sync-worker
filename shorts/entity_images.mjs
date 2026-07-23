// entity_images.mjs — FREE, license-safe "picture of the thing the story is about."
//
// The problem (user: "if news is about an actress in The Odyssey, fetch the actress AND
// the movie image; when a keyword appears, research a related image from other sources"):
// outlet og:images cover the EVENT, but a story often names a PERSON / FILM / PLACE / TEAM /
// COMPANY the viewer wants to SEE — and the outlet photo may be a logo, a stadium, or a
// generic crowd. So we RESEARCH each key entity and fetch a real photo OF it.
//
// SOURCES (all $0 + monetization-safe — public-domain / CC / freely licensed):
//   • Wikipedia REST summary  → the article's lead image (a person's portrait, a film
//     poster's subject, a landmark). https://<lang>.wikipedia.org/api/rest_v1/page/summary/<title>
//   • Wikidata P18 (image)    → the canonical Commons image for the entity, resolved via
//     wbsearchentities → wbgetclaims → Commons file URL. More precise for disambiguation.
// Both are Wikimedia — no API key, generous rate limits, and their images are Commons
// (CC-BY-SA / PD), safe to show in a monetized video WITH on-screen source credit (we
// already render "Source:" chrome; the entity photo is a factual news illustration).
//
// We NEVER use Google Images / gstatic / social-media avatars (copyright + the exact leak
// the user flagged). Entity photos are SECONDARY: appended AFTER the real outlet photos so
// the sequence still LEADS with the event image, then shows who/what it's about.
//
// Fail-open everywhere: any network/parse error → skip that entity (never blocks a render).

import { acceptImage, isAggregatorUrl } from '../src/extract.mjs';

const UA = 'AgyataNewsBot/1.0 (https://agyata.com; contact@agyata.com) Node';
const WIKI_LANG = process.env.SHORTS_WIKI_LANG || 'en';
const ENTITY_IMG_MAX = Number(process.env.SHORTS_ENTITY_IMG_MAX || 3); // entities to illustrate
const ENABLE = process.env.SHORTS_ENTITY_IMAGES !== '0'; // on by default

const jget = async (url, { timeoutMs = 8000 } = {}) => {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

// ── Wikipedia REST: title → lead image (originalimage/thumbnail). Cheapest, one call. ──
// `type` guards against disambiguation/list pages (no real subject photo there).
async function wikipediaImage(title) {
  try {
    const j = await jget(
      `https://${WIKI_LANG}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
    );
    if (!j || j.type === 'disambiguation') return null;
    const url = j.originalimage?.source || j.thumbnail?.source || null;
    // The summary thumbnail is often a small crop; prefer originalimage, and drop the
    // size-limiting "/thumb/…/NNNpx-" segment so we get the full-res Commons original.
    return url ? url.replace(/\/thumb(\/.+?)\/\d+px-[^/]+$/, '$1') : null;
  } catch {
    return null;
  }
}

// ── Wikidata: entity search → P18 (image) → Commons file URL. More precise (uses the
// knowledge graph to disambiguate "The Odyssey (2026 film)" from the poem). ──
async function wikidataImage(name) {
  try {
    const s = await jget(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&format=json&limit=1&origin=*`,
    );
    const id = s?.search?.[0]?.id;
    if (!id) return null;
    const c = await jget(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${id}&property=P18&format=json&origin=*`,
    );
    const file = c?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (!file) return null;
    // Commons Special:FilePath resolves a file NAME to its actual image URL (handles the
    // md5-hash directory sharding). width= keeps it a reasonable size.
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1200`;
  } catch {
    return null;
  }
}

// Resolve ONE entity name → a usable image URL (Wikipedia lead first — it's the most
// "editorial" pick; Wikidata P18 as the disambiguating fallback). Gated through the same
// acceptImage filters (no ads/aggregators/tiny/avatars) as every other image.
export async function entityImage(name) {
  const clean = String(name || '').trim();
  if (clean.length < 3) return null;
  const url = (await wikipediaImage(clean)) || (await wikidataImage(clean));
  if (!url || isAggregatorUrl(url)) return null;
  // pubDomain '' → accept any host (Commons/Wikipedia upload domains), path/ad gate still applies.
  return acceptImage(url, '');
}

// Fetch photos for up to ENTITY_IMG_MAX entities in parallel, preserving priority order.
// `entities` = ranked list of names (most important first). Returns deduped image URLs.
export async function entityImages(entities, { max = ENTITY_IMG_MAX } = {}) {
  if (!ENABLE || !Array.isArray(entities) || !entities.length) return [];
  const pick = entities.slice(0, max);
  const urls = await Promise.all(pick.map((e) => entityImage(e).catch(() => null)));
  return [...new Set(urls.filter(Boolean))];
}

// ── ENTITY EXTRACTION — which names in the story are worth a picture? ──
// Heuristic (no dependency, works offline): pull multi-word Capitalized runs (proper
// nouns) from the TITLE first (the headline names the subject), then the summary. Filters
// leading filler ("The", "After", …) and single common words. The LLM path (below) is
// preferred when a provider is reachable — it distinguishes a PERSON/FILM/PLACE worth
// showing from a generic capitalized word — but this guarantees we always have candidates.
const LEAD_STOP = new Set(
  ('the a an this that these those after before amid over under with from into for and but ' +
    'his her their its new latest breaking watch how why what when where who will would could ' +
    'says said report reports update')
    .split(/\s+/),
);
export function extractEntitiesHeuristic(story) {
  // Split into sentences FIRST so a Capitalized run can't leap a sentence boundary
  // ("…The Odyssey. Universal Pictures…" must NOT yield "Odyssey. Universal Pictures").
  // The title is its own unit. A period is allowed INSIDE a run only for a dotted
  // initialism ("U.S."), never as a sentence terminator (a period followed by space+cap).
  const units = [String(story?.title || ''), ...String(story?.summary || '').split(/(?<=[.!?])\s+/)];
  const seen = new Set();
  const out = [];
  for (const unit of units) {
    const runs = unit.match(/\b([A-Z][a-zA-Z'&-]+(?:\.[A-Z])?(?:\s+[A-Z][a-zA-Z'&-]+){0,3})\b/g) || [];
    for (let r of runs) {
      // Trim a leading filler word ("The Odyssey" keeps Odyssey-context, but "After Trump" → "Trump").
      const words = r.split(/\s+/);
      while (words.length > 1 && LEAD_STOP.has(words[0].toLowerCase())) words.shift();
      r = words.join(' ').replace(/\.$/, '').trim(); // never keep a trailing sentence period
      const key = r.toLowerCase();
      if (r.length < 3 || seen.has(key)) continue;
      // Skip a single common word that merely started a sentence (only kept if multi-word
      // or clearly a name — a lone all-caps/Capitalized token ≥4 chars is likely a proper noun).
      if (words.length === 1 && (LEAD_STOP.has(key) || r.length < 4)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// LLM-backed extraction: ask for the 1-3 most VISUAL entities (a person, film, place, team,
// company) that a viewer would want to SEE, as a strict JSON array. Falls back to the
// heuristic on any failure. `llmChat` is injected so this module has no provider coupling.
export async function extractEntities(story, llmChat) {
  const heuristic = extractEntitiesHeuristic(story);
  if (typeof llmChat !== 'function') return heuristic;
  try {
    const prompt =
      'From this news headline and summary, list the 1 to 3 most VISUAL named entities a ' +
      'viewer would want to SEE on screen — a specific PERSON, FILM/SHOW, PLACE/LANDMARK, ' +
      'SPORTS TEAM, or COMPANY. Prefer the main subject. Use the exact proper name (the ' +
      'name a Wikipedia article would use). Ignore generic words. Respond with ONLY a JSON ' +
      'array of strings, most important first, no prose.\n\n' +
      `HEADLINE: ${story?.title || ''}\nSUMMARY: ${story?.summary || ''}`;
    const raw = await llmChat(prompt, { maxTokens: 120, json: true });
    if (raw) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        const names = (Array.isArray(arr) ? arr : []).map((s) => String(s || '').trim()).filter((s) => s.length >= 3);
        if (names.length) return [...new Set(names)];
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  return heuristic;
}
