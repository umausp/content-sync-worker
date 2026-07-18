// Differential test: prove the INDEXED greedy clustering produces IDENTICAL
// cluster assignments to the naive O(N^2) loop, using the REAL dedup primitives.
// If assignments match on adversarial synthetic data, the same algorithm inlined
// into pipeline.mjs is behaviour-preserving.
import { isSameStory, wordSet, distinctiveTokens } from '../src/dedup.mjs';

// A rep score that CHANGES reps mid-loop (the tricky part — index must re-index).
const repScore = (a) => a.rank;

// ---- NAIVE reference (exact copy of pipeline.mjs lines 478-493 semantics) ----
function naive(raw) {
  const clusters = [];
  for (const a of raw) {
    let joined = false;
    for (const c of clusters) {
      if (isSameStory(a.title, c.rep.title)) {
        c.sources.add(a.src);
        if (repScore(a) > repScore(c.rep)) c.rep = a;
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ rep: a, sources: new Set([a.src]), members: [a], _ids: [a.id] });
    else clusters.find((c) => c.sources.has(a.src) && c._ids && c.rep) ; // no-op
  }
  // record membership: rebuild by re-running assignment capture
  return clusters;
}
// Simpler: capture assignment as "for each article id, which cluster leader id"
function naiveAssign(raw) {
  const clusters = [];
  const assign = {};
  for (const a of raw) {
    let joinedIdx = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (isSameStory(a.title, clusters[i].rep.title)) { joinedIdx = i; break; }
    }
    if (joinedIdx >= 0) {
      const c = clusters[joinedIdx];
      c.ids.push(a.id);
      if (repScore(a) > repScore(c.rep)) c.rep = a;
      assign[a.id] = c.leader;
    } else {
      clusters.push({ rep: a, leader: a.id, ids: [a.id] });
      assign[a.id] = a.id;
    }
  }
  return { assign, count: clusters.length };
}

// ---- INDEXED version (the algorithm we'll inline) ----
function indexedAssign(raw) {
  const clusters = [];       // {rep, leader, ids}
  const tokenIndex = new Map(); // distinctiveToken -> Set<clusterIdx>
  const shortReps = new Set();  // clusterIdx where rep wordSet size < 3
  const assign = {};
  const distOf = (title) => distinctiveTokens(wordSet(title));
  const addToIndex = (idx) => {
    const set = wordSet(clusters[idx].rep.title);
    if (set.size < 3) shortReps.add(idx);
    for (const t of distinctiveTokens(set)) {
      let s = tokenIndex.get(t); if (!s) { s = new Set(); tokenIndex.set(t, s); } s.add(idx);
    }
  };
  const removeFromIndex = (idx, repTitle) => {
    const set = wordSet(repTitle);
    shortReps.delete(idx);
    for (const t of distinctiveTokens(set)) { const s = tokenIndex.get(t); if (s) s.delete(idx); }
  };
  for (const a of raw) {
    const aSet = wordSet(a.title);
    // candidate cluster indices
    let candidates;
    if (aSet.size < 3) {
      candidates = clusters.map((_, i) => i); // short article can match anything
    } else {
      const set = new Set(shortReps);
      for (const t of distinctiveTokens(aSet)) { const s = tokenIndex.get(t); if (s) for (const i of s) set.add(i); }
      candidates = [...set];
    }
    candidates.sort((x, y) => x - y); // ASCENDING = insertion order = first-match parity
    let joinedIdx = -1;
    for (const i of candidates) {
      if (isSameStory(a.title, clusters[i].rep.title)) { joinedIdx = i; break; }
    }
    if (joinedIdx >= 0) {
      const c = clusters[joinedIdx];
      c.ids.push(a.id);
      if (repScore(a) > repScore(c.rep)) {
        const oldTitle = c.rep.title;
        c.rep = a;
        removeFromIndex(joinedIdx, oldTitle);
        addToIndex(joinedIdx);
      }
      assign[a.id] = c.leader;
    } else {
      const idx = clusters.length;
      clusters.push({ rep: a, leader: a.id, ids: [a.id] });
      addToIndex(idx);
      assign[a.id] = a.id;
    }
  }
  return { assign, count: clusters.length };
}

// ---- adversarial synthetic corpus ----
const SUBJECTS = ['Wangchuk', 'Vikram1', 'Modi', 'ISRO', 'RBI', 'Kohli', 'Netflix', 'Adani', 'Tharoor', 'Ambani'];
const EVENTS = ['strike', 'launch', 'verdict', 'match', 'deal', 'protest', 'result', 'crash'];
const FILLER = ['says', 'over', 'after', 'amid', 'in India', 'today', 'reports', 'new update on'];
function mkCorpus(n, seed) {
  // deterministic PRNG
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    let title;
    if (kind < 0.15) title = `${pick(SUBJECTS)}`; // very short (subject only)
    else if (kind < 0.30) title = `${pick(FILLER)} ${pick(FILLER)}`; // short generic
    else title = `${pick(FILLER)} ${pick(SUBJECTS)} ${pick(EVENTS)} ${pick(FILLER)} ${pick(SUBJECTS)}`;
    out.push({ id: i, title, src: `src${i % 20}`, rank: Math.floor(rnd() * 10) });
  }
  return out;
}

let failures = 0;
for (let seed = 1; seed <= 200; seed++) {
  const corpus = mkCorpus(120, seed);
  const a = naiveAssign(corpus);
  const b = indexedAssign(corpus);
  // Compare: same cluster COUNT and same partition (same leader-grouping).
  // Leaders may differ in id but the PARTITION must be identical. Compare by
  // building "which ids share a cluster" canonical signature.
  const sig = (res) => {
    const groups = {};
    for (const [id, leader] of Object.entries(res.assign)) { (groups[leader] ||= []).push(+id); }
    return JSON.stringify(Object.values(groups).map((g) => g.sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]));
  };
  if (sig(a) !== sig(b)) {
    failures++;
    if (failures <= 3) console.log(`MISMATCH seed=${seed}: naive=${a.count} clusters, indexed=${b.count}`);
  }
}
console.log(failures === 0 ? '✅ ALL 200 seeds: indexed == naive (identical partitions)' : `❌ ${failures}/200 seeds mismatched`);
process.exit(failures === 0 ? 0 : 1);
