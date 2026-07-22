// llm.mjs — the shorts pipeline's LLM chat helper. This is now a THIN ADAPTER over the
// SHARED multi-provider router in src/providers.mjs — the SAME NVIDIA-first, fail-fast,
// Ollama-fallback ladder the news pipeline uses (user: "use AI model with NVidia
// following others and fallback to ollama").
//
// WHY: shorts used to carry its OWN tiny 3-provider list (Groq / SambaNova / OpenRouter)
// with no NVIDIA and no Ollama. When those weren't keyed or 429'd, llmChat() returned
// null and every summary fell back to raw extractive paragraphs — the "repeated words,
// weak content" the user saw. Delegating to src/providers.mjs gives shorts the full free
// ladder (nvidia,gemini,sambanova,cohere,openrouter,mistral,gitmodels → paid openai →
// local ollama), per-run caps, benching, and the same PROVIDER_ORDER env switch.
//
// Fail-open: returns null if no provider is reachable, so the caller keeps its extractive
// text. Same signature as before — callers (world_feeds.enrichSummary) need no change.

import { generate, availableProviders } from '../src/providers.mjs';

// Run a single-prompt chat completion through the shared provider ladder.
// Returns the assistant text, or null on total failure.
export async function llmChat(prompt, { maxTokens = 400, temperature = 0.3, json = false, timeoutMs } = {}) {
  // NOTE: the shared adapter fixes temperature at 0.2 (news-grade determinism); the
  // `temperature` arg is accepted for signature-compatibility but the router's low temp
  // is what we want for factual news summaries anyway (less hallucination/repetition).
  const { text } = await generate(prompt, {
    maxTokens,
    json,
    timeoutMs: timeoutMs || Number(process.env.SHORTS_LLM_TIMEOUT_MS || 30000),
  });
  return text ? String(text).trim() : null;
}

// True when at least one provider is configured/reachable. The shared router counts
// Ollama as always-available (local last resort) unless PROVIDER_USE_OLLAMA=0, so this is
// effectively "is any hosted key set OR is Ollama allowed". Callers use it to decide
// whether to attempt LLM synthesis before falling back to extractive text.
export function haveLlmKey() {
  return availableProviders().length > 0;
}
