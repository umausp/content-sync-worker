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
    kw = dict(device_map="auto")
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
    msgs = [{"role": "user", "content": "Fasse in einem deutschen Satz zusammen: Die Zentralbank senkte den Leitzins um 25 Basispunkte auf 5,25 Prozent."}]
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True).to(model.device)
    t1 = time.time()
    out = model.generate(**enc, max_new_tokens=80, do_sample=False)
    gen = out[0][enc["input_ids"].shape[1]:]
    res["answer"] = tok.decode(gen, skip_special_tokens=True)
    res["new_tokens"] = int(gen.shape[0]); res["tok_per_s"] = round(res["new_tokens"] / (time.time() - t1), 1)
    step(f"answer ok ({res['new_tokens']} tokens, {res['tok_per_s']} tok/s)")
except Exception:
    res["error"] = traceback.format_exc()[-1500:]; step("FAILED")
save()
print(json.dumps(res, indent=1), flush=True)
