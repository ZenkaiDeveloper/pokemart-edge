import type { DbPort } from "../ports/db";
import { isoNow, randomToken, sha256Hex } from "../crypto_util";
import { listHoldings, listSalesForHoldings, loadLadderCells } from "./holdings";
import { valuePortfolio, type PortfolioSummary } from "./value";

export async function createShareLink(opts: {
  db: DbPort;
  userId: string;
  showCost?: boolean;
  now?: Date;
}): Promise<{ rawToken: string; tokenHash: string }> {
  // 128-bit token
  const raw = await randomToken(16);
  const hash = await sha256Hex(raw);
  await opts.db
    .prepare(
      `INSERT INTO share_link (token_hash, user_id, show_cost, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .bind(
      hash,
      opts.userId,
      opts.showCost ? 1 : 0,
      isoNow(opts.now || new Date()),
    )
    .run();
  return { rawToken: raw, tokenHash: hash };
}

export async function revokeShareLink(
  db: DbPort,
  userId: string,
  rawToken: string,
  now: Date = new Date(),
): Promise<boolean> {
  const hash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT token_hash FROM share_link
       WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .bind(hash, userId)
    .first<{ token_hash: string }>();
  if (!row) return false;
  await db
    .prepare(`UPDATE share_link SET revoked_at = ? WHERE token_hash = ?`)
    .bind(isoNow(now), hash)
    .run();
  return true;
}

export async function resolveShareView(
  db: DbPort,
  rawToken: string,
): Promise<
  | {
      ok: true;
      showCost: boolean;
      summary: PortfolioSummary;
      userId: string;
    }
  | { ok: false; status: number; error: string }
> {
  if (!rawToken) return { ok: false, status: 400, error: "missing_token" };
  const hash = await sha256Hex(rawToken);
  const link = await db
    .prepare(
      `SELECT user_id, show_cost, revoked_at FROM share_link WHERE token_hash = ?`,
    )
    .bind(hash)
    .first<{ user_id: string; show_cost: number; revoked_at: string | null }>();
  if (!link) return { ok: false, status: 404, error: "not_found" };
  if (link.revoked_at) return { ok: false, status: 410, error: "revoked" };
  const holdings = await listHoldings(db, link.user_id);
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
  const summary = valuePortfolio(holdings, sales, cells);
  if (!link.show_cost) {
    for (const line of summary.lines) {
      line.cost_cents = null;
      line.line_cost_cents = null;
    }
    summary.cost_basis_cents = 0;
    summary.unrealized_cents = null;
  }
  return {
    ok: true,
    showCost: Boolean(link.show_cost),
    summary,
    userId: link.user_id,
  };
}
