# Shared helpers for the circleci-qa sections. Sourced, never executed. Callers set SECTION first.
# Sections never exit non-zero on their own: they record PASS | FAIL | SKIP, and the gate step decides.
QA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export QA_ROOT
export QA_OUT="${QA_OUT:-$PWD/qa-out}"
export QA_WORK="${QA_WORK:-${RUNNER_TEMP:-/tmp}/qa-work}"
: "${QA_SECTIONS:=pipeline,dryrun,site,browser}"
: "${QA_EDITIONS:=world,in,jp}"
: "${QA_PIPELINE_REF:=feat/news-ddg-finance-tech}"
: "${QA_PIPELINE_BASE:=main}"
: "${QA_SITE_REF:=feat/revenue-mvp}"
: "${QA_SITE_BASE:=master}"
: "${QA_VALIDATOR_MODEL:=gemma4:31b-cloud}"
mkdir -p "$QA_OUT" "$QA_WORK"

# qa_want <section>: true when the section is in the QA_SECTIONS csv.
qa_want() { case ",${QA_SECTIONS// /}," in *",$1,"*) return 0 ;; esac; return 1; }

# qa_warn <text>: one warning line, kept in the section's result.
qa_warn() { mkdir -p "$QA_OUT"; echo "$*" >> "$QA_OUT/warn_$SECTION.txt"; echo "::warning title=$SECTION::$*"; }

# qa_record <PASS|FAIL|SKIP> <detail...>: writes qa-out/result_<section>.json and prints one line.
qa_record() {
  local st="$1"; shift
  node -e '
    const fs = require("fs");
    const [section, status, detail, warnFile, outFile] = process.argv.slice(1);
    const warnings = fs.existsSync(warnFile) ? fs.readFileSync(warnFile, "utf8").split("\n").filter(Boolean) : [];
    fs.writeFileSync(outFile, JSON.stringify({ section, status, detail, warnings }, null, 2) + "\n");
    console.log(`[${section}] ${status}: ${detail}`);
  ' "$SECTION" "$st" "$*" "$QA_OUT/warn_$SECTION.txt" "$QA_OUT/result_$SECTION.json"
}

# qa_redact <file>: replaces the token in a captured error file (git can echo the clone URL).
qa_redact() {
  [ -n "${PRIVATE_REPO_TOKEN:-}" ] && [ -f "$1" ] && sed -i.bak "s|${PRIVATE_REPO_TOKEN}|***|g" "$1" && rm -f "$1.bak"
  return 0
}

# qa_clone <owner/repo> <ref> <dest>: shallow clone with the private token. Errors are redacted, then printed.
qa_clone() {
  local repo="$1" ref="$2" dest="$3" err
  [ -n "${PRIVATE_REPO_TOKEN:-}" ] || { echo "PRIVATE_REPO_TOKEN is empty (project env var missing)" >&2; return 1; }
  rm -rf "$dest"
  err="$QA_OUT/clone_$(basename "$dest").err"
  if git clone -q --depth 1 --branch "$ref" "https://x-access-token:${PRIVATE_REPO_TOKEN}@github.com/${repo}.git" "$dest" >/dev/null 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  qa_redact "$err"
  echo "clone of $repo@$ref failed:" >&2
  head -n 3 "$err" >&2
  return 1
}
