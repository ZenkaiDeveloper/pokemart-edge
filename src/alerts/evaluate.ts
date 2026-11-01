/**
 * Evaluate alert rules against ladder snapshots.
 * Fire only when passport >= C (A/B/C) — equivalent to headline_allowed=1.
 * Events are idempotent via UNIQUE(rule_id, snapshot_date).
 */
import type { DbPort } from "../ports/db";
import { isoNow, randomToken } from "../crypto_util";

export const PASSPORT_OK = new Set(["A", "B", "C"]);

export type LadderCell = {
  print_id: string;
  grade_label: string;
  p50: number | null;
  n: number;
  passport_grade: string;
  newest_sold_at: string | null;
  snapshot_date: string;
};

export type AlertEventPayload = {
  kind: string;
  print_id: string;
  grade_label: string;
  snapshot_date: string;
  n: number;
  passport_grade: string;
  p50: number | null;
  prev_p50?: number | null;
  prev_n?: number | null;
  prev_passport?: string | null;
  pct_move_bps?: number | null;
  threshold?: number | null;
  capture_note: string;
  evidence_path: string;
};

export type EvalStats = {
  rules_scanned: number;
  cells_skipped_passport: number;
  events_created: number;
  events_idempotent_skip: number;
  writes: number;
};

function evidencePath(printId: string, gradeLabel: string): string {
  // Prefer print_id path; card pages use set/card slugs — deep-link via search.
  return `/search/?q=${encodeURIComponent(printId)}&grade=${encodeURIComponent(gradeLabel)}`;
}

export function headlineAllowed(passport: string): boolean {
  return PASSPORT_OK.has(String(passport || "").toUpperCase());
}

export function ruleTriggered(
  kind: string,
  threshold: number | null,
  curr: LadderCell,
  prev: LadderCell | null,
  hist7: LadderCell | null,
): { fire: boolean; payload: Partial<AlertEventPayload> } {
  const base: Partial<AlertEventPayload> = {
    kind,
    print_id: curr.print_id,
    grade_label: curr.grade_label,
    snapshot_date: curr.snapshot_date,
    n: curr.n,
    passport_grade: curr.passport_grade,
    p50: curr.p50,
    threshold,
    capture_note:
      "Medians are Browse-API ended-auction last-bid proxies, not confirmed sold prices.",
    evidence_path: evidencePath(curr.print_id, curr.grade_label),
  };

  if (!headlineAllowed(curr.passport_grade)) {
    return { fire: false, payload: base };
  }

  switch (kind) {
    case "median_above": {
      if (curr.p50 == null || threshold == null) return { fire: false, payload: base };
      return { fire: curr.p50 >= threshold, payload: base };
    }
    case "median_below": {
      if (curr.p50 == null || threshold == null) return { fire: false, payload: base };
      return { fire: curr.p50 <= threshold, payload: base };
    }
    case "pct_move_7d": {
      const ref = hist7 || prev;
      if (
        curr.p50 == null ||
        !ref ||
        ref.p50 == null ||
        ref.p50 === 0 ||
        threshold == null
      ) {
        return { fire: false, payload: { ...base, prev_p50: ref?.p50 ?? null } };
      }
      const bps = Math.round(((curr.p50 - ref.p50) / ref.p50) * 10_000);
      const fire = Math.abs(bps) >= Math.abs(threshold);
      return {
        fire,
        payload: {
          ...base,
          prev_p50: ref.p50,
          pct_move_bps: bps,
        },
      };
    }
    case "new_comp": {
      if (!prev) return { fire: false, payload: base };
      const fire =
        curr.n > prev.n ||
        (curr.newest_sold_at != null &&
          curr.newest_sold_at !== prev.newest_sold_at);
      return {
        fire,
        payload: { ...base, prev_n: prev.n, prev_p50: prev.p50 },
      };
    }
    case "passport_change": {
      if (!prev) return { fire: false, payload: base };
      const fire =
        String(prev.passport_grade).toUpperCase() !==
        String(curr.passport_grade).toUpperCase();
      return {
        fire,
        payload: {
          ...base,
          prev_passport: prev.passport_grade,
          prev_p50: prev.p50,
          prev_n: prev.n,
        },
      };
    }
    default:
      return { fire: false, payload: base };
  }
}

