#!/usr/bin/env node
// Agyata news pipeline — runs ENTIRELY on a GitHub Actions runner (no laptop, no
// server, no Cloudflare Worker). One job does the whole Google-News-style flow:
//
//   fetch ~150 RSS feeds → dedup → CLUSTER same-event → CORROBORATION score
//   (distinct outlets = importance) → select best N → SYNTHESISE each with a
//   REAL LLM running on the runner (Ollama) → POST finished stories to the
//   agyata ingest endpoint (which upserts to Cloudflare D1).
//
// Everything is on GitHub: the runner is the "machine" (ephemeral, free on a
// public repo = unlimited minutes). Data lives on Cloudflare (D1) via the HTTPS
// ingest API — the only secret needed is NEWS_INGEST_TOKEN.
//
// Env (GitHub secrets):
//   INGEST_URL        e.g. https://api.agyata.com/news/ingest
//   NEWS_INGEST_TOKEN bearer token for the ingest endpoint
//   OLLAMA_MODEL      e.g. qwen2.5:3b-instruct  (pulled by the workflow)
//   MAX_STORIES       best N to synthesise (default 30)
//   MIN_IMPORTANCE    publish floor 1-5 (default 3)
//   PER_FEED          articles per feed (default 15)

import { FEEDS } from './feeds.mjs';
import { isSameStory } from './dedup.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const INGEST_URL = process.env.INGEST_URL || '';
const INGEST_TOKEN = process.env.NEWS_INGEST_TOKEN || '';
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct';
// SCORE-GATE (not a fixed story cap): synth every cluster scoring >= this. On a
// big news hour that's 50-100 stories; a quiet hour fewer. SYNTH_HARD_MAX only
// bounds runtime so a runner can't run away.
const SYNTH_MIN_SCORE = Number(process.env.SYNTH_MIN_SCORE || 6);
const SYNTH_HARD_MAX = Number(process.env.SYNTH_HARD_MAX || 120);
const PER_FEED = Number(process.env.PER_FEED || 15);
const BREAKING_TTL_H = Number(process.env.BREAKING_TTL_HOURS || 3);
const LIVE_TTL_H = Number(process.env.LIVE_TTL_HOURS || 2);
if (!INGEST_URL || !INGEST_TOKEN) { console.error('missing INGEST_URL / NEWS_INGEST_TOKEN'); process.exit(1); }

// ── Editorial charter (mirrors docs/NEWS_EDITORIAL_CHARTER.md) ──────────────
const CHARTER =
  'You are the front-page editor of a serious India-first news app (Reuters/AP/BBC discipline, Inshorts crispness). ' +
  'QUALITY OVER QUANTITY. SKIP (skip:true) if ANY apply: ads/PR; listicles; horoscopes/quizzes; clickbait; ' +
  'celebrity gossip/personal-life chatter (spotted/loves/dating/throwback/spats); opinion/prediction-as-news (backs/could/set to shine/previews); ' +
  'unverifiable superlatives (biggest/highest-grossing/record) unless attributed with a number; lone local crime with no wider significance; single-source rumour. ' +
  'PREFER: government/policy/courts/elections, economy/markets with numbers, major world events, confirmed film/OTT releases-reviews-box-office(with source), science/space. When in doubt, SKIP. ' +
  'HEADLINE: complete specific sentence, real names/numbers, active voice, <=90 chars, no clickbait, no ellipsis; neutral framing for sensitive crime/court items. ' +
  'SUMMARY: one "so what" sentence <=200 chars. BODY: 2-4 tight sentences, inverted pyramid, neutral, attributed, include key number/date. Own words. Never fabricate.';

