// Shared "same news = one thread" matcher. Used by the push path (block a new
// duplicate → append to the existing thread instead) and the merge script
// (collapse existing duplicate stories). Goal: ~99% on true same-event dupes
// while NOT collapsing genuinely distinct stories.
//
// The signal that works for news headlines: the SIGNIFICANT-WORD set. Two
// headlines about the same event share most of their meaningful words even when
// re-worded ("vows to stay with" vs "says he will stay with"). We combine:
//   * Jaccard similarity of the word sets, AND
//   * CONTAINMENT (smaller set mostly inside the larger) — catches the case
//     where one headline is a longer variant of the other.
// A match if EITHER is high. Numbers/proper-noun tokens are kept (they're the
// discriminating entities: "Tianwen-2", "600-crore", "Hormuz").

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'as', 'is', 'are', 'be',
  'with', 'after', 'amid', 'over', 'vs', 'v', 'set', 'make', 'makes', 'making', 'new', 'says',
  'say', 'said', 'will', 'has', 'have', 'from', 'by', 'into', 'its', 'his', 'her', 'their', 'was',
  'were', 'that', 'this', 'it', 'he', 'she', 'they', 'but', 'not', 'who', 'what', 'how', 'why',
  'near', 'up', 'out', 'off', 'about', 'more', 'than', 'been', 'being', 'ahead', 'amid',
]);

export function wordSet(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// Containment: fraction of the SMALLER set's words present in the larger set.
function containment(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const w of small) if (large.has(w)) inter++;
  return inter / small.size;
}

// Tunable thresholds. Jaccard 0.5 OR containment 0.8 (with the smaller set
// having ≥3 significant words so tiny titles don't over-match).
const JACCARD_MIN = Number(process.env.DEDUP_JACCARD || 0.55);
const CONTAIN_MIN = Number(process.env.DEDUP_CONTAINMENT || 0.82);

// A DISTINCTIVE token: a number/year (2050, 600, Q1) or a longer word that is
// almost certainly a proper noun / specific entity ("hormuz", "semaglutide",
// "accenture", "pixel"). Generic nouns ("india", "challenges", "security") are
// NOT distinctive. Two stories are only "the same" if they SHARE at least one
// distinctive token — this stops vague AI umbrella titles ("India's
// Environmental Challenges" vs "Security Challenges in India") from collapsing.
const GENERIC = new Set([
  'india', 'indian', 'world', 'global', 'national', 'security', 'challenge', 'challenges',
  'crisis', 'update', 'updates', 'report', 'reports', 'news', 'people', 'government', 'country',
  'health', 'environmental', 'environment', 'economy', 'economic', 'market', 'markets', 'plan',
  'plans', 'issue', 'issues', 'day', 'year', 'years', 'time', 'week', 'top', 'first', 'set',
]);
function distinctiveTokens(set) {
  const out = new Set();
  for (const w of set) {
    if (GENERIC.has(w)) continue;
    if (/\d/.test(w) || w.length >= 5) out.add(w); // numbers or longer entity-ish words
  }
  return out;
}
// Count of DISTINCTIVE tokens (entities/numbers) two headlines share. This is
// the key signal for "same EVENT" that plain word-overlap misses: two headlines
// about one event share their entities+action ("US … strikes … Iran") even when
// each adds different peripheral detail (…Hormuz ceasefire vs …drones/radar),
// which dilutes Jaccard below any sane threshold.
function sharedDistinctiveCount(a, b) {
  const da = distinctiveTokens(a);
  let n = 0;
  for (const w of distinctiveTokens(b)) if (da.has(w)) n++;
  return n;
}
function sharesDistinctive(a, b) {
  return sharedDistinctiveCount(a, b) >= 1;
}

// Two headlines describe the SAME EVENT if — after requiring they share at least
// one distinctive entity/number (blocks vague AI umbrella titles that share only
// generic words) — EITHER:
//   (1) FULL-REPHRASE overlap: Jaccard >= 0.55 OR containment >= 0.82. Catches
//       re-worded headlines of the same length.
//   (2) SAME-SUBJECT signal: they share >= 3 distinctive entities (e.g. the
//       three tokens "senator/lindsey/graham" — near-certain same story), OR
//       share >= 2 distinctive entities with a modest word overlap (Jaccard
//       >= 0.30). Catches same-event/different-detail pairs the ratio-only test
//       misses (the "US launches strikes on Iran …" variants: shared distinctive
//       {launches, strikes} = 2, Jaccard 0.33 → now MATCH).
// The env/security false-positive stays apart because it shares 0 distinctive
// tokens (all its words are GENERIC), so the gate returns false before any bar.
function sameEvent(a, b) {
  const smaller = Math.min(a.size, b.size);
  if (smaller < 3) return jaccard(a, b) >= 0.75; // very short titles need a high bar
  const shared = sharedDistinctiveCount(a, b);
  if (shared < 1) return false; // no shared entity → not the same event
  if (jaccard(a, b) >= JACCARD_MIN || containment(a, b) >= CONTAIN_MIN) return true;
  if (shared >= 3) return true; // 3+ shared entities → almost certainly one story
  if (shared >= 2 && jaccard(a, b) >= 0.3) return true; // same subject + detail variation
  return false;
}

export function isSameStory(titleA, titleB) {
  return sameEvent(wordSet(titleA), wordSet(titleB));
}

// Given a candidate title and a list of {hashtag, title, ...} existing stories,
// return the best-matching existing story (or null). Used to reroute a new
// candidate onto an existing thread.
export function findMatch(title, existing) {
  const a = wordSet(title);
  if (a.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const s of existing) {
    const b = wordSet(s.title);
    if (!sameEvent(a, b)) continue; // same same-event rule as isSameStory
    // Rank matches by a blended score so the BEST existing thread wins: word
    // overlap (max of jaccard/containment) plus a bonus per shared entity.
    const score = Math.max(jaccard(a, b), containment(a, b)) + 0.15 * sharedDistinctiveCount(a, b);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// Group a list of {hashtag,title,...} into clusters of the same story. Greedy:
// each story joins the first existing cluster it matches, else starts its own.
// Returns arrays of the original objects (length>1 = a duplicate group).
export function groupSameStories(stories) {
  const clusters = [];
  for (const s of stories) {
    let placed = false;
    for (const cl of clusters) {
      if (isSameStory(s.title, cl[0].title)) {
        cl.push(s);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([s]);
  }
  return clusters;
}
