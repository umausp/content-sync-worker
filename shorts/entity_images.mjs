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

// MONETIZATION SAFETY: only Wikimedia COMMONS files (CC/PD) are safe to show in a monetized
// video. A file served from a LOCAL wiki upload path (/wikipedia/en/…, /wikipedia/hi/…) is a
// NON-FREE "fair use" upload — album covers, film posters, TV screenshots, company logos —
// which is copyrighted and NOT license-safe for us. Commons files live under /wikipedia/commons/.
// (P18 is Commons-only by datatype, so this only ever filters the Wikipedia-summary lead image.)
function isCommonsHosted(url) {
  return /\/wikipedia\/commons\//.test(String(url || '')) ||
    /(^|\/\/)commons\.wikimedia\.org\//.test(String(url || ''));
}

// ── Wikipedia REST: title → lead image (originalimage/thumbnail). Cheapest, one call. ──
// `type` guards against disambiguation/list pages (no real subject photo there).
async function wikipediaImage(title) {
  try {
    const j = await jget(
      `https://${WIKI_LANG}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
    );
    if (!j || j.type === 'disambiguation') return null;
    const url = j.originalimage?.source || j.thumbnail?.source || null;
    if (!url) return null;
    // The summary thumbnail is often a small crop; prefer originalimage, and drop the
    // size-limiting "/thumb/…/NNNpx-" segment so we get the full-res Commons original.
    const full = url.replace(/\/thumb(\/.+?)\/\d+px-[^/]+$/, '$1');
    // Reject non-free local-wiki uploads (posters/covers/logos) — keep only Commons CC/PD.
    return isCommonsHosted(full) ? full : null;
  } catch {
    return null;
  }
}

function commonsFilePath(file) {
  // Commons Special:FilePath resolves a file NAME to its actual image URL (handles the
  // md5-hash directory sharding). width= keeps it a reasonable size. NOT the formatter URL
  // https://commons.wikimedia.org/wiki/<file> — that returns a description PAGE, not the
  // binary (deep-research refuted that path 1-2).
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1200`;
}

// ── CONTEXT-AWARE DISAMBIGUATION (user: "Odyssey should give the Odyssey MOVIE, not the
// poem — always fetch the LATEST image which is in the news"). Wikipedia REST returns the
// PRIMARY topic for a title ("The Odyssey" → Homer's ancient poem), which is wrong when the
// news is the 2026 Nolan film. So we search Wikidata for CANDIDATES and pick the one whose
// short description best fits THIS story: other named entities appearing in it, overlap with
// the story's words, a RECENT year (news is current), and media-type words (film/series/…). ──
const CTX_TYPE = /\b(film|movie|series|show|season|album|song|single|video game|tournament|championship|election|company|startup|band|novel|book)\b/;
function buildContext(story, entities) {
  const text = `${story?.title || ''} ${story?.summary || ''}`.toLowerCase();
  const words = new Set(text.match(/[a-z]{4,}/g) || []);
  const others = (entities || []).map((e) => String(e || '').toLowerCase());
  return { words, entities: others };
}
// Score how well a Wikidata candidate's description matches the story context. Higher = the
// candidate the news is actually about. `self` is the entity being resolved (excluded from
// the other-entity signal). Context-less callers pass an empty context → score 0 (rank wins).
function scoreCandidate(desc, ctx, self) {
  const d = String(desc || '').toLowerCase();
  if (!d || !ctx) return 0;
  let s = 0;
  const selfLc = String(self || '').toLowerCase();
  for (const e of ctx.entities || []) {
    if (!e || e === selfLc) continue;
    // a co-occurring OTHER entity named in the description is the strongest signal
    if (e.split(/\s+/).some((t) => t.length >= 4 && d.includes(t))) s += 4;
  }
  for (const w of ctx.words || []) if (w.length >= 4 && d.includes(w)) s += 1;
  const ym = d.match(/\b(?:19|20)\d{2}\b/); // a recent year → the current-events sense
  if (ym && Number(ym[0]) >= 2015) s += 3;
  if (CTX_TYPE.test(d)) s += 1;
  return s;
}

// How much better a non-primary candidate must score before we OVERRIDE Wikidata's own
// rank-0 result. The rank-0 sense is right for most people/places (Zendaya → the actress,
// NOT her album), so we only switch when the story context STRONGLY points elsewhere
// (e.g. "The Odyssey" in a film story: film scores ≫ poem → switch to the film).
const OVERRIDE_MARGIN = 3;

// Resolve an entity NAME to the best-matching Wikidata item id, returning { id, label,
// description }. DEFAULTS to Wikidata's rank-0 (the primary/most-notable sense) and only
// overrides it when a later candidate beats rank-0's context score by ≥OVERRIDE_MARGIN.
// One API call. With no context, always returns rank-0.
async function resolveWikidataItem(name, ctx) {
  const s = await jget(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
      `&language=en&format=json&limit=7&origin=*`,
  );
  const cands = s?.search || [];
  if (!cands.length) return null;
  const primary = cands[0];
  const asItem = (c) => (c ? { id: c.id, label: c.label, description: c.description } : null);
  if (!ctx) return asItem(primary);
  const primaryScore = scoreCandidate(primary.description, ctx, name);
  // find the highest-scoring NON-primary candidate
  let alt = null;
  let altScore = -Infinity;
  for (let i = 1; i < cands.length; i++) {
    const sc = scoreCandidate(cands[i].description, ctx, name) - i * 0.01; // rank tiebreak
    if (sc > altScore) { altScore = sc; alt = cands[i]; }
  }
  // Override only on a strong, positive contextual win over the primary sense.
  if (alt && altScore >= primaryScore + OVERRIDE_MARGIN && altScore > 0) return asItem(alt);
  return asItem(primary);
}

// Given a resolved Wikidata id, fetch (in ONE call) its enwiki article TITLE + P18 image.
// Prefer the Wikipedia lead image of the RIGHT article (curated, editorial); fall back to
// the P18 Commons file. Returns an image URL or null.
async function imageForWikidataId(id) {
  const e = await jget(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}` +
      `&props=sitelinks|claims&sitefilter=enwiki&format=json&origin=*`,
  );
  const ent = e?.entities?.[id];
  const title = ent?.sitelinks?.enwiki?.title;
  if (title) {
    const wimg = await wikipediaImage(title);
    if (wimg) return wimg;
  }
  const file = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return file ? commonsFilePath(file) : null;
}

// Resolve ONE entity name → a usable image URL, DISAMBIGUATED by the story context so a
// title in the news (a film, an album, a person) maps to the RIGHT article rather than the
// generic primary topic. Gated through acceptImage (no ads/aggregators/tiny/avatars).
//   • WITH context → Wikidata context-scored resolution FIRST (fixes "Odyssey → the poem"),
//     then a bare Wikipedia-summary fallback.
//   • WITHOUT context → cheap Wikipedia-summary first, then Wikidata rank-1.
export async function entityImage(name, ctx = null) {
  const clean = String(name || '').trim();
  if (clean.length < 3) return null;
  let url = null;
  try {
    if (ctx) {
      // Context path: resolve to the IN-THE-NEWS sense via Wikidata. Use its image if it
      // has one; only if Wikidata resolved NOTHING do we fall back to the bare Wikipedia
      // summary. We do NOT fall back to the summary when Wikidata resolved a specific sense
      // but that sense has no free image — that would return the WRONG-sense photo (e.g.
      // Homer's poem for a Nolan-film story). Better no entity image than a wrong one.
      const item = await resolveWikidataItem(clean, ctx);
      if (item) url = await imageForWikidataId(item.id);
      else url = await wikipediaImage(clean);
    } else {
      url = (await wikipediaImage(clean)) || (await (async () => {
        const item = await resolveWikidataItem(clean, null);
        return item ? imageForWikidataId(item.id) : null;
      })());
    }
  } catch {
    return null;
  }
  if (!url || isAggregatorUrl(url)) return null;
  // pubDomain '' → accept any host (Commons/Wikipedia upload domains), path/ad gate still applies.
  return acceptImage(url, '');
}

// Fetch photos for up to ENTITY_IMG_MAX entities in parallel, preserving priority order.
// `entities` = ranked list of names (most important first). `story` (optional) provides the
// disambiguation context so each entity resolves to its IN-THE-NEWS sense. Returns a deduped
// list of { name, url } PAIRS — kept paired so the render layer can time each photo to the
// moment ITS entity name is spoken (Gap 1: "right image at right time when it spells out").
export async function entityImageMap(entities, { max = ENTITY_IMG_MAX, story = null } = {}) {
  if (!ENABLE || !Array.isArray(entities) || !entities.length) return [];
  const pick = entities.slice(0, max);
  const ctx = story ? buildContext(story, entities) : null;
  const pairs = await Promise.all(
    pick.map(async (e) => ({ name: String(e || '').trim(), url: await entityImage(e, ctx).catch(() => null) })),
  );
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    if (!p.url || !p.name || seen.has(p.url)) continue; // dedupe on URL (same photo, keep first name)
    seen.add(p.url);
    out.push(p);
  }
  return out;
}

// Back-compat: just the deduped URLs (drops the name pairing). Prefer entityImageMap.
export async function entityImages(entities, opts = {}) {
  return (await entityImageMap(entities, opts)).map((p) => p.url);
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
