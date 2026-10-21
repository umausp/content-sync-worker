"""Kaggle GPU LLM server for news-publish (GitHub -> Kaggle -> GitHub lane).

Started by .github/workflows/news-publish.yml (job llm_up) via `kaggle kernels push`; the workflow injects KEY and MODEL.
It runs one Ollama per GPU (gemma on 2x T4), an authenticated least-busy proxy, and a Cloudflare quick tunnel, prints
`KAGGLE_LLM_ENDPOINT=<url>` for the workflow to read from the live kernel log, then EXITS when idle so GPU hours are only
spent while the pipeline is calling it (Kaggle gives ~30 GPU h/week).
"""
import asyncio, json, os, re, shutil, subprocess, sys, threading, time, urllib.request

KEY = "__KEY__"
RUN = "__RUN__"
MODEL = "__MODEL__"
PARALLEL = "__PARALLEL__"      # concurrent requests per GPU
CTX = "__CTX__"             # per-request context
IDLE_MIN = float(os.environ.get("LLM_IDLE_MIN", "6"))        # exit after this long with no requests
FIRST_IDLE_MIN = float(os.environ.get("LLM_FIRST_IDLE_MIN", "15"))  # grace for the pipeline to start calling
MAX_MIN = float(os.environ.get("LLM_MAX_MIN", "45"))         # hard session cap
T0 = time.time()
ROOT = "/kaggle/working"
state = {"last": None, "inflight": 0, "served": 0, "stop": False}
procs = []


DIAG = open("/kaggle/working/server_diag.log", "a")


def log(*a):
    print(*a, flush=True)
    try:
        print(*a, file=DIAG, flush=True)
    except Exception:
        pass


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def gpu_count():
    out = sh("nvidia-smi -L").stdout
    return max(1, len([l for l in out.splitlines() if l.startswith("GPU")]))


def install_ollama():
    if os.path.exists(f"{ROOT}/ollama/bin/ollama"):
        return
    sh("apt-get -qq install -y zstd >/dev/null 2>&1")
    os.makedirs(f"{ROOT}/ollama", exist_ok=True)
    r = sh(f"curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C {ROOT}/ollama")
    if r.returncode != 0:
        raise SystemExit(f"ollama install failed: {r.stderr[-300:]}")


def start_ollama(n):
    ports = []
    for i in range(n):
        port = 11434 + i
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(i), OLLAMA_HOST=f"127.0.0.1:{port}", OLLAMA_MODELS=f"{ROOT}/models",
                   OLLAMA_NUM_PARALLEL=PARALLEL, OLLAMA_CONTEXT_LENGTH=CTX, OLLAMA_KEEP_ALIVE="-1",
                   OLLAMA_MAX_LOADED_MODELS="1", OLLAMA_FLASH_ATTENTION="1")
        procs.append(subprocess.Popen([f"{ROOT}/ollama/bin/ollama", "serve"], env=env, stdout=open(f"{ROOT}/ollama{i}.log", "w"), stderr=subprocess.STDOUT))
        ports.append(port)
    for port in ports:
        for _ in range(90):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/tags", timeout=2); break
            except Exception:
                time.sleep(1)
    return ports


def pull_and_warm(ports):
    env = dict(os.environ, OLLAMA_HOST=f"127.0.0.1:{ports[0]}", OLLAMA_MODELS=f"{ROOT}/models")
    r = subprocess.run([f"{ROOT}/ollama/bin/ollama", "pull", MODEL], env=env, capture_output=True, text=True)
    log("PULL", MODEL, "rc", r.returncode, (r.stderr or r.stdout)[-120:].replace("\n", " "))
    if r.returncode != 0:
        raise SystemExit("model pull failed")
    for port in ports:
        body = json.dumps({"model": MODEL, "stream": False, "think": False, "messages": [{"role": "user", "content": "Say OK."}], "options": {"num_predict": 4}}).encode()
        t = time.time()
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/chat", body, {"content-type": "application/json"}), timeout=300).read()
        log("WARM port", port, f"{time.time() - t:.1f}s")


