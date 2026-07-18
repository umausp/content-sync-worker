// Entity-aware clustering — the fix for "one event became 25 stories". Headline
// word-overlap (dedup.mjs) can't tell that "Kejriwal urges Wangchuk" and "Tharoor
// appeals to Wangchuk" are the SAME ongoing event — they share few words but ONE
// dominant subject. Google News clusters by the underlying entity+event, not
// headline words. This module extracts a title's PRIMARY ENTITY (the person/org/
// place the story is really about) so same-subject stories converge on ONE thread.
//
// The primary entity also drives the HASHTAG: a short, stable, entity-anchored tag
// (e.g. #SonamWangchuk, #Vikram1) that every story about that subject shares →
// ingest upserts them as UPDATES to one story, not 25 separate cards.

// Words that look capitalised mid-headline but are NOT entities (titles, filler).
const NON_ENTITY = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'of', 'to', 'for', 'and', 'or', 'with', 'after', 'over',
  'as', 'by', 'from', 'amid', 'says', 'said', 'urges', 'slams', 'visits', 'appeals', 'welcomes',
  'india', 'indian', 'delhi', 'new', 'chief', 'minister', 'pm', 'cm', 'mp', 'mla', 'president',
  'court', 'high', 'supreme', 'police', 'govt', 'government', 'party', 'leader', 'day', 'today',
  'live', 'breaking', 'update', 'news', 'report', 'first', 'set', 'plan', 'top', 'big', 'watch',
  'his', 'her', 'their', 'this', 'that', 'more', 'than', 'will', 'may', 'can', 'not', 'who',
  // sentence-initial / interrogative / filler capitals that are NOT entities —
  // these were leaking into canonical entities ("How Sonam Wangchuk", "What…").
  'how', 'what', 'why', 'when', 'where', 'which', 'whose', 'is', 'are', 'was', 'were', 'be',
  'it', 'he', 'she', 'they', 'we', 'you', 'here', 'there', 'now', 'then', 'no', 'yes', 'up',
  'out', 'off', 'down', 'over', 'all', 'some', 'many', 'few', 'one', 'two', 'services',
  'production', 'amp', 'ss', 'watch', 'read', 'exclusive', 'video', 'photos', 'pics',
]);

// Multi-word proper-noun phrases (consecutive Capitalised words) are the strongest
// entity signal — "Sonam Wangchuk", "Supreme Court", "Vikram-1". We also keep
// standalone distinctive capitalised tokens + alphanumeric product names (Vikram-1).
export function extractEntities(title) {
  const raw = String(title || '');
  const tokens = raw.split(/\s+/);
  const phrases = [];
  let cur = [];
  for (const tok of tokens) {
    const w = tok.replace(/[^\p{L}\p{N}\-]/gu, '');
    if (!w) { if (cur.length) { phrases.push(cur); cur = []; } continue; }
    const isCap = /^[A-Z]/.test(w) || /\d/.test(w); // Capitalised OR has a digit (product/number)
    const isNoise = NON_ENTITY.has(w.toLowerCase());
    if (isCap && !isNoise && w.length > 1) {
      cur.push(w);
    } else {
      if (cur.length) { phrases.push(cur); cur = []; }
    }
  }
  if (cur.length) phrases.push(cur);
  // Normalise each phrase → lowercase alnum key. For a MULTI-word person/org
  // ("Sonam Wangchuk"), ALSO emit the last token ("wangchuk") as an alias, so a
  // later headline that only says "Wangchuk" unifies with it. The full phrase is
  // the canonical key; aliases let short references match.
  // Normalise a token→key: lowercase, alnum-only, and strip a trailing possessive
  // 's' so "Wangchuk" and "Wangchuk's"/"Wangchuks" unify (they split clusters).
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, (m, i, str) => (str.length > 4 ? '' : m));
  const ents = [];
  for (const p of phrases) {
    const raw = p.join(' ');
    const key = norm(raw);
    if (key.length < 3) continue;
    const aliases = new Set([key]);
    if (p.length >= 2) {
      const last = norm(p[p.length - 1]);
      if (last.length >= 4) aliases.add(last); // surname/product alias
    }
    ents.push({ raw, key, aliases: [...aliases] });
  }
  // Dedup by key + sort by specificity (longer/multi-word first).
  const seen = new Set();
  const out = [];
  for (const e of ents.sort((a, b) => b.key.length - a.key.length)) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out; // [{raw:"Sonam Wangchuk", key:"sonamwangchuk", aliases:["sonamwangchuk","wangchuk"]}, ...]
}

