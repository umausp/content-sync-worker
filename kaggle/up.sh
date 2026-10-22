#!/usr/bin/env bash
# Start the Kaggle GPU LLM server and wait for its endpoint. Env: KAGGLE_API_TOKEN, KAGGLE_MODEL, KAGGLE_MIN_REMAINING_H,
# GITHUB_RUN_ID, GITHUB_OUTPUT, RUNNER_TEMP. Writes url=<endpoint> (or empty) to $GITHUB_OUTPUT; never fails the job.
set -uo pipefail
echo "url=" >> "$GITHUB_OUTPUT"
REMAIN=$(kaggle quota --format json | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(float(x['remaining'].rstrip('h')) for x in d if x['resource']=='GPU'))") || REMAIN=0
echo "Kaggle GPU quota remaining: ${REMAIN}h"
python3 -c "import sys;sys.exit(0 if float('$REMAIN')>=float('$KAGGLE_MIN_REMAINING_H') else 1)" || { echo "::error::Kaggle GPU quota low (${REMAIN}h)"; exit 1; }
KEY=$(printf '%s:%s' "$KAGGLE_API_TOKEN" "$GITHUB_RUN_ID" | sha256sum | cut -c1-40)
echo "::add-mask::$KEY"
KUSER=$(kaggle config view | sed -n 's/^- username: //p')
WORK="$RUNNER_TEMP/kllm"; mkdir -p "$WORK"
sed -e "s|__KEY__|$KEY|" -e "s|__MODEL__|$KAGGLE_MODEL|" -e "s|__RUN__|$GITHUB_RUN_ID|" -e "s|__PARALLEL__|${KAGGLE_PARALLEL:-2}|" -e "s|__CTX__|${KAGGLE_CTX:-8192}|" kaggle/llm_server/server.py > "$WORK/server.py"
cat > "$WORK/kernel-metadata.json" <<JSON
{"id":"$KUSER/agyata-llm-server","title":"agyata-llm-server","code_file":"server.py","language":"python","kernel_type":"script","is_private":true,"enable_gpu":true,"enable_internet":true,"dataset_sources":[],"competition_sources":[],"kernel_sources":[]}
JSON
if ! kaggle kernels push -p "$WORK" -t 3300 --accelerator NvidiaTeslaT4 2>"$WORK/push.err"; then
  echo "push with --accelerator NvidiaTeslaT4 failed: $(tail -c 400 "$WORK/push.err")"
  kaggle kernels push -p "$WORK" -t 3300 || { echo "::error::Kaggle push failed"; exit 1; }
fi
# Kaggle's log stream occasionally dies (500 Internal Server Error): keep re-attaching and appending until the job ends.
( while true; do kaggle kernels logs -f "$KUSER/agyata-llm-server" >> "$WORK/log.txt" 2>&1; sleep 5; done ) &
FOLLOWER=$!
trap 'kill $FOLLOWER 2>/dev/null' EXIT
QUEUED_SINCE=0
for i in $(seq 1 84); do
  if [ $((i % 3)) -eq 1 ]; then
    STATE=$(kaggle kernels status "$KUSER/agyata-llm-server" 2>/dev/null | sed -n 's/.*KernelWorkerStatus\.\([A-Z_]*\).*/\1/p')
    echo "[$(date -u +%H:%M:%S)] kaggle kernel state: ${STATE:-unknown}"
    if [ "$STATE" = "QUEUED" ]; then QUEUED_SINCE=$((QUEUED_SINCE + 30)); else QUEUED_SINCE=0; fi
    if [ "$STATE" = "ERROR" ] || [ "$STATE" = "CANCEL_ACKNOWLEDGED" ]; then echo "::error::Kaggle kernel ended in state $STATE"; exit 1; fi
    if [ "$QUEUED_SINCE" -ge 480 ]; then echo "::error::Kaggle kept the kernel QUEUED for 8+ minutes (no GPU session started; check https://www.kaggle.com/code/$KUSER/agyata-llm-server)"; exit 1; fi
  fi
  LINE=$(grep -a "KAGGLE_LLM_ENDPOINT=.* run=$GITHUB_RUN_ID" "$WORK/log.txt" | tail -1 || true)
  if [ -n "$LINE" ]; then
    URL=$(echo "$LINE" | sed -n 's/.*KAGGLE_LLM_ENDPOINT=\([^ ]*\) .*/\1/p')
    if curl -fsS -m 20 -H "Authorization: Bearer $KEY" "$URL/health" >/dev/null; then
      echo "Kaggle LLM ready: $URL"; echo "url=$URL" >> "$GITHUB_OUTPUT"; grep -a -E "MODEL_READY|OLLAMA_INSTALLED|GPU" "$WORK/log.txt" | head -5; exit 0
    fi
  fi
  if grep -aq "Traceback\|SystemExit\|failed" "$WORK/log.txt"; then break; fi
  sleep 10
done
echo "::error::Kaggle LLM did not become ready"; tail -n 60 "$WORK/log.txt" | cut -c1-200
exit 1
