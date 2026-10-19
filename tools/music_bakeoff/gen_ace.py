"""ACE-Step 1.5 turbo (DiT only, no 5Hz LM) bake-off generator, CPU.

Writes <out>/ace_<mood>.wav and <out>/ace_<mood>.json.
"""
import argparse
import inspect
import json
import os
import resource
import shutil
import subprocess
import sys
import time


def _sig(name, obj):
    try:
        print(f"[bakeoff] signature {name}{inspect.signature(obj)}", flush=True)
    except (TypeError, ValueError) as e:  # pragma: no cover - diagnostics only
        print(f"[bakeoff] signature {name} unavailable: {e}", flush=True)


def _git_head(repo):
    try:
        return subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="ACE-Step-1.5 clone dir (checkpoints in <repo>/checkpoints)")
    ap.add_argument("--mood", required=True)
    ap.add_argument("--prompts", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--seconds", type=float, default=None)
    args = ap.parse_args()

    import torch

    torch.set_num_threads(os.cpu_count() or 1)

    with open(args.prompts, encoding="utf-8") as f:
        prompts = json.load(f)
    if args.mood not in prompts["moods"]:
        sys.exit(f"unknown mood {args.mood!r}; have {sorted(prompts['moods'])}")
    brief = prompts["moods"][args.mood]
    seconds = args.seconds if args.seconds is not None else prompts["seconds"]
    os.makedirs(args.out, exist_ok=True)

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    _sig("AceStepHandler.initialize_service", AceStepHandler.initialize_service)
    _sig("GenerationParams", GenerationParams)
    _sig("GenerationConfig", GenerationConfig)
    _sig("generate_music", generate_music)

    t0 = time.time()
    h = AceStepHandler()
    msg, ok = h.initialize_service(project_root=args.repo, config_path="acestep-v15-turbo", device="cpu")
    load_s = time.time() - t0
    print(f"[bakeoff] initialize_service ok={ok} msg={msg}", flush=True)
    if not ok:
        sys.exit(f"initialize_service failed: {msg}")

    p = GenerationParams(
        caption=brief["caption"],
        lyrics="[Instrumental]",
        instrumental=True,
        bpm=brief["bpm"],
        keyscale=brief["keyscale"],
        timesignature=brief["timesignature"],
        duration=seconds,
        inference_steps=8,
        seed=args.seed,
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_language=False,
    )
    c = GenerationConfig(
        batch_size=1,
        use_random_seed=False,
        seeds=[args.seed],
        audio_format="wav",
    )

    t1 = time.time()
    r = generate_music(h, None, p, c, save_dir=args.out)
    gen_s = time.time() - t1
    if not r.success:
        sys.exit(f"generate_music failed: {r.error}")
    src = r.audios[0]["path"]

    final_wav = os.path.join(args.out, f"ace_{args.mood}.wav")
    if os.path.abspath(src) != os.path.abspath(final_wav):
        shutil.move(src, final_wav)

    rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_rss_mb = rss_kb / 1024.0 if sys.platform != "darwin" else rss_kb / (1024.0 * 1024.0)
    rtf = gen_s / seconds

    meta = {
        "model": "ace",
        "mood": args.mood,
        "seed": args.seed,
        "seconds": seconds,
        "load_s": round(load_s, 2),
        "gen_s": round(gen_s, 2),
        "rtf": round(rtf, 4),
        "peak_rss_mb": round(peak_rss_mb, 1),
        "torch_version": torch.__version__,
        "cpu_count": os.cpu_count(),
        "commit": _git_head(args.repo),
    }
    with open(os.path.join(args.out, f"ace_{args.mood}.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(
        f"[bakeoff] model=ace mood={args.mood} load_s={meta['load_s']} gen_s={meta['gen_s']} rtf={meta['rtf']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
