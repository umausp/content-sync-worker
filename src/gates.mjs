// gates.mjs — the GOLD-STANDARD editorial gate stack. Mirrors the layered checks
// real newsrooms run (Google SOURCERANK + Prominence, BBC editorial standards,
// Reuters Tracer verification). A candidate must pass EVERY gate, in order, to
// publish. Each gate is a pure function → returns a reject-reason string, or null
// to pass. Mostly algorithmic (fast, deterministic, free); the expensive
// LLM fact-consistency gate lives in review.mjs and runs LAST on survivors only.
//
// Gate order (cheap→expensive, most-common-reject first):
//   G1  structure      — required fields, real title, single category, hashtag
//   G2  spam / PR      — ad/press-release/promo/affiliate markers
//   G3  clickbait      — curiosity-gap, ALLCAPS, excessive punctuation
//   G4  gossip/opinion — celebrity personal-life, prediction/analysis-as-news
//   G5  superlatives   — unverifiable "biggest/first-ever" without attribution
//   G6  safety         — minors+crime, suicide method, communal framing, slurs
//   G7  staleness      — source article older than MAX_AGE_H
//   G8  language       — English-quality, not truncated, sentence sanity
//   G9  fact-shape     — body must not invent numbers/quotes absent from source
//   (G10 fact-consistency LLM verifier + G11 corroboration/importance bar: review.mjs)

export const CATEGORIES = ['top', 'politics', 'world', 'business', 'tech', 'science', 'health', 'sports', 'entertainment'];

