/**
 * D1-shaped wrapper over node:sqlite for offline Worker tests.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");

function stmt(db, sql) {
  const prepared = db.prepare(sql);
  let bound = [];
  const api = {
    bind(...values) {
      bound = values.map((v) => (v === undefined ? null : v));
      return api;
    },
    async first() {
      const row = prepared.get(...bound);
      return row || null;
    },
    async all() {
      const results = prepared.all(...bound);
      return { results };
    },
    async run() {
      try {
        const info = prepared.run(...bound);
        return { meta: { changes: info.changes } };
      } catch (err) {
        // Surface UNIQUE for idempotent alert_event inserts.
        throw err;
      }
    },
  };
  return api;
}

function applyMigrations(db) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    db.exec(sql);
  }
}

export function openMemoryDb() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  return {
    prepare(sql) {
      return stmt(db, sql);
    },
    _raw: db,
  };
}
