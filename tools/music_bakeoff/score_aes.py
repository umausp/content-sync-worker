"""Score every mp3 in a directory with Meta Audiobox Aesthetics (CE, CU, PC, PQ; 1-10 scale).

Writes <out> (aes.json) = {basename: {CE, CU, PC, PQ}}. Batch scoring first; if the batch call
raises, each file is decoded to 16 kHz mono wav with ffmpeg and scored on its own.
"""
import argparse
import glob
import inspect
import json
import os
import subprocess
import sys
import tempfile


def _floats(d):
    return {k: float(d[k]) for k in ("CE", "CU", "PC", "PQ")}


def _to_rows(res, n):
    """Normalise the forward() return value to a list of n dicts with CE/CU/PC/PQ."""
    if isinstance(res, dict):
        res = [res]
    rows = list(res)
    if len(rows) != n:
        sys.exit(f"forward returned {len(rows)} rows for {n} inputs")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.clips, "*.mp3")))
    if not files:
        sys.exit(f"no mp3 files in {args.clips}")

    from audiobox_aesthetics.infer import initialize_predictor

    pred = initialize_predictor()
    print(f"[aes] signature forward{inspect.signature(pred.forward)}", flush=True)

    scores = {}
    try:
        rows = _to_rows(pred.forward([{"path": os.path.abspath(f)} for f in files]), len(files))
        print(f"[aes] batch forward ok; return type {type(rows).__name__}, first item {rows[0]!r}", flush=True)
        for f, r in zip(files, rows):
            scores[os.path.basename(f)] = _floats(r)
    except Exception as e:  # decode or batch failure: fall back to per-file 16 kHz wav
        print(f"[aes] batch forward failed ({type(e).__name__}: {e}); per-file 16 kHz wav fallback", flush=True)
        scores = {}
        with tempfile.TemporaryDirectory() as td:
            for f in files:
                wav = os.path.join(td, os.path.splitext(os.path.basename(f))[0] + ".wav")
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", f,
                                "-ac", "1", "-ar", "16000", wav], check=True)
                rows = _to_rows(pred.forward([{"path": wav}]), 1)
                scores[os.path.basename(f)] = _floats(rows[0])

    for name in sorted(scores):
        s = scores[name]
        print(f"[aes] {name} CE={s['CE']:.3f} CU={s['CU']:.3f} PC={s['PC']:.3f} PQ={s['PQ']:.3f}", flush=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2)
    print(f"[aes] wrote {args.out} with {len(scores)} clips", flush=True)


if __name__ == "__main__":
    main()
