import type { DbPort } from "../ports/db";
import {
  addDays,
  isoNow,
  randomToken,
  sha256Hex,
} from "../crypto_util";

export const SESSION_COOKIE = "pm_session";

export type SessionRow = {
  session_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  ua_hash: string | null;
};

export function sessionCookieHeader(
  rawToken: string,
  maxAgeSec: number,
): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}; ` +
    `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
  );
}

export function clearSessionCookieHeader(): string {
  return (
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) {
      const v = decodeURIComponent(rest.join("=") || "");
      return v || null;
    }
  }
  return null;
}

export async function createSession(
  db: DbPort,
  userId: string,
  opts: { ttlDays: number; ua?: string | null; now?: Date },
): Promise<{ raw: string; expiresAt: string }> {
  const now = opts.now || new Date();
  const nowIso = isoNow(now);
  const expiresAt = addDays(nowIso, opts.ttlDays);
  const raw = await randomToken(32);
  const hash = await sha256Hex(raw);
  const uaHash = opts.ua ? await sha256Hex(opts.ua) : null;
  await db
    .prepare(
      `INSERT INTO sessions (session_hash, user_id, created_at, expires_at, ua_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(hash, userId, nowIso, expiresAt, uaHash)
    .run();
  return { raw, expiresAt };
}

export async function resolveSession(
  db: DbPort,
  rawToken: string | null,
  now: Date = new Date(),
): Promise<{ userId: string } | null> {
  if (!rawToken) return null;
  const hash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT user_id, expires_at FROM sessions WHERE session_hash = ?`,
    )
    .bind(hash)
    .first<{ user_id: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now.getTime()) {
    await db
      .prepare("DELETE FROM sessions WHERE session_hash = ?")
      .bind(hash)
      .run();
    return null;
  }
  return { userId: row.user_id };
}

export async function destroySession(
  db: DbPort,
  rawToken: string | null,
): Promise<void> {
  if (!rawToken) return;
  const hash = await sha256Hex(rawToken);
  await db
    .prepare("DELETE FROM sessions WHERE session_hash = ?")
    .bind(hash)
    .run();
}
