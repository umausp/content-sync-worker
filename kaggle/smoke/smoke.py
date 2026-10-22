"""Simplest Kaggle LLM check: load Gemma with transformers, answer one prompt, write /kaggle/working/result.json."""
import json, os, time, traceback
t0 = time.time()
res = {"steps": []}
def step(msg):
    res["steps"].append(f"{time.time() - t0:.0f}s {msg}"); print(res["steps"][-1], flush=True)
def save():
    json.dump(res, open("/kaggle/working/result.json", "w"), indent=1)
try:
    import torch, kagglehub
    res["gpus"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
    step(f"gpus {res['gpus']}")
    # Kaggle's own model hub needs a license click + interactive attach. Use the ungated Hugging Face mirror of the same
    # Gemma 3 12B weights (4-bit, ~8 GB) instead; the kernel has internet access.
    import subprocess, sys
    try:
        import bitsandbytes  # noqa: F401
    except Exception:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "bitsandbytes", "accelerate"], check=False)
    from huggingface_hub import snapshot_download
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    repo = "__HANDLE__"
    path = snapshot_download(repo, allow_patterns=["*.json", "*.safetensors", "*.model", "tokenizer*"], local_dir="/tmp/gemma")
    res["handle"] = repo; step(f"downloaded {repo}")
    tok = AutoTokenizer.from_pretrained(path)
    kw = dict(device_map={"": 0})  # one model replica on GPU 0 (a second process can use GPU 1)
    if "bnb-4bit" in repo or "4bit" in repo:
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
    else:
        kw["torch_dtype"] = torch.float16
    try:
        model = AutoModelForCausalLM.from_pretrained(path, **kw)
    except Exception as e:
        step(f"CausalLM load failed ({type(e).__name__}: {str(e)[:140]}); trying ImageTextToText")
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(path, **kw)
    step("model loaded")
    tok.padding_side = "left"
    device = next(model.parameters()).device
    res["device_map"] = str(getattr(model, "hf_device_map", None))[:200]
    article = ("The central bank announced on Wednesday that it would cut its benchmark interest rate by 25 basis points to 5.25 percent, citing slowing "
               "growth and easing inflation at 3.1 percent, while warning that energy prices remain volatile. ") * 4
    def prompt(i):
        return tok.apply_chat_template([{"role": "user", "content": f"[{i}] Summarise in German in 3 sentences: {article}"}], add_generation_prompt=True, tokenize=False)
    def run(bs, new):
        enc = tok([prompt(i) for i in range(bs)], return_tensors="pt", padding=True).to(device)
        torch.cuda.synchronize(); t = time.time()
        out = model.generate(**enc, max_new_tokens=new, min_new_tokens=new, do_sample=False)
        torch.cuda.synchronize(); dt = time.time() - t
        n = int((out.shape[1] - enc["input_ids"].shape[1]) * bs)
        return dt, n, tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True), int(enc["input_ids"].shape[1])
    run(1, 8); step("warm-up done")
    res["bench"] = []
    for bs in (1, 4, 8, 16):
        try:
            dt, n, text, plen = run(bs, 128)
            res["bench"].append({"batch": bs, "prompt_tokens": plen, "new_tokens_each": 128, "seconds": round(dt, 1), "agg_tok_s": round(n / dt, 1), "per_req_tok_s": round(128 / dt, 1)})
            if bs == 1: res["answer"] = text
            step(f"batch {bs}: {n / dt:.1f} tok/s aggregate ({128 / dt:.1f} per request) in {dt:.1f}s")
        except Exception as e:
            step(f"batch {bs} failed: {type(e).__name__}: {str(e)[:120]}"); break
except Exception:
    res["error"] = traceback.format_exc()[-1500:]; step("FAILED")
save()
print(json.dumps(res, indent=1), flush=True)
