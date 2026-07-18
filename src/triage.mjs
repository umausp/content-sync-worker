// LLM TRIAGE GATEWAY — the "one initial review" that replaces brittle editorial
// REGEXES with actual judgment. Rationale (user): regexes were doing editorial
// work they're bad at — deciding "is this junk / gossip / useful / important?".
// That was a compromise for when LLM calls were precious (slow CPU). With fast
// free hosted inference, judgment belongs to an LLM.
//
// Triage runs ONCE over ALL clustered headlines, in big cheap batches (headline +
// short snippet only — no full synthesis), and returns per item:
//   { keep: bool, category: <enum>, importance: 1-5, reason: short }
// The pipeline then FULL-synthesises only the kept items (score-sorted), so the
// expensive step is spent only on stories an editor would actually run.
//
// This is DIFFERENT from the per-story synth: triage is a fast bulk classifier
// ("would a serious editor publish this? which desk? how big?"), not a rewrite.
// It sees MANY headlines at once, which also helps it judge relative importance.

import { generate } from './providers.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

// URL LIVENESS check — before spending an LLM call (or publishing a story), make
// sure its source URL actually OPENS. A dead/404/errored link is a quality defect
// (reader taps through to nothing). We probe with a fast, cheap HEAD (fall back to
// a ranged GET — some servers reject HEAD), concurrency-capped, short timeout, and
// FAIL-OPEN on ambiguity: only DROP a URL that is DEFINITIVELY dead (explicit
// 4xx/5xx). A network blip / timeout / bot-block keeps the story (better a rare
// dead link than dropping good news on a flaky probe). Off via URL_CHECK=0.
async function isUrlLive(url, timeoutMs) {
  const opt = { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) };
  try {
    let r = await fetch(url, { ...opt, method: 'HEAD' });
    // Some servers 405/403 on HEAD → retry a tiny ranged GET before judging.
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      r = await fetch(url, { ...opt, method: 'GET', headers: { ...opt.headers, range: 'bytes=0-0' } });
    }
    if (r.status >= 400 && r.status < 600) return { live: false, status: r.status }; // definitively dead
    return { live: true, status: r.status };
  } catch {
    return { live: true, unknown: true }; // network/timeout → FAIL-OPEN (keep)
  }
}

// Filter a scored list to items whose URL opens. Concurrency-capped. Marks dropped
// items so the caller can log. Returns { live: [...], dead: n }.
export async function filterLiveUrls(scored, opts = {}) {
  const log = opts.log || (() => {});
  if (process.env.URL_CHECK === '0') return { live: scored, dead: 0 };
  const concurrency = Number(process.env.URL_CHECK_CONCURRENCY || 12);
  const timeoutMs = Number(process.env.URL_CHECK_TIMEOUT_MS || 6000);
  const cap = Number(process.env.URL_CHECK_MAX || 700); // don't probe an unbounded pool
  const toCheck = scored.slice(0, cap);
  const rest = scored.slice(cap); // beyond cap: keep unchecked (rare, low-rank tail)
  const results = new Array(toCheck.length);
  let idx = 0;
  async function worker() {
    while (idx < toCheck.length) {
      const i = idx++;
      const url = toCheck[i]?.a?.url;
      if (!url || !/^https?:\/\//i.test(url)) { results[i] = false; continue; }
      const r = await isUrlLive(url, timeoutMs);
      results[i] = r.live;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, worker));
  const live = toCheck.filter((_, i) => results[i]).concat(rest);
  const dead = toCheck.length - toCheck.filter((_, i) => results[i]).length;
  log('triage.urlcheck', { checked: toCheck.length, dead, kept: live.length });
  return { live, dead };
}

const CATEGORIES = ['top', 'politics', 'world', 'business', 'tech', 'science', 'health', 'sports', 'entertainment', 'local'];

// The editorial brief the triage LLM applies — this is the JUDGMENT the regexes
// used to fake. Broad + inclusive on genuinely useful content (incl. global
// OTT/finance/tech/science/lifestyle the user wants), strict on junk.
const TRIAGE_BRIEF =
  'You are the intake editor of a serious, India-first but globally-curious news app. ' +
  'For EACH numbered headline decide if it is worth a place in the feed. ' +
  'KEEP (keep=true): real news + genuinely useful/interesting content — government/policy/courts/elections, business/markets/economy, world events, tech/gadgets/AI, science & interesting facts, health, sports results, confirmed film/OTT/streaming releases-reviews-box-office, personal-finance & investing explainers, notable global stories (even non-India) a curious reader would value. ' +
  'DROP (keep=false): ads/PR/sponsored, pure clickbait, celebrity gossip & personal-life chatter, horoscopes/quizzes/listicles, coupons/deals, unverified rumor, spam, and trivially local items with no wider interest. ' +
  'Also return the best CATEGORY and an IMPORTANCE 1-5 (5=major/breaking, 3=notable, 1=trivial). Judge importance RELATIVE to the batch. Be decisive; when clearly junk, drop it.';

function safeArr(text) {
  const tp = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let v = tp(text);
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  const m = text && text.match(/\[[\s\S]*\]/);
  if (m) { v = tp(m[0]); if (Array.isArray(v)) return v; }
  return null;
}
const clampImp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 3)));
const normCat = (c) => { const s = String(c || '').toLowerCase(); return CATEGORIES.find((x) => s.includes(x)) || 'top'; };

