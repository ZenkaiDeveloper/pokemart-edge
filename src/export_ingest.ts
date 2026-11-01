import type { DbPort } from "./ports/db";
import {
  hmacSha256Hex,
  isoNow,
  randomToken,
  timingSafeEqualHex,
} from "./crypto_util";

export type LadderLatestRow = {
  print_id: string;
  grade_label: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  n: number;
  passport_grade: string;
  newest_sold_at: string | null;
  snapshot_date: string;
};

export type LadderHistoryRow = {
  print_id: string;
  grade_label: string;
  snapshot_date: string;
  p50: number | null;
  n: number | null;
};

export type ExportPayload = {
  snapshot_date: string;
  ladder_latest: LadderLatestRow[];
  ladder_history_90d?: LadderHistoryRow[];
};

const MAX_WRITES_PER_NIGHT = 20_000;
const MAX_SKEW_SEC = 300;

export async function verifyExportHmac(
  secret: string,
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!signatureHex || !timestamp) {
    return { ok: false, status: 401, error: "missing_signature" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 401, error: "bad_timestamp" };
  }
  const skew = Math.abs(now.getTime() / 1000 - ts);
  if (skew > MAX_SKEW_SEC) {
    return { ok: false, status: 401, error: "timestamp_skew" };
  }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!timingSafeEqualHex(expected.toLowerCase(), signatureHex.toLowerCase())) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  return { ok: true };
}

export type IngestResult =
  | {
      ok: true;
      snapshot_date: string;
      ladder_latest_n: number;
      history_n: number;
      writes: number;
    }
  | { ok: false; status: number; error: string };

/**
 * Upsert ladder_latest (no full-table DELETE — that would double row writes).
 * History for the snapshot day is applied only while the nightly write budget remains.
 * Full 90d history backfill is deferred when N is large (see README).
 */
export async function ingestExport(
  db: DbPort,
  payload: ExportPayload,
  archivePut?: (key: string, body: string) => Promise<void>,
): Promise<IngestResult> {
  const day = String(payload.snapshot_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, status: 400, error: "bad_snapshot_date" };
  }
  const latest = Array.isArray(payload.ladder_latest)
    ? payload.ladder_latest
    : [];
  const history = Array.isArray(payload.ladder_history_90d)
    ? payload.ladder_history_90d
    : [];

  // Latest upserts + export_log must fit; history is best-effort within budget.
  const latestCost = latest.length + 1; // rows + log
  if (latestCost > MAX_WRITES_PER_NIGHT) {
    return {
      ok: false,
      status: 413,
      error: `write_budget_exceeded:${latestCost}>${MAX_WRITES_PER_NIGHT}`,
    };
  }

  let writes = 0;
  const seen = new Set<string>();

  for (const row of latest) {
    const printId = String(row.print_id);
    const grade = String(row.grade_label);
    seen.add(`${printId}\0${grade}`);
    await db
      .prepare(
        `INSERT INTO ladder_latest (
           print_id, grade_label, p25, p50, p75, n,
           passport_grade, newest_sold_at, snapshot_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(print_id, grade_label) DO UPDATE SET
           p25 = excluded.p25,
           p50 = excluded.p50,
           p75 = excluded.p75,
           n = excluded.n,
           passport_grade = excluded.passport_grade,
           newest_sold_at = excluded.newest_sold_at,
           snapshot_date = excluded.snapshot_date`,
      )
      .bind(
        printId,
        grade,
        row.p25 == null ? null : Number(row.p25),
        row.p50 == null ? null : Number(row.p50),
        row.p75 == null ? null : Number(row.p75),
        Number(row.n) || 0,
        String(row.passport_grade || "D"),
        row.newest_sold_at == null ? null : String(row.newest_sold_at),
        day,
      )
      .run();
    writes += 1;
  }

  // Drop cells that disappeared from the Mac snapshot (small on steady nights).
  const existing = await db
    .prepare("SELECT print_id, grade_label FROM ladder_latest")
    .all<{ print_id: string; grade_label: string }>();
  for (const row of existing.results || []) {
    const key = `${row.print_id}\0${row.grade_label}`;
    if (seen.has(key)) continue;
    if (writes + 1 > MAX_WRITES_PER_NIGHT) break;
    await db
      .prepare(
        "DELETE FROM ladder_latest WHERE print_id = ? AND grade_label = ?",
      )
      .bind(row.print_id, row.grade_label)
      .run();
    writes += 1;
  }

  let historyWritten = 0;
  for (const row of history) {
    if (writes + 2 > MAX_WRITES_PER_NIGHT) break; // leave room for export_log
    await db
      .prepare(
        `INSERT INTO ladder_history_90d (
           print_id, grade_label, snapshot_date, p50, n
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(print_id, grade_label, snapshot_date) DO UPDATE SET
           p50 = excluded.p50, n = excluded.n`,
      )
      .bind(
        String(row.print_id),
        String(row.grade_label),
        String(row.snapshot_date).slice(0, 10),
        row.p50 == null ? null : Number(row.p50),
        row.n == null ? null : Number(row.n),
      )
      .run();
    writes += 1;
    historyWritten += 1;
  }

  const logId = await randomToken(12);
  await db
    .prepare(
      `INSERT INTO export_log (
         id, received_at, snapshot_date, ladder_latest_n, history_n, writes
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(logId, isoNow(), day, latest.length, historyWritten, writes + 1)
    .run();
  writes += 1;

  if (archivePut) {
    await archivePut(
      `exports/${day}/ladder-export.json`,
      JSON.stringify({
        snapshot_date: day,
        ladder_latest_n: latest.length,
        history_n: historyWritten,
        history_payload_n: history.length,
        writes,
      }),
    );
  }

  return {
    ok: true,
    snapshot_date: day,
    ladder_latest_n: latest.length,
    history_n: historyWritten,
    writes,
  };
}

export { MAX_WRITES_PER_NIGHT };
