#!/usr/bin/env bash
# Section 2 (dryrun): NEWS_DRY_RUN preview per edition (max 3 in parallel) with the production news flags, then the
# cloud validator. Fails on: review exit != 0, missing preview, any ingest POST in the log, no "nothing posted" line,
# world with 0 stories, or validator failure. Short-quality and stale items are warnings.
SECTION=dryrun
. "$(dirname "${BASH_SOURCE[0]}")/qa_lib.sh"
qa_want dryrun || { qa_record SKIP "not in QA_SECTIONS"; exit 0; }
P="$QA_WORK/pipeline-branch"
if [ ! -d "$P/.git" ]; then
  qa_clone umausp/agyata-pipeline-private "$QA_PIPELINE_REF" "$P" || { qa_record FAIL "clone of $QA_PIPELINE_REF failed"; exit 0; }
fi
if [ ! -d "$P/node_modules" ]; then
  ( cd "$P" && npm ci --no-audit --no-fund --cache "$QA_WORK/npm-cache" ) > "$QA_OUT/dryrun_npm.log" 2>&1 \
    || { qa_record FAIL "npm ci failed, see dryrun_npm.log"; exit 0; }
fi

EDITIONS_LIST="$(echo "$QA_EDITIONS" | tr ',' ' ')"
for e in $EDITIONS_LIST; do
  [[ "$e" =~ ^[a-z][a-z-]{1,15}$ ]] || { qa_record FAIL "invalid edition name: $e"; exit 0; }
done

printf '%s\n' $EDITIONS_LIST | xargs -P 3 -I{} bash "$QA_ROOT/.github/qa/dryrun_edition.sh" {} "$P" "$QA_OUT"

fails=(); summary=()
for e in $EDITIONS_LIST; do
  log="$QA_OUT/review_$e.log"; prev="$QA_OUT/news_preview_$e.json"
  rc="$(cat "$QA_OUT/review_$e.rc" 2>/dev/null || echo missing)"
  [ "$rc" = 0 ] || fails+=("$e: review.mjs exit $rc")
  if grep -Eq 'POST.*(news/ingest|dedup/claim)' "$log" 2>/dev/null; then fails+=("$e: ingest/claim POST seen in log"); fi
  grep -q 'nothing posted' "$log" 2>/dev/null || fails+=("$e: no 'nothing posted' dry-run summary line")
  if [ ! -f "$prev" ]; then
    fails+=("$e: preview file missing"); continue
  fi
  n="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Array.isArray(d)?d.length:(d.stories||[]).length)' "$prev" 2>/dev/null || echo 0)"
  [ "$e" != world ] || [ "$n" -gt 0 ] || fails+=("world: 0 stories (pipeline starved)")
  [ "$e" = world ] || [ "$n" -gt 0 ] || qa_warn "$e: 0 stories passed the publish bar (edition would stay empty; held: $(grep -c '▽ hold' "$log" 2>/dev/null) candidates, see review_$e.log)"
  summary+=("$e=$n stories")
  node "$QA_ROOT/.github/qa/validate_cloud.mjs" "$prev" --model "$QA_VALIDATOR_MODEL" --out "$QA_OUT/validation_$e.json" > "$QA_OUT/validate_$e.log" 2>&1
  vrc=$?
  [ "$vrc" = 0 ] || fails+=("$e: validator exit $vrc (see validate_$e.log)")
  if [ -f "$QA_OUT/validation_$e.json" ]; then
    node -e 'const j=require(process.argv[1]); (j.warnings||[]).forEach(w=>console.log(process.argv[2]+": "+w))' "$QA_OUT/validation_$e.json" "$e" 2>/dev/null \
      | while IFS= read -r w; do qa_warn "$w"; done
  fi
done

detail="editions: ${summary[*]:-none}; $( [ ${#fails[@]} -eq 0 ] && echo 'nothing posted, validator PASS' )"
if [ ${#fails[@]} -eq 0 ]; then
  qa_record PASS "$detail"
else
  qa_record FAIL "$detail; failures: $(IFS='; '; echo "${fails[*]}")"
fi
exit 0
