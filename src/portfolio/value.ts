/**
 * Portfolio valuation — Passport A–C only; never value D or missing cells.
 */
import { computeEbayFeesCents } from "./fees";

export const HEADLINE_GRADES = new Set(["A", "B", "C"]);

export type LadderCell = {
  print_id: string;
  grade_label: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  n: number;
  passport_grade: string | null;
};

export type HoldingRow = {
  id: string;
  print_id: string;
  grade_label: string;
  condition_tier?: string | null;
  qty: number;
  cost_cents: number | null;
  acquired_on?: string | null;
  notes?: string | null;
  /** Remaining qty after sales (caller may precompute). */
  remaining_qty?: number;
};

export type SaleRow = {
  id: string;
  holding_id: string;
  qty: number;
  price_cents: number;
  fees_cents: number | null;
  sold_on: string;
};

export type ValuedHolding = HoldingRow & {
  remaining_qty: number;
  priced: boolean;
  unpriced_reason: string | null;
  unit_p50: number | null;
  unit_p25: number | null;
  unit_p75: number | null;
  line_value_cents: number | null;
  line_low_cents: number | null;
  line_high_cents: number | null;
  line_cost_cents: number | null;
  passport_grade: string | null;
};

export type PortfolioSummary = {
  n_holdings: number;
  n_priced: number;
  n_unpriced: number;
  qty_priced: number;
  qty_unpriced: number;
  value_cents: number;
  low_cents: number;
  high_cents: number;
  cost_basis_cents: number; // cost on priced remaining only (unknown cost excluded)
  cost_basis_known_qty: number;
  unrealized_cents: number | null; // value - known cost on priced; null if no known cost
  realized_cents: number;
  lines: ValuedHolding[];
  unpriced: ValuedHolding[];
};

export function headlineAllowed(passportGrade: string | null | undefined): boolean {
  if (!passportGrade) return false;
  return HEADLINE_GRADES.has(String(passportGrade).trim().toUpperCase());
}

export function cellKey(printId: string, gradeLabel: string): string {
  return `${printId}||${gradeLabel}`;
}

export function remainingQty(
  holding: HoldingRow,
  sales: SaleRow[],
): number {
  const sold = sales
    .filter((s) => s.holding_id === holding.id)
    .reduce((a, s) => a + Math.max(0, Number(s.qty) || 0), 0);
  return Math.max(0, (Number(holding.qty) || 0) - sold);
}

function lookupCell(
  map: Map<string, LadderCell>,
  printId: string,
  gradeLabel: string,
): LadderCell | null {
  return map.get(cellKey(printId, gradeLabel)) || null;
}

export function valueHolding(
  holding: HoldingRow,
  cell: LadderCell | null,
  remQty: number,
): ValuedHolding {
  const base: ValuedHolding = {
    ...holding,
    remaining_qty: remQty,
    priced: false,
    unpriced_reason: null,
    unit_p50: null,
    unit_p25: null,
    unit_p75: null,
    line_value_cents: null,
    line_low_cents: null,
    line_high_cents: null,
    line_cost_cents:
      holding.cost_cents == null ? null : remQty * Number(holding.cost_cents),
    passport_grade: cell?.passport_grade ?? null,
  };
  if (remQty <= 0) {
    base.unpriced_reason = "fully_sold";
    return base;
  }
  if (!cell) {
    base.unpriced_reason = "no_ladder_cell";
    return base;
  }
  const pg = cell.passport_grade;
  if (!headlineAllowed(pg)) {
    base.unpriced_reason =
      pg && String(pg).toUpperCase() === "D"
        ? "passport_d"
        : "passport_below_c";
    base.passport_grade = pg;
    return base;
  }
  if (cell.p50 == null || !Number.isFinite(Number(cell.p50))) {
    base.unpriced_reason = "no_p50";
    return base;
  }
  const p50 = Number(cell.p50);
  const p25 = cell.p25 == null ? p50 : Number(cell.p25);
  const p75 = cell.p75 == null ? p50 : Number(cell.p75);
  base.priced = true;
  base.unpriced_reason = null;
  base.unit_p50 = p50;
  base.unit_p25 = p25;
  base.unit_p75 = p75;
  base.line_value_cents = remQty * p50;
  base.line_low_cents = remQty * p25;
  base.line_high_cents = remQty * p75;
  base.passport_grade = pg;
  return base;
}

export function realizedPnlCents(
  holding: HoldingRow,
  sales: SaleRow[],
): number {
  let total = 0;
  for (const s of sales) {
    if (s.holding_id !== holding.id) continue;
    const qty = Math.max(0, Number(s.qty) || 0);
    const price = Math.max(0, Number(s.price_cents) || 0);
    let fees = s.fees_cents;
    if (fees == null) {
      fees = computeEbayFeesCents(price).total_cents;
    }
    const costPer = holding.cost_cents == null ? 0 : Number(holding.cost_cents);
    // Net proceeds − cost of sold units. Unknown cost → treat sold cost as 0
    // but flag is handled at summary level via cost presence.
    total += price - Number(fees) - costPer * qty;
  }
  return total;
}

export function valuePortfolio(
  holdings: HoldingRow[],
  sales: SaleRow[],
  cells: LadderCell[],
): PortfolioSummary {
  const map = new Map<string, LadderCell>();
  for (const c of cells) {
    map.set(cellKey(c.print_id, c.grade_label), c);
  }
  const lines: ValuedHolding[] = [];
  let value = 0;
  let low = 0;
  let high = 0;
  let costKnown = 0;
  let costKnownQty = 0;
  let nPriced = 0;
  let nUnpriced = 0;
  let qtyPriced = 0;
  let qtyUnpriced = 0;
  let realized = 0;
  let hasKnownCostOnPriced = false;

  for (const h of holdings) {
    const rem = remainingQty(h, sales);
    const cell = lookupCell(map, h.print_id, h.grade_label);
    const valued = valueHolding(h, cell, rem);
    lines.push(valued);
    realized += realizedPnlCents(h, sales);
    if (rem <= 0) continue;
    if (valued.priced) {
      nPriced += 1;
      qtyPriced += rem;
      value += valued.line_value_cents || 0;
      low += valued.line_low_cents || 0;
      high += valued.line_high_cents || 0;
      if (h.cost_cents != null) {
        hasKnownCostOnPriced = true;
        costKnown += rem * Number(h.cost_cents);
        costKnownQty += rem;
      }
    } else if (valued.unpriced_reason !== "fully_sold") {
      nUnpriced += 1;
      qtyUnpriced += rem;
    }
  }

  return {
    n_holdings: holdings.length,
    n_priced: nPriced,
    n_unpriced: nUnpriced,
    qty_priced: qtyPriced,
    qty_unpriced: qtyUnpriced,
    value_cents: value,
    low_cents: low,
    high_cents: high,
    cost_basis_cents: costKnown,
    cost_basis_known_qty: costKnownQty,
    unrealized_cents: hasKnownCostOnPriced ? value - costKnown : null,
    realized_cents: realized,
    lines,
    unpriced: lines.filter(
      (l) => !l.priced && l.remaining_qty > 0 && l.unpriced_reason !== "fully_sold",
    ),
  };
}
