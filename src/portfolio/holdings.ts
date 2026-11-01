import type { DbPort } from "../ports/db";
import { isoNow, randomToken } from "../crypto_util";
import type { HoldingRow, LadderCell, SaleRow } from "./value";
import { valuePortfolio, type PortfolioSummary } from "./value";
import { computeEbayFeesCents } from "./fees";

export type CreateHoldingInput = {
  db: DbPort;
  userId: string;
  printId: string;
  gradeLabel: string;
  conditionTier?: string | null;
  qty?: number;
  costCents?: number | null;
  acquiredOn?: string | null;
  notes?: string | null;
  now?: Date;
};

export async function createHolding(
  opts: CreateHoldingInput,
): Promise<{ ok: true; holding: HoldingRow } | { ok: false; status: number; error: string }> {
  const printId = String(opts.printId || "").trim();
  const gradeLabel = String(opts.gradeLabel || "").trim() || "Ungraded";
  if (!printId || printId.length > 256) {
    return { ok: false, status: 400, error: "invalid_print_id" };
  }
  const qty = Math.max(1, Math.min(9999, Math.round(Number(opts.qty) || 1)));
  let cost: number | null =
    opts.costCents == null || opts.costCents === ("" as unknown)
      ? null
      : Math.round(Number(opts.costCents));
  if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
    return { ok: false, status: 400, error: "invalid_cost_cents" };
  }
  const id = await randomToken(16);
  const now = opts.now || new Date();
  const created = isoNow(now);
  await opts.db
    .prepare(
      `INSERT INTO holding (
         id, user_id, print_id, grade_label, condition_tier, qty,
         cost_cents, acquired_on, notes, created_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      opts.userId,
      printId,
      gradeLabel,
      opts.conditionTier || null,
      qty,
      cost,
      opts.acquiredOn || null,
      opts.notes || null,
      created,
    )
    .run();
  return {
    ok: true,
    holding: {
      id,
      print_id: printId,
      grade_label: gradeLabel,
      condition_tier: opts.conditionTier || null,
      qty,
      cost_cents: cost,
      acquired_on: opts.acquiredOn || null,
      notes: opts.notes || null,
    },
  };
}

export async function softDeleteHolding(
  db: DbPort,
  userId: string,
  holdingId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM holding WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .bind(holdingId, userId)
    .first<{ id: string }>();
  if (!row) return false;
  await db
    .prepare(`UPDATE holding SET deleted_at = ? WHERE id = ? AND user_id = ?`)
    .bind(isoNow(now), holdingId, userId)
    .run();
  return true;
}

export async function deleteAllHoldings(
  db: DbPort,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id FROM holding WHERE user_id = ? AND deleted_at IS NULL`,
    )
    .bind(userId)
    .all<{ id: string }>();
  const at = isoNow(now);
  for (const r of results || []) {
    await db
      .prepare(`UPDATE holding SET deleted_at = ? WHERE id = ?`)
      .bind(at, r.id)
      .run();
  }
  return (results || []).length;
}

export async function listHoldings(
  db: DbPort,
  userId: string,
): Promise<HoldingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, print_id, grade_label, condition_tier, qty, cost_cents,
              acquired_on, notes
       FROM holding WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all<HoldingRow>();
  return results || [];
}

export async function listSalesForHoldings(
  db: DbPort,
  holdingIds: string[],
): Promise<SaleRow[]> {
  if (!holdingIds.length) return [];
  const out: SaleRow[] = [];
  // D1/SQLite: bind per-id to avoid huge IN lists in tests.
  for (const id of holdingIds) {
    const { results } = await db
      .prepare(
        `SELECT id, holding_id, qty, price_cents, fees_cents, sold_on
         FROM sale WHERE holding_id = ?`,
      )
      .bind(id)
      .all<SaleRow>();
    out.push(...(results || []));
  }
  return out;
}

export async function recordSale(opts: {
  db: DbPort;
  userId: string;
  holdingId: string;
  qty: number;
  priceCents: number;
  feesCents?: number | null;
  soldOn: string;
  useEbayFeeTable?: boolean;
}): Promise<
  | { ok: true; sale: SaleRow }
  | { ok: false; status: number; error: string }
