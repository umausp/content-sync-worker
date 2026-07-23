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

# SPOKEN substitutions applied to the narration text BEFORE phonemization (the on-screen
# caption uses the caller's ORIGINAL text, so spelling is unaffected). espeak says the
# brand as "a-JI-ah-ta" and mangles ".com"; respell for a clean, natural read.
import re as _re

SAY_AS = [
    (_re.compile(r"\bagyata\.com\b", _re.I), "ag-yaa-ta dot com"),
    (_re.compile(r"\bagyata\b", _re.I), "ag-yaa-ta"),
]

# ABBREVIATION expansion — espeak mangles dotted initialisms ("U.S." → "you. ess." with
# awkward pauses). Expand the common news ones to full words so they read naturally.
# Order matters (dotted forms before bare). English only (skipped for Hindi lang='h').
ABBREV = [
    (_re.compile(r"\bU\.?\s?S\.?\s?A\.?\b"), "United States"),
    (_re.compile(r"\bU\.?\s?S\.?(?=[\s,.\)]|$)"), "United States"),
    (_re.compile(r"\bU\.?\s?K\.?(?=[\s,.\)]|$)"), "United Kingdom"),
    (_re.compile(r"\bU\.?\s?N\.?(?=[\s,.\)]|$)"), "United Nations"),
    (_re.compile(r"\bU\.?\s?A\.?\s?E\.?\b"), "U A E"),
    (_re.compile(r"\bE\.?\s?U\.?(?=[\s,.\)]|$)"), "European Union"),
    (_re.compile(r"\bU\.?\s?P\.?(?=[\s,.\)]|$)"), "U P"),  # Uttar Pradesh state code
    (_re.compile(r"\bD\.?\s?C\.?(?=[\s,.\)]|$)"), "D C"),
    (_re.compile(r"\bPM\b"), "Prime Minister"),
    (_re.compile(r"\bCM\b"), "Chief Minister"),
    (_re.compile(r"\bGDP\b"), "G D P"),
    (_re.compile(r"\bCEO\b"), "C E O"),
    (_re.compile(r"\bAI\b"), "A I"),
    (_re.compile(r"\bvs\.?\b", _re.I), "versus"),
    (_re.compile(r"&"), " and "),
    (_re.compile(r"%"), " percent"),
]

# CURRENCY — "$5 billion" is read "dollar five billion"; reorder to "5 billion dollars".
# The magnitude may be a WORD (billion) or a single-letter suffix ($3B, $2K, €5M) — both
# must expand to the full word ("billion"), never be read as a bare letter ("3 dollarsB").
_MAG = {
    "k": "thousand", "m": "million", "bn": "billion", "b": "billion",
    "tn": "trillion", "t": "trillion", "thousand": "thousand", "million": "million",
    "billion": "billion", "trillion": "trillion", "lakh": "lakh", "crore": "crore",
}


def _money(unit):
    def repl(m):
        num = m.group(1)
        mag = _MAG.get((m.group(2) or "").lower(), "")
        return " ".join(p for p in (num, mag, unit) if p)
    return repl


# Uppercase single-letter magnitudes (B/M/K/T) are case-SENSITIVE so a lowercase "3m"
# (metres) is never turned into money; word forms + "bn"/"tn" are case-insensitive.
_CUR = [
    (_re.compile(r"\$\s?([\d.,]+)\s?(trillion|billion|million|thousand|lakh|crore|bn|tn|[TBMK])\b"),
     _money("dollars")),
    (_re.compile(r"\$\s?([\d.,]+)"), lambda m: f"{m.group(1)} dollars"),
    (_re.compile(r"£\s?([\d.,]+)\s?(trillion|billion|million|thousand|bn|tn|[TBMK])\b"),
     _money("pounds")),
    (_re.compile(r"£\s?([\d.,]+)"), lambda m: f"{m.group(1)} pounds"),
    (_re.compile(r"€\s?([\d.,]+)\s?(trillion|billion|million|thousand|bn|tn|[TBMK])\b"),
     _money("euros")),
    (_re.compile(r"€\s?([\d.,]+)"), lambda m: f"{m.group(1)} euros"),
    (_re.compile(r"₹\s?([\d.,]+)\s?(crore|lakh|billion|million|thousand)\b", _re.I),
     _money("rupees")),
    (_re.compile(r"₹\s?([\d.,]+)"), lambda m: f"{m.group(1)} rupees"),
]

# THOUSANDS SEPARATORS — espeak/phonemizer preserve the comma as a PAUSE, so "2,000" is
# read "two … zero zero zero". Strip a comma sitting BETWEEN digits so the whole number is
# read as one value ("2,000" → "2000" → "two thousand"; "1,234,567" → the full number).
# A comma NOT between digits (list/clause separator) is left untouched.
_THOUSANDS = _re.compile(r"(?<=\d),(?=\d)")

# Characters that must NEVER be voiced (markup/JSON/markdown leaking into the text).
_TTS_STRIP = _re.compile(r"[#*_~`|<>{}\[\]\\^=]+")
_URL_RE = _re.compile(r"https?://\S+")


