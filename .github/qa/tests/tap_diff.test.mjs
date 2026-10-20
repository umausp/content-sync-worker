// Unit tests for tap_diff.mjs. Pure functions only: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTap, parseVitest, diffFailures } from '../tap_diff.mjs';

const TAP_BRANCH = `TAP version 13
# Subtest: a.test.mjs
    ok 1 - adds
    not ok 2 - rounds half up
      ---
      error: 'expected 2'
      ...
not ok 3 - b.test.mjs
ok 4 - known flake # TODO
not ok 5 - todo-marked failure # TODO
ok 6 - skipped one # SKIP
1..6
# tests 6
# pass 3
# fail 2
# cancelled 0
# skipped 1
# todo 1
`;

const TAP_BASE = `TAP version 13
not ok 1 - b.test.mjs
ok 2 - adds
1..2
# tests 2
# pass 1
# fail 1
`;

test('parseTap collects counts and failing names, ignoring TODO and SKIP', () => {
  const r = parseTap(TAP_BRANCH);
  assert.equal(r.ok, true);
  assert.equal(r.counts.tests, 6);
  assert.equal(r.counts.fail, 2);
  assert.deepEqual(r.failed, ['rounds half up', 'b.test.mjs']);
});

test('parseTap reports unparseable text as not ok', () => {
  assert.equal(parseTap('some crash output\n').ok, false);
});

test('parseTap counts a failure that has no named not-ok line', () => {
  const r = parseTap('# tests 3\n# fail 1\n');
  assert.deepEqual(r.failed, ['(1 unnamed failure(s))']);
});

test('diffFailures splits new, baseline-known and fixed', () => {
  const d = diffFailures(parseTap(TAP_BRANCH), parseTap(TAP_BASE));
  assert.deepEqual(d.newFailures, ['rounds half up']);
  assert.deepEqual(d.baselineKnown, ['b.test.mjs']);
  assert.deepEqual(d.fixed, []);
});

test('diffFailures reports base-only failures as fixed', () => {
  const d = diffFailures(parseTap(TAP_BASE), parseTap(TAP_BRANCH));
  assert.deepEqual(d.newFailures, []);
  assert.deepEqual(d.fixed, ['rounds half up']);
});

const VITEST_ANSI = [
  '\x1b[1m\x1b[46m RUN \x1b[49m\x1b[22m \x1b[36mv2.1.0\x1b[39m',
  'web test: \x1b[31m FAIL \x1b[39m \x1b[2msrc/rate.test.ts\x1b[22m > rate > rounds',
  'web test:  Test Files  1 failed | 2 passed (3)',
  'web test:       Tests  1 failed | 9 passed (10)',
  'news-svc test:  Test Files  1 passed (1)',
  'news-svc test:       Tests  4 passed (4)',
].join('\n');

test('parseVitest strips ANSI, tolerates pnpm prefixes and sums counts', () => {
  const r = parseVitest(VITEST_ANSI);
  assert.equal(r.ok, true);
  assert.equal(r.counts.tests_failed, 1);
  assert.equal(r.counts.tests_passed, 13);
  assert.equal(r.counts.files_failed, 1);
  assert.deepEqual(r.failed, ['src/rate.test.ts > rate > rounds']);
});
