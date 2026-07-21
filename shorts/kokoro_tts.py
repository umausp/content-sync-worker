#!/usr/bin/env python3
"""kokoro_tts.py — Kokoro (Apache-2.0, commercial-safe) narration for Agyata Shorts.

Reads a JSON job on argv[1]:
  { "chunks": ["Breaking news.", "India and the US signed a deal.", ...],
    "lang": "a"|"h", "voice": "af_heart", "out": "/path/base" }
and writes:
  <out>.wav     — 24 kHz mono narration (all chunks concatenated, in order)
  <out>.json    — { "duration": float,
                    "segments": [{ "start", "end", "text" }, ...] }   # text = REAL words

Design: the CALLER splits the narration into caption-sized chunks (real, human-readable
text). We synthesize EACH chunk separately, measure its exact audio length, and emit a
segment carrying the caller's original text + true start/end. This gives readable,
sentence/phrase-level caption timing that stays perfectly in sync with the voice —
Kokoro's own per-chunk output is phonemes (IPA), useless as caption text, so we never
rely on it for the words, only for the audio + duration.

EN = lang 'a' (voice af_heart), Hindi/Hinglish = lang 'h' (voice hf_alpha).
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 24000


def synth_chunk(pipe, text, voice):
    """Return the concatenated float32 audio for one caption chunk."""
    parts = []
    for _gs, _ps, audio in pipe(text, voice=voice):
        a = np.asarray(audio, dtype=np.float32)
        if a.ndim > 1:
            a = a.reshape(-1)
        parts.append(a)
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts)


def main() -> int:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    chunks = [c.strip() for c in (job.get("chunks") or []) if c and c.strip()]
    lang = job.get("lang") or "a"
    voice = job.get("voice") or ("hf_alpha" if lang == "h" else "af_heart")
    out = job["out"]
    # A short silent gap between caption chunks — natural pacing + clean caption swaps.
    gap = float(job.get("gap", 0.18))
    if not chunks:
        print("kokoro_tts: no chunks", file=sys.stderr)
        return 2

    import warnings

    warnings.filterwarnings("ignore")
    from kokoro import KPipeline

    pipe = KPipeline(lang_code=lang)
    gap_samples = np.zeros(int(gap * SR), dtype=np.float32)

    audio_parts = []
    segments = []
    t = 0.0
    for text in chunks:
        a = synth_chunk(pipe, text, voice)
        dur = len(a) / SR
        if dur < 0.02:
            # Kokoro produced nothing usable for this chunk — skip rather than emit a
            # zero-length caption, but keep going (one bad chunk shouldn't kill the run).
            continue
        segments.append({"start": round(t, 3), "end": round(t + dur, 3), "text": text})
        audio_parts.append(a)
        audio_parts.append(gap_samples)
        t += dur + gap

    if not audio_parts:
        print("kokoro_tts: produced no audio", file=sys.stderr)
        return 3

    full = np.concatenate(audio_parts)
    # Peak-normalize to -1.5 dBFS headroom (final loudness normalization is done in ffmpeg).
    peak = float(np.max(np.abs(full))) or 1.0
    full = (full / peak) * (10 ** (-1.5 / 20))
    sf.write(f"{out}.wav", full, SR)

    json.dump(
        {"duration": round(len(full) / SR, 3), "segments": segments},
        open(f"{out}.json", "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    print(f"kokoro_tts: {len(segments)} segments, {round(len(full)/SR,2)}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
