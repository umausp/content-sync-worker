// Multi-provider LLM router — pluggable FACTORY/REGISTRY design so providers can
// be added, reordered, capped, and switched on demand purely by config/env, with
// automatic failover. Synthesis runs on FREE hosted inference (sub-second) with a
// fallback ladder so no single provider's rate-limit/outage stops the run.
//
// DESIGN
//   • Every provider is a REGISTRY entry: { name, kind, tier, adapterFactory,
//     enabled(), model, cap }. The router reads PROVIDER_ORDER, keeps the enabled
//     ones, and tries them in order — each call falls through to the next on
//     rate-limit/error/cap.
//   • kind='openai' → ONE shared adapter (Groq, Cerebras, SambaNova, OpenAI all
//     speak the OpenAI /chat/completions shape — only base URL + key + model
//     differ). kind='gemini' and kind='cloudflare' have their own adapters.
//   • tier='free' providers just 429 when exhausted (no bill). tier='paid'
//     (OpenAI) is placed LAST with a tight cap so it's spillover only → $0-safe.
//   • Cloudflare is the one FREE provider that BILLS past its neuron allowance,
//     so it also carries a hard cap.
//
// Add a provider = add one REGISTRY entry. Switch order = set PROVIDER_ORDER.
//
// Env (all optional — a provider is skipped if its key is absent):
//   CEREBRAS_API_KEY / CEREBRAS_MODEL        (free, very fast — good primary)
//   GROQ_API_KEY / GROQ_MODEL                (free, fast)
//   SAMBANOVA_API_KEY / SAMBANOVA_MODEL      (free tier)
//   GEMINI_API_KEY / GEMINI_MODEL            (free Flash tier)
//   CF_ACCOUNT_ID + CF_AI_TOKEN / CF_AI_MODEL(free neurons, capped)
//   OPENAI_API_KEY / OPENAI_MODEL            (PAID — last, tight cap, spillover)
//   OLLAMA_HOST / OLLAMA_MODEL               (local CPU, last-resort)
//   PROVIDER_ORDER  (comma list; default below)  •  <NAME>_DAILY_CAP per provider

import { readFileSync, writeFileSync } from 'node:fs';

const STATE_FILE = process.env.PROVIDER_STATE_FILE || '/tmp/agyata_provider_usage.json';

// ── shared OpenAI-compatible adapter factory ────────────────────────────────
// Read an API key from the FIRST configured env name — tolerates the exact secret
// names in the repo (e.g. SOMBANOVA_API_KEY / COHERA_API_KEY) alongside the
// correctly-spelled fallbacks, so a naming typo never silently disables a provider.
function envKey(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
}

// Groq / Cerebras / SambaNova / OpenAI all use POST {baseUrl}/chat/completions
// with a Bearer key. One factory, parameterised. keyEnv may be an array of
// candidate env names.
function openAiAdapter({ baseUrl, keyEnv, modelEnv, modelDefault }) {
  return async (prompt, opts) => {
    const key = envKey(...(Array.isArray(keyEnv) ? keyEnv : [keyEnv]));
    if (!key) return null;
    const model = process.env[modelEnv] || modelDefault;
    // OpenAI (and strict clones) HARD-REJECT response_format=json_object unless the
    // word "json" appears in the messages. Our callers usually include it, but the
    // paid OpenAI safety-net must never 400 on a JSON call just because a prompt
    // didn't — so append a JSON instruction when json mode is on and it's missing.
    const content = opts.json && !/json/i.test(prompt) ? `${prompt}\n\nRespond ONLY with a valid JSON object.` : prompt;
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: opts.maxTokens || 400,
        response_format: opts.json ? { type: 'json_object' } : undefined,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (r.status === 429) throw { rateLimited: true };
    if (!r.ok) {
      // Surface the STATUS (and a short body) so a misconfig is diagnosable — a
      // silent null on a bad key/model was un-debuggable (the cerebras case).
      const detail = await r.text().catch(() => '');
      throw new Error(`http ${r.status} ${detail.slice(0, 120)}`);
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? null;
  };
}

// ── Gemini adapter (generateContent) ────────────────────────────────────────
function geminiAdapter() {
  return async (prompt, opts) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    // Use a FLASH TEXT model (fast, cheap, free tier). NOT a *-live model — those
    // are realtime audio/video streaming, not batch JSON text. Override via GEMINI_MODEL.
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: opts.maxTokens || 400, responseMimeType: opts.json ? 'application/json' : 'text/plain' },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (r.status === 429) throw { rateLimited: true };
    if (!r.ok) return null;
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  };
}

