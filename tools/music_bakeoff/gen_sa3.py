"""Stable Audio 3 small-music bake-off generator, CPU.

Writes <out>/sa3_<mood>.wav (16-bit, peak-normalised to -1 dBFS) and <out>/sa3_<mood>.json.
"""
import argparse
import inspect
import json
import os
import resource
import sys
import time


def _sig(name, obj):
    try:
        print(f"[bakeoff] signature {name}{inspect.signature(obj)}", flush=True)
    except (TypeError, ValueError) as e:  # pragma: no cover - diagnostics only
        print(f"[bakeoff] signature {name} unavailable: {e}", flush=True)


def _to_channels_first(x):
    import numpy as np

    arr = x.detach().float().cpu().numpy() if hasattr(x, "detach") else np.asarray(x, dtype=np.float32)
    while arr.ndim > 2:
        arr = arr[0]
    if arr.ndim == 1:
        arr = arr[None, :]
    # Channels first with <= 2 channels: if the layout looks time-first, transpose.
    if arr.shape[0] > 2 and arr.shape[1] <= 2:
        arr = arr.T
    return arr.astype("float32")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mood", required=True)
    ap.add_argument("--prompts", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--seconds", type=float, default=None)
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    import torch

    torch.set_num_threads(os.cpu_count() or 1)

    with open(args.prompts, encoding="utf-8") as f:
        prompts = json.load(f)
    if args.mood not in prompts["moods"]:
        sys.exit(f"unknown mood {args.mood!r}; have {sorted(prompts['moods'])}")
    brief = prompts["moods"][args.mood]
    seconds = args.seconds if args.seconds is not None else prompts["seconds"]
    if seconds > 120:
        sys.exit(f"stable audio 3 max duration is 120 s, got {seconds}")
    os.makedirs(args.out, exist_ok=True)

    from stable_audio_3 import StableAudioModel

    _sig("StableAudioModel.from_pretrained", StableAudioModel.from_pretrained)
    _sig("StableAudioModel.generate", StableAudioModel.generate)

    load_params = inspect.signature(StableAudioModel.from_pretrained).parameters
    load_kw = {}
    if "device" in load_params:
        load_kw["device"] = "cpu"

    t0 = time.time()
    m = StableAudioModel.from_pretrained("small-music", **load_kw)
    load_s = time.time() - t0

    gen_params = inspect.signature(m.generate).parameters
    prompt = f"{brief['caption']}, {brief['bpm']} BPM"
    gen_kw = {"prompt": prompt, "duration": seconds}
    if "seed" in gen_params:
        gen_kw["seed"] = args.seed
    else:
        print("[bakeoff] WARNING: generate() takes no seed argument; this run is not seeded", flush=True)
    print(f"[bakeoff] generate kwargs keys={sorted(gen_kw)}", flush=True)

    t1 = time.time()
    out = m.generate(**gen_kw)
    gen_s = time.time() - t1

    if isinstance(out, tuple):
        audio_raw, sr = out[0], out[1]
    else:
        audio_raw = out
        # generate() itself reads self.model.sample_rate (stable_audio_3/model.py), so that is
        # the authoritative value; model_config["sample_rate"] is the JSON fallback.
        inner = getattr(getattr(m, "model", None), "sample_rate", None)
        cfg_sr = (getattr(m, "model_config", None) or {}).get("sample_rate")
        print(f"[bakeoff] sample_rate: m.model.sample_rate={inner} model_config['sample_rate']={cfg_sr}", flush=True)
        sr = inner if inner is not None else cfg_sr
        if sr is None:
            print("[bakeoff] WARNING: no sample rate attribute found; falling back to 44100", flush=True)
            sr = 44100
    sr = int(sr)
    print(f"[bakeoff] output type={type(out).__name__} sr={sr}", flush=True)

    audio = _to_channels_first(audio_raw)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 0.0:
        sys.exit("generated audio is silent")
    target = 10 ** (-1.0 / 20.0)  # -1 dBFS
    audio = audio * (target / peak)
    audio = np.clip(audio, -1.0, 1.0)

    final_wav = os.path.join(args.out, f"sa3_{args.mood}.wav")
    sf.write(final_wav, audio.T, sr, subtype="PCM_16")

    rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_rss_mb = rss_kb / 1024.0 if sys.platform != "darwin" else rss_kb / (1024.0 * 1024.0)
    rtf = gen_s / seconds

    meta = {
        "model": "sa3",
        "mood": args.mood,
        "seed": args.seed,
        "seconds": seconds,
        "load_s": round(load_s, 2),
        "gen_s": round(gen_s, 2),
        "rtf": round(rtf, 4),
        "peak_rss_mb": round(peak_rss_mb, 1),
        "torch_version": torch.__version__,
        "cpu_count": os.cpu_count(),
        "commit": os.environ.get("UPSTREAM_COMMIT", "unknown"),
        "sample_rate": sr,
    }
    with open(os.path.join(args.out, f"sa3_{args.mood}.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(
        f"[bakeoff] model=sa3 mood={args.mood} load_s={meta['load_s']} gen_s={meta['gen_s']} rtf={meta['rtf']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
