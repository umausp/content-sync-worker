#!/usr/bin/env bash
# Validates every story body in a news_preview_<edition>.json against the REAL news-svc ingest schema
# (packages/contracts IngestStoryRequestSchema from the site repo at $QA_SITE_REF). A dry run never POSTs, so without
# this a body news-svc would 400 (null optionals, over-long update.summary...) looks fine until the first live run.
# Usage: schema_check.sh <preview.json>; prints one line per bad story; exit 0 = all valid, 1 = invalid bodies, 2 = tooling failed.
. "$(dirname "${BASH_SOURCE[0]}")/qa_lib.sh"
PREVIEW="$1"
D="$QA_WORK/contracts-deps"
if [ ! -f "$D/src/news.ts" ]; then
  qa_clone umausp/agyata "$QA_SITE_REF" "$QA_WORK/site-contracts" || exit 2
  mkdir -p "$D" && cp -R "$QA_WORK/site-contracts/packages/contracts/src" "$D/src" || exit 2
  ( cd "$D" && [ -f package.json ] || echo '{"name":"qa-contracts","private":true,"type":"module"}' > package.json
    npm i --no-audit --no-fund --cache "$QA_WORK/npm-cache" zod tsx ) > "$QA_OUT/schema_deps.log" 2>&1 || exit 2
fi
cp "$QA_ROOT/.github/qa/schema_check.mts" "$D/schema_check.mts"
( cd "$D" && node node_modules/tsx/dist/cli.mjs schema_check.mts "$PREVIEW" )