def spoken_form(text, lang="a"):
    out = str(text or "")
    out = _URL_RE.sub(" ", out)  # don't read raw URLs aloud
    # English-only number/abbrev normalization. These expand into ENGLISH WORDS ("billion",
    # "percent", "United States") and strip the thousands comma — all CORRECT for English
    # (lang a/b) but WRONG for the native-language Kokoro channels: French uses a DECIMAL
    # comma ("2,5" must not become "25"), reads "%" as "pour cent", "&" as "et"; Japanese
    # (lang 'j') needs none of it. So gate the whole block to English and let espeak read
    # native numbers/currency in-language for fr/j (matches the Piper path's language-safety).
    english = lang in ("a", "b")
    if english:
        out = _THOUSANDS.sub("", out)  # "2,000" → "2000" so it reads as one number, not digits
        for pat, rep in _CUR:  # currency BEFORE stripping '$'/'£'
            out = pat.sub(rep, out)
    out = _TTS_STRIP.sub(" ", out)  # kill markup/JSON/markdown chars
    if english:  # abbreviation expansion is English-only
        for pat, rep in ABBREV:
            out = pat.sub(rep, out)
    for pat, rep in SAY_AS:
        out = pat.sub(rep, out)
    # Collapse whitespace + stray punctuation runs left behind (incl. a period stranded
    # before a hyphen by abbrev expansion, e.g. "United States.-India").
    out = _re.sub(r"\.(?=[-–—])", "", out)
    out = _re.sub(r"\s+([.,!?;:])", r"\1", out)
    out = _re.sub(r"\s+", " ", out).strip()
    return out


def make_phonemizer(espeak_lang):
    """espeak-ng backend via phonemizer. Uses Kokoro's bundled libespeak-ng if the
    system one isn't found, so it works on any runner."""
    # Point phonemizer at Kokoro's bundled libespeak-ng so it works on any runner.
    # Guard every call with hasattr — the wrapper API differs across phonemizer /
    # phonemizer-fork versions (older ones lack set_library / set_data_path), and a
    # missing attribute must NOT crash: we just fall back to whatever's on PATH.
    try:
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        if hasattr(EspeakWrapper, "set_library"):
            EspeakWrapper.set_library(espeakng_loader.get_library_path())
        if hasattr(EspeakWrapper, "set_data_path"):
            EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
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
    gap = float(job.get("gap", 0.32))  # inter-sentence breath (was 0.18 = too rushed)
    out = job["out"]
    if not chunks:
        print("kokoro_tts: no chunks", file=sys.stderr)
        return 2

    import warnings

    warnings.filterwarnings("ignore")
    from kokoro import KPipeline

    pipe = KPipeline(lang_code=lang)

    # EXPLICIT-espeak phoneme path is ENGLISH/HINDI ONLY (lang a/b/h). For those, Kokoro's
    # own G2P is espeak-based too, so phonemizing the WHOLE text with espeak-ng first fixes
    # proper-noun/initialism mispronunciation (the reason this path exists). For the NATIVE
    # channels it must NOT run:
    #   • French (lang 'f') — Kokoro-fr's native G2P already IS EspeakG2P(fr), so the text
    #     path gives the same phonemes without our extra step (and our English respelling
    #     would corrupt it — already gated off in spoken_form).
    #   • Japanese (lang 'j') — Kokoro-ja was trained on misaki/OpenJTalk MORA phonemes, NOT
    #     espeak IPA; feeding it espeak-ja phonemes produces garbled audio. It MUST use
    #     Kokoro's own JA G2P (misaki[ja]) via the text path.
    # So build the espeak backend only for a/b/h; everything else uses Kokoro's text G2P.
    use_espeak = lang in ("a", "b", "h")
    backend = None
    if use_espeak:
        try:
            backend = make_phonemizer(espeak_lang)
        except Exception as e:
            print(f"kokoro_tts: phonemizer unavailable ({e}); using Kokoro text G2P", file=sys.stderr)

    audio_parts = []
    segments = []
    t = 0.0
    phonemized = 0
    for text in chunks:
        a = np.zeros(0, dtype=np.float32)
        spoken = spoken_form(text, lang)  # voice-only respelling; caption keeps `text`
        # Preferred path: espeak phonemes → Kokoro tokens.
        if backend is not None:
            try:
                ph = backend.phonemize([spoken], strip=True)
                ph = (ph[0] if ph else "").strip()
                # espeak injects LANGUAGE-SWITCH markers like "(en)word(hi)" when it hits
                # a foreign word (e.g. an English name inside Hindi). Kokoro reads those
                # literally → the voice says "hi"/"en". Strip all "(xx)" markers so only
                # real phonemes remain. (This was the 'always voicing hi' bug.)
                ph = _re.sub(r"\((?:en|hi|[a-z]{2,3})\)", " ", ph)
                ph = _re.sub(r"\s+", " ", ph).strip()
                if ph:
                    a = synth_phonemes(pipe, ph, voice, speed)
                    if len(a) / SR >= 0.05:
                        phonemized += 1
            except Exception as e:
                print(f"kokoro_tts: phoneme synth failed on a chunk ({e}); text fallback", file=sys.stderr)
                a = np.zeros(0, dtype=np.float32)
        # Fallback: Kokoro's normal text path (also uses the spoken respelling).
        if len(a) / SR < 0.05:
            a = synth_text(pipe, spoken, voice, speed)
        dur = len(a) / SR
        if dur < 0.02:
            continue  # one bad chunk shouldn't kill the run
        segments.append({"start": round(t, 3), "end": round(t + dur, 3), "text": text})
        audio_parts.append(a)
        # Natural pacing: a LONGER beat after the headline (first chunk) so it lands,
        # then normal sentence gaps. This is the "pause in the right place" fix.
        this_gap = gap * 2.0 if len(segments) == 1 else gap
        audio_parts.append(np.zeros(int(this_gap * SR), dtype=np.float32))
        t += dur + this_gap

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
