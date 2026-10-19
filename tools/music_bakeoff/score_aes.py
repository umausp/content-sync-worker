"""Score every mp3 in a directory with Meta Audiobox Aesthetics (CE, CU, PC, PQ; 1-10 scale).

Writes <out> (aes.json) = {basename: {CE, CU, PC, PQ}}. Each clip is decoded to 16 kHz mono wav
with ffmpeg and scored in its own forward() call.
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

    # One clip per forward call, decoded to 16 kHz mono wav first. A single batch over all clips
    # was killed by the runner (shutdown signal, exit 143) twice, so keep memory per call small.
    import resource

    scores = {}
    with tempfile.TemporaryDirectory() as td:
        for f in files:
            name = os.path.basename(f)
            wav = os.path.join(td, os.path.splitext(name)[0] + ".wav")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", f,
                            "-ac", "1", "-ar", "16000", wav], check=True)
            rows = _to_rows(pred.forward([{"path": wav}]), 1)
            if name == os.path.basename(files[0]):
                print(f"[aes] first result type {type(rows).__name__}: {rows[0]!r}", flush=True)
            scores[name] = _floats(rows[0])
            os.remove(wav)
            rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
            print(f"[aes] {name} scored; peak_rss_mb={rss_mb:.0f}", flush=True)

    for name in sorted(scores):
        s = scores[name]
        print(f"[aes] {name} CE={s['CE']:.3f} CU={s['CU']:.3f} PC={s['PC']:.3f} PQ={s['PQ']:.3f}", flush=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2)
    print(f"[aes] wrote {args.out} with {len(scores)} clips", flush=True)


if __name__ == "__main__":
    main()