> {
  const h = await opts.db
    .prepare(
      `SELECT id, qty FROM holding WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .bind(opts.holdingId, opts.userId)
    .first<{ id: string; qty: number }>();
  if (!h) return { ok: false, status: 404, error: "holding_not_found" };
  const qty = Math.max(1, Math.round(Number(opts.qty) || 1));
  const price = Math.max(0, Math.round(Number(opts.priceCents) || 0));
  let fees =
    opts.feesCents == null
      ? opts.useEbayFeeTable === false
        ? 0
        : computeEbayFeesCents(price).total_cents
      : Math.max(0, Math.round(Number(opts.feesCents)));
  const id = await randomToken(16);
  await opts.db
    .prepare(
      `INSERT INTO sale (id, holding_id, qty, price_cents, fees_cents, sold_on)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, opts.holdingId, qty, price, fees, opts.soldOn)
    .run();
  return {
    ok: true,
    sale: {
      id,
      holding_id: opts.holdingId,
      qty,
      price_cents: price,
      fees_cents: fees,
      sold_on: opts.soldOn,
    },
  };
}

export async function loadLadderCells(
  db: DbPort,
  pairs: { print_id: string; grade_label: string }[],
): Promise<LadderCell[]> {
  const out: LadderCell[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const k = `${p.print_id}||${p.grade_label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const row = await db
      .prepare(
        `SELECT print_id, grade_label, p25, p50, p75, n, passport_grade
         FROM ladder_latest WHERE print_id = ? AND grade_label = ?`,
      )
      .bind(p.print_id, p.grade_label)
      .first<LadderCell>();
    if (row) out.push(row);
  }
  return out;
}

export async function recomputePortfolio(
  db: DbPort,
  userId: string,
): Promise<PortfolioSummary> {
  const holdings = await listHoldings(db, userId);
  const sales = await listSalesForHoldings(
    db,
    holdings.map((h) => h.id),
  );
  const cells = await loadLadderCells(
    db,
    holdings.map((h) => ({
      print_id: h.print_id,
      grade_label: h.grade_label,
    })),
  );
  return valuePortfolio(holdings, sales, cells);
}

export async function snapshotValuation(
  db: DbPort,
  userId: string,
  asOf: string,
  summary?: PortfolioSummary,
): Promise<void> {
  const s = summary || (await recomputePortfolio(db, userId));
  await db
    .prepare(
      `INSERT OR REPLACE INTO valuation_history
         (user_id, as_of, value_cents, n_priced, n_unpriced)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(userId, asOf, s.value_cents, s.n_priced, s.n_unpriced)
    .run();
}

/** Migrate local watchlist / collection JSON into holdings (idempotent by print+grade). */
export async function migrateLocalLists(opts: {
  db: DbPort;
  userId: string;
  watchlist?: Array<Record<string, unknown>>;
  collection?: Array<Record<string, unknown>>;
  now?: Date;
}): Promise<{ added: number; skipped: number }> {
  const existing = await listHoldings(opts.db, opts.userId);
  const have = new Set(
    existing.map((h) => `${h.print_id}||${h.grade_label}`),
  );
  let added = 0;
  let skipped = 0;

  const upsert = async (row: {
    printId: string;
    grade: string;
    qty: number;
    cost: number | null;
  }) => {
    const key = `${row.printId}||${row.grade}`;
    if (have.has(key)) {
      skipped += 1;
      return;
    }
    const res = await createHolding({
      db: opts.db,
      userId: opts.userId,
      printId: row.printId,
      gradeLabel: row.grade,
      qty: row.qty,
      costCents: row.cost,
      now: opts.now,
    });
    if (res.ok) {
      have.add(key);
      added += 1;
    } else {
      skipped += 1;
    }
  };

  for (const it of opts.watchlist || []) {
    const printId = String(it.print_id || it.card_key || it.id || "").trim();
    if (!printId) {
      skipped += 1;
      continue;
    }
    await upsert({
      printId,
      grade: String(it.grade_label || it.grade || "Ungraded"),
      qty: 1,
      cost: null,
    });
  }
  for (const it of opts.collection || []) {
    const printId = String(it.print_id || it.card_key || it.id || "").trim();
    if (!printId) {
      skipped += 1;
      continue;
    }
    const costRaw = it.cost_cents ?? it.costCents;
    const cost =
      costRaw == null || costRaw === ""
        ? null
        : Math.round(Number(costRaw));
    await upsert({
      printId,
      grade: String(it.grade_label || it.grade || "Ungraded"),
      qty: Math.max(1, Math.round(Number(it.qty) || 1)),
      cost: Number.isFinite(cost as number) ? (cost as number) : null,
    });
  }
  return { added, skipped };
}
