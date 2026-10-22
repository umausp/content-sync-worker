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
    handles = ["__HANDLE__", "google/gemma-3/transformers/gemma-3-12b-it"]
    path = None
    for h in handles:
        try:
            path = kagglehub.model_download(h); res["handle"] = h; step(f"downloaded {h} -> {path}"); break
        except Exception as e:
            step(f"handle {h} failed: {type(e).__name__}: {str(e)[:160]}")
    if not path:
        raise RuntimeError("no model handle worked")
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tok = AutoTokenizer.from_pretrained(path)
    try:
        model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.float16, device_map="auto")
    except Exception as e:
        step(f"CausalLM load failed ({type(e).__name__}: {str(e)[:120]}); trying ImageTextToText")
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(path, torch_dtype=torch.float16, device_map="auto")
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
