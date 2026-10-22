#!/usr/bin/env bash
# Start the Kaggle GPU LLM server (Ollama) and wait for its endpoint.
# Env: KAGGLE_API_TOKEN, KAGGLE_MODEL, KAGGLE_MIN_REMAINING_H, KAGGLE_PARALLEL, KAGGLE_CTX, GITHUB_RUN_ID, GITHUB_OUTPUT, RUNNER_TEMP.
# Writes url=<endpoint> to $GITHUB_OUTPUT. Fails the job (exit 1) on any problem: there is no silent fallback on this lane.
# The server announces its tunnel URL two ways: a ntfy.sh topic derived from the per-run key (primary; independent of Kaggle's
# log API, which returns 500 at times) and its kernel log (secondary). Every call to the server needs the per-run bearer key.
set -uo pipefail
echo "url=" >> "$GITHUB_OUTPUT"

REMAIN=$(kaggle quota --format json | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(float(x['remaining'].rstrip('h')) for x in d if x['resource']=='GPU'))") || REMAIN=0
echo "Kaggle GPU quota remaining: ${REMAIN}h"
python3 -c "import sys;sys.exit(0 if float('$REMAIN')>=float('$KAGGLE_MIN_REMAINING_H') else 1)" || { echo "::error::Kaggle GPU quota low (${REMAIN}h)"; exit 1; }

KEY=$(printf '%s:%s' "$KAGGLE_API_TOKEN" "$GITHUB_RUN_ID" | sha256sum | cut -c1-40)
echo "::add-mask::$KEY"
TOPIC="agyata-$(printf '%s' "$KEY" | sha256sum | cut -c1-24)"   # unguessable without the key; the URL alone is useless without the key
echo "::add-mask::$TOPIC"
KUSER=$(kaggle config view | sed -n 's/^- username: //p')
SLUG="$KUSER/agyata-llm-server"
WORK="$RUNNER_TEMP/kllm"; mkdir -p "$WORK"

sed -e "s|__KEY__|$KEY|" -e "s|__TOPIC__|$TOPIC|" -e "s|__MODEL__|$KAGGLE_MODEL|" -e "s|__RUN__|$GITHUB_RUN_ID|" \
    -e "s|__PARALLEL__|${KAGGLE_PARALLEL:-2}|" -e "s|__CTX__|${KAGGLE_CTX:-8192}|" kaggle/llm_server/server.py > "$WORK/server.py"
cat > "$WORK/kernel-metadata.json" <<JSON
{"id":"$SLUG","title":"agyata-llm-server","code_file":"server.py","language":"python","kernel_type":"script","is_private":true,"enable_gpu":true,"enable_internet":true,"dataset_sources":[],"competition_sources":[],"kernel_sources":[]}
JSON

if ! kaggle kernels push -p "$WORK" -t 3300 --accelerator NvidiaTeslaT4 2>"$WORK/push.err"; then
  echo "push with --accelerator NvidiaTeslaT4 failed: $(tail -c 400 "$WORK/push.err")"
  kaggle kernels push -p "$WORK" -t 3300 || { echo "::error::Kaggle push failed"; exit 1; }
fi

# Secondary channel: Kaggle's live log. Re-attach when its stream errors; harmless if it never works.
( while true; do kaggle kernels logs -f "$SLUG" >> "$WORK/log.txt" 2>&1; sleep 5; done ) &
FOLLOWER=$!
trap 'kill $FOLLOWER 2>/dev/null' EXIT

endpoint_from_ntfy() {
  curl -fsS -m 15 "https://ntfy.sh/$TOPIC/json?poll=1&since=all" 2>/dev/null | RUN="$GITHUB_RUN_ID" python3 -c '
import json, os, sys
run = "run=" + os.environ["RUN"]
last = ""
for line in sys.stdin:
    try: m = json.loads(line).get("message", "")
    except Exception: continue
    if run in m and m.startswith("https://"): last = m.split()[0]
print(last)'
}
endpoint_from_log() {
  grep -a "KAGGLE_LLM_ENDPOINT=.* run=$GITHUB_RUN_ID" "$WORK/log.txt" 2>/dev/null | tail -1 | sed -n 's/.*KAGGLE_LLM_ENDPOINT=\([^ ]*\) .*/\1/p'
}

QUEUED_S=0
for i in $(seq 1 90); do
  if [ $((i % 3)) -eq 1 ]; then
    STATE=$(kaggle kernels status "$SLUG" 2>/dev/null | sed -n 's/.*KernelWorkerStatus\.\([A-Z_]*\).*/\1/p')
    echo "[$(date -u +%H:%M:%S)] kaggle kernel state: ${STATE:-unknown}"
    if [ "$STATE" = "QUEUED" ]; then QUEUED_S=$((QUEUED_S + 30)); else QUEUED_S=0; fi
    if [ "$STATE" = "ERROR" ] || [ "$STATE" = "CANCEL_ACKNOWLEDGED" ]; then echo "::error::Kaggle kernel ended in state $STATE"; tail -n 40 "$WORK/log.txt" | cut -c1-200; exit 1; fi
    if [ "$QUEUED_S" -ge 600 ]; then echo "::error::Kaggle kept the kernel QUEUED for 10+ minutes (no GPU session started). Check https://www.kaggle.com/code/$SLUG and stop stale versions."; exit 1; fi
  fi
  URL=$(endpoint_from_ntfy); [ -z "$URL" ] && URL=$(endpoint_from_log)
  if [ -n "$URL" ]; then
    if curl -fsS -m 25 -H "Authorization: Bearer $KEY" "$URL/health" >/dev/null; then
      echo "Kaggle LLM ready: $URL"; echo "url=$URL" >> "$GITHUB_OUTPUT"; exit 0
    fi
    echo "endpoint announced ($URL) but /health not reachable yet"
  fi
  if grep -aq "KAGGLE_LLM_FAILED" "$WORK/log.txt" 2>/dev/null; then echo "::error::Kaggle server reported a startup failure"; grep -a -A12 "KAGGLE_LLM_FAILED" "$WORK/log.txt" | cut -c1-220; exit 1; fi
  sleep 10
done
echo "::error::Kaggle LLM did not become ready within 15 minutes"; tail -n 60 "$WORK/log.txt" | cut -c1-200
exit 1
