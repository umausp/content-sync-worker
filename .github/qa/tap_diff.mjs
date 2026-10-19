#!/usr/bin/env node
// Failing-test diff for the QA lane. Only NEW failures (branch minus base) fail; failures that also exist on the base
// are listed as baseline-known. Also used for vitest output (--format vitest).
// Usage: node .github/qa/tap_diff.mjs --format tap|vitest --branch <file> --base <file> [--label <name>] [--out <json>]
// Last stdout line is a one-line summary. Exit 0 = no new failures, 1 = new failures, 2 = branch output unparseable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Parses node:test TAP output. Failing = `not ok` lines, except `# TODO` / `# SKIP` directives. */
export function parseTap(text) {
  const counts = {};
  const failed = new Set();
  for (const raw of String(text).replace(ANSI, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const c = /^#\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/.exec(line);
    if (c) {
      counts[c[1]] = Number(c[2]);
      continue;
    }
    const m = /^\s*not ok\s+(?:\d+\s+-\s+)?(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (/#\s*(TODO|SKIP)\b/i.test(name)) continue;
    failed.add(name.replace(/\s+#.*$/, '').trim() || '(unnamed test)');
  }
  return finish(counts, failed, 'fail');
}

/** Parses vitest output (pnpm -r prefixes are tolerated). Counts are summed across packages. */
export function parseVitest(text) {
  const counts = {};
  const failed = new Set();
  for (const raw of String(text).replace(ANSI, '').split('\n')) {
    const line = raw.trimEnd();
    const f = /(?:^|\s)FAIL\s+(\S.*)$/.exec(line);
    if (f) {
      failed.add(f[1].trim());
      continue;
    }
    const t = /(?:^|\s)(Tests|Test Files)\s+(\d.*)$/.exec(line);
    if (t) {
      const key = t[1] === 'Tests' ? 'tests' : 'files';
      for (const [, n, label] of t[2].matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) {
        const k = `${key}_${label}`;
        counts[k] = (counts[k] || 0) + Number(n);
      }
    }
  }
  return finish(counts, failed, 'tests_failed');
}

function finish(counts, failed, failKey) {
  const names = [...failed];
  const nFail = counts[failKey] ?? counts.fail ?? 0;
  // A run that reports failures without naming them must still count as failing.
  if (nFail > 0 && names.length === 0) names.push(`(${nFail} unnamed failure(s))`);
  return { counts, failed: names, ok: Object.keys(counts).length > 0 };
}

/** Splits failing names into new (not on base), baseline-known (also on base) and fixed (base only). */
export function diffFailures(branch, base) {
  const b = new Set(base.failed);
  const br = new Set(branch.failed);
  return {
    newFailures: branch.failed.filter((n) => !b.has(n)),
    baselineKnown: branch.failed.filter((n) => b.has(n)),
    fixed: base.failed.filter((n) => !br.has(n)),
  };
}

const fmt = (c) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || 'no counts';

function load(file, parse) {
  if (!file || !existsSync(file)) return { missing: true, counts: {}, failed: [], ok: false };
  return { missing: false, ...parse(readFileSync(file, 'utf8')) };
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const format = arg('--format', 'tap');
  const parse = format === 'vitest' ? parseVitest : parseTap;
  const label = arg('--label', format);
  const out = arg('--out', null);
  const branch = load(arg('--branch', null), parse);
  const base = load(arg('--base', null), parse);

  if (!branch.ok) {
    const line = `${label}: branch output has no parseable results (missing=${branch.missing}) -> ERROR`;
    console.log(line);
    if (out) writeFileSync(out, JSON.stringify({ label, status: 'ERROR', line }, null, 2) + '\n');
    return 2;
  }
  const d = base.ok ? diffFailures(branch, base) : { newFailures: branch.failed, baselineKnown: [], fixed: [] };
  const status = d.newFailures.length ? 'FAIL' : 'PASS';
  const shown = d.newFailures.slice(0, 5).join('; ') + (d.newFailures.length > 5 ? '; ...' : '');
  const line = `${label}: branch [${fmt(branch.counts)}] | base [${base.ok ? fmt(base.counts) : 'UNPARSEABLE, all branch failures treated as new'}] | new failures ${d.newFailures.length}${d.newFailures.length ? ` (${shown})` : ''} | baseline-known ${d.baselineKnown.length} | fixed ${d.fixed.length}`;

  if (out) {
    writeFileSync(out, JSON.stringify({
      label, format, status, line,
      branch: { counts: branch.counts, failed: branch.failed },
      base: { counts: base.counts, failed: base.failed, parsed: base.ok },
      newFailures: d.newFailures, baselineKnown: d.baselineKnown, fixed: d.fixed,
    }, null, 2) + '\n');
  }
  console.log(line);
  return d.newFailures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
