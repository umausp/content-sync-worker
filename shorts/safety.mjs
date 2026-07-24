// safety.mjs — DEMONETIZATION GUARD for the Shorts pipeline (user: "make sure you are not
// adding any words or images that will demonetise").
//
// These videos are PUBLIC + monetized on @AgyataWorld. YouTube's advertiser-friendly
// guidelines penalise two things this pipeline could accidentally emit:
//   1. STRONG PROFANITY / SLURS in the TITLE, on-screen CAPTIONS, or narration — "inappropriate
//      language" → limited/no ads; a slur → hate-speech strike + full demonetization.
//   2. Genuinely disqualifying SUBJECTS — sexual content involving minors, explicit sexual
//      how-to, suicide/self-harm METHOD instructions, incitement/genocide framing.
//
// THREE tools, all DETERMINISTIC (no LLM — a monetization guard must be non-bypassable):
//   • isUnsafeStory(story) — reason string (→ DROP) for a disqualifying subject OR a SLUR
//     anywhere (hate speech must never reach narration/caption), else null. HIGH-PRECISION:
//     mainstream war/crime/death news does NOT match. FAIL-CLOSED: a matched story is dropped
//     even if that empties the run (a missed Short beats a monetization strike) — the OPPOSITE
//     of the dedup ledger's fail-open.
//   • sanitizeStory(story) — MASK strong profanity in title+summary+headline IN PLACE
//     ("shit" → "s***"). This is the DISPLAY form: the on-screen headline + the YouTube
//     title/description show the masked text (the news-chyron convention). Mild words YouTube
//     tolerates in news (damn/hell/crap/bloody) are deliberately NOT masked.
//   • stripForSpeech(text) — REMOVE masked tokens so NARRATION + CAPTIONS never try to speak
//     "f***" (TTS would read the asterisks). Narration is built from the masked text, so the
//     narration builder runs each spoken line through this → clean, pronounceable audio whose
//     captions (derived from the audio) are clean too.
//
// SCOPE: the profanity/slur set is English — the dominant automated-detection signal, and what
// the World channel + all hashtags/tags use. The native briefs are LLM-synthesised with an
// explicit "neutral, factual, no hype" instruction, so native-language profanity is improbable;
// add per-language sets here if a native channel ever needs it.
//
// IMAGES: entity photos are already restricted to Wikimedia Commons CC/PD (entity_images.mjs),
// story photos are publisher og:images (news-desk vetted), and stock is OFF by default — so the
// image surface carries little "added" risk. Text is where the pipeline can actually INTRODUCE a
// demonetizing token, so text is what we guard.

// ── STRONG PROFANITY (word STEMS; inflections handled by SUFFIX_RE) ───────────────────────────
// Masked → first letter + up to 4 asterisks. Kept tight: strong profanity that reads as
// "inappropriate language" to YouTube. NOT mild expletives (damn/hell/crap/bloody). Entries that
// collide with common clean words are omitted on purpose: "prick" (pricked/prickly),
// "ass" (bass/class/assess) — only compounded forms (asshole/jackass/dumbass) are listed.
const PROFANITY_STEMS = [
  'motherfuck', 'fuck', 'bullshit', 'shit', 'bitch', 'bastard', 'asshole', 'jackass',
  'dumbass', 'dickhead', 'cunt', 'wanker', 'bollocks', 'twat', 'slut', 'whore', 'douchebag',
];
// Optional inflectional suffix after a stem: "fuck"→fucking/fucked/fucker(s); "shit"→shitty/
// shithead/shitshow; "bitch"→bitches/bitchy. Bounded so it can't run past the word.
const SUFFIX = '(?:ing|ings|ed|er|ers|es|s|in|hole|head|show|ty|y)?';

// ── SLURS (regex fragments with leet variants; matching any → DROP the story) ─────────────────
// A slur is hate speech: never mask-and-ship, always DROP. Fragments avoid clean-word collisions
// via word boundaries (verified: "Pakistan"/"spice"/"conspicuous" do NOT match). "retard" is
// listed but "flame retardant" is protected by the boundary (suffix set excludes "ant").
const SLURS = [
  'n[i1]gger', 'n[i1]gga', 'f[a4]ggot', 'r[e3]tard', 'ch[i1]nk', 'sp[i1]c',
  'k[i1]ke', 'w[e3]tback', 'tr[a4]nny', 'g[o0][o0]k', 'p[a4]ki',
];
const SLUR_SUFFIX = '(?:s|es|ed|ing|y|ish|o)?';

// Combined MASK matcher for DISPLAY (profanity only — slurs are dropped, not masked; but include
// them here too as defense-in-depth in case a drop is ever bypassed). Case-insensitive, global.
const MASK_RE = new RegExp(
  `\\b(?:${SLURS.map((s) => s + SLUR_SUFFIX).join('|')}|${PROFANITY_STEMS.map((s) => s + SUFFIX).join('|')})\\b`,
  'gi',
);
// Slur-anywhere matcher for the DROP decision.
const SLUR_RE = new RegExp(`\\b(?:${SLURS.map((s) => s + SLUR_SUFFIX).join('|')})\\b`, 'i');