// ── RSS parsing (regex, dependency-free) ────────────────────────────────────
const tag = (b, n) => { const m = b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m?.[1] ? m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() : ''; };
const decode = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function inlineImage(b) { for (const re of [/<media:content[^>]+url=["']([^"']+)["']/i, /<media:thumbnail[^>]+url=["']([^"']+)["']/i, /<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i, /<img[^>]+src=["']([^"']+)["']/i]) { const m = b.match(re); if (m?.[1] && /^https?:\/\//i.test(m[1])) return decode(m[1]); } return null; }
function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').replace(/^feeds?\./, ''); } catch { return ''; } }
function outlet(u) { const h = domainOf(u); const map = { 'bbci.co.uk': 'BBC', 'theguardian.com': 'The Guardian', 'aljazeera.com': 'Al Jazeera', 'nytimes.com': 'New York Times', 'dw.com': 'DW', 'npr.org': 'NPR', 'cnbc.com': 'CNBC', 'thehindu.com': 'The Hindu', 'indianexpress.com': 'The Indian Express', 'hindustantimes.com': 'Hindustan Times', 'livemint.com': 'Mint', 'moneycontrol.com': 'Moneycontrol', 'news18.com': 'News18', 'economictimes.indiatimes.com': 'Economic Times', 'indiatimes.com': 'Times of India', 'feedburner.com': 'NDTV', 'nasa.gov': 'NASA', 'space.com': 'Space.com', 'bollywoodhungama.com': 'Bollywood Hungama', 'pinkvilla.com': 'Pinkvilla', 'koimoi.com': 'Koimoi', 'indiatoday.in': 'India Today', 'zeenews.india.com': 'Zee News', 'dnaindia.com': 'DNA India', 'business-standard.com': 'Business Standard', 'scroll.in': 'Scroll' }; for (const [d, n] of Object.entries(map)) if (h.endsWith(d)) return n; const w = h.split('.')[0] || 'source'; return w.charAt(0).toUpperCase() + w.slice(1); }
function parseFeed(xml, category, limit) {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1).map((b) => b.split(isAtom ? /<\/entry>/i : /<\/item>/i)[0] || '');
  const out = [];
  for (const b of blocks.slice(0, limit)) {
    if (!b) continue;
    const title = strip(tag(b, 'title'));
    let link = strip(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]+href=["']([^"']+)["']/i); if (m?.[1]) link = m[1]; }
    if (!title || !link) continue;
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    let publishedAt = null; if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) publishedAt = d.toISOString(); }
    out.push({ title, url: decode(link), sourceName: outlet(link), snippet: strip(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 400), imageUrl: inlineImage(b), publishedAt, category });
  }
  return out;
}
async function fetchFeed(f) { try { const r = await fetch(f.url, { headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(12000) }); if (!r.ok) return []; return parseFeed(await r.text(), f.category, PER_FEED); } catch { return []; } }

// ── Scoring ─────────────────────────────────────────────────────────────────
const RANK = { BBC: 5, 'The Guardian': 5, 'Al Jazeera': 5, 'New York Times': 5, DW: 4, NPR: 4, CNBC: 4, NASA: 5, 'Space.com': 4, 'The Hindu': 5, 'The Indian Express': 4, 'Hindustan Times': 4, 'Times of India': 4, NDTV: 4, Mint: 4, 'Economic Times': 4, 'Business Standard': 4, 'India Today': 4, Moneycontrol: 3, News18: 3, 'Zee News': 3, 'DNA India': 3, Scroll: 3, 'Bollywood Hungama': 4, Pinkvilla: 3, Koimoi: 3 };
const PRIORITY = new Set(['politics', 'entertainment', 'science']);
function fresh(a, now) { const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN; if (isNaN(t)) return 3; const h = (now - t) / 3.6e6; if (h < 3) return 6; if (h < 8) return 4; if (h < 24) return 2; if (h > 72) return -3; return 0; }

