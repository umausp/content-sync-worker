// word_timing.mjs — per-WORD [start,end] timestamps for the narration, with NO extra
// dependency or model download.
//
// We already synthesize each caption sentence SEPARATELY (kokoro_tts.py) and measure its
// true audio duration, so every sentence carries an exact [start,end] window. Within a
// sentence we distribute that window across its words weighted by SYLLABLE COUNT (a good
// proxy for how long a word is spoken), giving accurate per-word timing.
//
// Why not a forced aligner? Deep research (WhisperX / faster-whisper / MFA) confirmed they
// give per-word timestamps but cost a heavy model download + tens of seconds on CPU-only CI,
// and Kokoro's own token timestamps are undocumented on our espeak-phoneme path. Since we
// GENERATE the text and already have ground-truth SENTENCE windows, syllable-weighting inside
// those windows is free, deterministic, and plenty accurate for "show the image / focus the
// word when it's spoken." This module is pure (no I/O) so it's fully unit-testable.

// Rough English syllable count: vowel-groups minus a silent trailing 'e', floored at 1.
export function syllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  // silent trailing 'e' ("time" = 1, but "the"/"be" keep 1 via the floor; "cake" = 1)
  if (w.length > 2 && /e$/.test(w) && !/[aeiouy]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

// A word's spoken WEIGHT: syllables, plus a small bump for length (long words take longer
// even at equal syllables) and a beat for trailing punctuation (comma/period = a short pause
// lands on that word). Tuned to feel synced, not to be phonetically exact.
function weight(token) {
  const syl = syllables(token);
  const chars = String(token).replace(/[^A-Za-z0-9]/g, '').length;
  const pause = /[,;:.!?—–]$/.test(token) ? 0.6 : 0; // trailing punctuation = a beat
  return syl + chars * 0.08 + pause;
}

// Distribute ONE sentence window [start,end] across its whitespace tokens, weighted by
// spoken length. Returns [{ word, start, end, wi }] (wi = index within the sentence).
// `word` keeps the ORIGINAL token (punctuation intact) so callers can render it verbatim.
export function wordsForSegment(text, start, end) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(0.001, end - start);
  const weights = tokens.map(weight);
  const total = weights.reduce((a, b) => a + b, 0) || tokens.length;
  const out = [];
  let t = start;
  for (let i = 0; i < tokens.length; i++) {
    const d = (span * weights[i]) / total;
    const wEnd = i === tokens.length - 1 ? end : t + d; // last word lands exactly on `end`
    out.push({ word: tokens[i], start: t, end: wEnd, wi: i });
    t = wEnd;
  }
  return out;
}

// Flatten ALL sentence segments into one word timeline. `segments` = [{start,end,text}]
// (the kokoro_tts.py output). Adds `si` = sentence index for callers that group by sentence.
export function wordTimings(segments) {
  const out = [];
  (segments || []).forEach((sg, si) => {
    for (const w of wordsForSegment(sg.text, sg.start, sg.end)) out.push({ ...w, si });
  });
  return out;
}

// Normalize a token for fuzzy matching (lowercase, letters/digits only).
function normTok(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find WHEN an entity name is spoken in the word timeline. Matches the entity's significant
// tokens as a contiguous run (so "Christopher Nolan" matches the two adjacent words) and
// returns { start, end } spanning the matched run — or null if the name isn't spoken.
// Multi-word entities need ALL their significant tokens adjacent; single-word entities match
// the first occurrence. Case/punctuation-insensitive.
export function entitySpokenAt(entity, timeline) {
  const parts = String(entity || '')
    .split(/\s+/)
    .map(normTok)
    .filter((p) => p.length >= 2); // drop 1-char noise ("A", punctuation)
  if (!parts.length || !timeline?.length) return null;
  const toks = timeline.map((w) => normTok(w.word));
  for (let i = 0; i + parts.length <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      // allow the timeline token to CONTAIN the entity part (e.g. "Nolan's" ⊇ "nolan")
      if (!toks[i + j] || !toks[i + j].includes(parts[j])) { ok = false; break; }
    }
    if (ok) return { start: timeline[i].start, end: timeline[i + parts.length - 1].end };
  }
  return null;
}