// Mask one matched token: keep the first character, replace the rest with up to 4 '*'.
// "Fuck" → "F***", "shit" → "s***", "motherfucker" → "m****".
function maskToken(tok) {
  if (tok.length <= 1) return tok;
  return tok[0] + '*'.repeat(Math.min(tok.length - 1, 4));
}

// Strip stray HTML/XML tags that leaked from an article body into the text (e.g. Sky Sports
// embeds "<p><em>Sky Sports News</em>" inside JSON-LD articleBody). The extractor is the
// primary fix, but this is the render-time backstop: it runs on EVERY candidate (incl.
// already-committed research bundles), so leaked markup can never reach a caption or the TTS.
// Bounded tag shape (`<` + optional `/` + letter…`>`) so real prose like "score < 5" is left
// alone; collapses the space left behind.
function stripMarkup(s) {
  if (!s || s.indexOf('<') === -1) return s;
  return String(s).replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// Mask strong profanity/slurs in a string (DISPLAY form). Safe on empty/undefined.
export function scrubText(s) {
  if (!s) return s;
  return stripMarkup(String(s)).replace(MASK_RE, (m) => maskToken(m)).replace(/ {2,}/g, ' ').trim();
}

// Remove masked tokens ("f***", "S****") so NARRATION/CAPTIONS never speak asterisks. Also
// strips any raw profanity that reached the speech path unmasked (belt-and-suspenders). Fixes
// spacing/space-before-punctuation a removal leaves behind. Used by the narration builder.
export function stripForSpeech(s) {
  if (!s) return s;
  return stripMarkup(String(s))
    .replace(/\b[A-Za-z]\*{2,}/g, '') // masked tokens
    .replace(MASK_RE, '') // any unmasked profanity/slur that slipped through
    .replace(/\s+([,.;:!?])/g, '$1') // tidy " ," → ","
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Mutate a story so every DISPLAY surface (on-screen headline + YouTube title/description)
// inherits masked text. Returns the same object for chaining.
export function sanitizeStory(story) {
  if (!story) return story;
  if (story.title) story.title = scrubText(story.title);
  if (story.summary) story.summary = scrubText(story.summary);
  if (story.headline) story.headline = scrubText(story.headline);
  if (story.backstory) story.backstory = scrubText(story.backstory);
  return story;
}

// ── HARD-DROP SUBJECTS (mirror of the news pipeline's gSafety backstop) ──────────────────────
// Tuned high-precision: real news about war/crime/death does NOT match; only sexual-minor,
// explicit sexual how-to, self-harm METHOD instruction, and incitement/genocide framing.
const UNSAFE_SUBJECT = [
  { re: /\b(child (porn|sexual abuse|sex)|minors?\b[^.]*\b(sexual|rape|nude)|underage\b[^.]*\b(sexual|nude|sex)|csam)\b/i, reason: 'sexual_content_minor' },
  { re: /\b(how to have sex|porn(hub| video| clip)|explicit sex tape|xxx video|onlyfans leak)\b/i, reason: 'explicit_sexual' },
  { re: /\b(how to (kill yourself|commit suicide|end your life)|suicide (method|instructions|how[- ]to)|ways to (die|kill yourself)|best way to (die|hang))\b/i, reason: 'self_harm_method' },
  { re: /\b(exterminate the|wipe out the|kill all (the )?(muslims|hindus|jews|christians|sikhs|blacks|whites)|genocide against the|gas the|lynch the)\b/i, reason: 'incitement' },
];

// Return a drop-reason string, else null. Checks title + summary + body. Slur ANYWHERE → drop
// (hate speech must never reach narration/caption). FAIL-CLOSED: caller drops on non-null.
export function isUnsafeStory(story) {
  if (!story) return null;
  const hay = `${story.title || ''} ${story.summary || ''} ${story.body || ''}`;
  for (const { re, reason } of UNSAFE_SUBJECT) if (re.test(hay)) return reason;
  if (SLUR_RE.test(hay)) return 'slur';
  return null;
}

// Filter a candidate list: DROP unsafe stories, SANITIZE (mask) the survivors' text in place.
// Preserves the `.region` tag the world path pins on the array. Fail-closed on drops, but never
// throws — a guard bug must not crash the run, so on an unexpected error we sanitize without
// dropping (masking still applied).
export function guardStories(stories, { label = 'shorts' } = {}) {
  if (!Array.isArray(stories) || !stories.length) return stories;
  const region = stories.region;
  try {
    const kept = [];
    let dropped = 0;
    for (const s of stories) {
      const reason = isUnsafeStory(s);
      if (reason) {
        dropped++;
        console.log(`[safety:${label}] DROP "${String(s.title || '').slice(0, 60)}" — ${reason}`);
        continue;
      }
      kept.push(sanitizeStory(s));
    }
    if (dropped) console.log(`[safety:${label}] dropped ${dropped} unsafe candidate(s); ${kept.length} kept + sanitized`);
    if (region !== undefined) kept.region = region;
    return kept;
  } catch (e) {
    console.log(`[safety:${label}] guard error (${e.message}) — sanitizing without drop`);
    stories.forEach(sanitizeStory);
    return stories;
  }
}