// ── Event-specific hashtag (algorithmic; avoids topic-collision mega-threads) ─
const GENERIC = new Set(['camelcasetoken', 'news', 'breaking', 'update', 'india', 'indiapolitics', 'politics', 'world', 'business', 'sports', 'entertainment', 'science', 'tech', 'story', 'today', 'fifaworldcup', 'worldcup', 'cricket', 'bollywood', 'movies', 'ott', 'market', 'economy']);
const TSTOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'as', 'is', 'are', 'be', 'with', 'after', 'over', 'vs', 'set', 'new', 'says', 'said', 'will', 'has', 'have', 'from', 'by', 'its', 'was', 'were', 'that', 'this', 'it', 'who', 'what', 'how', 'why', 'up', 'out', 'about', 'more', 'than', 'may', 'can', 'get', 'day', 'year']);
function hashtagFromTitle(t) {
  const words = String(t || '').split(/\s+/); const proper = [], other = [];
  for (const raw of words) { const w = raw.replace(/[^\p{L}\p{N}]/gu, ''); if (!w) continue; const lo = w.toLowerCase(); if (TSTOP.has(lo)) continue; if (/^[A-Z0-9]/.test(w) && w.length > 1) proper.push(w); else if (lo.length >= 4) other.push(w); }
  const pick = (proper.length >= 2 ? proper : [...proper, ...other]).slice(0, 4);
  let tag = pick.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 60);
  if (tag.length < 6) { const k = String(t).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24); tag = k ? 'Story' + k.charAt(0).toUpperCase() + k.slice(1) : 'Story'; }
  return tag;
}
function resolveHashtag(modelTag, title) {
  const c = String(modelTag || '').replace(/[^\p{L}\p{N}_]/gu, ''); const lo = c.toLowerCase();
  const words = new Set(String(title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const overlaps = [...words].some((w) => lo.includes(w));
  if (c.length >= 6 && !GENERIC.has(lo) && overlaps) return c.slice(0, 60);
  return hashtagFromTitle(title);
}

// ── LLM synth via Ollama (runs on the runner) ───────────────────────────────
const CATEGORIES = ['top', 'politics', 'world', 'business', 'tech', 'science', 'health', 'sports', 'entertainment'];
// Normalise whatever the model returns to ONE valid category. Weak models echo
// the whole enum ("top|politics|world…") — that was a real defect; here we pick
// the FIRST valid token found, else fall back to the feed's category.
function normalizeCategory(raw, fallback) {
  const s = String(raw || '').toLowerCase();
  for (const c of CATEGORIES) if (s.includes(c)) return c;
  return CATEGORIES.includes(fallback) ? fallback : 'top';
}
function safeJson(text) { try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} } return null; } }
// JSON-SCHEMA-CONSTRAINED decoding: Ollama accepts a full JSON Schema as `format`
// and constrains generation to it (llama.cpp GBNF under the hood). This makes the
// weak-model "category enum leak" IMPOSSIBLE by construction — category can ONLY
// be one of the enum values, importance is an integer 1-5, etc. Research finding:
// this is what lets a small fast model produce reliable structured output, so we
// don't need a slow 7B. See huggingface / llama.cpp grammar docs.
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    skip: { type: 'boolean' },
    hashtag: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    body: { type: 'string' },
    importance: { type: 'integer', minimum: 1, maximum: 5 },
    signal: { type: 'string', enum: ['breaking', 'live', 'none'] },
  },
  required: ['skip', 'hashtag', 'title', 'summary', 'category', 'body', 'importance', 'signal'],
};
async function synth(a) {
  const prompt = `${CHARTER}\n\nSynthesise ONE news story as JSON. category = exactly ONE genre. hashtag = a SPECIFIC event tag with the key proper noun + a distinguishing word (e.g. IsroChandrayaan4, TrumpChinaTariffs), NEVER a broad topic. importance: 5=major breaking … 1=trivial. Set skip=true if it fails the SKIP rules.\n\nARTICLE:\nTITLE: ${a.title}\nOUTLET: ${a.sourceName}\nPUBLISHED: ${a.publishedAt ?? 'unknown'}\nSNIPPET: ${a.snippet}`;
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt, stream: false, format: SYNTH_SCHEMA, options: { temperature: 0.2, num_predict: 400 } }), signal: AbortSignal.timeout(120000) });
    if (!r.ok) return null;
    const j = safeJson((await r.json()).response || '');
    if (!j || !j.title) return null;
    const title = String(j.title).slice(0, 300);
    return { skip: j.skip === true, hashtag: resolveHashtag(String(j.hashtag || ''), title), title, summary: String(j.summary || '').slice(0, 240), category: normalizeCategory(j.category, a.category), body: String(j.body || '').slice(0, 5000), importance: Math.max(1, Math.min(5, Math.round(Number(j.importance) || 3))), signal: ['breaking', 'live', 'none'].includes(j.signal) ? j.signal : 'none' };
  } catch { return null; }
}

