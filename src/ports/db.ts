/**
 * Thin D1 port so tests can swap in node:sqlite.
 * Keep Postgres-ready: callers talk to DbPort, not D1 SQL quirks beyond prepare/bind.
 */

export type SqlValue = string | number | null;

export interface DbStatement {
  bind(...values: SqlValue[]): DbStatement;
  first<T = Record<string, SqlValue>>(): Promise<T | null>;
  all<T = Record<string, SqlValue>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface DbPort {
  prepare(sql: string): DbStatement;
  batch?(statements: DbStatement[]): Promise<unknown[]>;
}

/** Cloudflare D1Database is already DbPort-shaped. */
export function asDb(db: D1Database): DbPort {
  return db as unknown as DbPort;
}

export async function countUserOwned(
  db: DbPort,
  userId: string,
): Promise<Record<string, number>> {
  const tables = [
    "login_tokens",
    "sessions",
    "consents",
    "alert_rule",
    "email_prefs",
    "rss_tokens",
    "alert_delivery_budget",
  ] as const;
  const out: Record<string, number> = { users: 0 };
  const u = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?")
    .bind(userId)
    .first<{ n: number }>();
  out.users = Number(u?.n || 0);
  for (const t of tables) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`)
      .bind(userId)
      .first<{ n: number }>();
    out[t] = Number(row?.n || 0);
  }
  return out;
}
