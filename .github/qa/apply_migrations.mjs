#!/usr/bin/env node
// Migration sanity for the QA lane: applies every *.sql in a migrations dir, in numeric order, to a fresh in-memory
// SQLite and fails on the first SQL error.
// Usage: node .github/qa/apply_migrations.mjs <migrationsDir> [--driver-from <repoDir>]
// Driver: better-sqlite3 resolved from <repoDir> when installed there, otherwise the built-in node:sqlite (Node >= 22.13).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function openDb(driverFrom) {
  if (driverFrom) {
    // better-sqlite3 lives in a workspace package, not the repo root: try the usual homes.
    const root = resolve(driverFrom);
    for (const sub of ['', 'services/news-svc', 'services/api-gateway', 'services/admin', 'apps/web']) {
      try {
        const req = createRequire(join(root, sub, 'package.json'));
        const BetterSqlite3 = req('better-sqlite3');
        return { kind: 'better-sqlite3', db: new BetterSqlite3(':memory:') };
      } catch {
        // not here, or native binding unavailable: try the next
      }
    }
  }
  const { DatabaseSync } = await import('node:sqlite');
  return { kind: 'node:sqlite', db: new DatabaseSync(':memory:') };
}

export function listMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => /\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Applies files in order; stops at the first error. Returns { ok, applied, failed, error }. */
export function applyAll(db, dir) {
  const files = listMigrations(dir);
  const applied = [];
  for (const f of files) {
    try {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      applied.push(f);
    } catch (e) {
      return { ok: false, applied, failed: f, error: e?.message || String(e) };
    }
  }
  return { ok: files.length > 0, applied, failed: null, error: files.length ? null : 'no *.sql files found' };
}

async function main(argv) {
  const dir = argv[0];
  const i = argv.indexOf('--driver-from');
  const driverFrom = i >= 0 ? argv[i + 1] : null;
  if (!dir || !existsSync(dir)) {
    console.error(`migrations dir not found: ${dir}`);
    return 2;
  }
  const { kind, db } = await openDb(driverFrom);
  const res = applyAll(db, dir);
  db.close?.();
  if (res.ok) {
    console.log(`migrations OK: ${res.applied.length} applied with ${kind}: ${res.applied.join(' ')}`);
    return 0;
  }
  console.log(`migrations FAILED (${kind}) at ${res.failed ?? '-'}: ${res.error}; applied before failure: ${res.applied.length}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