function daysBefore(isoDay: string, days: number): string {
  const t = Date.parse(`${isoDay}T00:00:00Z`);
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export async function loadLatestCells(
  db: DbPort,
): Promise<Map<string, LadderCell>> {
  const { results } = await db
    .prepare(
      `SELECT print_id, grade_label, p50, n, passport_grade,
              newest_sold_at, snapshot_date
       FROM ladder_latest`,
    )
    .all<LadderCell>();
  const map = new Map<string, LadderCell>();
  for (const r of results || []) {
    map.set(`${r.print_id}\0${r.grade_label}`, {
      ...r,
      p50: r.p50 == null ? null : Number(r.p50),
      n: Number(r.n) || 0,
    });
  }
  return map;
}

export async function loadHistoryCell(
  db: DbPort,
  printId: string,
  gradeLabel: string,
  snapshotDate: string,
): Promise<LadderCell | null> {
  const row = await db
    .prepare(
      `SELECT print_id, grade_label, p50, n, snapshot_date,
              passport_grade, newest_sold_at
       FROM ladder_history_90d
       WHERE print_id = ? AND grade_label = ? AND snapshot_date = ?`,
    )
    .bind(printId, gradeLabel, snapshotDate)
    .first<{
      print_id: string;
      grade_label: string;
      p50: number | null;
      n: number | null;
      snapshot_date: string;
      passport_grade: string | null;
      newest_sold_at: string | null;
    }>();
  if (!row) return null;
  return {
    print_id: row.print_id,
    grade_label: row.grade_label,
    p50: row.p50 == null ? null : Number(row.p50),
    n: Number(row.n) || 0,
    passport_grade: String(row.passport_grade || "D"),
    newest_sold_at: row.newest_sold_at,
    snapshot_date: row.snapshot_date,
  };
}

/** Previous snapshot cell: prefer history for (curr_date - 1 day), else any prior. */
export async function loadPrevCell(
  db: DbPort,
  printId: string,
  gradeLabel: string,
  currDate: string,
): Promise<LadderCell | null> {
  const yday = daysBefore(currDate, 1);
  const exact = await loadHistoryCell(db, printId, gradeLabel, yday);
  if (exact) return exact;
  const row = await db
    .prepare(
      `SELECT print_id, grade_label, p50, n, snapshot_date,
              passport_grade, newest_sold_at
       FROM ladder_history_90d
       WHERE print_id = ? AND grade_label = ? AND snapshot_date < ?
       ORDER BY snapshot_date DESC LIMIT 1`,
    )
    .bind(printId, gradeLabel, currDate)
    .first<{
      print_id: string;
      grade_label: string;
      p50: number | null;
      n: number | null;
      snapshot_date: string;
      passport_grade: string | null;
      newest_sold_at: string | null;
    }>();
  if (!row) return null;
  return {
    print_id: row.print_id,
    grade_label: row.grade_label,
    p50: row.p50 == null ? null : Number(row.p50),
    n: Number(row.n) || 0,
    passport_grade: String(row.passport_grade || "D"),
    newest_sold_at: row.newest_sold_at,
    snapshot_date: row.snapshot_date,
  };
}

/**
 * For passport_change / new_comp we need prior passport + newest_sold_at.
 * Tests seed a side table via ladder_history carrying only p50/n; for those
 * kinds, pass an optional priorCells map (from a fixture or prior ladder_latest dump).
 */
export async function evaluateAlerts(
  db: DbPort,
  opts: {
    now?: Date;
    /** Optional prior cells keyed print_id\\0grade_label (for new_comp / passport_change). */
    priorCells?: Map<string, LadderCell>;
  } = {},
): Promise<EvalStats> {
  const now = opts.now || new Date();
  const stats: EvalStats = {
    rules_scanned: 0,
    cells_skipped_passport: 0,
    events_created: 0,
    events_idempotent_skip: 0,
    writes: 0,
  };

  const latest = await loadLatestCells(db);
  const { results: rules } = await db
    .prepare(
      `SELECT id, user_id, print_id, grade_label, kind, threshold, channel
       FROM alert_rule WHERE disabled_at IS NULL`,
    )
    .all<{
      id: string;
      user_id: string;
      print_id: string;
      grade_label: string;
      kind: string;
      threshold: number | null;
      channel: string;
    }>();

  for (const rule of rules || []) {
    stats.rules_scanned += 1;
    const key = `${rule.print_id}\0${rule.grade_label}`;
    const curr = latest.get(key);
    if (!curr) continue;
    if (!headlineAllowed(curr.passport_grade)) {
      stats.cells_skipped_passport += 1;
      continue;
    }

    let prev: LadderCell | null =
      opts.priorCells?.get(key) ||
      (await loadPrevCell(db, rule.print_id, rule.grade_label, curr.snapshot_date));

    // Prefer priorCells passport/newest when history stub lacks them.
    if (opts.priorCells?.has(key)) {
      prev = opts.priorCells.get(key)!;
    }

    const hist7 = await loadHistoryCell(
      db,
      rule.print_id,
      rule.grade_label,
      daysBefore(curr.snapshot_date, 7),
    );

    const { fire, payload } = ruleTriggered(
      rule.kind,
      rule.threshold == null ? null : Number(rule.threshold),
      curr,
      prev,
      hist7,
    );
    if (!fire) continue;

    const eventId = await randomToken(16);
    const createdAt = isoNow(now);
    try {
      await db
        .prepare(
          `INSERT INTO alert_event (id, rule_id, snapshot_date, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          rule.id,
          curr.snapshot_date,
          JSON.stringify(payload),
          createdAt,
        )
        .run();
      stats.events_created += 1;
      stats.writes += 1;
      // Delivery rows are created in deliverPending so nightly event writes
      // stay within the 10k budget at 1,000 users × 10 rules.
    } catch (err) {
      const msg = String(err || "");
      if (/UNIQUE|unique/i.test(msg)) {
        stats.events_idempotent_skip += 1;
        continue;
      }
      throw err;
    }
  }

  return stats;
}

/** Theoretical nightly event-write upper bound (acceptance: ≤10k @ 1k×10). */
export function estimateDailyWrites(users: number, rulesPerUser: number): number {
  // Worst case: every rule fires → 1 alert_event row (delivery is a separate pass).
  return users * rulesPerUser;
}
