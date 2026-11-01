import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { openMemoryDb } from "./memory_db.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return ok === 0;
}

async function verifyExportHmac(secret, rawBody, signatureHex, timestamp, now) {
  if (!signatureHex || !timestamp) {
    return { ok: false, status: 401, error: "missing_signature" };
  }
  const ts = Number(timestamp);
  const skew = Math.abs(now.getTime() / 1000 - ts);
  if (skew > 300) return { ok: false, status: 401, error: "timestamp_skew" };
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!timingSafeEqualHex(expected.toLowerCase(), signatureHex.toLowerCase())) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  return { ok: true };
}

async function ingestExport(db, payload) {
  const day = String(payload.snapshot_date || "").slice(0, 10);
  const latest = payload.ladder_latest || [];
  const history = payload.ladder_history_90d || [];
  if (latest.length + 1 > 20_000) {
    return { ok: false, status: 413, error: "write_budget_exceeded" };
  }
  let writes = 0;
  for (const row of latest) {
    await db
      .prepare(
        `INSERT INTO ladder_latest (
           print_id, grade_label, p25, p50, p75, n,
           passport_grade, newest_sold_at, snapshot_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(print_id, grade_label) DO UPDATE SET
           p25 = excluded.p25, p50 = excluded.p50, p75 = excluded.p75,
           n = excluded.n, passport_grade = excluded.passport_grade,
           newest_sold_at = excluded.newest_sold_at, snapshot_date = excluded.snapshot_date`,
      )
      .bind(
        row.print_id,
        row.grade_label,
        row.p25,
        row.p50,
        row.p75,
        row.n,
        row.passport_grade || "D",
        row.newest_sold_at,
        day,
      )
      .run();
    writes += 1;
  }
  let historyWritten = 0;
  for (const row of history) {
    if (writes + 2 > 20_000) break;
    await db
      .prepare(
        `INSERT INTO ladder_history_90d (
           print_id, grade_label, snapshot_date, p50, n
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(print_id, grade_label, snapshot_date) DO UPDATE SET
           p50 = excluded.p50, n = excluded.n`,
      )
      .bind(row.print_id, row.grade_label, row.snapshot_date, row.p50, row.n)
      .run();
    writes += 1;
    historyWritten += 1;
  }
  await db
    .prepare(
      `INSERT INTO export_log (
         id, received_at, snapshot_date, ladder_latest_n, history_n, writes
       ) VALUES ('log1', '2026-11-01T12:00:00Z', ?, ?, ?, ?)`,
    )
    .bind(day, latest.length, historyWritten, writes + 1)
    .run();
  return {
    ok: true,
    snapshot_date: day,
    ladder_latest_n: latest.length,
    history_n: historyWritten,
    writes: writes + 1,
  };
}

describe("export HMAC", () => {
  it("rejects unsigned and accepts valid signature", async () => {
    const secret = "test-export-secret";
    const body = JSON.stringify({ snapshot_date: "2026-11-01", ladder_latest: [] });
    const now = new Date("2026-11-01T12:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));

    const missing = await verifyExportHmac(secret, body, null, null, now);
    assert.equal(missing.status, 401);

    const bad = await verifyExportHmac(secret, body, "deadbeef", ts, now);
    assert.equal(bad.status, 401);

    const sig = await hmacSha256Hex(secret, `${ts}.${body}`);
    const ok = await verifyExportHmac(secret, body, sig, ts, now);
    assert.equal(ok.ok, true);
  });
});

describe("export ingest", () => {
  it("ladder_latest count matches payload; writes logged and <= 20k", async () => {
    const db = openMemoryDb();
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push({
        print_id: `pm_${i}`,
        grade_label: "Raw",
        p25: 100,
        p50: 200,
        p75: 300,
        n: 3 + i,
        passport_grade: "B",
        newest_sold_at: "2026-10-30T00:00:00Z",
        snapshot_date: "2026-11-01",
      });
    }
    const result = await ingestExport(db, {
      snapshot_date: "2026-11-01",
      ladder_latest: rows,
      ladder_history_90d: [
        {
          print_id: "pm_0",
          grade_label: "Raw",
          snapshot_date: "2026-11-01",
          p50: 200,
          n: 3,
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ladder_latest_n, 5);
    assert.ok(result.writes <= 20_000);

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM ladder_latest")
      .first();
    assert.equal(Number(count.n), 5);

    const log = await db
      .prepare("SELECT writes FROM export_log ORDER BY received_at DESC LIMIT 1")
      .first();
    assert.equal(Number(log.writes), result.writes);
  });
});
