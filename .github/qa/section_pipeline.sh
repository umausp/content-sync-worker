#!/usr/bin/env bash
# Section 1 (pipeline): full `node --test test/` on the branch and on the base. Fails only on NEW failing tests.
SECTION=pipeline
. "$(dirname "${BASH_SOURCE[0]}")/qa_lib.sh"
qa_want pipeline || { qa_record SKIP "not in QA_SECTIONS"; exit 0; }
REPO=umausp/agyata-pipeline-private

run_suite() { # <dir> <tap-out>: TAP to the file. Files are test/*_test.mjs; the bare-directory form runs 1 bogus test.
  ( cd "$1" && node --test --test-reporter=tap test/*_test.mjs ) > "$2" 2> "$2.err"; echo $? > "$2.rc"
}

for side in branch base; do
  if [ "$side" = branch ]; then dir="$QA_WORK/pipeline-branch"; ref="$QA_PIPELINE_REF"; else dir="$QA_WORK/pipeline-base"; ref="$QA_PIPELINE_BASE"; fi
  qa_clone "$REPO" "$ref" "$dir" || { qa_record FAIL "clone of $side ref $ref failed (first lines in the log)"; exit 0; }
  ( cd "$dir" && npm ci --no-audit --no-fund --cache "$QA_WORK/npm-cache" ) > "$QA_OUT/pipeline_npm_$side.log" 2>&1 \
    || { qa_record FAIL "npm ci failed on $side ($ref), see pipeline_npm_$side.log"; exit 0; }
  run_suite "$dir" "$QA_OUT/pipeline_$side.tap"
  n=$(grep -E '^# tests ' "$QA_OUT/pipeline_$side.tap" | awk '{print $3}'); [ "${n:-0}" -ge 50 ] \
    || { qa_record FAIL "$side ran only ${n:-0} tests: the suite did not run (see pipeline_$side.tap.err)"; exit 0; }
  echo "pipeline $side ($ref): $(grep -E '^# (tests|pass|fail) ' "$QA_OUT/pipeline_$side.tap" | tr '\n' ' ') exit=$(cat "$QA_OUT/pipeline_$side.tap.rc")"
done

node "$QA_ROOT/.github/qa/tap_diff.mjs" --format tap --label pipeline \
  --branch "$QA_OUT/pipeline_branch.tap" --base "$QA_OUT/pipeline_base.tap" --out "$QA_OUT/pipeline_diff.json" > "$QA_OUT/pipeline_diff.txt" 2>&1
rc=$?
line="$(tail -n 1 "$QA_OUT/pipeline_diff.txt")"
node -e 'const j=require(process.argv[1]); j.baselineKnown.slice(0,20).forEach(n=>console.log("baseline-known: "+n))' "$QA_OUT/pipeline_diff.json" 2>/dev/null \
  | while IFS= read -r w; do qa_warn "$w"; done
case $rc in
  0) qa_record PASS "$line" ;;
  1) qa_record FAIL "$line" ;;
  *) qa_record FAIL "branch test output unparseable: $line" ;;
esac
exit 0
