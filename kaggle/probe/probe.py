import os, subprocess, sys, time
print("PROBE_START", flush=True)
print(subprocess.run("nvidia-smi -L || echo no-gpu; nproc; free -g | head -2; df -h /kaggle/working | tail -1", shell=True, capture_output=True, text=True).stdout, flush=True)
import urllib.request
try:
    print("INTERNET", urllib.request.urlopen("https://ollama.com", timeout=10).status, flush=True)
except Exception as e:
    print("INTERNET_FAIL", e, flush=True)
for i in range(6):
    print("TICK", i, int(time.time()), flush=True)
    time.sleep(10)
print("PROBE_END", flush=True)
