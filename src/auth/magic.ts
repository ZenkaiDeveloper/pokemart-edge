import type { DbPort } from "../ports/db";
import type { EmailPort } from "../email";
import { magicLinkEmailBody } from "../email";
import { hitRateLimit } from "../rate_limit";
import {
  addMinutes,
  isoNow,
  randomToken,
  sha256Hex,
} from "../crypto_util";
import {
  createSession,
  sessionCookieHeader,
} from "./session";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const e = String(raw || "")
    .trim()
    .toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

export async function ensureUser(
  db: DbPort,
  email: string,
  now: Date = new Date(),
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL")
    .bind(email)
    .first<{ id: string }>();
  if (existing?.id) return { id: existing.id, created: false };
  const id = await randomToken(16);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified_at, created_at, tier)
       VALUES (?, ?, NULL, ?, 'free')`,
    )
    .bind(id, email, isoNow(now))
    .run();
  return { id, created: true };
}

export type RequestLinkOpts = {
  db: DbPort;
  emailPort: EmailPort;
  email: string;
  ip: string;
  origin: string;
  ttlMinutes: number;
  emailLimit: number;
  ipLimit: number;
  now?: Date;
  /** Test hook: return raw token instead of only emailing. */
  exposeToken?: boolean;
};

export type RequestLinkResult =
  | { ok: true; emailed: boolean; rawToken?: string }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

export async function requestMagicLink(
  opts: RequestLinkOpts,
): Promise<RequestLinkResult> {
  const email = normalizeEmail(opts.email);
  if (!email) return { ok: false, status: 400, error: "invalid_email" };
  const now = opts.now || new Date();

  const ipHit = await hitRateLimit(
    opts.db,
    `ip:${opts.ip}`,
    opts.ipLimit,
    now,
  );
  if (!ipHit.ok) {
    return {
      ok: false,
      status: 429,
      error: "rate_limited_ip",
      retryAfterSec: ipHit.retryAfterSec,
    };
  }
  const emailHit = await hitRateLimit(
    opts.db,
    `email:${email}`,
    opts.emailLimit,
    now,
  );
  if (!emailHit.ok) {
    return {
      ok: false,
      status: 429,
      error: "rate_limited_email",
      retryAfterSec: emailHit.retryAfterSec,
    };
  }

  const user = await ensureUser(opts.db, email, now);
  const raw = await randomToken(32); // 256-bit
  const hash = await sha256Hex(raw);
  const expiresAt = addMinutes(isoNow(now), opts.ttlMinutes);
  await opts.db
    .prepare(
      `INSERT INTO login_tokens (token_hash, user_id, expires_at, used_at)
       VALUES (?, ?, ?, NULL)`,
    )
    .bind(hash, user.id, expiresAt)
    .run();

  const link = `${opts.origin.replace(/\/$/, "")}/account/verify?token=${encodeURIComponent(raw)}`;
  const body = magicLinkEmailBody({ link, minutes: opts.ttlMinutes });
  const sent = await opts.emailPort.send({
    to: email,
    subject: body.subject,
    text: body.text,
    html: body.html,
  });
  if (!sent.ok) {
    return { ok: false, status: 502, error: sent.error };
  }
  const out: RequestLinkResult = { ok: true, emailed: true };
  if (opts.exposeToken) (out as { rawToken?: string }).rawToken = raw;
  return out;
}

export type VerifyOpts = {
  db: DbPort;
  token: string;
  ttlDays: number;
  ua?: string | null;
  now?: Date;
};

export type VerifyResult =
  | {
      ok: true;
      userId: string;
      cookie: string;
    }
  | { ok: false; status: number; error: string };

export async function verifyMagicLink(
  opts: VerifyOpts,
): Promise<VerifyResult> {
  const raw = String(opts.token || "").trim();
  if (!raw) return { ok: false, status: 400, error: "missing_token" };
  const now = opts.now || new Date();
  const hash = await sha256Hex(raw);
  const row = await opts.db
    .prepare(
      `SELECT user_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?`,
    )
    .bind(hash)
    .first<{ user_id: string; expires_at: string; used_at: string | null }>();
  if (!row) return { ok: false, status: 400, error: "invalid_token" };
  if (row.used_at) return { ok: false, status: 400, error: "token_reused" };
  if (Date.parse(row.expires_at) <= now.getTime()) {
    return { ok: false, status: 400, error: "token_expired" };
  }

  await opts.db
    .prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?")
    .bind(isoNow(now), hash)
    .run();
  await opts.db
    .prepare(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
    )
    .bind(isoNow(now), row.user_id)
    .run();

  const session = await createSession(opts.db, row.user_id, {
    ttlDays: opts.ttlDays,
    ua: opts.ua,
    now,
  });
  const maxAge = opts.ttlDays * 86_400;
  return {
    ok: true,
    userId: row.user_id,
    cookie: sessionCookieHeader(session.raw, maxAge),
  };
}

/** Hard-delete user + every dependent row that carries user_id. */
export async function hardDeleteUser(
  db: DbPort,
  userId: string,
): Promise<void> {
  // Alert events/deliveries for this user's rules
  const { results: rules } = await db
    .prepare(`SELECT id FROM alert_rule WHERE user_id = ?`)
    .bind(userId)
    .all<{ id: string }>();
  for (const r of rules || []) {
    const { results: events } = await db
      .prepare(`SELECT id FROM alert_event WHERE rule_id = ?`)
      .bind(r.id)
      .all<{ id: string }>();
    for (const e of events || []) {
      await db.prepare(`DELETE FROM delivery WHERE event_id = ?`).bind(e.id).run();
    }
    await db.prepare(`DELETE FROM alert_event WHERE rule_id = ?`).bind(r.id).run();
  }
  await db.prepare("DELETE FROM alert_rule WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM email_prefs WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM rss_tokens WHERE user_id = ?").bind(userId).run();
  await db
    .prepare("DELETE FROM alert_delivery_budget WHERE user_id = ?")
    .bind(userId)
    .run();
  await db.prepare("DELETE FROM login_tokens WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM consents WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}