// Corpus-aware clustering: group titles by their shared HOT entity (an entity/
// alias recurring across ≥2 titles). Returns clusters as arrays of the original
// items. Each item is {title, ...}; getTitle extracts the title. This is what
// collapses "one event → 25 stories": every Wangchuk headline lands in one group.
export function clusterByEntity(items, getTitle, minCluster = 2) {
  // 1. per-item entity alias sets + global alias frequency
  const per = items.map((it) => {
    const ents = extractEntities(getTitle(it));
    const aliases = new Set();
    for (const e of ents) for (const a of e.aliases) aliases.add(a);
    return { it, ents, aliases };
  });
  const freq = {};
  for (const p of per) for (const a of p.aliases) freq[a] = (freq[a] || 0) + 1;
  // 2. hot aliases (recurring) — the real subjects of the hour
  const hot = new Set(Object.entries(freq).filter(([, n]) => n >= minCluster).map(([a]) => a));
  // 3. assign each item to a hot alias. A story's SUBJECT is the SPECIFIC recurring
  //    entity, not a ubiquitous BACKGROUND name (Modi/India/BJP appear in many
  //    unrelated stories). So: (a) never anchor on a GENERIC background entity if a
  //    specific hot entity co-occurs; (b) among specific candidates, pick the most
  //    frequent, tie-break by longer/more-specific alias.
  const groups = new Map();
  const canonRaw = new Map(); // key → best human-readable raw form
  const solo = [];
  for (const p of per) {
    const hotAliases = [...p.aliases].filter((a) => hot.has(a));
    const specific = hotAliases.filter((a) => !GENERIC_ENTITY.has(a));
    const pool = specific.length ? specific : hotAliases; // background name only if it's all we have
    if (pool.length === 0) { solo.push([p.it]); continue; }
    pool.sort((a, b) => freq[b] - freq[a] || b.length - a.length);
    const key = pool[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.it);
    const best = p.ents.find((e) => e.aliases.includes(key));
    if (best && (!canonRaw.has(key) || best.raw.length > canonRaw.get(key).length)) canonRaw.set(key, best.raw);
  }
  // 4. MERGE surname-only groups into their full-name group. "wangchuk" and
  //    "sonamwangchuk" are the same person — the full name is a superstring of the
  //    surname alias, so fold the shorter into the longer.
  const keys = [...groups.keys()].sort((a, b) => b.length - a.length); // longest first
  for (const shortKey of [...keys].sort((a, b) => a.length - b.length)) {
    if (!groups.has(shortKey)) continue;
    // find a longer key that ENDS WITH this key (surname) — the canonical full name
    const full = keys.find((k) => k !== shortKey && groups.has(k) && k.endsWith(shortKey) && k.length > shortKey.length);
    if (full) {
      groups.get(full).push(...groups.get(shortKey));
      groups.delete(shortKey);
    }
  }
  return {
    clusters: [...groups.entries()].map(([key, its]) => ({ key, canonicalEntity: canonRaw.get(key) || key, items: its })),
    solo,
  };
}

