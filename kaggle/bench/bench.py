"""One-session throughput + language benchmark for the Kaggle 2x T4 LLM lane (kernel umausp/agyata-llm-bench).

Runs everything ON the Kaggle box (no tunnel), so one GPU session answers all questions:
  A. Ollama gemma3:12b, one server per GPU, OLLAMA_NUM_PARALLEL sweep, synth-sized (8 articles) and small (2 articles) prompts
  B. gemma3:4b on a triage-sized prompt (candidate for triage next to the 12B)
  C. language compliance for non-English editions, with and without a "write in the headline's language" reminder
  D. llama.cpp llama-server (prebuilt CUDA build) with -np slots + continuous batching, and speculative decoding (1B draft)
Writes /kaggle/working/bench.json and prints BENCH lines as it goes.
"""
import glob, json, os, random, subprocess, threading, time, urllib.request

ROOT = "/kaggle/tmp"  # NOT /kaggle/working: Kaggle saves that dir as output at session end (GBs of model files)
OUTDIR = "/kaggle/working"
os.makedirs(ROOT, exist_ok=True)
OUT = {"t0": time.time(), "results": [], "lang": [], "notes": []}
SECTIONS = os.environ.get("BENCH_SECTIONS", "__SECTIONS__")
LLAMA_TAG = "b11818"
procs = []


def log(*a):
    print(*a, flush=True)


def save():
    json.dump(OUT, open(f"{OUTDIR}/bench.json", "w"), indent=1, ensure_ascii=False)


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def post(url, body, timeout=900):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def wait_http(url, n=300):
    for _ in range(n):
        try:
            urllib.request.urlopen(url, timeout=2); return True
        except Exception:
            time.sleep(1)
    return False


# ---------- workloads (varied text per request so no prompt cache can cheat) ----------
CO = ["Siemens", "Toyota", "Infosys", "Unilever", "Petrobras", "Samsung", "Nestle", "Telkom", "Enel", "Turkcell", "BBVA", "Rio Tinto"]
VERB = ["raised its full-year outlook", "cut 1,200 jobs", "agreed to buy a rival", "missed profit forecasts", "won a state contract", "issued a green bond"]
INSTR = ("You are a newsroom editor. For each numbered article write a neutral 2-sentence summary with the key number, "
         "a headline under 12 words, and a category (business, tech or world). Return JSON "
         '{"items":[{"i":n,"headline":"...","summary":"...","category":"..."}]}. Do not invent facts.\n\n')


def article(rng):
    c, v = rng.choice(CO), rng.choice(VERB)
    n1, n2, n3 = rng.randint(2, 98), rng.randint(100, 9000), rng.randint(1, 30)
    s = (f"{c} {v} on {rng.choice(['Monday', 'Tuesday', 'Wednesday', 'Thursday'])}, saying revenue rose {n1} percent to {n2} million "
         f"while costs climbed {n3} percent. The chief executive said demand in Asia and Europe stayed firm, but warned that energy "
         f"prices and currency swings could weigh on margins next year. Analysts at {rng.choice(CO)} had expected {n1 - 1} percent. "
         f"Shares moved {rng.choice(['up', 'down'])} {rng.randint(1, 9)} percent in early trading after the statement. ")
    return s * 3


def synth_prompt(rng, n):
    return INSTR + "\n".join(f"[{i}] {article(rng)}" for i in range(1, n + 1))


def triage_prompt(rng):
    rows = "\n".join(f"{i}. {rng.choice(CO)} {rng.choice(VERB)} ({rng.randint(1, 99)}%)" for i in range(1, 21))
    return ("Score each headline 0-10 for importance to business and tech readers and say keep or drop. Return JSON "
            '{"items":[{"i":n,"score":0,"keep":true}]}.\n' + rows)


# ---------- clients ----------
def ollama_call(port, model, prompt, npredict):
    d = post(f"http://127.0.0.1:{port}/api/chat", {"model": model, "stream": False, "think": False, "format": "json",
             "messages": [{"role": "user", "content": prompt}], "options": {"num_predict": npredict, "temperature": 0.2}})
    return d.get("prompt_eval_count") or 0, d.get("eval_count") or 0


def llama_call(port, model, prompt, npredict):
    d = post(f"http://127.0.0.1:{port}/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": prompt}],
             "max_tokens": npredict, "temperature": 0.2, "response_format": {"type": "json_object"}, "cache_prompt": True})
    u = d.get("usage") or {}
    return u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0