// Triage one batch of items. `items` = [{title, snippet}]. Returns array aligned
// by index: [{keep, category, importance, reason}] (null entry if unparseable).
async function triageBatch(items, opts) {
  const list = items
    .map((a, i) => `[${i}] ${String(a.title || '').slice(0, 160)}${a.snippet && a.snippet !== a.title ? ' — ' + String(a.snippet).slice(0, 160) : ''}`)
    .join('\n');
  const prompt =
    `${TRIAGE_BRIEF}\n\n` +
    `Reply ONLY as JSON {"items":[ ... ]}, one element per headline in the SAME ORDER, each:\n` +
    `{"i": <index>, "keep": true|false, "category": "<one of: ${CATEGORIES.join(', ')}>", "importance": 1-5, "reason": "<=6 words"}\n` +
    `Include ALL ${items.length} items.\n\nHEADLINES:\n${list}`;
  const { text } = await generate(prompt, { json: true, maxTokens: Math.min(40 * items.length + 100, 4000), timeoutMs: opts.timeoutMs || 40000 });
  if (text == null) return null;
  const arr = safeArr(text);
  if (!arr) return null;
  const out = new Array(items.length).fill(null);
  const sameLen = arr.length === items.length;
  arr.forEach((o, pos) => {
    const idx = Number.isInteger(o?.i) && o.i >= 0 && o.i < items.length ? o.i : (sameLen ? pos : -1);
    if (idx < 0 || out[idx]) return;
    out[idx] = { keep: o.keep !== false, category: normCat(o.category), importance: clampImp(o.importance), reason: String(o.reason || '').slice(0, 60) };
  });
  return out;
}

// Triage a list of scored clusters. Each `p` has p.a.{title,snippet}. Mutates p:
//   p.triageKeep, p.triageImportance, p.triageCategory, p.triageReason.
// On provider failure the batch is FAIL-OPEN (keep=true) so a triage outage never
// silently empties the feed — the downstream structural + safety gates still run.
// Returns { kept, dropped, batches, failedBatches }.
export async function triage(scored, opts = {}) {
  const log = opts.log || (() => {});
  const batchSize = Number(process.env.TRIAGE_BATCH || 20);
  const budgetMs = Number(process.env.TRIAGE_BUDGET_MS || 5 * 60 * 1000);
  const started = Date.now();
  let kept = 0, dropped = 0, batches = 0, failedBatches = 0, failOpen = 0;

  for (let b = 0; b * batchSize < scored.length; b++) {
    if (Date.now() - started > budgetMs) {
      // out of triage budget → remaining items fail-open (kept), synth decides.
      for (const p of scored.slice(b * batchSize)) { p.triageKeep = true; failOpen++; }
      log('triage.budget_spent', { atBatch: b, failOpen: scored.length - b * batchSize });
      break;
    }
    const group = scored.slice(b * batchSize, (b + 1) * batchSize);
    const res = await triageBatch(group.map((p) => p.a), { timeoutMs: opts.timeoutMs });
    batches++;
    if (!res) {
      failedBatches++;
      for (const p of group) { p.triageKeep = true; failOpen++; } // FAIL-OPEN
      continue;
    }
    res.forEach((r, k) => {
      const p = group[k];
      if (!r) { p.triageKeep = true; failOpen++; return; } // unparsed item → keep
      p.triageKeep = r.keep;
      p.triageImportance = r.importance;
      p.triageCategory = r.category;
      p.triageReason = r.reason;
      if (r.keep) kept++; else dropped++;
    });
  }
  log('triage.done', { total: scored.length, kept, dropped, failOpen, batches, failedBatches, ms: Date.now() - started });
  return { kept, dropped, batches, failedBatches, failOpen };
}
