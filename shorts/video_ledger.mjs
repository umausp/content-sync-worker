// video_ledger.mjs — the renderer's DEDICATED "have we already published a VIDEO for this
// story?" memory. Backed by Upstash Redis (REST API over plain HTTPS fetch — no driver,
// $0 free tier ~10k cmds/day; we use ~100/hr). This is SEPARATE from the website's
// Cloudflare `news_dedup_claims` (that stays untouched for the site).
//
// WHY a second store (user: "if any story is published then it should not come to video
// until there is an update and new important news came for it… create your own DB for
// quick checking if that news story is already created"):
//   • CF news_dedup_claims is a SHORT-window race guard (≤24h) so 4 Shorts + 2 long-form in
//     the same hour don't collide — it PRUNES old keys, so a story becomes claimable again
//     after ~2h. That's wrong for "we already made a video of this."
//   • This ledger is the DURABLE long-term memory: once a story is turned into a video it's
//     LOCKED for VIDEO_LEDGER_TTL_DAYS and only re-qualifies when there's a genuine UPDATE.
//
// "GENUINE UPDATE" detection (deterministic — LLM summaries vary run-to-run so we must NOT
// hash the summary):
//   • KEY = normKey(title) — the SAME word-set key the rest of the pipeline dedups on. A
//     materially new development almost always rewrites the headline ("Autopsy inconclusive"
//     → "Second autopsy ordered") → a DIFFERENT key → naturally treated as a new story.
//   • VALUE = a fingerprint that only moves on a real update: the thread updateCount. A
//     near-identical headline with a bumped updateCount (a threaded story got a new
//     development) re-qualifies; the same headline at the same updateCount is a duplicate.
//
// Fail-open EVERYWHERE: any Redis/network error → we do NOT block rendering (a rare repeat
// beats an empty channel). Disabled cleanly if the env secrets are unset.

const URL_BASE = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TTL_DAYS = Number(process.env.VIDEO_LEDGER_TTL_DAYS || 7);
const TTL_SEC = Math.max(3600, Math.round(TTL_DAYS * 86400));
const PREFIX = process.env.VIDEO_LEDGER_PREFIX || 'agyata:vid:';

export function ledgerEnabled() {
  return !!(URL_BASE && TOKEN);
}

// SAME normalized-title key the renderer + research pool dedup on, so the ledger agrees with
// every other layer on what "the same story" is. (Kept in sync with build_short.mjs normKey.)
export function ledgerKey(title) {
  const k = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 8)
    .join(' ');
  return k ? PREFIX + k : '';
}

// Fingerprint that changes ONLY on a genuine update — the thread's update count. Non-threaded
// trend/research stories are 0, so once published they stay locked for the whole TTL (exactly
// "don't remake until there's an update"); a threaded story that gains a real development bumps
// updateCount → different fp → re-qualifies.
function fingerprint(story) {
  const upd = Number(story.updateCount || story.updates || 0) || 0;
  return `u${upd}`;
}

