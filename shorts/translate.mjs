// translate.mjs — English news → natural HINGLISH for the India (bharat) channel.
//
// The national feed is English; the India channel speaks Hindi/Hinglish. We translate
// the picked story's title + summary to conversational Hinglish (Hindi in Devanagari,
// keeping English proper nouns/brand/number terms as-is — the way Indian news anchors
// actually speak). Kokoro's Hindi voice reads this style cleanly (verified).
//
// Uses free LLM providers directly (Gemini first — the primary in the news ladder),
// keyed by env. FAIL-SAFE: if no key / the call fails, returns the ORIGINAL English
// text so a Short still renders (never blocks the pipeline). Single attempt per
// provider, matching the pipeline's strict fail-fast philosophy.

const TIMEOUT_MS = 25000;

// Gemini (generativelanguage) — the primary free provider. Model overridable.
async function viaGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// OpenAI-compatible fallback (SambaNova / OpenRouter / Groq / NVIDIA — whichever is keyed).
async function viaOpenAICompatible(prompt) {
  const providers = [
    { key: 'SOMBANOVA_API_KEY', base: 'https://api.sambanova.ai/v1', model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct' },
    { key: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1', model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free' },
    { key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' },
  ];
  for (const p of providers) {
    const key = process.env[p.key];
    if (!key) continue;
    try {
      const r = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
    } catch {
      /* try next */
    }
  }
  return null;
}

function buildPrompt(title, summary) {
  return [
    'You are a senior Hindi news anchor for a national TV channel. Translate the English',
    'news below into clear, professional, NATURAL HINDI in Devanagari script.',
    'RULES:',
    '- Write EVERYTHING in Hindi/Devanagari — including people, places and organisation',
    "  names, transliterated to Devanagari (e.g. 'Donald Trump' → 'डोनाल्ड ट्रंप',",
    "  'Netflix' → 'नेटफ्लिक्स', 'Parliament' → 'संसद').",
    '- Keep numbers/dates readable in Hindi. Do NOT leave English words in Latin script.',
    '- Crisp, factual, broadcast tone. NO opinion, NO new facts, NO English sentences.',
    '- Do NOT add greetings or filler; translate only the given text.',
    'Return ONLY valid JSON: {"title": "...", "summary": "..."} — no markdown, no extra text.',
    '',
    `English title: ${title}`,
    `English summary: ${summary}`,
  ].join('\n');
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Translate → { title, summary } in professional Devanagari HINDI, or the ORIGINAL
// English on any failure (fail-safe so a Short still renders). Prefers FREE providers
// (SambaNova / OpenRouter / Groq — all free tiers) and only uses Gemini if its key is
// set. `translated:false` means it fell back to English — the caller logs that loudly.
export async function toHinglish(title, summary) {
  const prompt = buildPrompt(title, summary);
  let out = null;
  try {
    // Free OpenAI-compatible providers first; Gemini only as an optional extra.
    out = (await viaOpenAICompatible(prompt)) || (await viaGemini(prompt));
  } catch {
    out = null;
  }
  const parsed = parseJson(out);
  if (parsed?.title && parsed?.summary) {
    return { title: String(parsed.title).trim(), summary: String(parsed.summary).trim(), translated: true };
  }
  // Fail-safe: keep English so the Short still renders.
  return { title, summary, translated: false };
}
