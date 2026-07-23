#!/usr/bin/env python3
"""align_audio.py — turn an EXTERNAL narration audio file into the SAME timing contract
kokoro_tts.py emits, so the karaoke-caption + image-sync render path is identical whether
the audio came from Kokoro (World channel) or was SUPPLIED by the user (Hindi channel).

Reads a JSON job on argv[1]:
  { "audio": "/path/narration.(wav|mp3|m4a)",   # the supplied narration
    "text":  "पूरा हिंदी स्क्रिप्ट...",           # OPTIONAL caption text (used verbatim on
                                                  # screen; whisper Hindi text can be rough)
    "lang":  "hi"|"en"|null,                      # language hint (null → autodetect)
    "out":   "/path/base" }
and writes (identical shape to kokoro_tts.py so the render layer needs no changes):
  <out>.json  — { "duration": float, "segments": [{start,end,text}, ...] }
  <out>.wav   — the audio re-encoded to a clean 48k stereo WAV (so ffmpeg is happy)

HOW:
  faster-whisper (CTranslate2, CPU-friendly, no GPU) transcribes with word_timestamps so we
  get real word boundaries → grouped into caption-sized sentence segments carrying real
  [start,end]. When the user SUPPLIES text, we keep whisper's TIMELINE but replace the words
  with the supplied text, distributing the supplied sentences across the timeline by their
  proportion of the audio (so captions read the user's exact Hindi, timed to the speech).

Fail-safe: if faster-whisper is unavailable OR transcription fails, we fall back to a
DURATION-ONLY plan — split the supplied text into sentences and weight each by syllable/char
length across the measured audio duration (same idea as word_timing.mjs, one level up). Less
precise than real alignment, but never blocks a render and still tracks the narration.
"""
import json
import subprocess
import sys


def _ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except (TypeError, ValueError):
        return 0.0


def _to_wav(src, dst):
    """Re-encode any input audio to 48k stereo WAV so the render's ffmpeg graph is happy."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-ar", "48000", "-ac", "2", dst],
        check=True,
    )


def _split_sentences(text, lang):
    """Split into caption-sized sentences. Devanagari uses the danda '।' plus ./!/?."""
    import re
    parts = re.split(r"(?<=[।.!?])\s+", str(text or "").strip())
    return [p.strip() for p in parts if p.strip()]


def _syllable_weight(token, lang):
    """Rough spoken-length proxy so a longer sentence holds the screen longer."""
    import re
    if lang == "hi":
        # Devanagari vowel signs + independent vowels ≈ syllable nuclei.
        n = len(re.findall(r"[अ-औा-ौंः]", token))
        return max(1, n) + len(token) * 0.05
    groups = re.findall(r"[aeiouy]+", token.lower())
    return max(1, len(groups)) + len(re.sub(r"[^a-z0-9]", "", token.lower())) * 0.08


def _duration_only_plan(text, lang, duration):
    """No aligner → distribute the supplied text's sentences across [0,duration] by weight."""
    sents = _split_sentences(text, lang)
    if not sents:
        return [{"start": 0.0, "end": round(duration, 3), "text": str(text or "").strip() or " "}]
    weights = [sum(_syllable_weight(w, lang) for w in s.split()) or 1 for s in sents]
    total = sum(weights) or 1
    segs = []
    t = 0.0
    for i, s in enumerate(sents):
        d = duration * weights[i] / total
        end = duration if i == len(sents) - 1 else t + d
        segs.append({"start": round(t, 3), "end": round(end, 3), "text": s})
        t = end
    return segs


def _group_words(words, max_words=8, max_gap=0.7):
    """Group whisper word objects into caption-sized sentence segments. Breaks on terminal
    punctuation, on a long silence gap, or at max_words. Each segment carries real times."""
    segs = []
    cur = []
    cur_start = None
    for w in words:
        if cur_start is None:
            cur_start = w["start"]
        if cur and (w["start"] - cur[-1]["end"]) > max_gap:
            segs.append((cur_start, cur[-1]["end"], " ".join(x["word"] for x in cur).strip()))
            cur, cur_start = [], w["start"]
        cur.append(w)
        ends_sentence = any(w["word"].rstrip().endswith(p) for p in ("।", ".", "!", "?"))
        if ends_sentence or len(cur) >= max_words:
            segs.append((cur_start, w["end"], " ".join(x["word"] for x in cur).strip()))
            cur, cur_start = [], None
    if cur:
        segs.append((cur_start, cur[-1]["end"], " ".join(x["word"] for x in cur).strip()))
    return [{"start": round(s, 3), "end": round(e, 3), "text": t} for s, e, t in segs if t]


def _overlay_supplied_text(segs, text, lang):
    """Keep whisper's TIMELINE but show the user's exact text. Distribute the supplied
    sentences across the aligned segments proportionally to the segments' durations so the
    user's Hindi reads on screen, timed to the actual speech."""
    sents = _split_sentences(text, lang)
    if not sents or not segs:
        return segs
    total = segs[-1]["end"] - segs[0]["start"]
    if total <= 0:
        return segs
    # Map each supplied sentence to a time window sized by its spoken weight.
    weights = [sum(_syllable_weight(w, lang) for w in s.split()) or 1 for s in sents]
    wsum = sum(weights) or 1
    out = []
    t = segs[0]["start"]
    for i, s in enumerate(sents):
        d = total * weights[i] / wsum
        end = segs[-1]["end"] if i == len(sents) - 1 else t + d
        out.append({"start": round(t, 3), "end": round(end, 3), "text": s})
        t = end
    return out


def main() -> int:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    audio = job["audio"]
    text = job.get("text") or ""
    lang = job.get("lang")  # None → autodetect
    out = job["out"]

    # Always produce a clean WAV the render can mux.
    wav = f"{out}.wav"
    try:
        _to_wav(audio, wav)
    except Exception as e:
        print(f"align_audio: could not re-encode audio ({e})", file=sys.stderr)
        return 2
    duration = _ffprobe_duration(wav)
    if duration <= 0:
        print("align_audio: audio has zero duration", file=sys.stderr)
        return 3

    segs = None
    try:
        from faster_whisper import WhisperModel

        # tiny/base are the CPU-friendly sizes; base is more accurate for Hindi. int8 keeps
        # it fast + low-mem on the free CI runner. Model is cached after first download.
        import os
        size = os.environ.get("ALIGN_WHISPER_MODEL", "base")
        model = WhisperModel(size, device="cpu", compute_type="int8")
        seg_iter, info = model.transcribe(
            wav, language=lang, word_timestamps=True, vad_filter=True,
        )
        words = []
        for s in seg_iter:
            for w in (s.words or []):
                words.append({"start": float(w.start), "end": float(w.end), "word": w.word})
        if words:
            segs = _group_words(words)
            detected = lang or getattr(info, "language", None) or "en"
            if text.strip():
                segs = _overlay_supplied_text(segs, text, "hi" if detected == "hi" else detected)
            print(f"align_audio: whisper({size}) aligned {len(words)} words → {len(segs)} segments "
                  f"(lang={detected})", file=sys.stderr)
    except Exception as e:
        print(f"align_audio: faster-whisper unavailable/failed ({e}); duration-only plan", file=sys.stderr)

    if not segs:
        if not text.strip():
            print("align_audio: no aligner and no supplied text — cannot caption", file=sys.stderr)
            return 4
        segs = _duration_only_plan(text, "hi" if lang == "hi" else (lang or "en"), duration)
        print(f"align_audio: duration-only plan → {len(segs)} segments", file=sys.stderr)

    json.dump(
        {"duration": round(duration, 3), "segments": segs},
        open(f"{out}.json", "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
