// llm.mjs — a tiny, free-first LLM chat helper for the shorts pipeline. Speaks the
// OpenAI /chat/completions shape across the free providers we already key (SambaNova /
// OpenRouter / Groq). Used to SYNTHESISE a genuinely useful multi-source summary from
// the raw article body (fixes "content is very less"). Fail-open: returns null if no
// key is set or every provider fails, so the caller keeps the extractive text.

const TIMEOUT_MS = Number(process.env.SHORTS_LLM_TIMEOUT_MS || 25000);

const PROVIDERS = [
  { key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' },
  { key: 'SOMBANOVA_API_KEY', base: 'https://api.sambanova.ai/v1', model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct' },
  { key: 'SAMBANOVA_API_KEY', base: 'https://api.sambanova.ai/v1', model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct' },
  { key: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1', model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free' },
];

// Run a single-prompt chat completion through the first available free provider.
// Returns the assistant text, or null on total failure.
export async function llmChat(prompt, { maxTokens = 400, temperature = 0.3 } = {}) {
  for (const p of PROVIDERS) {
    const key = process.env[p.key];
    if (!key) continue;
    try {
      const r = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
    } catch {
      /* try next provider */
    }
  }
  return null;
}

export function haveLlmKey() {
  return PROVIDERS.some((p) => process.env[p.key]);
}