def load(label, fn, ports, model, conc, make_prompt, npredict, articles_per_req):
    """conc requests at once spread round-robin over ports (same as the proxy's least-busy for equal-sized calls)."""
    rng = random.Random(hash(label) & 0xffff)
    prompts = [make_prompt(rng) for _ in range(conc)]
    res = [None] * conc

    def one(i):
        t = time.time()
        try:
            pin, pout = fn(ports[i % len(ports)], model, prompts[i], npredict); res[i] = (time.time() - t, pin, pout, None)
        except Exception as e:  # noqa: BLE001
            res[i] = (time.time() - t, 0, 0, f"{type(e).__name__}: {str(e)[:120]}")
    t0 = time.time(); ths = [threading.Thread(target=one, args=(i,)) for i in range(conc)]
    [t.start() for t in ths]; [t.join() for t in ths]
    wall = time.time() - t0
    ok = [r for r in res if r[3] is None]
    out_tok = sum(r[2] for r in ok)
    row = {"label": label, "conc": conc, "wall_s": round(wall, 1), "ok": len(ok), "out_tok": out_tok,
           "in_tok_avg": round(sum(r[1] for r in ok) / max(1, len(ok))), "agg_tok_s": round(out_tok / wall, 1),
           "articles_per_min": round(len(ok) * articles_per_req * 60 / wall, 1), "lat_max_s": round(max(r[0] for r in res), 1),
           "errors": [r[3] for r in res if r[3]][:3]}
    OUT["results"].append(row); save()
    log("BENCH", json.dumps(row))
    return row


# ---------- language test ----------
LANG_CASES = [
    ("id", "Indonesian", "Bank Indonesia pertahankan suku bunga di 6 persen", "Bank Indonesia memutuskan mempertahankan suku bunga acuan di level 6 persen pada rapat Dewan Gubernur, dengan alasan inflasi terkendali di 2,8 persen dan rupiah yang stabil. Ekonom memperkirakan pemangkasan pada kuartal berikutnya."),
    ("it", "Italian", "Enel alza le stime sull'utile 2026", "Enel ha rivisto al rialzo le previsioni sull'utile netto ordinario per il 2026, a 7,1 miliardi di euro, grazie alla crescita delle rinnovabili in Spagna e America Latina. Il titolo e salito del 3 per cento a Piazza Affari."),
    ("tr", "Turkish", "Merkez Bankasi faizi 250 baz puan indirdi", "Turkiye Cumhuriyet Merkez Bankasi politika faizini 250 baz puan indirerek yuzde 40'a cekti. Banka, enflasyondaki dususun surdugunu ve talep kosullarinin dengelendigini belirtti; lira dolar karsisinda hafif deger kaybetti."),
    ("de", "German", "Siemens Energy hebt Prognose an", "Siemens Energy hat seine Jahresprognose angehoben, nachdem der Auftragseingang im Netzgeschaeft um 30 Prozent gestiegen ist. Die Aktie legte im fruehen Handel um sechs Prozent zu; Analysten sprechen von einer Wende."),
    ("vi", "Vietnamese", "Vietcombank bao lai quy III tang 12%", "Ngan hang Vietcombank cong bo loi nhuan truoc thue quy III tang 12% so voi cung ky, dat 11.000 ty dong, nho tang truong tin dung va chi phi du phong giam. Co phieu VCB tang 2% trong phien sang."),
    ("es", "Spanish", "BBVA gana un 18% mas hasta septiembre", "BBVA obtuvo un beneficio atribuido de 7.600 millones de euros hasta septiembre, un 18% mas, impulsado por Mexico y Turquia. El banco mantiene su objetivo de rentabilidad y anuncia una recompra de acciones."),
]


def lang_prompt(title, text, lang_name, remind):
    p = (f"Write a 3-sentence news summary of this story for a website card and a one-line short summary. Return JSON "
         f'{{"summary":"...","summaryShort":"..."}}.\nHeadline: {title}\nText: {text}\n')
    if remind:
        p = (f"Write ONLY in {lang_name}, the language of the headline. Never answer in English.\n") + p + f"\nReminder: the summary must be in {lang_name}."
    return p