// Background entities that appear across MANY unrelated stories — they must never
// be a cluster's anchor when a specific co-occurring subject exists (else every
// story mentioning Modi/India clusters together).
const GENERIC_ENTITY = new Set([
  'modi', 'india', 'indian', 'bjp', 'congress', 'aap', 'rss', 'pmmodi', 'narendramodi',
  'delhi', 'mumbai', 'supremecourt', 'highcourt', 'centre', 'government', 'parliament',
  'us', 'usa', 'china', 'pakistan', 'trump', 'sensex', 'nifty',
]);

// The PRIMARY entity — the single subject a story clusters under. Heuristic: the
// most specific (longest) multi-word proper noun, else the longest single entity.
export function primaryEntity(title) {
  const ents = extractEntities(title);
  if (ents.length === 0) return null;
  // Prefer a multi-word phrase (has a space in raw) — those are real subjects
  // ("Sonam Wangchuk") over generic single caps.
  const multi = ents.find((e) => /\s/.test(e.raw));
  return multi || ents[0];
}

// Two titles are the SAME EVENT (entity sense) if they share their primary entity
// AND at least one other distinctive entity/word — so "Wangchuk hunger strike" and
// "Wangchuk wins Padma Shri" (same person, DIFFERENT event) do NOT merge, but
// "Kejriwal urges Wangchuk [to end strike]" and "Tharoor appeals to Wangchuk [to
// break fast]" DO (shared primary Wangchuk + shared event-word strike/fast).
const EVENT_WORDS = /\b(strike|fast|hunger|protest|launch|blast|attack|arrest|verdict|ruling|poll|election|result|win|loss|fire|crash|flood|quake|death|dies|killed|resign|ban|raid|hospital|rescue|deal|pact|summit|budget|hike|cut|surge|fall|crore|lakh|match|final)/i;
export function sameEntityEvent(titleA, titleB) {
  const pa = primaryEntity(titleA);
  const pb = primaryEntity(titleB);
  if (!pa || !pb || pa.key !== pb.key) return false; // different primary subject
  // Same subject — require a shared EVENT word so different events about the same
  // person don't collapse. If neither has an event word, fall back to requiring
  // the shared primary is a MULTI-word entity (specific enough on its own).
  const ea = (titleA.match(EVENT_WORDS) || [])[0]?.toLowerCase();
  const eb = (titleB.match(EVENT_WORDS) || [])[0]?.toLowerCase();
  if (ea && eb) return ea === eb; // same subject + same event kind → same thread
  if (!ea && !eb) return /\s/.test(pa.raw); // both eventless → merge only if specific multi-word subject
  return false; // one has an event word, the other doesn't → likely different
}

// Build a SHORT, stable, entity-anchored hashtag. Primary entity + (optional)
// event word, CamelCase, capped. Same event → same hashtag → ingest upserts as an
// update. This replaces the old headline-word hashtag that drifted per-headline.
const STOP_H = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'with', 'his', 'her']);
export function entityHashtag(title) {
  const p = primaryEntity(title);
  const ev = (title.match(EVENT_WORDS) || [])[0];
  if (p) {
    const base = p.raw.split(/\s+/).filter((w) => !STOP_H.has(w.toLowerCase())).slice(0, 3);
    // strip a trailing possessive/plural 's on the LAST word ("Wangchuks"→"Wangchuk")
    let tag = base.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).map((w, i) => (i === base.length - 1 ? w.replace(/s$/, (m, _i, s) => (s.length > 4 ? '' : m)) : w)).map(cap).join('');
    if (ev && tag.length < 40) tag += cap(ev.replace(/[^a-z0-9]/gi, ''));
    tag = tag.slice(0, 48);
    if (tag.length >= 5) return tag;
  }
  // fallback: first 3 distinctive words of the title
  const words = String(title).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length > 2 && !STOP_H.has(w.toLowerCase())).slice(0, 4);
  const tag = words.map(cap).join('').slice(0, 48);
  return tag.length >= 5 ? tag : 'Story' + Math.abs(hash(title)).toString(36).slice(0, 6);
}
function cap(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''; }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
