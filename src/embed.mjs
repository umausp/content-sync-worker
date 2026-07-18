// Semantic EMBEDDINGS — a meaning-based signal that complements the word-overlap +
// entity dedup. It catches "same event, DIFFERENT words" pairs those miss (verified
// on real titles: "What is Kimi K3" ~ "Moonshot AI unveils Kimi K3"; two FIFA-final
// previews; a Kudankulam breach reworded). Runs as ONNX in pure Node via
// transformers.js — CPU-only, ~4ms/short-title, no GPU/Python.
//
// DESIGN (safe-by-default):
//   • LAZY + FAIL-OPEN: the model loads on first use; if load or inference fails,
//     embedText returns null and every caller degrades to the existing word+entity
//     dedup — semantics can only ADD merges, never break the pipeline.
//   • EDITION-AWARE model: English edition → bge-base-en-v1.5 (best symmetric
//     short-text model in our test; nothing beats it for this task). Hindi/local →
//     gte-multilingual-base (Apache-2.0, Hindi-capable, no prefixes).
//   • CLS pooling: bge + gte-v1.5 were TRAINED with CLS; it widened our same-vs-
//     different separation gap by ~40% over mean pooling (0.107→0.150), measured.
//   • Cosine on L2-normalised vectors. SIM threshold tuned high (0.85 default) so
//     the added merges are precise — comfortably above the same-event floor (~0.58
//     w/ cls) and well above the different-event ceiling (~0.43).
//
// Off unless EMBED_DEDUP=1 (or EMBED_VERIFY=1). No dependency cost when disabled —
// the transformers import is dynamic, only paid when a caller actually embeds.

const IS_LOCAL = (process.env.EDITION || 'national').toLowerCase() === 'local';
// English: bge-base-en-v1.5 (CLS). Hindi/local: multilingual gte (CLS, Apache-2.0,
// no mandatory prefixes). Override via EMBED_MODEL.
const MODEL = process.env.EMBED_MODEL || (IS_LOCAL ? 'onnx-community/gte-multilingual-base' : 'Xenova/bge-base-en-v1.5');
const POOLING = process.env.EMBED_POOLING || 'cls'; // matches how bge/gte were trained
export const SIM_THRESHOLD = Number(process.env.EMBED_SIM_THRESHOLD || 0.85);

let _pipe = null;      // the loaded feature-extraction pipeline
let _loadTried = false; // once load fails we don't retry every call (fail-fast)
let _loadPromise = null;

async function getPipe(log) {
  if (_pipe) return _pipe;
  if (_loadTried) return null; // already failed once — stay degraded
  if (!_loadPromise) {
    _loadTried = true;
    _loadPromise = (async () => {
      try {
        const t0 = Date.now();
        const { pipeline } = await import('@huggingface/transformers');
        _pipe = await pipeline('feature-extraction', MODEL);
        log?.('embed.loaded', { model: MODEL, ms: Date.now() - t0 });
        return _pipe;
      } catch (e) {
        log?.('embed.load_failed', { model: MODEL, err: e?.message || String(e) });
        return null; // FAIL-OPEN: callers degrade to word+entity dedup
      }
    })();
  }
  return _loadPromise;
}

// Embed one string → normalised Float32 vector (Array), or null on any failure.
export async function embedText(text, opts = {}) {
  const pipe = await getPipe(opts.log);
  if (!pipe) return null;
  try {
    const out = await pipe(String(text || '').slice(0, 512), { pooling: POOLING, normalize: true });
    return Array.from(out.data);
  } catch (e) {
    opts.log?.('embed.infer_failed', { err: e?.message || String(e) });
    return null;
  }
}

// Embed many strings → array of vectors (null entries for failures). Sequential —
// on a 4-vCPU runner batching gives little and keeps memory flat.
export async function embedMany(texts, opts = {}) {
  const pipe = await getPipe(opts.log);
  if (!pipe) return texts.map(() => null);
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) out[i] = await embedText(texts[i], opts);
  return out;
}

// Cosine similarity of two already-NORMALISED vectors (dot product). Returns 0 if
// either is missing so a failed embed never falsely reports similarity.
export function cosine(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const EMBED_ENABLED = process.env.EMBED_DEDUP === '1';
export const EMBED_VERIFY_ENABLED = process.env.EMBED_VERIFY === '1';
export const EMBED_MODEL_NAME = MODEL;
