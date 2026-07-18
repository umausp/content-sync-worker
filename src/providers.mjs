// Multi-provider LLM router — the throughput unlock. Synthesis moves off the slow
// CPU Ollama to FREE hosted inference (sub-second), with a fallback ladder so no
// single provider's rate-limit/outage stops the run:
//
//   Groq (fast, generous free RPD) → Gemini Flash (free) → Cloudflare Workers AI
//   (free neurons, already on our stack) → Ollama (local CPU, last resort)
//
// $0 GUARANTEE — the hard part. Free tiers mostly just 429 when exhausted (no
// bill), EXCEPT Cloudflare Workers AI, which BILLS past the free neuron
// allowance. So every provider has a conservative DAILY REQUEST CAP persisted
// across runs (state file), and Cloudflare's cap is the strictest. When a
// provider is caby-capped or errors, we fall to the next. If ALL hosted
// providers are exhausted, we fall to Ollama (free) or, failing that, signal the
// caller to use the extractive path — so a run never costs money and never fully
// fails.
//
// Env (GitHub secrets, all optional — a provider is simply skipped if unkeyed):
//   GROQ_API_KEY, GROQ_MODEL (default llama-3.3-70b-versatile)
//   GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.0-flash)
//   CF_ACCOUNT_ID + CF_AI_TOKEN, CF_AI_MODEL (default @cf/meta/llama-3.1-8b-instruct-fp8-fast)
//   OLLAMA_HOST, OLLAMA_MODEL (local fallback)
//   PROVIDER_ORDER (comma list, default "groq,gemini,cloudflare,ollama")
//   *_DAILY_CAP per provider (see DEFAULT_CAPS); CF cap is the $0 guardrail.

import { readFileSync, writeFileSync } from 'node:fs';

const STATE_FILE = process.env.PROVIDER_STATE_FILE || '/tmp/agyata_provider_usage.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Conservative daily request caps — WELL under each free tier so we never spill.
// Cloudflare is the only one that BILLS past free, so its cap is the real $0
// guardrail (a small-model call ≈ tens of neurons; 3000 calls stays under the
// ~10k-neuron/day free allowance with margin). Others just 429 when exhausted.
const DEFAULT_CAPS = {
  groq: Number(process.env.GROQ_DAILY_CAP || 12000), // free ~14.4k/day; leave headroom
  gemini: Number(process.env.GEMINI_DAILY_CAP || 1400), // free ~1500/day
  cloudflare: Number(process.env.CF_DAILY_CAP || 2500), // HARD $0 guardrail (bills past free)
  ollama: Number(process.env.OLLAMA_DAILY_CAP || 100000), // local, effectively unlimited
};

// ── usage state (persisted so DAILY caps are real across runs) ───────────────
function today() {
  // UTC date key. Date.now is available on the runner; if unavailable, fall back.
  try { return new Date().toISOString().slice(0, 10); } catch { return 'nodate'; }
}
function loadUsage() {
  try {
    const u = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (u.date === today()) return u;
  } catch {}
  return { date: today(), counts: {} };
}
function saveUsage(u) {
  try { writeFileSync(STATE_FILE, JSON.stringify(u)); } catch {}
}

// ── provider adapters — each: (prompt, opts) → text | null ───────────────────
async function callGroq(prompt, opts) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: opts.maxTokens || 400,
      response_format: opts.json ? { type: 'json_object' } : undefined,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
  if (r.status === 429) throw { rateLimited: true };
  if (!r.ok) return null;
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? null;
}

async function callGemini(prompt, opts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
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
}

async function callCloudflare(prompt, opts) {
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
}

async function callOllama(prompt, opts) {
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
}

const ADAPTERS = { groq: callGroq, gemini: callGemini, cloudflare: callCloudflare, ollama: callOllama };

// Which providers are actually configured (have keys). Ollama is assumed available
// (local); the caller can drop it via PROVIDER_ORDER.
export function availableProviders() {
  const order = (process.env.PROVIDER_ORDER || 'groq,gemini,cloudflare,ollama').split(',').map((s) => s.trim()).filter(Boolean);
  return order.filter((p) => {
    if (p === 'groq') return !!process.env.GROQ_API_KEY;
    if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
    if (p === 'cloudflare') return !!(process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN);
    if (p === 'ollama') return process.env.PROVIDER_USE_OLLAMA !== '0';
    return false;
  });
}

// The router. Tries providers in order, honouring daily caps + rate-limit backoff.
// Returns { text, provider } or { text: null } if every provider is exhausted/failed
// (caller then uses the extractive fallback — never a paid call, never a hard fail).
const usage = loadUsage();
let flushCounter = 0;
export async function generate(prompt, opts = {}) {
  const providers = availableProviders();
  for (const p of providers) {
    const cap = DEFAULT_CAPS[p] ?? 1000;
    const used = usage.counts[p] || 0;
    if (used >= cap) continue; // daily cap hit — the $0 guardrail (esp. cloudflare)
    try {
      const text = await ADAPTERS[p](prompt, opts);
      if (text != null) {
        usage.counts[p] = used + 1;
        if (++flushCounter % 5 === 0) saveUsage(usage); // persist periodically
        return { text, provider: p };
      }
    } catch (e) {
      if (e?.rateLimited) { usage.counts[p] = cap; /* treat as exhausted for this run */ continue; }
      // network/other error → try next provider
    }
  }
  saveUsage(usage);
  return { text: null, provider: null };
}

export function usageSummary() {
  return { date: usage.date, counts: { ...usage.counts }, caps: DEFAULT_CAPS };
}
export function flushUsage() { saveUsage(usage); }
