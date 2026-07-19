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

export const CATEGORIES = ['top', 'politics', 'world', 'business', 'tech', 'science', 'health', 'sports', 'entertainment', 'local'];

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

// A VIDEO-NATIVE story = a trending video where the clip IS the content (YouTube-
// trending). Its "body" is a caption, so the body-shape gates (length, echoes-
// title, is-a-sentence) don't apply — the player carries the value. Flag set on the
// candidate + its article in the pipeline.
function isVideoNative(c) { return c?.videoNative === true || c?.article?.videoNative === true; }

// ── REPAIR pass (run BEFORE the gates) ───────────────────────────────────────
// A real newsroom (Google News / Reuters / Inshorts) does NOT discard a genuine
// story because its headline carries the outlet's " | The Hindu" suffix or a
// trailing "…", or because the body just echoes the title. It NORMALISES them.
// normalizeCandidate mutates+returns the candidate with these COSMETIC defects
// FIXED, so the gates then only reject GENUINE garbage (empty/slug/markup/unsafe),
// not fixable formatting. Idempotent + safe on already-clean input.
export function normalizeCandidate(c) {
  if (!c) return c;
  let t = String(c.title || '').trim();
  // Strip an outlet/section suffix after a pipe or middot: "Headline | The Hindu",
  // "Headline · NDTV" → "Headline". Keep the LONGEST leading segment that's a real
  // headline (>=15 chars) so we don't nuke a title that legitimately contains a pipe
  // mid-sentence (rare). Also collapse any remaining pipes to a dash.
  if (/[|]/.test(t)) {
    const head = t.split(/\s*\|\s*/)[0].trim();
    t = head.length >= 15 ? head : t.replace(/\s*\|\s*/g, ' — ');
  }
  // Trim a trailing ellipsis ("Makers announce…" → "Makers announce").
  t = t.replace(/\s*(\.\.\.|…)\s*$/, '').trim();
  // Trailing terminal punctuation on a headline reads oddly → drop a lone .,;:
  t = t.replace(/[.,;:]+$/, '').trim();
  c.title = t;

  // BODY repair. A thin/empty body OR one that just echoes the title (lazy synth /
  // extractive fallback) is not WRONG — but we can enrich it from the source snippet
  // when that's richer, rather than reject the story. A short accurate body is fine.
  const body = String(c.body || '').trim();
  const snip = String(c.article?.snippet || '').trim();
  const echoes = body.toLowerCase().startsWith(t.toLowerCase().slice(0, 40)) && body.length < 90;
  const thin = body.replace(/[^a-z0-9]/gi, '').length < 40;
  if ((echoes || thin) && snip && snip.length > body.length && snip.toLowerCase() !== t.toLowerCase()) {
    c.body = snip.slice(0, 600);
  }
  // ensure the body ends as a sentence so the language gate passes
  if (c.body && !/[.!?।॥]\s*$/.test(String(c.body).trim())) c.body = String(c.body).trim() + '.';
  // Thin/missing summary → derive one from the body (first sentence) or snippet, so
  // a real story isn't rejected for a lazy summary field.
  if (String(c.summary || '').trim().length < 20) {
    const src = String(c.body || c.article?.snippet || '').trim();
    const firstSentence = (src.match(/^.{20,200}?[.!?।॥]/) || [src.slice(0, 200)])[0].trim();
    if (firstSentence.length >= 20) c.summary = firstSentence;
  }
  return c;
}

