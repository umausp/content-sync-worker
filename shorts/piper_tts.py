#!/usr/bin/env python3
"""piper_tts.py — Piper (MIT) narration for the NATIVE-language Agyata Shorts channels
that Kokoro cannot speak: German (de), Dutch (nl), Swedish (sv), Norwegian (no),
Danish (da). Kokoro only ships English/Spanish/French/Italian/Hindi/Japanese/… voices,
so these five go through Piper instead.

DROP-IN CONTRACT — identical to kokoro_tts.py so build_short.mjs / word_timing.mjs call
either engine without caring which. Reads a JSON job on argv[1]:
  { "chunks": ["Satz eins…", "Satz zwei…"],
    "lang": "de"|"nl"|"sv"|"no"|"da",   # informational; the voice model fixes the language
    "voice": "de_DE-thorsten-high",      # Piper voice key (locale-name-quality)
    "espeakLang": "de",                  # informational (Piper embeds its own phoneme config)
    "speed": 1.22,                       # SAME meaning as Kokoro: >1 = faster
    "gap": 0.18,                         # inter-sentence breath (seconds)
    "out": "/path/base" }
and writes:
  <out>.wav   — mono narration at the voice's native rate (all chunks concatenated, in order)
  <out>.json  — { "duration": float, "segments": [{start,end,text}, ...] }  # text = REAL words

The caller splits narration into caption-sized chunks (real readable text). We synthesize
each separately, measure its true length, and emit a segment carrying the ORIGINAL text
(for captions) + real start/end (perfectly voice-synced) — exactly like the Kokoro path.

Piper phonemizes with its OWN bundled espeak-ng config baked into each voice model, so —
unlike Kokoro — there's no separate phonemizer step and no English abbreviation/currency
expansion here: espeak-ng reads native numbers, decimals and currency correctly in-language.
We keep only language-SAFE normalization (strip URLs + markup, light brand respelling).

Voices are pulled once from rhasspy/piper-voices (MIT) and cached under PIPER_VOICES_DIR
(default /tmp/piper-voices); CI caches that dir so later runs skip the download.

Deps are numpy + stdlib `wave` only — Piper emits int16 PCM directly, so (unlike the
Kokoro path) there's no soundfile requirement to install on the Piper workflows.
"""
import json
import os
import re
import sys
import wave
from pathlib import Path
from urllib.request import urlopen, Request

import numpy as np

VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR", "/tmp/piper-voices"))
HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Characters that must NEVER be voiced (markup / JSON / markdown leaking into the text).
_TTS_STRIP = re.compile(r"[#*_~`|<>{}\[\]\\^=]+")
_URL_RE = re.compile(r"https?://\S+")
# Brand: espeak reads "agyata.com" as an awkward URL. Respell so every language reads a
# clean word. NO dotted ".com" (espeak spells it out); syllable spacing nudges the vowels.
_BRAND = [
    (re.compile(r"\bagyata\.com\b", re.I), "agyata"),
    (re.compile(r"\bagyata\b", re.I), "ag ya ta"),
]


