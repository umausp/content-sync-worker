#!/usr/bin/env bash
# One NEWS_DRY_RUN preview for one edition, with the production news flags. Nothing is posted: the ingest token is a
# dummy, so even a bug that POSTs cannot authenticate. Writes review_<e>.log, review_<e>.rc, news_preview_<e>.json.
# Usage: dryrun_edition.sh <edition> <pipeline_dir> <out_dir>
E="$1"; PIPE="$2"; OUT="$3"
cd "$PIPE" || { echo 97 > "$OUT/review_$E.rc"; exit 0; }
export EDITION="$E" NEWS_DRY_RUN=1 \
  SOURCE_MODE=both NEWS_DDG=1 SHORTS_DDG_NEWS=1 SHORTS_DDG_RETRIES=3 SHORTS_DDG_PROXY_URL="${DDG_PROXY_URL:-}" \
  NEWS_FOCUS=business,tech NEWS_NATIVE_SOLO=1 PUBLISH_NATIVE_MIN_SCORE=5 PUBLISH_NATIVE_MIN_IMPORTANCE=3 NEWS_SUMMARY=1 NEWS_SUMMARY_MODEL=deepseek-v4.1-flash:cloud NEWS_SUMMARY_MAX_CALLS=40 \
  NEWS_IMAGES=1 NEWS_IMAGES_VLM=1 NEWS_IMAGES_MAX_STORIES=25 NEWS_IMAGES_FALLBACK_PUBLISHER=0 \
  SHORTS_VLM_GATE=1 SHORTS_VLM_GATE_MODEL=deepseek-v4.1-flash:cloud SHORTS_VLM_GATE_FALLBACK_MODELS= \
  PROVIDER_ORDER=ollama PROVIDER_USE_OLLAMA=1 OLLAMA_MODEL="${OLLAMA_MODEL:-deepseek-v4-pro:0813-cloud}" \
  OLLAMA_GLOBAL_CONCURRENCY=0 POOL_TARGET=200 \
  INGEST_URL=https://api.agyata.com/news/ingest STORIES_URL=https://api.agyata.com/news/stories \
  NEWS_INGEST_TOKEN=dryrun-dummy
node src/review.mjs > "$OUT/review_$E.log" 2>&1
echo $? > "$OUT/review_$E.rc"
[ -f out/news_preview_"$E".json ] && cp out/news_preview_"$E".json "$OUT/news_preview_$E.json"
exit 0
