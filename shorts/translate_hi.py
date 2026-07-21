#!/usr/bin/env python3
"""translate_hi.py — OFFLINE English→Hindi translation for the Bharat channel.

Uses facebook/m2m100_418M (MIT license, commercial-safe, NOT gated) via transformers.
Chosen after testing: NLLB-quality output, keeps proper nouns sane (no 'Netflix →
ब्लूफिक्स' hallucination), no special toolkit, and compatible with the transformers
version Kokoro already installs — so no dependency conflict, no gated repo, no LLM
rate limits. Fully offline once the model is cached.

Reads a JSON job on argv[1]:
  { "items": [{"title": "...", "summary": "..."}, ...], "out": "/path.json" }
Writes <out>: { "items": [{"title": "...", "summary": "...", "translated": true}, ...] }
Fail-safe: on any error a given item keeps its English text with translated=false, so
the pipeline never blocks (the caller logs if translation didn't happen).
"""
import json
import sys


def main() -> int:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    items = job.get("items") or []
    out_path = job["out"]

    import warnings

    warnings.filterwarnings("ignore")
    try:
        from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer

        tok = M2M100Tokenizer.from_pretrained("facebook/m2m100_418M")
        model = M2M100ForConditionalGeneration.from_pretrained("facebook/m2m100_418M")
        tok.src_lang = "en"
        hi_id = tok.get_lang_id("hi")
    except Exception as e:  # model load failed → all items stay English
        print(f"translate_hi: model load failed ({e}); keeping English", file=sys.stderr)
        json.dump(
            {"items": [{**it, "translated": False} for it in items]},
            open(out_path, "w", encoding="utf-8"),
            ensure_ascii=False,
        )
        return 0

    def tr(text):
        text = (text or "").strip()
        if not text:
            return "", False
        try:
            ids = tok(text, return_tensors="pt", truncation=True, max_length=256)
            gen = model.generate(
                **ids, forced_bos_token_id=hi_id, max_length=256, num_beams=5, no_repeat_ngram_size=3
            )
            return tok.batch_decode(gen, skip_special_tokens=True)[0].strip(), True
        except Exception as e:
            print(f"translate_hi: item failed ({e})", file=sys.stderr)
            return text, False

    out_items = []
    done = 0
    for it in items:
        ti, ok1 = tr(it.get("title"))
        su, ok2 = tr(it.get("summary"))
        out = {**it, "title": ti or it.get("title", ""), "summary": su or it.get("summary", ""), "translated": bool(ok1 and ok2)}
        # Optional backstory (thread origin) — translate it too when present.
        if it.get("backstory"):
            bs, _ok = tr(it.get("backstory"))
            out["backstory"] = bs or it.get("backstory", "")
        if out["translated"]:
            done += 1
        out_items.append(out)

    json.dump({"items": out_items}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"translate_hi: {done}/{len(items)} translated EN→HI (m2m100)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
