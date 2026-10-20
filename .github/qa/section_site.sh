#!/usr/bin/env bash
# Section 3 (site): umausp/agyata branch vs base. Typecheck (branch), vitest (NEW failures only), biome on changed
# files, vite build gzip-JS growth (fail above +20%), migration sanity (every db/migrations/*.sql in order).
SECTION=site
. "$(dirname "${BASH_SOURCE[0]}")/qa_lib.sh"
qa_want site || { qa_record SKIP "not in QA_SECTIONS"; exit 0; }
REPO=umausp/agyata
R="$QA_WORK/site-branch"; S="$QA_WORK/site-base"
checks=(); hard=0
note() { checks+=("$1"); }

if ! qa_clone "$REPO" "$QA_SITE_REF" "$R"; then
  if grep -qiE 'denied|not found|authentication|403|could not read' "$QA_OUT/clone_site-branch.err" 2>/dev/null; then
    qa_record FAIL "token lacks access to umausp/agyata (clone of $QA_SITE_REF denied; see qa-output clone_site-branch.err)"
  else
    qa_record FAIL "clone of $QA_SITE_REF failed (see clone_site-branch.err)"
  fi
  exit 0
fi
qa_clone "$REPO" "$QA_SITE_BASE" "$S" || { qa_record FAIL "clone of base $QA_SITE_BASE failed (see clone_site-base.err)"; exit 0; }

# Tooling: pnpm from the packageManager field (corepack); no --ignore-scripts so native addons build.
sudo corepack enable >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true
for d in "$R" "$S"; do
  ( cd "$d" && pnpm install --frozen-lockfile ) > "$QA_OUT/site_install_$(basename "$d").log" 2>&1 \
    || { qa_record FAIL "pnpm install --frozen-lockfile failed in $(basename "$d"), see site_install_*.log"; exit 0; }
done

# 1. typecheck every workspace package that has one (branch)
( cd "$R" && pnpm -r --if-present typecheck ) > "$QA_OUT/site_typecheck.log" 2>&1; tc=$?
if [ $tc = 0 ]; then note "typecheck=PASS"; else note "typecheck=FAIL(exit $tc)"; hard=1; fi

# 2. vitest, branch vs base; only NEW failures fail
( cd "$R" && pnpm -r --if-present --no-bail test ) > "$QA_OUT/site_vitest_branch.log" 2>&1
( cd "$S" && pnpm -r --if-present --no-bail test ) > "$QA_OUT/site_vitest_base.log" 2>&1
node "$QA_ROOT/.github/qa/tap_diff.mjs" --format vitest --label vitest \
  --branch "$QA_OUT/site_vitest_branch.log" --base "$QA_OUT/site_vitest_base.log" --out "$QA_OUT/site_vitest_diff.json" > "$QA_OUT/site_vitest_diff.txt" 2>&1
vt=$?
vline="$(tail -n 1 "$QA_OUT/site_vitest_diff.txt")"
node -e 'const j=require(process.argv[1]); j.baselineKnown.slice(0,20).forEach(n=>console.log("baseline-known: "+n))' "$QA_OUT/site_vitest_diff.json" 2>/dev/null \
  | while IFS= read -r w; do qa_warn "$w"; done
if [ $vt = 0 ]; then note "vitest=PASS"; else note "vitest=FAIL($vline)"; hard=1; fi

# 3. biome on files changed vs base (fetch the base tip into the branch clone; FETCH_HEAD is that tip)
( cd "$R" && git fetch -q --depth 1 origin "$QA_SITE_BASE" && git diff --name-only --diff-filter=ACMR FETCH_HEAD HEAD ) \
  > "$QA_OUT/site_changed.txt" 2>"$QA_OUT/site_changed.err"
grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$' "$QA_OUT/site_changed.txt" > "$QA_OUT/site_biome_files.txt"
if [ ! -s "$QA_OUT/site_biome_files.txt" ]; then
  note "biome=SKIP(no changed biome files)"
else
  ( cd "$R" && tr '\n' '\0' < "$QA_OUT/site_biome_files.txt" | xargs -0 pnpm exec biome check --no-errors-on-unmatched --files-ignore-unknown=true ) \
    > "$QA_OUT/site_biome.log" 2>&1; bc=$?
  if [ $bc = 0 ]; then note "biome=PASS($(wc -l < "$QA_OUT/site_biome_files.txt" | tr -d ' ') files)"; else note "biome=FAIL(exit $bc, see site_biome.log)"; hard=1; fi
fi

# 4. vite build of apps/web, branch vs base; gzip JS total growth above 20% fails
( cd "$R/apps/web" && pnpm exec vite build ) > "$QA_OUT/site_build_branch.log" 2>&1; br=$?
( cd "$S/apps/web" && pnpm exec vite build ) > "$QA_OUT/site_build_base.log" 2>&1; bs=$?
gz_total() { node -e 'const fs=require("fs"),path=require("path"),zlib=require("zlib");
  const dir=process.argv[1]; let t=0,n=0;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) { t+=zlib.gzipSync(fs.readFileSync(path.join(dir,f)),{level:9}).length; n++; }
  console.log(JSON.stringify({files:n,gz:t}));' "$1"; }
if [ $br != 0 ]; then
  note "build=FAIL(branch vite build exit $br)"; hard=1
else
  bj="$(gz_total "$R/apps/web/dist/assets" 2>/dev/null || echo '{"files":0,"gz":0}')"
  if [ $bs != 0 ]; then
    note "bundle=WARN(base build failed, not compared: branch $bj)"; qa_warn "base vite build failed; bundle size not compared"
  else
    sj="$(gz_total "$S/apps/web/dist/assets" 2>/dev/null || echo '{"files":0,"gz":0}')"
    growth="$(node -e 'const b=JSON.parse(process.argv[1]).gz, s=JSON.parse(process.argv[2]).gz; console.log(s>0 ? ((b-s)/s*100).toFixed(1) : "n/a")' "$bj" "$sj")"
    over="$(node -e 'const b=JSON.parse(process.argv[1]).gz, s=JSON.parse(process.argv[2]).gz; console.log(s>0 && (b-s)/s > 0.20 ? 1 : 0)' "$bj" "$sj")"
    if [ "$over" = 1 ]; then note "bundle=FAIL(gz JS +${growth}% vs base, limit 20%)"; hard=1
    else note "bundle=PASS(gz JS ${growth}% vs base; branch $bj base $sj)"; fi
  fi
fi

# 5. migrations: every db/migrations/*.sql applied in order to an in-memory sqlite
if [ -d "$R/db/migrations" ]; then
  node "$QA_ROOT/.github/qa/apply_migrations.mjs" "$R/db/migrations" --driver-from "$R" > "$QA_OUT/site_migrations.log" 2>&1; mg=$?
  if [ $mg = 0 ]; then note "migrations=PASS($(head -n 1 "$QA_OUT/site_migrations.log" | cut -c1-80))"; else note "migrations=FAIL($(head -n 1 "$QA_OUT/site_migrations.log" | cut -c1-160))"; hard=1; fi
else
  note "migrations=FAIL(no db/migrations dir on $QA_SITE_REF)"; hard=1
fi

detail=""
for c in "${checks[@]}"; do detail="${detail:+$detail | }$c"; done
if [ $hard = 0 ]; then qa_record PASS "$detail"; else qa_record FAIL "$detail"; fi
exit 0