// ── Cloudflare Workers AI adapter ───────────────────────────────────────────
function cloudflareAdapter() {
  return async (prompt, opts) => {
    const acct = process.env.CF_ACCOUNT_ID;
    const key = process.env.CF_AI_TOKEN;
    if (!acct || !key) return null;
    const model = process.env.CF_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, max_tokens: opts.maxTokens || 400, temperature: 0.2 }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (r.status === 429) throw { rateLimited: true };
    if (!r.ok) return null;
    const j = await r.json();
    return j.result?.response ?? null;
  };
}

// ── Cohere adapter (v2 /chat) ───────────────────────────────────────────────
// Reads the key from whatever name is configured (the repo has COHERA_API_KEY).
function cohereAdapter() {
  return async (prompt, opts) => {
    const key = envKey('COHERE_API_KEY', 'COHERA_API_KEY');
    if (!key) return null;
    const model = process.env.COHERE_MODEL || 'command-r-08-2024'; // fast, cheap free-tier chat model
    const content = opts.json && !/json/i.test(prompt) ? `${prompt}\n\nRespond ONLY with a valid JSON object.` : prompt;
    const r = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: opts.maxTokens || 400,
        response_format: opts.json ? { type: 'json_object' } : undefined,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (r.status === 429) throw { rateLimited: true };
    if (!r.ok) return null;
    const j = await r.json();
    // Cohere v2: message.content is an array of {type,text}
    return j.message?.content?.map((p) => p.text).join('') ?? null;
  };
}