def spoken_form(text):
    """Language-safe normalization. Deliberately does NOT touch commas/periods between
    digits (European decimal comma: '2,5 Millionen') or expand English abbreviations —
    Piper's in-language espeak-ng reads native numbers/currency correctly on its own."""
    out = str(text or "")
    out = _URL_RE.sub(" ", out)          # don't read raw URLs aloud
    out = _TTS_STRIP.sub(" ", out)        # kill markup/JSON/markdown chars
    for pat, rep in _BRAND:
        out = pat.sub(rep, out)
    out = re.sub(r"\s+([.,!?;:])", r"\1", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out


def voice_rel_path(key):
    """de_DE-thorsten-high -> de/de_DE/thorsten/high/de_DE-thorsten-high.onnx"""
    locale, name, quality = key.split("-", 2)
    lang = locale.split("_")[0]
    return f"{lang}/{locale}/{name}/{quality}/{key}.onnx"


def _download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = Request(url, headers={"User-Agent": "agyata-shorts/1.0"})
    with urlopen(req, timeout=180) as r, open(tmp, "wb") as f:
        while True:
            buf = r.read(1 << 16)
            if not buf:
                break
            f.write(buf)
    tmp.replace(dest)


def ensure_voice(key):
    """Return (onnx_path, config_path), downloading from rhasspy/piper-voices on first use.
    Checks a flat cache (<dir>/<key>.onnx) and the HF mirror layout before fetching."""
    rel = voice_rel_path(key)
    candidates = [
        VOICES_DIR / f"{key}.onnx",              # flat cache (what we write)
        VOICES_DIR / rel,                          # HF mirror layout (pre-seeded voices)
        VOICES_DIR / key.split("_")[0] / f"{key}.onnx",  # <lang>/<key>.onnx (older layout)
    ]
    onnx = next((c for c in candidates if c.exists() and (c.parent / f"{c.name}.json").exists()), None)
    if onnx is None:
        onnx = VOICES_DIR / f"{key}.onnx"
        cfg = VOICES_DIR / f"{key}.onnx.json"
        if not onnx.exists():
            print(f"piper_tts: downloading voice {key}…", file=sys.stderr)
            _download(f"{HF_BASE}/{rel}", onnx)
        if not cfg.exists():
            _download(f"{HF_BASE}/{rel}.json", cfg)
        return onnx, cfg
    return onnx, onnx.parent / f"{onnx.name}.json"


def main() -> int:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    chunks = [c.strip() for c in (job.get("chunks") or []) if c and c.strip()]
    voice = job.get("voice")
    speed = float(job.get("speed", 1.22))
    gap = float(job.get("gap", 0.18))
    out = job["out"]
    if not chunks:
        print("piper_tts: no chunks", file=sys.stderr)
        return 2
    if not voice:
        print("piper_tts: no voice in job", file=sys.stderr)
        return 2

    from piper import PiperVoice, SynthesisConfig

    onnx, cfg = ensure_voice(voice)
    tts = PiperVoice.load(str(onnx), config_path=str(cfg))
    sr = tts.config.sample_rate

    # Kokoro `speed` is a rate MULTIPLIER (>1 = faster); Piper `length_scale` is the inverse
    # (<1 = faster). Convert so the job's `speed` means the same on both engines. Disable
    # Piper's per-chunk normalize_audio (it would jump levels between sentences) and do one
    # global peak-normalize after concatenation, matching kokoro_tts.py.
    syn = SynthesisConfig(length_scale=(1.0 / speed if speed else 1.0), normalize_audio=False)

    # Accumulate as float32 in [-1,1] so we can peak-normalize the whole clip at the end
    # (matches the Kokoro path); Piper hands us int16, so scale by 32768 on the way in.
    audio_parts = []
    segments = []
    t = 0.0
    for text in chunks:
        spoken = spoken_form(text)  # voice-only respelling; caption keeps original `text`
        if not spoken:
            continue
        parts = []
        for ch in tts.synthesize(spoken, syn_config=syn):
            a = np.asarray(ch.audio_int16_array, dtype=np.float32) / 32768.0
            parts.append(a if a.ndim == 1 else a.reshape(-1))
        a = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        dur = len(a) / sr
        if dur < 0.02:
            continue  # one bad chunk shouldn't kill the run
        segments.append({"start": round(t, 3), "end": round(t + dur, 3), "text": text})
        audio_parts.append(a)
        # Natural pacing: a LONGER beat after the headline (first chunk) so it lands, then
        # normal sentence gaps — same shape as the Kokoro path.
        this_gap = gap * 2.0 if len(segments) == 1 else gap
        audio_parts.append(np.zeros(int(this_gap * sr), dtype=np.float32))
        t += dur + this_gap

    if not audio_parts:
        print("piper_tts: produced no audio", file=sys.stderr)
        return 3

    full = np.concatenate(audio_parts)
    peak = float(np.max(np.abs(full))) or 1.0
    full = (full / peak) * (10 ** (-1.5 / 20))  # -1.5 dBFS headroom (matches Kokoro path)
    pcm = np.clip(np.round(full * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(f"{out}.wav", "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    json.dump(
        {"duration": round(len(full) / sr, 3), "segments": segments},
        open(f"{out}.json", "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    print(
        f"piper_tts: {len(segments)} segs, {round(len(full)/sr,2)}s @ {sr}Hz via {voice}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
