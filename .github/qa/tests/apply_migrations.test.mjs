// Unit tests for apply_migrations.mjs against fixture SQL dirs (node:sqlite driver, no install needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAll, listMigrations, openDb } from '../apply_migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, 'fixtures', name);

test('listMigrations sorts numerically, not lexically', async () => {
  const files = listMigrations(fx('migrations_order'));
  assert.deepEqual(files, ['1_t.sql', '2_t.sql', '10_t.sql']);
});

test('a valid migration set applies in order to an in-memory db', async () => {
  const { db, kind } = await openDb(null);
  const res = applyAll(db, fx('migrations_ok'));
  assert.equal(kind, 'node:sqlite');
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.applied, ['0001_init.sql', '0002_b.sql']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 2);
  db.close();
});

test('a broken migration stops the run at the failing file', async () => {
  const { db } = await openDb(null);
  const res = applyAll(db, fx('migrations_bad'));
  assert.equal(res.ok, false);
  assert.equal(res.failed, '0002_broken.sql');
  assert.deepEqual(res.applied, ['0001_init.sql']);
  db.close();
});

test('an empty directory is a failure, never a pass', async () => {
  const { db } = await openDb(null);
  const res = applyAll(db, join(here, 'fixtures'));
  assert.equal(res.ok, false);
  db.close();
});