// ── TOPIC DIVERSITY (user: "don't create same category/topic every run; track on Redis") ──
// The trend builders tag almost everything `category:'offbeat'`, so `category` can't keep a
// run from being football-after-football-after-football. Classify each story into a REAL
// coarse topic from its title/summary keywords, remember the topics of recent videos in
// Redis, and let the picker cool a topic down for a few runs after it airs. Deterministic,
// keyword-based (no LLM): a wrong-ish bucket just nudges rotation, never blocks a story.
const TOPIC_PREFIX = process.env.VIDEO_TOPIC_PREFIX || 'agyata:vidtopic:';
const TOPIC_TTL_SEC = Math.max(
  1800,
  Math.round(Number(process.env.VIDEO_TOPIC_COOLDOWN_H || 6) * 3600),
);
// Ordered, so the FIRST match wins (sport before generic 'world'). Each topic → its tell-tale
// words. Word-boundary matched against `${title} ${summary}` lowercased.
const TOPIC_RULES = [
  ['football', /\b(fc|transfer|loan|striker|midfielder|winger|goalkeeper|premier league|la liga|serie a|bundesliga|uefa|champions league|penalty|goal|matchday|deadline day|signing|manager|coach|squad|footballer|arsenal|chelsea|liverpool|tottenham|barcelona|madrid|juventus|villa)\b/],
  ['cricket', /\b(cricket|wicket|batsman|bowler|innings|odi|test match|ipl|t20|century|run chase)\b/],
  ['tennis', /\b(tennis|wimbledon|grand slam|atp|wta|us open|roland garros|australian open|set point|ace)\b/],
  ['sports-other', /\b(nba|nfl|mlb|nhl|golf|f1|formula one|grand prix|boxing|ufc|mma|olympic|athletics|darts|rugby|cycling|motogp)\b/],
  ['politics', /\b(election|parliament|senate|congress|president|prime minister|minister|policy|vote|campaign|govern|referendum|diplomat|sanction|treaty|tariff)\b/],
  ['conflict', /\b(war|military|strike|missile|troops|ceasefire|invasion|attack|bombing|hostage|drone|airstrike|militant|border clash)\b/],
  ['crime', /\b(murder|killed|arrest|police|court|trial|guilty|charged|verdict|prison|suspect|homicide|found dead|investigation|epstein)\b/],
  ['business', /\b(stock|market|shares|earnings|revenue|profit|ipo|merger|acquisition|economy|inflation|interest rate|ceo|layoff|startup|nasdaq|dow)\b/],
  ['tech', /\b(ai|artificial intelligence|iphone|android|google|apple|microsoft|openai|chip|semiconductor|app|software|cyber|robot|gadget|xbox|playstation|nintendo)\b/],
  ['entertainment', /\b(film|movie|actor|actress|singer|album|song|celebrity|hollywood|netflix|box office|premiere|concert|tour|grammy|oscar|rosal)\b/],
  ['science', /\b(nasa|space|rocket|satellite|study|research|scientist|climate|discovery|species|vaccine|dna|physics|astronomer|telescope)\b/],
  ['health', /\b(health|disease|virus|outbreak|hospital|doctor|patient|medicine|drug|cancer|mental health|pandemic|surgery)\b/],
  ['weather', /\b(storm|hurricane|flood|wildfire|heatwave|earthquake|tornado|drought|blizzard|typhoon|evacuat|weather)\b/],
];
export function classifyTopic(story) {
  const hay = `${story?.title || ''} ${story?.summary || ''}`.toLowerCase();
  for (const [topic, re] of TOPIC_RULES) if (re.test(hay)) return topic;
  return 'general';
}
const TOPIC_NAMES = [...TOPIC_RULES.map(([t]) => t), 'general'];
const topicKey = (t) => TOPIC_PREFIX + t;

