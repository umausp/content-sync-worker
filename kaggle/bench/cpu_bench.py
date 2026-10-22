"""Kaggle CPU-only (no GPU quota) timing of the news LLM calls: one real summary prompt and one VLM image prompt,
cold and warm, think=false, for several Gemma tags. Answers "can an always-on warm CPU session serve the pipeline?".
Results: /kaggle/working/cpu_bench.json and CPU_BENCH log lines. Big files live in /tmp (not saved as output).
"""
import base64, json, os, subprocess, threading, time, urllib.request

INPUTS = json.loads(r'''__INPUTS__''')
MODELS = "__MODELS__".split(",")
ROOT = "/tmp/agyata"; os.makedirs(ROOT, exist_ok=True)
OUT = {"cpu": "", "runs": [], "notes": []}


def log(*a):
    print("CPU_BENCH", *a, flush=True)


def save():
    json.dump(OUT, open("/kaggle/working/cpu_bench.json", "w"), indent=1, ensure_ascii=False)


def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True)


def chat(model, content, images=None, npredict=400):
    msg = {"role": "user", "content": content}
    if images: msg["images"] = images
    body = {"model": model, "stream": False, "think": False, "format": "json", "messages": [msg], "options": {"num_predict": npredict, "temperature": 0.2}}
    t = time.time()
    d = json.loads(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/api/chat", json.dumps(body).encode(), {"content-type": "application/json"}), timeout=1800).read())
    ns = 1e9
    return {"wall_s": round(time.time() - t, 1), "load_s": round(d.get("load_duration", 0) / ns, 1), "prompt_tok": d.get("prompt_eval_count"),
            "prefill_tok_s": round(d.get("prompt_eval_count", 0) / max(1e-9, d.get("prompt_eval_duration", 1) / ns), 1),
            "out_tok": d.get("eval_count"), "decode_tok_s": round(d.get("eval_count", 0) / max(1e-9, d.get("eval_duration", 1) / ns), 1),
            "text": (d.get("message") or {}).get("content", "")[:300]}


def main():
    OUT["cpu"] = sh("nproc; free -g | head -2; lscpu | grep 'Model name'").stdout.strip(); log(OUT["cpu"].replace("\n", " | "))
    t = time.time(); sh("apt-get -qq install -y zstd >/dev/null 2>&1")
    os.makedirs(f"{ROOT}/ollama", exist_ok=True)
    sh(f"curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C {ROOT}/ollama")
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_MODELS=f"{ROOT}/models", OLLAMA_KEEP_ALIVE="-1", OLLAMA_NUM_PARALLEL="2",
               OLLAMA_CONTEXT_LENGTH="4096", OLLAMA_MAX_LOADED_MODELS="1")
    subprocess.Popen([f"{ROOT}/ollama/bin/ollama", "serve"], env=env, stdout=open(f"{ROOT}/ollama.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(5); OUT["notes"].append(f"install {time.time() - t:.0f}s")
    try:
        req = urllib.request.Request(INPUTS["image"], headers={"User-Agent": "agyata-bench/1.0 (https://agyata.com)"})
        img = base64.b64encode(urllib.request.urlopen(req, timeout=30).read()).decode()
    except Exception as e:  # noqa: BLE001
        img = None; OUT["notes"].append(f"image fetch failed {e}")
    vlm_q = f'Does this photo depict the news story "{INPUTS["title"]}"? Return JSON {{"tier":"EXACT|CONTEXTUAL|GENERIC|WRONG","depicts":"..."}}'
    for m in MODELS:
        t = time.time(); r = sh(f"OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS={ROOT}/models {ROOT}/ollama/bin/ollama pull {m}")
        OUT["notes"].append(f"pull {m} rc={r.returncode} {time.time() - t:.0f}s"); save()
        if r.returncode != 0: continue
        for label, fn in (("summary_cold", lambda: chat(m, INPUTS["prompt"])), ("summary_warm", lambda: chat(m, INPUTS["prompt"])),
                          ("vlm_warm", lambda: chat(m, vlm_q, [img], 120) if img else None)):
            try:
                res = fn()
            except Exception as e:  # noqa: BLE001
                res = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
            if res is None: continue
            row = {"model": m, "label": label, **res}; OUT["runs"].append(row); save()
            log(json.dumps({k: v for k, v in row.items() if k != "text"}))
        # two summaries at once: does a 4-core CPU gain anything from parallel requests?
        res2 = [None, None]
        def one(i): res2[i] = chat(m, INPUTS["prompt"])
        t = time.time(); ths = [threading.Thread(target=one, args=(i,)) for i in range(2)]; [x.start() for x in ths]; [x.join() for x in ths]
        row = {"model": m, "label": "summary_x2_parallel", "wall_s": round(time.time() - t, 1), "out_tok": sum((x or {}).get("out_tok") or 0 for x in res2)}
        OUT["runs"].append(row); save(); log(json.dumps(row))
        sh(f"OLLAMA_HOST=127.0.0.1:11434 {ROOT}/ollama/bin/ollama stop {m}")
    log("done")


main()