def lang_test(port, model):
    for code, name, title, text in LANG_CASES:
        for remind in (False, True):
            try:
                d = post(f"http://127.0.0.1:{port}/api/chat", {"model": model, "stream": False, "think": False, "format": "json",
                         "messages": [{"role": "user", "content": lang_prompt(title, text, name, remind)}], "options": {"num_predict": 300, "temperature": 0.4}})
                txt = (d.get("message") or {}).get("content", "")
            except Exception as e:  # noqa: BLE001
                txt = f"ERROR {e}"
            OUT["lang"].append({"code": code, "remind": remind, "model": model, "text": txt[:600]}); save()
    log("BENCH lang done", len(OUT["lang"]))


# ---------- Ollama ----------
def install_ollama():
    t = time.time()
    sh("apt-get -qq install -y zstd >/dev/null 2>&1")
    os.makedirs(f"{ROOT}/ollama", exist_ok=True)
    r = sh(f"curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C {ROOT}/ollama")
    OUT["notes"].append(f"ollama install rc={r.returncode} {time.time() - t:.0f}s")


def start_ollama(parallel, ctx):
    stop_all()
    ports = []
    for i in range(2):
        port = 11434 + i
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(i), OLLAMA_HOST=f"127.0.0.1:{port}", OLLAMA_MODELS=f"{ROOT}/models",
                   OLLAMA_NUM_PARALLEL=str(parallel), OLLAMA_CONTEXT_LENGTH=str(ctx), OLLAMA_KEEP_ALIVE="-1", OLLAMA_MAX_LOADED_MODELS="2",
                   OLLAMA_FLASH_ATTENTION="1", OLLAMA_KV_CACHE_TYPE="q8_0")
        procs.append(subprocess.Popen([f"{ROOT}/ollama/bin/ollama", "serve"], env=env, stdout=open(f"{ROOT}/ollama{i}.log", "a"), stderr=subprocess.STDOUT))
        ports.append(port)
    for p in ports:
        wait_http(f"http://127.0.0.1:{p}/api/tags", 90)
    return ports


def warm(ports, model):
    for p in ports:
        t = time.time(); ollama_call(p, model, "Say OK.", 4); OUT["notes"].append(f"warm {model} port {p} {time.time() - t:.1f}s")


def stop_all():
    for p in procs:
        try: p.terminate(); p.wait(20)
        except Exception: pass
    procs.clear(); time.sleep(2)


def section_ollama():
    install_ollama()
    for m in ("gemma3:12b", "gemma3:4b"):
        t = time.time()
        r = sh(f"OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS={ROOT}/models {ROOT}/ollama/bin/ollama pull {m}") if procs else None
        if r is None:
            start_ollama(2, 8192)
            r = sh(f"OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS={ROOT}/models {ROOT}/ollama/bin/ollama pull {m}")
        OUT["notes"].append(f"pull {m} rc={r.returncode} {time.time() - t:.0f}s"); save()
    s8 = lambda r: synth_prompt(r, 8)
    s2 = lambda r: synth_prompt(r, 2)
    for par, concs in ((2, (8,)), (4, (8, 16))):
        ports = start_ollama(par, 8192); warm(ports, "gemma3:12b")
        for c in concs:
            load(f"ollama12b_np{par}_synth8", ollama_call, ports, "gemma3:12b", c, s8, 700, 8)
        load(f"ollama12b_np{par}_synth2", ollama_call, ports, "gemma3:12b", 2 * c, s2, 220, 2)
        log("NVIDIA", sh("nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader").stdout.strip().replace("\n", " | "))
    # leave np4 running for the triage + language checks
    load("ollama12b_np4_triage", ollama_call, ports, "gemma3:12b", 4, triage_prompt, 600, 20)
    warm(ports, "gemma3:4b")
    load("ollama4b_np4_triage", ollama_call, ports, "gemma3:4b", 4, triage_prompt, 600, 20)
    load("ollama4b_np4_synth8", ollama_call, ports, "gemma3:4b", 8, s8, 700, 8)
    lang_test(ports[0], "gemma3:12b")
    stop_all()


# ---------- llama.cpp ----------
def fetch(url, dst):
    t = time.time(); r = sh(f"curl -fsSL -o {dst} '{url}'")
    OUT["notes"].append(f"fetch {os.path.basename(dst)} rc={r.returncode} {time.time() - t:.0f}s {r.stderr[-120:]}"); save()