// Low-level Upstash REST call. Single command → POST body ["CMD","arg",…] → { result }.
async function redis(cmd, { timeoutMs = 8000 } = {}) {
  const r = await fetch(URL_BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const j = await r.json();
  return j.result;
}
// Pipeline several commands in ONE round-trip → POST /pipeline [["CMD",…],…] → [{result},…].
async function redisPipeline(cmds, { timeoutMs = 10000 } = {}) {
  if (!cmds.length) return [];
  const r = await fetch(`${URL_BASE}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`upstash pipeline ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const j = await r.json();
  return Array.isArray(j) ? j.map((x) => x?.result) : [];
}

// FILTER a candidate list down to stories we have NOT already made a video of (or that have a
// genuine update since we did). Preserves input order. Fail-open: on any error, returns the
// input unchanged so a Redis hiccup never blanks the channel.
export async function filterAlreadyMade(stories, { label = 'shorts' } = {}) {
  if (!ledgerEnabled() || !Array.isArray(stories) || !stories.length) return stories;
  try {
    const keyed = stories.map((s) => ({ s, key: ledgerKey(s.title), fp: fingerprint(s) }));
    const keys = keyed.map((k) => k.key).filter(Boolean);
    if (!keys.length) return stories;
    const stored = (await redis(['MGET', ...keys])) || [];
    // Align MGET results back to the keyed list (skip stories with no key → always keep).
    let idx = 0;
    const fresh = [];
    let blocked = 0;
    for (const k of keyed) {
      if (!k.key) {
        fresh.push(k.s);
        continue;
      }
      const prev = stored[idx++];
      // Already made a video of this exact story (same fp) → DROP. New story (no row) or a
      // genuine update (fp differs) → KEEP.
      if (prev != null && String(prev) === k.fp) {
        blocked++;
        continue;
      }
      fresh.push(k.s);
    }
    console.log(`[video-ledger:${label}] ${blocked}/${keys.length} candidates already made into a video (dropped); ${fresh.length} fresh`);
    // Never blank the channel: if EVERYTHING recent was already made, fall back to the
    // unfiltered pool (a rare repeat beats posting nothing) — and say so loudly.
    if (!fresh.length) {
      console.log(`[video-ledger:${label}] ⚠ all candidates already published — falling back to unfiltered pool (no fresh story right now)`);
      return stories;
    }
    return fresh;
  } catch (e) {
    console.log(`[video-ledger:${label}] check failed (${e.message}) — proceeding without video-dedup`);
    return stories;
  }
}

// RECORD that we published a video containing these stories. Call AFTER a successful upload
// so a failed render/upload never locks a story. `entries` = [{key, fp}] (from meta.json) OR
// raw story objects. Best-effort, fail-open.
export async function markPublished(entries, { label = 'shorts' } = {}) {
  if (!ledgerEnabled() || !Array.isArray(entries) || !entries.length) return;
  try {
    const cmds = [];
    for (const e of entries) {
      const key = e.key || ledgerKey(e.title);
      const fp = e.fp || fingerprint(e);
      if (key) cmds.push(['SET', key, fp, 'EX', TTL_SEC]);
    }
    if (!cmds.length) return;
    await redisPipeline(cmds);
    console.log(`[video-ledger:${label}] recorded ${cmds.length} published stories (TTL ${TTL_DAYS}d)`);
  } catch (e) {
    console.log(`[video-ledger:${label}] mark failed (${e.message}) — not fatal`);
  }
}

// ── RECENT-TOPIC COOLDOWN ─────────────────────────────────────────────────────
// Read the set of topics aired in the last VIDEO_TOPIC_COOLDOWN_H hours. Each publish
// writes one `agyata:vidtopic:<topic>` key with that TTL; presence = "on cooldown". We
// MGET all buckets in one call. Fail-open → empty set (never blocks a render).
export async function recentTopics({ label = 'shorts' } = {}) {
  if (!ledgerEnabled()) return new Set();
  try {
    const vals = (await redis(['MGET', ...TOPIC_NAMES.map(topicKey)])) || [];
    const hot = new Set();
    TOPIC_NAMES.forEach((t, i) => { if (vals[i] != null) hot.add(t); });
    if (hot.size) console.log(`[video-topic:${label}] on cooldown: ${[...hot].join(', ')}`);
    return hot;
  } catch (e) {
    console.log(`[video-topic:${label}] recent-topics read failed (${e.message}) — no cooldown this run`);
    return new Set();
  }
}

// Re-order a candidate list so topics NOT recently aired come first, preserving the
// original (score) order WITHIN each group. Nothing is dropped — a fresh-topic story just
// outranks a repeat-topic one — so the channel never blanks even if every topic is hot.
// Annotates each story with `.topic` for downstream logging/marking.
export function deprioritizeRecentTopics(stories, hot, { label = 'shorts' } = {}) {
  if (!Array.isArray(stories) || !stories.length) return stories;
  const cool = [];
  const warm = [];
  for (const s of stories) {
    s.topic = s.topic || classifyTopic(s);
    (hot && hot.has(s.topic) ? warm : cool).push(s);
  }
  if (hot && hot.size && warm.length && cool.length) {
    console.log(`[video-topic:${label}] ${cool.length} fresh-topic ahead of ${warm.length} recent-topic`);
  }
  return [...cool, ...warm];
}

// RECORD the topics of the stories we just published so they cool down. Call alongside
// markPublished (after a successful upload). Best-effort, fail-open.
export async function markTopicsPublished(entries, { label = 'shorts' } = {}) {
  if (!ledgerEnabled() || !Array.isArray(entries) || !entries.length) return;
  try {
    const topics = new Set(
      entries.map((e) => e.topic || classifyTopic(e)).filter(Boolean),
    );
    const cmds = [...topics].map((t) => ['SET', topicKey(t), '1', 'EX', TOPIC_TTL_SEC]);
    if (!cmds.length) return;
    await redisPipeline(cmds);
    console.log(`[video-topic:${label}] cooled down topics: ${[...topics].join(', ')} (TTL ${Math.round(TOPIC_TTL_SEC / 3600)}h)`);
  } catch (e) {
    console.log(`[video-topic:${label}] mark-topics failed (${e.message}) — not fatal`);
  }
}

// Build the compact {key, fp, topic} records to persist in meta.json so upload.mjs can mark
// them after a successful upload (build_short → meta.json → upload.mjs).
export function ledgerRecords(stories) {
  return (stories || [])
    .map((s) => ({ key: ledgerKey(s.title), fp: fingerprint(s), topic: s.topic || classifyTopic(s) }))
    .filter((r) => r.key);
}