const BAD_TITLE = /^[\s.\-–—…]*$|^(untitled|news|update|test|breaking|latest)$/i;
const PR_MARKERS = /\b(press release|prnewswire|businesswire|sponsored|advertorial|partnered content|brand ?post|in partnership with|use code|affiliate|shop now|buy now|discount|coupon|% off|deal of the day|book now|sign up today)\b/i;
const CLICKBAIT = /\b(shocking|shook|you won'?t believe|won'?t believe|goes viral|watch:|must[- ]see|mind[- ]blowing|jaw[- ]dropping|here'?s why|this is what happens|number \d+ will|will blow your mind|what happened next|internet reacts|breaks the internet)\b/i;
const GOSSIP = /\b(spotted|snapped|papped|dating|rumou?red|is said to|reportedly in love|crush on|throwback|opens up about|breaks silence|reacts to|hits back|slams|takes a dig|trolled|fans react|netizens|goes topless|flaunts|steals the show|turns heads|sizzles|oozes|bold (look|avatar)|cosy|cozy|pda|wedding rumou?rs)\b/i;
const OPINION = /\b(could|should|would|may|might|set to (shine|impress|dazzle|win|rule)|predicts?|tipped to|likely to (win|clinch)|hopes? to|aims? to|is expected to shine|opinion:|analysis:|comment:|view:|why .* matters|the case for|here'?s how .* can)\b/i;
const SUPERLATIVE = /\b(biggest ever|highest[- ]grossing|record[- ]breaking|most[- ]watched|first[- ]ever|largest ever|fastest ever|best ever|worst ever|all[- ]time (high|low|record))\b/i;
// Safety: sexual content w/ minors, suicide method, communal/incitement, slurs.
const SAFETY = /\b(child (porn|sexual)|minor.*(rape|sexual)|underage.*(sexual|nude)|suicide (method|how to|by hanging|by jumping)|kill (yourself|themselves)|hang (himself|herself|themselves)|ways to die|behead|lynch(ed|ing)? the|exterminate|genocide against|wipe out the (hindus|muslims|christians|sikhs))\b/i;

// Distinctive numbers/entities present in a text (for fact-shape checking).
function numbers(s) { return (String(s).match(/\b\d[\d,.]*\b/g) || []).map((x) => x.replace(/[.,]$/, '')); }
function quoted(s) { return (String(s).match(/[""][^""]{6,}[""]|"[^"]{6,}"/g) || []); }

// ── Individual gates ────────────────────────────────────────────────────────
export function gStructure(c) {
  const t = (c.title || '').trim();
  if (t.length < 12) return 'title_too_short';
  if (BAD_TITLE.test(t)) return 'placeholder_title';
  if (/\|/.test(t)) return 'title_has_pipe';
  if (/(\.\.\.|…)\s*$/.test(t)) return 'title_trailing_ellipsis';
  if (!CATEGORIES.includes(c.category)) return 'bad_category';
  if (!/^[A-Za-z][\p{L}\p{N}_]{5,59}$/u.test(c.hashtag || '')) return 'bad_hashtag';
  const body = (c.body || '').trim();
  if (body.length < 80) return 'body_too_short';
  if ((c.summary || '').trim().length < 25) return 'summary_too_short';
  if (!c.article?.url || !/^https?:\/\//i.test(c.article.url)) return 'no_source_url';
  return null;
}
export function gSpam(c) {
  const hay = `${c.title} ${c.summary} ${c.body}`;
  return PR_MARKERS.test(hay) ? 'spam_or_pr' : null;
}
export function gClickbait(c) {
  const t = c.title || '';
  if (CLICKBAIT.test(t)) return 'clickbait';
  if ((t.match(/[!?]/g) || []).length >= 3) return 'excessive_punctuation';
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 10 && letters === letters.toUpperCase()) return 'all_caps';
  return null;
}
export function gGossip(c) { return GOSSIP.test(`${c.title} ${c.summary}`) ? 'gossip' : null; }
export function gOpinion(c) { return OPINION.test(c.title || '') ? 'opinion_or_prediction' : null; }
export function gSuperlative(c) {
  const t = c.title || '';
  // Allowed if a number/official source is attributed nearby (kept simple: any digit present).
  if (SUPERLATIVE.test(t) && !/\d/.test(t)) return 'unverifiable_superlative';
  return null;
}
export function gSafety(c) { return SAFETY.test(`${c.title} ${c.summary} ${c.body}`) ? 'safety_sensitive' : null; }
export function gStaleness(c, nowMs, maxAgeH) {
  const t = c.article?.publishedAt ? Date.parse(c.article.publishedAt) : NaN;
  if (!Number.isNaN(t) && (nowMs - t) / 3.6e6 > maxAgeH) return 'stale';
  return null;
}
export function gLanguage(c) {
  const body = (c.body || '').trim();
  // Must read as >=2 real sentences, not a fragment or a headline echo. Split on a
  // sentence-ender followed by whitespace OR end-of-string, so the FINAL sentence
  // and newline-separated sentences are counted (the old /[.!?]\s/ dropped both).
  const sentences = body.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim().length > 12).length;
  if (sentences < 2) return 'body_too_few_sentences';
  if (/[.,;:]$/.test(c.title || '')) return 'title_bad_terminal_punct';
  // Title shouldn't just equal the body's first fragment (lazy model).
  if (body.toLowerCase().startsWith((c.title || '').toLowerCase().slice(0, 40)) && body.length < 120) return 'body_echoes_title';
  return null;
}
// Fact-shape: the synthesised body must not INVENT numbers or quotes that aren't
// in the source snippet/title (cheap hallucination guard before the LLM verifier).
export function gFactShape(c) {
  const src = `${c.article?.title || ''} ${c.article?.snippet || ''}`;
  const srcNums = new Set(numbers(src));
  const bodyNums = numbers(c.body || '');
  // Allow years + small ints; flag a specific multi-digit number absent from source.
  const invented = bodyNums.filter((n) => n.replace(/[^\d]/g, '').length >= 3 && !srcNums.has(n) && !/^(19|20)\d{2}$/.test(n));
  if (invented.length >= 2) return 'invented_numbers';
  // Quotes in body must have some basis in source (source has a quote too).
  if (quoted(c.body || '').length > 0 && quoted(src).length === 0 && !/said|according to|told|stated/i.test(src)) return 'invented_quote';
  return null;
}

// Run all algorithmic gates in order; return {reason} or null (pass).
export function runGates(c, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeH = opts.maxAgeH ?? 36;
  const chain = [
    ['structure', gStructure(c)],
    ['spam', gSpam(c)],
    ['clickbait', gClickbait(c)],
    ['gossip', gGossip(c)],
    ['opinion', gOpinion(c)],
    ['superlative', gSuperlative(c)],
    ['safety', gSafety(c)],
    ['staleness', gStaleness(c, nowMs, maxAgeH)],
    ['language', gLanguage(c)],
    ['factshape', gFactShape(c)],
  ];
  for (const [gate, reason] of chain) if (reason) return { gate, reason };
  return null;
}
