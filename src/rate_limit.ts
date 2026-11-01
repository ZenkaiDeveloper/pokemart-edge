import type { DbPort } from "./ports/db";
import { isoNow } from "./crypto_util";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Sliding fixed-hour window keyed in D1.
 * limit: max events per hour for `key`.
 */
export async function hitRateLimit(
  db: DbPort,
  key: string,
  limit: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const nowIso = isoNow(now);
  const hourStartMs = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const windowStart = isoNow(new Date(hourStartMs));
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: string; count: number }>();

  if (!row || row.window_start !== windowStart) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      )
      .bind(key, windowStart)
      .run();
    return { ok: true };
  }

  if (Number(row.count) >= limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((hourStartMs + 3_600_000 - now.getTime()) / 1000),
    );
    return { ok: false, retryAfterSec };
  }

  await db
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
    .bind(key)
    .run();
  // silence unused — nowIso kept for future logging
  void nowIso;
  return { ok: true };
}
