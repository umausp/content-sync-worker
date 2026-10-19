#!/usr/bin/env bash
# Section 4 (browser): serves the branch's built site with the repo's local rig on :8787 and runs browser_qa.mjs.
# Playwright and axe install into $QA_WORK/browser-deps (outside the repo). Fails on any browser_qa fail.
SECTION=browser
. "$(dirname "${BASH_SOURCE[0]}")/qa_lib.sh"
qa_want browser || { qa_record SKIP "not in QA_SECTIONS"; exit 0; }
R="$QA_WORK/site-branch"
[ -f "$R/apps/web/dist/index.html" ] || { qa_record FAIL "no built site at apps/web/dist (site section skipped or build failed)"; exit 0; }
[ -f "$R/docs/acceptance/probes/local_site_rig.mts" ] || { qa_record FAIL "local_site_rig.mts absent on $QA_SITE_REF"; exit 0; }

DEPS="$QA_WORK/browser-deps"; mkdir -p "$DEPS"
[ -f "$DEPS/package.json" ] || echo '{"name":"qa-deps","private":true}' > "$DEPS/package.json"
( cd "$DEPS" && npm i --no-save --no-audit --no-fund --cache "$QA_WORK/npm-cache" playwright@1.49.1 @axe-core/playwright@4.10.2 ) \
  > "$QA_OUT/browser_deps.log" 2>&1 || { qa_record FAIL "npm install of playwright/axe failed (browser_deps.log)"; exit 0; }
( cd "$DEPS" && npx playwright install --with-deps chromium ) > "$QA_OUT/browser_install.log" 2>&1 \
  || { qa_record FAIL "playwright chromium install failed (browser_install.log)"; exit 0; }

# The rig needs the built dist and runs from apps/web (its fixture path is relative to that dir).
TSX_CLI="$(ls "$R"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs 2>/dev/null | head -n 1)"
( cd "$R/apps/web" && export RIG_FIXTURE_STORIES=../../docs/acceptance/probes/fixtures/stories_with_images.json
  if [ -n "$TSX_CLI" ]; then exec node "$TSX_CLI" ../../docs/acceptance/probes/local_site_rig.mts
  else exec npx tsx ../../docs/acceptance/probes/local_site_rig.mts; fi ) > "$QA_OUT/browser_rig.log" 2>&1 &
RIG=$!
up=0
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/news)" = 200 ] && { up=1; break; }
  sleep 2
done
if [ $up = 0 ]; then
  kill $RIG 2>/dev/null
  qa_record FAIL "rig did not answer 200 on localhost:8787/news (browser_rig.log)"; exit 0
fi

timeout 1500 node "$QA_ROOT/.github/qa/browser_qa.mjs" --base http://localhost:8787 --deps "$DEPS" --out "$QA_OUT" > "$QA_OUT/browser_run.log" 2>&1
brc=$?
kill $RIG 2>/dev/null; pkill -f local_site_rig 2>/dev/null

if [ ! -f "$QA_OUT/browser_results.json" ]; then
  qa_record FAIL "browser_qa produced no results (exit $brc, see browser_run.log)"; exit 0
fi
node -e 'const j=require(process.argv[1]); j.warnings.forEach(w=>console.log(w))' "$QA_OUT/browser_results.json" \
  | while IFS= read -r w; do qa_warn "$w"; done
line="$(node -e 'const j=require(process.argv[1]); console.log(`${j.pass} pass, ${j.warn} warn, ${j.fail} fail`)' "$QA_OUT/browser_results.json")"
if [ $brc = 0 ]; then
  qa_record PASS "$line"
else
  qa_record FAIL "$line; first: $(node -e 'const j=require(process.argv[1]); console.log(j.failures.slice(0,5).join(" ; "))' "$QA_OUT/browser_results.json")"
fi
exit 0