def run_proxy(ports):
    from aiohttp import web, ClientSession, ClientTimeout
    inflight = {p: 0 for p in ports}

    async def handle(req):
        if req.headers.get("authorization") != f"Bearer {KEY}":
            return web.Response(status=401, text="unauthorized")
        if req.path == "/__shutdown":
            state["stop"] = True
            return web.json_response({"stopping": True})
        if req.path == "/health":
            return web.json_response({"ok": True, "model": MODEL, "gpus": len(ports), "served": state["served"], "inflight": state["inflight"]})
        if not req.path.startswith("/api/"):
            return web.Response(status=404, text="not found")
        port = min(ports, key=lambda p: inflight[p])
        inflight[port] += 1; state["inflight"] += 1; state["last"] = time.time()
        try:
            body = await req.read()
            async with ClientSession(timeout=ClientTimeout(total=900)) as s:
                async with s.request(req.method, f"http://127.0.0.1:{port}{req.path_qs}", data=body, headers={"content-type": req.headers.get("content-type", "application/json")}) as up:
                    data = await up.read()
                    if up.status != 200:
                        log(f"UPSTREAM_ERROR port={port} status={up.status} body={data[:300]!r}")
                    state["served"] += 1
                    return web.Response(status=up.status, body=data, content_type=up.content_type)
        except Exception as e:
            log(f"PROXY_EXCEPTION port={port} {type(e).__name__}: {e}")
            return web.Response(status=502, text=str(e))
        finally:
            inflight[port] -= 1; state["inflight"] -= 1; state["last"] = time.time()

    async def main():
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.router.add_route("*", "/{tail:.*}", handle)
        runner = web.AppRunner(app); await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 8080).start()
        while True:
            await asyncio.sleep(3600)

    threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
    time.sleep(2)


def start_tunnel():
    cf = f"{ROOT}/cloudflared"
    if not os.path.exists(cf):
        sh(f"curl -fsSL -o {cf} https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x {cf}")
    p = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8080"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    procs.append(p)
    deadline = time.time() + 90
    while time.time() < deadline:
        line = p.stdout.readline()
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line or "")
        if m:
            return m.group(0)
    raise SystemExit("no tunnel url")


def tunnel_ok(url):
    for _ in range(30):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url + "/health", headers={"authorization": f"Bearer {KEY}"}), timeout=10)
            if r.status == 200:
                return True
        except Exception:
            time.sleep(2)
    return False


def main():
    log("KAGGLE_LLM_START", MODEL)
    log(sh("nvidia-smi -L").stdout.strip())
    n = gpu_count()
    install_ollama(); log("OLLAMA_INSTALLED", f"{time.time() - T0:.0f}s")
    ports = start_ollama(n)
    pull_and_warm(ports); log("MODEL_READY", f"{time.time() - T0:.0f}s", "gpus", n)
    run_proxy(ports)
    url = start_tunnel()
    if not tunnel_ok(url):
        raise SystemExit("tunnel health check failed")
    state["last"] = time.time()
    log(f"KAGGLE_LLM_ENDPOINT={url} run={RUN}")
    log("KAGGLE_LLM_READY", f"{time.time() - T0:.0f}s")
    last_beat = 0
    while True:
        time.sleep(5)
        now = time.time()
        idle = now - state["last"]
        grace = FIRST_IDLE_MIN if state["served"] == 0 else IDLE_MIN
        if state["stop"]:
            log("EXIT shutdown requested"); break
        if state["inflight"] == 0 and idle > grace * 60:
            log(f"EXIT idle {idle / 60:.1f}m"); break
        if now - T0 > MAX_MIN * 60:
            log("EXIT max session"); break
        if now - last_beat > 60:
            last_beat = now; log(f"HEARTBEAT served={state['served']} inflight={state['inflight']} up={(now - T0) / 60:.1f}m")
    for p in procs:
        try: p.terminate()
        except Exception: pass
    log(f"KAGGLE_LLM_USAGE minutes={(time.time() - T0) / 60:.1f} served={state['served']}")


main()
