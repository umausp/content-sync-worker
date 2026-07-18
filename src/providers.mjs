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
function openAiAdapter({ baseUrl, keyEnv, modelEnv, modelDefault, reasoningEffort }) {
  return async (prompt, opts) => {
    const key = envKey(...(Array.isArray(keyEnv) ? keyEnv : [keyEnv]));
    if (!key) return null;
    const model = process.env[modelEnv] || modelDefault;
    // OpenAI (and strict clones) HARD-REJECT response_format=json_object unless the
    // word "json" appears in the messages. Our callers usually include it, but the
    // paid OpenAI safety-net must never 400 on a JSON call just because a prompt
    // didn't — so append a JSON instruction when json mode is on and it's missing.
    const content = opts.json && !/json/i.test(prompt) ? `${prompt}\n\nRespond ONLY with a valid JSON object.` : prompt;
    // reasoning_effort='low' keeps a REASONING model (e.g. Cerebras gpt-oss-120b —
    // the only tier left after Cerebras retired Llama) fast + cheap for a simple
    // rewrite, so it doesn't burn hidden reasoning tokens. Set per-provider in the
    // REGISTRY; omitted providers send no such field.
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: opts.maxTokens || 400,
        response_format: opts.json ? { type: 'json_object' } : undefined,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (r.status === 429) throw { rateLimited: true };
    if (!r.ok) {
      // Surface the STATUS (and a short body) so a misconfig is diagnosable — a
      // silent null on a bad key/model was un-debuggable (the cerebras case).
      const detail = await r.text().catch(() => '');
      const err = new Error(`http ${r.status} ${detail.slice(0, 120)}`);
      // PERMANENT for this run (retrying is pointless → bench + move on): 401 bad
      // key, 402 billing, 403 forbidden, 404 missing model, 410 GONE (model retired
      // — the NVIDIA qwen2.5-coder EOL case). All are config problems, not blips.
      if ([401, 402, 403, 404, 410].includes(r.status)) err.permanent = true;
      throw err;
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
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      const err = new Error(`http ${r.status} ${detail.slice(0, 120)}`);
      if ([400, 401, 403, 404, 410].includes(r.status)) err.permanent = true; // bad key/model/request — permanent this run
      throw err;
    }
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
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      const err = new Error(`http ${r.status} ${detail.slice(0, 120)}`);
      if ([400, 401, 403, 404, 410].includes(r.status)) err.permanent = true;
      throw err;
    }
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
    tier: 'free', // very fast (~3000 tok/s); strong free tier — good PRIMARY
    // Cerebras RETIRED all Llama/Qwen models (llama-3.3-70b now 404s — verified live
    // 2026-07-18). gpt-oss-120b is their only Production model; it's reasoning-capable,
    // so reasoning_effort='low' keeps it fast/cheap for a plain news rewrite. Override
    // via CEREBRAS_MODEL. Free tier: 5 RPM / 30K TPM / 1M TPD (mind the low RPM — the
    // circuit breaker + cooldown handle its 429s gracefully).
    adapter: openAiAdapter({ baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', modelEnv: 'CEREBRAS_MODEL', modelDefault: 'gpt-oss-120b', reasoningEffort: process.env.CEREBRAS_REASONING_EFFORT || 'low' }),
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
  openrouter: {
    tier: 'free', // aggregator — use a ':free' model (free daily quota, then 429)
    // OpenRouter is OpenAI-compatible. The ':free' suffix routes to a zero-cost
    // model pool (rate-limited, not billed). Default to a solid free Llama; override
    // via OPENROUTER_MODEL (e.g. 'deepseek/deepseek-chat-v3:free', 'google/
    // gemini-2.0-flash-exp:free'). Keep the ':free' suffix or it may BILL.
    adapter: openAiAdapter({ baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', modelDefault: 'meta-llama/llama-3.3-70b-instruct:free' }),
    enabled: () => !!process.env.OPENROUTER_API_KEY,
    cap: Number(process.env.OPENROUTER_DAILY_CAP || 900),
  },
  nvidia: {
    tier: 'free', // NVIDIA NIM (build.nvidia.com) — generous free API credits
    // OpenAI-compatible at integrate.api.nvidia.com/v1. Default = llama-3.3-70b (a
    // strong general model, free on NVIDIA's dev-program credits → a QUALITY tier;
    // its ~40 RPM limit makes it quality-not-volume, which the fail-fast router
    // handles). The original qwen2.5-coder-32b returned HTTP 410 GONE (retired +
    // a coding model). Override via NVIDIA_MODEL (e.g. meta/llama-3.1-8b-instruct
    // for a faster, higher-RPM option).
    adapter: openAiAdapter({ baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY', modelEnv: 'NVIDIA_MODEL', modelDefault: 'meta/llama-3.3-70b-instruct' }),
    enabled: () => !!process.env.NVIDIA_API_KEY,
    cap: Number(process.env.NVIDIA_DAILY_CAP || 1000),
  },
  mistral: {
    tier: 'free', // Mistral La Plateforme — free "experiment" tier
    // OpenAI-compatible at api.mistral.ai/v1. mistral-small = fast + free-tier
    // friendly; ample for a title+summary rewrite. Override via MISTRAL_MODEL.
    adapter: openAiAdapter({ baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', modelDefault: 'mistral-small-latest' }),
    enabled: () => !!process.env.MISTRAL_API_KEY,
    cap: Number(process.env.MISTRAL_DAILY_CAP || 900),
  },
  gitmodels: {
    tier: 'free', // GitHub Models — free for GitHub users (rate-limited, not billed)
    // OpenAI-compatible at models.github.ai/inference. Model IDs are namespaced
    // ('openai/gpt-4o-mini', 'meta/Llama-3.3-70B-Instruct'). Low free RPM/TPD, so
    // the cap is modest + the cooldown/breaker handle its 429s. Override via GITMODELS_MODEL.
    adapter: openAiAdapter({ baseUrl: 'https://models.github.ai/inference', keyEnv: 'GITMODELS_API_KEY', modelEnv: 'GITMODELS_MODEL', modelDefault: 'openai/gpt-4o-mini' }),
    enabled: () => !!process.env.GITMODELS_API_KEY,
    cap: Number(process.env.GITMODELS_DAILY_CAP || 300),
  },
  deepinfra: {
    tier: 'free-metered', // free signup credits, then PAY-PER-USE (bills the card)
    // DeepInfra is OpenAI-compatible at /v1/openai. New accounts get free credits,
    // but it BILLS once they're spent — so it's OFF the default order (we keep the
    // ladder strictly $0). Re-add via PROVIDER_ORDER to spend the free credits; the
    // cap bounds the burn. Small fast model per 'use only what's needed'.
    adapter: openAiAdapter({ baseUrl: 'https://api.deepinfra.com/v1/openai', keyEnv: 'DEEPINFRA_API_KEY', modelEnv: 'DEEPINFRA_MODEL', modelDefault: 'meta-llama/Meta-Llama-3.1-8B-Instruct' }),
    enabled: () => !!process.env.DEEPINFRA_API_KEY,
    cap: Number(process.env.DEEPINFRA_DAILY_CAP || 600),
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
// Cerebras is OMITTED by default: on our free account gpt-oss-120b returns 402
// 'Payment required' (Llama models retired), so it can't run at $0. It stays in the
// REGISTRY — re-add via PROVIDER_ORDER if billing is ever enabled. (The runtime
// permanent-failure disable also catches it, but omitting it avoids the wasted
// first-hop probe each run.)
// Free-first ladder — all $0 (rate-limited, not billed): gemini, sambanova, cohere,
// openrouter(:free), nvidia, mistral, gitmodels; then PAID openai (spillover, tight
// cap); then local ollama (last resort). DeepInfra is OMITTED — it BILLS the card
// once free signup credits run out, and we keep the default ladder STRICTLY $0 (user
// decision 2026-07-18); re-add via PROVIDER_ORDER='...,deepinfra,...' to spend its
// credits. Cerebras + Groq + Cloudflare are also OFF by default (see notes above).
const DEFAULT_ORDER = 'gemini,sambanova,cohere,openrouter,nvidia,mistral,gitmodels,openai,ollama';

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
// PER-ATTEMPT timeout for a HOSTED provider. Healthy hosted inference answers in a
// few seconds; if it hasn't in HOSTED_ATTEMPT_MS it's down for this run (we bench
// it below), so one hung endpoint can't eat the caller's whole (up to 150s synth)
// budget. Ollama is legitimately slow (local CPU) → it alone keeps the full timeout.
const HOSTED_ATTEMPT_MS = Number(process.env.PROVIDER_HOSTED_TIMEOUT_MS || 30000);
// STRICT FAIL-FAST (user: "check once; if it fails move to next and NEVER retry"):
// each provider gets ONE attempt per run. On ANY failure — 429, permanent
// (401/402/403/404), timeout, 5xx, empty — it's BENCHED for the whole run and
// never tried again. No cooldown, no circuit-counter, no retry loop (that loop
// spun 18 min on OpenRouter's constant :free 429s → run timed out + cancelled).
// benched: name → { reason, kind } so the run can PRINT exactly which providers
// failed and why (the user's "which keys to remove" list). Ollama is NEVER benched
// — it's the local last resort and must always be reachable.
const benched = new Map();
function bench(name, kind, reason) {
  if (name === 'ollama') { console.warn(`[providers] ollama ${reason} — last resort, will retry`); return; }
  benched.set(name, { kind, reason });
  console.warn(`[providers] ${name} ${reason} — benched for this run (${kind}, no retry)`);
}
export async function generate(prompt, opts = {}) {
  // DATE ROLLOVER: usage was loaded at import; if this (rare, but a Hindi hourly
  // run could) crosses midnight UTC, reset the day's counts so caps aren't locked
  // to the process's start date.
  const day = today();
  if (usage.date !== day) { usage.date = day; usage.counts = {}; }
  for (const name of availableProviders()) {
    if (benched.has(name)) continue; // already failed once this run — skip instantly, never retry
    const entry = REGISTRY[name];
    const used = usage.counts[name] || 0;
    if (used >= entry.cap) continue; // cap hit — the $0/spend guardrail
    // Cap a hosted attempt so one hung endpoint can't eat the whole synth budget.
    const attemptMs = name === 'ollama' ? (opts.timeoutMs || 150000) : Math.min(opts.timeoutMs || HOSTED_ATTEMPT_MS, HOSTED_ATTEMPT_MS);
    try {
      const text = await entry.adapter(prompt, { ...opts, timeoutMs: attemptMs });
      if (text != null) {
        usage.counts[name] = used + 1;
        if (++flushCounter % 5 === 0) saveUsage(usage);
        return { text, provider: name };
      }
      bench(name, 'empty', 'returned no text (non-OK / empty response)');
    } catch (e) {
      // Categorise so the end-of-run report tells the user which keys are actually
      // BAD (permanent) vs merely RATE-LIMITED (key is fine, just throttled) — the
      // two need different actions (remove the key vs keep it).
      if (e?.permanent) bench(name, 'permanent', e.message);            // 401/402/403/404 — bad key/model/billing
      else if (e?.rateLimited) bench(name, 'rate_limited', 'http 429'); // key WORKS, just throttled this run
      else bench(name, 'error', e?.message || String(e));              // timeout / network / 5xx
    }
  }
  saveUsage(usage);
  return { text: null, provider: null };
}

// The per-run provider FAILURE report (user's "which keys aren't working" list).
// kind: 'permanent' = bad key/model/billing (REMOVE candidate); 'rate_limited' =
// key works but throttled (KEEP); 'error' = timeout/5xx (flaky, watch); 'empty'.
export function providerFailures() {
  return [...benched.entries()].map(([name, v]) => ({ name, ...v }));
}

export function usageSummary() {
  const caps = {};
  for (const [n, e] of Object.entries(REGISTRY)) caps[n] = e.cap;
  return { date: usage.date, counts: { ...usage.counts }, caps };
}
export function flushUsage() { saveUsage(usage); }
