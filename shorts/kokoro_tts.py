#!/usr/bin/env python3
"""kokoro_tts.py — Kokoro (Apache-2.0) narration for Agyata Shorts, with EXPLICIT
espeak-ng phonemization for correct pronunciation (esp. proper nouns + Hindi).

Reads a JSON job on argv[1]:
  { "chunks": ["Story 1. Andy Burnham...", "..."],
    "lang": "a"|"h",           # a = English, h = Hindi
    "voice": "am_michael",     # Kokoro voice (am_*/af_* = US accent)
    "espeakLang": "en-us",     # espeak-ng language for phonemization
    "speed": 0.94,
    "out": "/path/base" }
and writes:
  <out>.wav   — 24 kHz mono narration (all chunks concatenated, in order)
  <out>.json  — { "duration": float, "segments": [{start,end,text}, ...] }  # text = REAL words

WHY espeak-ng phonemization:
  Kokoro's default English G2P (misaki) uses a dictionary and only falls back to
  espeak for out-of-dictionary words — which mispronounces many names. Here we
  phonemize the WHOLE text with espeak-ng (via phonemizer) to IPA, then feed those
  phonemes straight to Kokoro (generate_from_tokens), bypassing the dictionary. This
  is the correct-phonemes-then-audio path the user asked for. Hindi (lang 'h') is
  espeak-native in Kokoro anyway; we phonemize with espeak 'hi' for consistency.
  Falls back to Kokoro's normal text path if phonemization/token-gen ever fails, so a
  clip never silently drops.

The CALLER splits narration into caption-sized chunks (real readable text). We
synthesize each separately, measure its true length, and emit a segment carrying the
ORIGINAL text (for captions) + real start/end (perfectly voice-synced).
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 24000

# Map our job lang → espeak-ng language code. World channel = 'en-us' (USA style).
ESPEAK_LANG = {"a": "en-us", "b": "en-gb", "h": "hi"}


def make_phonemizer(espeak_lang):
    """espeak-ng backend via phonemizer. Uses Kokoro's bundled libespeak-ng if the
    system one isn't found, so it works on any runner."""
    try:
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        try:
            EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        except Exception:
            pass
    except Exception:
        pass  # fall through to whatever phonemizer finds on PATH
    from phonemizer.backend import EspeakBackend

    return EspeakBackend(espeak_lang, preserve_punctuation=True, with_stress=True)


def synth_text(pipe, text, voice, speed):
    """Kokoro's normal text path (fallback). Returns concatenated float32 audio."""
    parts = []
    for _gs, _ps, audio in pipe(text, voice=voice, speed=speed):
        a = np.asarray(audio, dtype=np.float32)
        parts.append(a if a.ndim == 1 else a.reshape(-1))
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def synth_phonemes(pipe, phonemes, voice, speed):
    """Feed espeak IPA phonemes straight to Kokoro (bypasses misaki dictionary)."""
    parts = []
    for r in pipe.generate_from_tokens(tokens=phonemes, voice=voice, speed=speed):
        a = np.asarray(r.audio, dtype=np.float32)
        parts.append(a if a.ndim == 1 else a.reshape(-1))
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def main() -> int:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    chunks = [c.strip() for c in (job.get("chunks") or []) if c and c.strip()]
    lang = job.get("lang") or "a"
    voice = job.get("voice") or ("hf_alpha" if lang == "h" else "am_michael")
    espeak_lang = job.get("espeakLang") or ESPEAK_LANG.get(lang, "en-us")
    speed = float(job.get("speed", 0.94))
    gap = float(job.get("gap", 0.18))
    out = job["out"]
    if not chunks:
        print("kokoro_tts: no chunks", file=sys.stderr)
        return 2

    import warnings

    warnings.filterwarnings("ignore")
    from kokoro import KPipeline

    pipe = KPipeline(lang_code=lang)

    # Build the espeak phonemizer once. If it can't init, we degrade to Kokoro's own
    # text G2P (still works, just without the explicit-espeak accuracy win).
    backend = None
    try:
        backend = make_phonemizer(espeak_lang)
    except Exception as e:
        print(f"kokoro_tts: phonemizer unavailable ({e}); using Kokoro text G2P", file=sys.stderr)

    gap_samples = np.zeros(int(gap * SR), dtype=np.float32)
    audio_parts = []
    segments = []
    t = 0.0
    phonemized = 0
    for text in chunks:
        a = np.zeros(0, dtype=np.float32)
        # Preferred path: espeak phonemes → Kokoro tokens.
        if backend is not None:
            try:
                ph = backend.phonemize([text], strip=True)
                ph = (ph[0] if ph else "").strip()
                if ph:
                    a = synth_phonemes(pipe, ph, voice, speed)
                    if len(a) / SR >= 0.05:
                        phonemized += 1
            except Exception as e:
                print(f"kokoro_tts: phoneme synth failed on a chunk ({e}); text fallback", file=sys.stderr)
                a = np.zeros(0, dtype=np.float32)
        # Fallback: Kokoro's normal text path.
        if len(a) / SR < 0.05:
            a = synth_text(pipe, text, voice, speed)
        dur = len(a) / SR
        if dur < 0.02:
            continue  # one bad chunk shouldn't kill the run
        segments.append({"start": round(t, 3), "end": round(t + dur, 3), "text": text})
        audio_parts.append(a)
        audio_parts.append(gap_samples)
        t += dur + gap

    if not audio_parts:
        print("kokoro_tts: produced no audio", file=sys.stderr)
        return 3

    full = np.concatenate(audio_parts)
    peak = float(np.max(np.abs(full))) or 1.0
    full = (full / peak) * (10 ** (-1.5 / 20))  # -1.5 dBFS headroom
    sf.write(f"{out}.wav", full, SR)
    json.dump(
        {"duration": round(len(full) / SR, 3), "segments": segments},
        open(f"{out}.json", "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    print(
        f"kokoro_tts: {len(segments)} segs, {round(len(full)/SR,2)}s, "
        f"phonemized={phonemized}/{len(chunks)} via espeak({espeak_lang})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
