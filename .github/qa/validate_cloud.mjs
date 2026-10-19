#!/usr/bin/env node
// Cloud validator for a NEWS_DRY_RUN preview (out/news_preview_<edition>.json). Standalone: imports nothing from the
// pipeline. Same checks as the pipeline's local validator, against https://ollama.com with a Bearer key.
// Usage: node .github/qa/validate_cloud.mjs <preview.json> --model <name> --out <validation.json>
//          [--host https://ollama.com] [--max 40]
// Env: OLLAMA_API_KEY (sent only as the Authorization header; never printed).
// Per story: BRAND (finance/tech fit), FAITH (summary + short vs sourceText), SHORT (states the main event, warn),
//            IMAGES (vision relevance of licence-free thumbnails), RECENCY (publishedAt <= 36 h, warn).
// Exit 0 = no story fails. 1 = at least one brand/faith/image failure. 2 = preflight failed (no key, host, auth, model).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UA = 'AgyataQA/1.0 (news preview validation; https://agyata.com)';
export const RECENCY_MAX_H = 36;
export const CALL_TIMEOUT_MS = 120000;
export const CONCURRENCY = 2;
const WIKI_WIDTHS = [960, 1280];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Removes a ```json ... ``` (or bare ```) fence. Text without a fence is returned trimmed. */
export function stripFence(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/);
  return m ? m[1].trim() : t;
}

/** Parses a model reply as one JSON object (fence stripped; falls back to the outermost {...}). Null when none. */
export function parseReply(s) {
  const t = stripFence(s);
  for (const cand of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Stale when publishedAt is more than maxH hours before nowMs. Missing or invalid date gives stale null. */
export function recencyFlag(publishedAt, nowMs = Date.now(), maxH = RECENCY_MAX_H) {
  const t = Date.parse(publishedAt || '');
  if (!Number.isFinite(t)) return { stale: null, ageH: null };
  const ageH = Math.round(((nowMs - t) / 3600000) * 10) / 10;
  return { stale: ageH > maxH, ageH };
}

/** Wikimedia thumbnails at a non-standard width are rewritten to 960 px. Other URLs are returned unchanged. */
export function normalizeThumbUrl(url) {
  const m = String(url ?? '').match(/^(https:\/\/upload\.wikimedia\.org\/.+\/)(\d+)px-([^/]+)$/);
  if (!m || WIKI_WIDTHS.includes(Number(m[2]))) return String(url ?? '');
  return `${m[1]}${WIKI_WIDTHS[0]}px-${m[3]}`;
}

export const PROMPTS = {
  brand: ({ title, summary }) => [
    'You classify a news story for a finance and technology app.',
    'Is the story PRIMARILY a finance, business, markets, economy-policy-affecting-markets, or technology story?',
    `HEADLINE: ${title}`,
    `SUMMARY: ${summary}`,
    'Return {"primary": "finance"|"tech"|"other", "fit": true|false, "reason": "<short>"}.',
    'Reply with ONLY one JSON object, no prose, no code fence.',
  ].join('\n'),
  faith: ({ title, summary, short, sourceText }) => [
    'You check a news summary against its source text.',
    'List every claim, number, date or name in SUMMARY or SHORT that the SOURCE TEXT does not support.',
    'Ignore rewording and ordering. Only flag facts that are absent from or contradicted by the source.',
    `HEADLINE: ${title}`,
    `SUMMARY: ${summary}`,
    `SHORT: ${short}`,
    'SOURCE TEXT:',
    sourceText,
    'Return {"faithful": true|false, "unsupported": ["<claim>", ...]}.',
    'Reply with ONLY one JSON object, no prose, no code fence.',
  ].join('\n'),
  short: ({ title, short }) => [
    'Does the SHORT state the MAIN EVENT of the HEADLINE (who did what)?',
    `HEADLINE: ${title}`,
    `SHORT: ${short}`,
    'Return {"states_main_event": true|false, "reason": "<short>"}.',
    'Reply with ONLY one JSON object, no prose, no code fence.',
  ].join('\n'),
  image: ({ title }) => [
    `Headline: ${title}`,
    'Does this image depict the news event in the headline or its main subject (a person, place or thing it is about)?',
    'A generic stock photo that does not match the story is NOT relevant.',
    'Return {"relevant": true|false, "depicts": "<what the image shows>", "reason": "<short>"}.',
    'Reply with ONLY one JSON object, no prose, no code fence.',
  ].join('\n'),
};

/** Downloads one image with the descriptive UA and returns { url, b64 }. Throws on HTTP, type or size problems. */
export async function fetchImageB64(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const u = normalizeThumbUrl(url);
  const res = await fetchImpl(u, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error(`image type ${type || 'none'} not allowed`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) throw new Error(`image size ${buf.length} bytes out of range`);
  return { url: u, b64: buf.toString('base64') };
}

/** One Ollama /api/chat call at temperature 0. Throws with the HTTP status only (never the key or body). */
export async function chat({ host, key, model, messages, fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS }) {
  const res = await fetchImpl(`${String(host).replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': UA },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return String(j?.message?.content ?? '');
}

async function ask(opts, prompt, images = null) {
  try {
    const msg = { role: 'user', content: prompt };
    if (images) msg.images = images;
    const text = await chat({ ...opts, messages: [msg] });
    const json = parseReply(text);
    return json ? { ok: true, json } : { ok: false, error: 'reply was not a JSON object' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Per-story verdicts. failures make the story FAIL; warnings never do. */
export function storyVerdict(r) {
  const failures = [];
  const warnings = [];
  if (r.brand.verdict !== 'pass') failures.push(`brand:${r.brand.verdict}`);
  if (r.faith.verdict !== 'pass') failures.push(`faith:${r.faith.verdict}`);
  for (const im of r.images) {
    if (im.verdict === 'irrelevant' || im.verdict === 'error') failures.push(`image:${im.verdict}`);
    if (im.verdict === 'unavailable') warnings.push('image:unavailable');
  }
  if (r.short.verdict !== 'pass') warnings.push(`short:${r.short.verdict}`);
  if (r.recency.stale === true) warnings.push(`recency:stale ${r.recency.ageH}h`);
  return { status: failures.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS', failures, warnings };
}

export async function validateStory(story, { host, key, model, fetchImpl = fetch, nowMs = Date.now() }) {
  const opts = { host, key, model, fetchImpl };
  const title = String(story.title || '');
  const summary = String(story.summary || '');
  const short = String(story.summaryShort || '');
  const sourceText = String(story.sourceText || '');

  const b = await ask(opts, PROMPTS.brand({ title, summary }));
  const brand = b.ok
    ? { verdict: b.json.fit === true && b.json.primary !== 'other' ? 'pass' : 'fail', primary: b.json.primary ?? null, reason: b.json.reason ?? '' }
    : { verdict: 'error', reason: b.error };

  let faith;
  if (!sourceText.trim()) {
    faith = { verdict: 'no_source', unsupported: [], reason: 'preview record has no sourceText' };
  } else {
    const f = await ask(opts, PROMPTS.faith({ title, summary, short, sourceText }));
    faith = f.ok
      ? { verdict: f.json.faithful === true && !(f.json.unsupported || []).length ? 'pass' : 'fail', unsupported: f.json.unsupported || [] }
      : { verdict: 'error', unsupported: [], reason: f.error };
  }

  const s = await ask(opts, PROMPTS.short({ title, short }));
  const shortCheck = s.ok
    ? { verdict: s.json.states_main_event === true ? 'pass' : 'fail', reason: s.json.reason ?? '' }
    : { verdict: 'error', reason: s.error };

  const images = [];
  for (const im of Array.isArray(story.images) ? story.images : []) {
    let img;
    try {
      img = await fetchImageB64(im.url, { fetchImpl });
    } catch (e) {
      images.push({ url: im.url, verdict: 'unavailable', reason: e?.message || String(e) });
      continue;
    }
    const v = await ask(opts, PROMPTS.image({ title }), [img.b64]);
    if (!v.ok) images.push({ url: img.url, verdict: 'error', reason: v.error });
    else images.push({ url: img.url, verdict: v.json.relevant === true ? 'relevant' : 'irrelevant', depicts: v.json.depicts ?? '', reason: v.json.reason ?? '' });
  }

  const recency = recencyFlag(story.publishedAt, nowMs);
  const r = { hashtag: story.hashtag, title, category: story.category, brand, faith, short: shortCheck, images, recency };
  return { ...r, ...storyVerdict(r) };
}

/** Bounded-concurrency map that keeps input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Accepts { edition, stories } (current preview) or a bare array (older runs). */
export function storiesFrom(doc) {
  if (Array.isArray(doc)) return doc;
  return Array.isArray(doc?.stories) ? doc.stories : [];
}

async function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const file = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
  const model = arg('--model', 'gemma4:31b-cloud');
  const host = arg('--host', 'https://ollama.com');
  const out = arg('--out', null);
  const max = Number(arg('--max', '40'));
  const key = process.env.OLLAMA_API_KEY || '';

  if (!file) return usage(2);
  if (!key) {
    console.log('validator: OLLAMA_API_KEY is empty (project env var missing); nothing validated');
    return 2;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`validator: cannot read ${file}: ${e.message}`);
    return 2;
  }
  const stories = storiesFrom(doc).slice(0, max);
  const opts = { host, key, model };
  const pre = await ask(opts, 'Reply with ONLY one JSON object: {"ok": true}. No prose, no code fence.');
  if (!pre.ok) {
    console.log(`validator: preflight against ${host} model ${model} failed: ${pre.error}; nothing validated`);
    return 2;
  }

  console.log(`validating ${stories.length} stories with ${model} @ ${host} (concurrency ${CONCURRENCY})`);
  const rows = await mapLimit(stories, CONCURRENCY, (s) => validateStory(s, opts));
  const counts = { pass: 0, warn: 0, fail: 0 };
  const failures = [];
  const warnings = [];
  for (const r of rows) {
    counts[r.status === 'PASS' ? 'pass' : r.status === 'WARN' ? 'warn' : 'fail'] += 1;
    const tag = `#${r.hashtag || '?'} ${r.title.slice(0, 70)}`;
    if (r.failures.length) failures.push(`${tag}: ${r.failures.join(', ')}`);
    if (r.warnings.length) warnings.push(`${tag}: ${r.warnings.join(', ')}`);
    console.log(`${r.status.padEnd(4)} ${tag}${r.failures.length ? `  [${r.failures.join(', ')}]` : ''}`);
  }
  const report = { generatedAt: new Date().toISOString(), model, host, file, counts, failures, warnings, stories: rows };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`totals: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);
  return counts.fail ? 1 : 0;
}

function usage(code) {
  console.log('usage: node .github/qa/validate_cloud.mjs <preview.json> [--model M] [--host H] [--out F] [--max N]');
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
