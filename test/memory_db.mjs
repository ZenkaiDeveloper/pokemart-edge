/**
 * D1-shaped wrapper over node:sqlite for offline Worker tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = readFileSync(join(root, "migrations/0001_init.sql"), "utf8");

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
      const info = prepared.run(...bound);
      return { meta: { changes: info.changes } };
    },
  };
  return api;
}

export function openMemoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    prepare(sql) {
      return stmt(db, sql);
    },
    _raw: db,
  };
}