// ── Individual gates ────────────────────────────────────────────────────────
export function gStructure(c) {
  const t = (c.title || '').trim();
  // These gates reject only STRUCTURALLY BROKEN output (garbage/slug/markup) — NOT
  // short news. A crisp 2-word headline ("Modi resigns") or a tight body is fine
  // if it's real prose; quality is judged elsewhere, not by length.
  if (t.length < 8) return 'title_too_short'; // 12→8: allow short real headlines
  if (BAD_TITLE.test(t)) return 'placeholder_title';
  // NOTE: title_has_pipe + title_trailing_ellipsis are now REPAIRED by
  // normalizeCandidate() (run before gates), not rejected — a "Headline | Outlet"
  // or "Headline…" is a real story, just cosmetically dirty.
  // RAW SLUG / MARKUP leak guard — a title must read like prose, not a URL slug or
  // template token. Rejects "<ss_rajamouli_first_pics_mandakini>": markup chars,
  // underscores, or a hyphen/all-lowercase slug shape. (The pipeline now HUMANIZES
  // slug input before synth + as a safety net, so a genuine quality story is fixed
  // upstream, not rejected here — this gate only catches what slipped through.)
  if (/[<>{}\[\]|]/.test(t)) return 'title_has_markup';
  if (/_/.test(t)) return 'title_has_underscore';
  const words = t.split(/\s+/).filter(Boolean);
  const vn = isVideoNative(c);
  // slug shape = 3+ tokens joined ONLY by hyphens with no spaces, all lowercase
  if (words.length === 1 && /^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(t)) return 'title_looks_like_slug';
  const hasCap = /[A-Zऀ-ॿ]/.test(t); // a capital OR Devanagari (Hindi has no case)
  // multiword all-lowercase = slug — but a VIDEO-NATIVE title comes straight from
  // YouTube (creators often title in lowercase), not a URL slug, so allow it there.
  if (!vn && !hasCap && words.length >= 3) return 'title_looks_like_slug';
  if (!CATEGORIES.includes(c.category)) return 'bad_category';
  if (!/^[A-Za-z][\p{L}\p{N}_]{5,59}$/u.test(c.hashtag || '')) return 'bad_hashtag';
  const body = (c.body || '').trim();
  // A VIDEO-NATIVE story (YouTube-trending) IS the video — the body is just a short
  // caption, so the article-length body requirement doesn't apply. Everything else
  // still needs a real body. (`vn` computed above.)
  if (!vn && body.length < 50) return 'body_too_short'; // 80→50: allow crisp short stories
  if (!vn && (c.summary || '').trim().length < 20) return 'summary_too_short'; // 25→20
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
  // VIDEO-NATIVE: the clip is the content; its caption needn't be a full sentence or
  // differ from the title. Skip the body-shape checks (only the title-punct check
  // below still applies).
  if (isVideoNative(c)) {
    if (/[.,;:]$/.test(c.title || '')) return 'title_bad_terminal_punct';
    return null;
  }
  // A body must be a real, complete sentence — but ONE good sentence is acceptable
  // for a crisp short story (was >=2, too strict; short quality news is fine). Split
  // on a sentence-ender incl. the Devanagari DANDA (।/॥). We only reject a body that
  // isn't even one proper sentence (a bare fragment).
  const sentences = body.split(/[.!?।॥]+(?:\s+|$)/).filter((s) => s.trim().length > 6).length;
  const endsProperly = /[.!?।॥]\s*$/.test(body);
  if (sentences < 1 || (sentences < 2 && !endsProperly)) return 'body_not_a_sentence';
  if (/[.,;:]$/.test(c.title || '')) return 'title_bad_terminal_punct';
  // NOTE: body_echoes_title is REPAIRED by normalizeCandidate() (swaps in the source
  // snippet when richer) — no longer a reject. A short accurate body is acceptable
  // news, not a defect worth discarding a real story over.
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

// Run the algorithmic gates in order; return {reason} or null (pass).
//
// DIVISION OF LABOUR (redesign): the LLM TRIAGE gateway (triage.mjs) now owns
// EDITORIAL judgment — is this junk / gossip / clickbait / opinion / low-value?
// It does that far better than regexes. So these gates keep ONLY what regexes are
// genuinely good at — MECHANICAL, deterministic checks:
//   • structure  — real title (not slug/markup), valid hashtag, has body/summary
//   • safety     — hard backstop (minors+crime, suicide method, communal/slurs):
//                  kept even though triage also judges, because safety must be
//                  deterministic + non-bypassable, never left solely to a model
//   • staleness  — source age (a clock check, not judgment)
//   • language   — is the BODY a real sentence (not a fragment/echo)
//   • factshape  — did synth INVENT a number/quote absent from source (mechanical
//                  hallucination guard)
// The editorial regexes (spam/clickbait/gossip/opinion/superlative) are RETIRED
// from the chain — the LLM triage replaces them. Set GATES_LEGACY_EDITORIAL=1 to
// re-add them (belt-and-suspenders) if ever needed.
export function runGates(c, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeH = opts.maxAgeH ?? 36;
  const chain = [
    ['structure', gStructure(c)],
    ['safety', gSafety(c)], // hard backstop — always on
    ['staleness', gStaleness(c, nowMs, maxAgeH)],
    ['language', gLanguage(c)],
    ['factshape', gFactShape(c)],
  ];
  if (process.env.GATES_LEGACY_EDITORIAL === '1') {
    chain.splice(1, 0, ['spam', gSpam(c)], ['clickbait', gClickbait(c)], ['gossip', gGossip(c)], ['opinion', gOpinion(c)], ['superlative', gSuperlative(c)]);
  }
  for (const [gate, reason] of chain) if (reason) return { gate, reason };
  return null;
}