def start_llama(binary, model, np_, ctx_per_slot, extra=()):
    stop_all()
    ports = []
    for i in range(2):
        port = 8090 + i
        cmd = [binary, "-m", model, "--host", "127.0.0.1", "--port", str(port), "-ngl", "999", "-fa", "on", "-np", str(np_),
               "-c", str(np_ * ctx_per_slot), "-cb", "-ctk", "q8_0", "-ctv", "q8_0", "-b", "2048", "-ub", "512", "--no-webui", *extra]
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(i), LD_LIBRARY_PATH=os.path.dirname(binary) + ":" + os.environ.get("LD_LIBRARY_PATH", ""))
        procs.append(subprocess.Popen(cmd, env=env, stdout=open(f"{ROOT}/llama{i}.log", "a"), stderr=subprocess.STDOUT))
        ports.append(port)
    t = time.time()
    ok = all(wait_http(f"http://127.0.0.1:{p}/health", 400) for p in ports)
    OUT["notes"].append(f"llama-server np={np_} extra={list(extra)} ready={ok} {time.time() - t:.0f}s"); save()
    if not ok:
        OUT["notes"].append(open(f"{ROOT}/llama0.log", errors="replace").read()[-1500:]); save()
    return ports if ok else None


def section_llama():
    d = f"{ROOT}/llama"; os.makedirs(d, exist_ok=True)
    base = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}"
    fetch(f"{base}/llama-{LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", f"{d}/l.tgz")
    fetch(f"{base}/cudart-llama-{LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", f"{d}/c.tgz")
    sh(f"cd {d} && tar xzf l.tgz && tar xzf c.tgz")
    binary = next(iter(glob.glob(f"{d}/**/llama-server", recursive=True)), None)
    if not binary:
        OUT["notes"].append("llama-server binary not found: " + sh(f"ls -R {d} | head -40").stdout); save(); return
    libdir = os.path.dirname(binary)
    for so in glob.glob(f"{d}/**/*.so*", recursive=True):  # cudart libs may unpack elsewhere
        if os.path.dirname(so) != libdir: sh(f"cp -n '{so}' '{libdir}/'")
    hf = "https://huggingface.co/ggml-org"
    m12, m1 = f"{d}/g12.gguf", f"{d}/g1.gguf"
    fetch(f"{hf}/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf", m12)
    fetch(f"{hf}/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf", m1)
    s8 = lambda r: synth_prompt(r, 8)
    s2 = lambda r: synth_prompt(r, 2)
    for np_, concs in ((4, (8,)), (8, (16,))):
        ports = start_llama(binary, m12, np_, 8192)
        if not ports: return
        llama_call(ports[0], "g", "Say OK.", 4); llama_call(ports[1], "g", "Say OK.", 4)
        for c in concs:
            load(f"llama12b_np{np_}_synth8", llama_call, ports, "g", c, s8, 700, 8)
            load(f"llama12b_np{np_}_synth2", llama_call, ports, "g", 2 * c, s2, 220, 2)
        log("NVIDIA", sh("nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader").stdout.strip().replace("\n", " | "))
    # speculative decoding with the 1B draft
    ports = start_llama(binary, m12, 4, 8192, ("-md", m1, "-ngld", "999", "--draft-max", "16", "--draft-min", "4"))
    if ports:
        load("llama12b_spec_np4_synth8_c2", llama_call, ports, "g", 2, s8, 700, 8)
        load("llama12b_spec_np4_synth8_c8", llama_call, ports, "g", 8, s8, 700, 8)
        ports2 = start_llama(binary, m12, 4, 8192)
        if ports2:
            load("llama12b_np4_synth8_c2", llama_call, ports2, "g", 2, s8, 700, 8)
    stop_all()


def main():
    log("BENCH start", SECTIONS, sh("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader").stdout.strip())
    OUT["gpu"] = sh("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader").stdout.strip()
    for name, fn in (("ollama", section_ollama), ("llama", section_llama)):
        if name in SECTIONS:
            t = time.time()
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                OUT["notes"].append(f"section {name} failed: {type(e).__name__}: {e}")
            OUT["notes"].append(f"section {name} {time.time() - t:.0f}s"); save()
    OUT["total_min"] = round((time.time() - OUT["t0"]) / 60, 1); save()
    log("BENCH done", OUT["total_min"], "min")


main()