// ── STAGE 1: gather → cluster → corroboration-score → synth → CANDIDATES ─────
// This stage does NOT push. It returns validated-shape candidates for review.mjs
// to gate. NO fixed story cap — we synth every cluster above a cheap pre-score
// (SYNTH_MIN_SCORE) so a busy news hour can yield 50-100, a quiet one fewer.
export async function buildCandidates() {
  const now = Date.now();
  const lists = await Promise.all(FEEDS.map(fetchFeed));
  const raw = lists.flat();
  console.log(`fetched ${raw.length} from ${FEEDS.length} feeds`);

  // Cluster same-event; corroboration = distinct outlets.
  const clusters = [];
  for (const a of raw) {
    let joined = false;
    for (const c of clusters) if (isSameStory(a.title, c.rep.title)) { c.sources.add(a.sourceName); if ((RANK[a.sourceName] || 2) > (RANK[c.rep.sourceName] || 2) && a.imageUrl) c.rep = a; joined = true; break; }
    if (!joined) clusters.push({ rep: a, sources: new Set([a.sourceName]) });
  }
  const scored = clusters
    .map((c) => { const a = c.rep; const corr = c.sources.size; let s = (RANK[a.sourceName] || 2) + fresh(a, now); if (PRIORITY.has(a.category)) s += 2; if (a.imageUrl) s += 1; s += Math.max(0, corr - 1) * 3; return { a, corr, score: s }; })
    .sort((x, y) => y.score - x.score);
  // SCORE-GATE, not a fixed cap: synth everything above SYNTH_MIN_SCORE, bounded
  // by SYNTH_HARD_MAX only to keep runtime sane (still 50-100 on a big hour).
  const eligible = scored.filter((p) => p.score >= SYNTH_MIN_SCORE).slice(0, SYNTH_HARD_MAX);
  console.log(`clustered ${clusters.length}; multi-source ${clusters.filter((c) => c.sources.size > 1).length}; eligible ${eligible.length}; top corroboration ${Math.max(0, ...eligible.map((p) => p.corr))}`);

  const candidates = [];
  let synthesized = 0;
  for (const p of eligible) {
    const s = await synth(p.a);
    if (!s) continue;
    synthesized++;
    // Corroboration shapes importance + gates breaking (Google-News velocity).
    if (p.corr >= 3) s.importance = Math.min(5, s.importance + 1);
    if (s.signal === 'breaking' && p.corr < 2) s.signal = 'none';
    candidates.push({ ...s, corr: p.corr, score: p.score, article: p.a });
  }
  console.log(`synthesized ${synthesized} candidates`);
  return candidates;
}

// Build the ingest payload for a reviewed candidate.
const HTTPS = (u) => (u && /^https:\/\//i.test(u) ? u : undefined);
export function toIngestBody(s) {
  const nowMs = Date.now();
  const a = s.article;
  return {
    hashtag: s.hashtag, title: s.title, summary: s.summary, category: s.category,
    imageUrl: HTTPS(a.imageUrl), publishedAt: a.publishedAt || undefined,
    breakingUntil: s.signal === 'breaking' ? new Date(nowMs + BREAKING_TTL_H * 3.6e6).toISOString() : undefined,
    liveUntil: s.signal === 'live' ? new Date(nowMs + LIVE_TTL_H * 3.6e6).toISOString() : undefined,
    update: { kind: 'update', headline: s.title, summary: s.summary, body: s.body, sources: [{ name: a.sourceName, url: a.url }], imageUrl: HTTPS(a.imageUrl), publishedAt: a.publishedAt || undefined },
  };
}
export { CATEGORIES, isSameStory };