// ── local Ollama adapter (last-resort, free, slow) ──────────────────────────
function ollamaAdapter() {
  return async (prompt, opts) => {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
    const r = await fetch(`${host}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: opts.json ? 'json' : undefined, keep_alive: '30m', options: { temperature: 0.2, num_predict: opts.maxTokens || 400 } }),
      signal: AbortSignal.timeout(opts.timeoutMs || 150000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.response ?? null;
  };
}

// ── PROVIDER REGISTRY ───────────────────────────────────────────────────────
// One entry per provider. `enabled()` = has its credentials. `cap` = per-run
// request budget (the $0 guardrail — conservative for capped/paid providers). The
// chosen MODELS are deliberately the CHEAP/FAST "mini/flash/instant" tier — a news
// title+summary rewrite needs no heavy or reasoning model. (OpenAI: gpt-4o-mini,
// NOT o3/o4-mini — reasoning models burn hidden tokens + cost more for this task.)
const REGISTRY = {
  cerebras: {
    tier: 'free', // very fast; strong free tier — good PRIMARY
    adapter: openAiAdapter({ baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', modelEnv: 'CEREBRAS_MODEL', modelDefault: 'llama-3.3-70b' }),
    enabled: () => !!process.env.CEREBRAS_API_KEY,
    cap: Number(process.env.CEREBRAS_DAILY_CAP || 8000),
  },
  groq: {
    tier: 'free',
    adapter: openAiAdapter({ baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', modelDefault: 'llama-3.3-70b-versatile' }),
    enabled: () => !!process.env.GROQ_API_KEY,
    cap: Number(process.env.GROQ_DAILY_CAP || 8000),
  },
  sambanova: {
    tier: 'free',
    // repo secret is SOMBANOVA_API_KEY (typo) — read that first, then the correct spelling
    adapter: openAiAdapter({ baseUrl: 'https://api.sambanova.ai/v1', keyEnv: ['SOMBANOVA_API_KEY', 'SAMBANOVA_API_KEY'], modelEnv: 'SAMBANOVA_MODEL', modelDefault: 'Meta-Llama-3.3-70B-Instruct' }),
    enabled: () => !!envKey('SOMBANOVA_API_KEY', 'SAMBANOVA_API_KEY'),
    cap: Number(process.env.SAMBANOVA_DAILY_CAP || 2000),
  },
  cohere: {
    tier: 'free', // free/trial tier — command-r class, fast
    adapter: cohereAdapter(),
    enabled: () => !!envKey('COHERE_API_KEY', 'COHERA_API_KEY'),
    cap: Number(process.env.COHERE_DAILY_CAP || 900),
  },
  gemini: {
    tier: 'free',
    adapter: geminiAdapter(),
    enabled: () => !!process.env.GEMINI_API_KEY,
    cap: Number(process.env.GEMINI_DAILY_CAP || 1400),
  },
  cloudflare: {
    tier: 'free-metered', // free neurons but BILLS past them → hard cap
    adapter: cloudflareAdapter(),
    enabled: () => !!(process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN),
    cap: Number(process.env.CF_DAILY_CAP || 150),
  },
  openai: {
    tier: 'paid', // PAID — last resort, TIGHT cap, spillover only ($ guardrail)
    adapter: openAiAdapter({ baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', modelDefault: 'gpt-4o-mini' }),
    enabled: () => !!process.env.OPENAI_API_KEY,
    cap: Number(process.env.OPENAI_DAILY_CAP || 100),
  },
  ollama: {
    tier: 'local',
    adapter: ollamaAdapter(),
    enabled: () => process.env.PROVIDER_USE_OLLAMA !== '0',
    cap: Number(process.env.OLLAMA_DAILY_CAP || 100000),
  },
};

// Order: cheap fast FREE first (cerebras/gemini/sambanova/cohere), PAID openai
// last (spillover), local ollama last-resort. Groq +
// Cloudflare are still in the REGISTRY (usable by setting PROVIDER_ORDER) but are
// OFF by default — no Groq key, and Cloudflare's billable creds are unwanted in a
// public repo. Set PROVIDER_ORDER to re-include them.
const DEFAULT_ORDER = 'cerebras,gemini,sambanova,cohere,openai,ollama';

// ── usage state (persisted so per-run/day caps are honoured) ─────────────────
function today() { try { return new Date().toISOString().slice(0, 10); } catch { return 'nodate'; } }
function loadUsage() {
  try { const u = JSON.parse(readFileSync(STATE_FILE, 'utf8')); if (u.date === today()) return u; } catch {}
  return { date: today(), counts: {} };
}
function saveUsage(u) { try { writeFileSync(STATE_FILE, JSON.stringify(u)); } catch {} }

// Ordered list of ENABLED provider names (per PROVIDER_ORDER, filtered to keyed).
export function availableProviders() {
  const order = (process.env.PROVIDER_ORDER || DEFAULT_ORDER).split(',').map((s) => s.trim()).filter(Boolean);
  return order.filter((name) => REGISTRY[name]?.enabled());
}

// The router. Tries enabled providers in order, honouring per-run caps + failover.
// Returns { text, provider } or { text: null } (caller uses the extractive
// fallback — never a paid call beyond its cap, never a hard fail).
const usage = loadUsage();
let flushCounter = 0;
// COOLDOWN: park a provider for a SHORT window instead of banning it for the run.
// Triggered by (a) a 429 (often a per-minute TPM blip, not the daily cap) and
// (b) the CIRCUIT BREAKER below. Keyed by name → epoch-ms it's usable again.
const COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 90000);
// PER-ATTEMPT timeout for a HOSTED provider. Healthy hosted inference answers in a
// few seconds; if it hasn't in HOSTED_ATTEMPT_MS it's effectively down for THIS
// call, so we fall through rather than burn the caller's whole (up to 150s synth)
// budget on one hung endpoint. Ollama is legitimately slow (local CPU) → it alone
// keeps the caller's full timeout.
const HOSTED_ATTEMPT_MS = Number(process.env.PROVIDER_HOSTED_TIMEOUT_MS || 30000);
// CIRCUIT BREAKER: after this many CONSECUTIVE failures (bad key / timeout / 5xx —
// NOT a 429, which has its own cooldown) a hosted provider is benched for
// COOLDOWN_MS. This is what makes the router DECIDE FAST to stop re-trying a dead
// provider (e.g. a bad CEREBRAS key) as the wasteful first hop on every one of the
// run's ~90 calls, and fall straight through to a working one (incl. Ollama).
const FAIL_THRESHOLD = Number(process.env.PROVIDER_FAIL_THRESHOLD || 2);
const cooldownUntil = {};
const consecFails = {};
// Bench a provider after repeated non-429 failures so a dead provider stops being
// re-tried every call. Ollama is never benched — it's the last resort.
function tripBreaker(name, why) {
  consecFails[name] = (consecFails[name] || 0) + 1;
  const open = name !== 'ollama' && consecFails[name] >= FAIL_THRESHOLD;
  if (open) { cooldownUntil[name] = Date.now() + COOLDOWN_MS; consecFails[name] = 0; }
  console.warn(`[providers] ${name} ${why}${open ? ` — circuit OPEN, benched ${Math.round(COOLDOWN_MS / 1000)}s` : ' — falling through'}`);
}
export async function generate(prompt, opts = {}) {
  // DATE ROLLOVER: usage was loaded at import; if this (rare, but a Hindi hourly
  // run could) crosses midnight UTC, reset the day's counts so caps aren't locked
  // to the process's start date.
  const day = today();
  if (usage.date !== day) { usage.date = day; usage.counts = {}; }
  for (const name of availableProviders()) {
    const entry = REGISTRY[name];
    const used = usage.counts[name] || 0;
    if (used >= entry.cap) continue; // cap hit — the $0/spend guardrail
    if (cooldownUntil[name] && Date.now() < cooldownUntil[name]) continue; // cooling down (429 or circuit) — skip
    // Cap a hosted attempt so one hung endpoint can't eat the whole synth budget.
    const attemptMs = name === 'ollama' ? (opts.timeoutMs || 150000) : Math.min(opts.timeoutMs || HOSTED_ATTEMPT_MS, HOSTED_ATTEMPT_MS);
    try {
      const text = await entry.adapter(prompt, { ...opts, timeoutMs: attemptMs });
      if (text != null) {
        usage.counts[name] = used + 1;
        consecFails[name] = 0; // healthy again → reset the breaker
        if (++flushCounter % 5 === 0) saveUsage(usage);
        return { text, provider: name };
      }
      // null = non-OK / empty (bad key, 5xx). Count toward the circuit breaker so a
      // dead provider (e.g. a rolled key silently rolling us toward PAID OpenAI) is
      // benched fast + visibly, not retried as the first hop every call.
      tripBreaker(name, 'returned no text (bad key / non-OK / empty)');
    } catch (e) {
      if (e?.rateLimited) { cooldownUntil[name] = Date.now() + COOLDOWN_MS; consecFails[name] = 0; console.warn(`[providers] ${name} rate-limited (429) — cooling down ${Math.round(COOLDOWN_MS / 1000)}s`); continue; }
      tripBreaker(name, `error: ${e?.message || e}`); // timeout / network / 5xx
    }
  }
  saveUsage(usage);
  return { text: null, provider: null };
}

export function usageSummary() {
  const caps = {};
  for (const [n, e] of Object.entries(REGISTRY)) caps[n] = e.cap;
  return { date: usage.date, counts: { ...usage.counts }, caps };
}
export function flushUsage() { saveUsage(usage); }
