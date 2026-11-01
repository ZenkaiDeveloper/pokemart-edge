import type { DbPort } from "../ports/db";
import { isoNow, randomToken, sha256Hex } from "../crypto_util";

export type EmailPrefs = {
  user_id: string;
  digest_hour_utc: number | null;
  double_opt_in_at: string | null;
  unsubscribed_at: string | null;
  unsubscribe_token_hash: string | null;
};

export async function getEmailPrefs(
  db: DbPort,
  userId: string,
): Promise<EmailPrefs | null> {
  return db
    .prepare(
      `SELECT user_id, digest_hour_utc, double_opt_in_at, unsubscribed_at,
              unsubscribe_token_hash
       FROM email_prefs WHERE user_id = ?`,
    )
    .bind(userId)
    .first<EmailPrefs>();
}

export async function ensureEmailPrefs(
  db: DbPort,
  userId: string,
  now: Date = new Date(),
): Promise<{ prefs: EmailPrefs; rawUnsubToken: string | null }> {
  const existing = await getEmailPrefs(db, userId);
  if (existing) return { prefs: existing, rawUnsubToken: null };
  const raw = await randomToken(24);
  const hash = await sha256Hex(raw);
  await db
    .prepare(
      `INSERT INTO email_prefs (
         user_id, digest_hour_utc, double_opt_in_at, unsubscribed_at, unsubscribe_token_hash
       ) VALUES (?, 10, NULL, NULL, ?)`,
    )
    .bind(userId, hash)
    .run();
  return {
    prefs: {
      user_id: userId,
      digest_hour_utc: 10,
      double_opt_in_at: null,
      unsubscribed_at: null,
      unsubscribe_token_hash: hash,
    },
    rawUnsubToken: raw,
  };
}

export async function confirmDoubleOptIn(
  db: DbPort,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await ensureEmailPrefs(db, userId, now);
  await db
    .prepare(
      `UPDATE email_prefs
       SET double_opt_in_at = COALESCE(double_opt_in_at, ?),
           unsubscribed_at = NULL
       WHERE user_id = ?`,
    )
    .bind(isoNow(now), userId)
    .run();
}

export async function unsubscribeByToken(
  db: DbPort,
  rawToken: string,
  now: Date = new Date(),
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const hash = await sha256Hex(String(rawToken || "").trim());
  const row = await db
    .prepare(
      `SELECT user_id FROM email_prefs WHERE unsubscribe_token_hash = ?`,
    )
    .bind(hash)
    .first<{ user_id: string }>();
  if (!row) return { ok: false, error: "invalid_token" };
  await db
    .prepare(
      `UPDATE email_prefs SET unsubscribed_at = ? WHERE user_id = ?`,
    )
    .bind(isoNow(now), row.user_id)
    .run();
  return { ok: true, userId: row.user_id };
}

export async function rawUnsubscribeTokenForUser(
  db: DbPort,
  userId: string,
): Promise<string> {
  // Rotate token so UI can show a working link (hash-only at rest otherwise).
  const raw = await randomToken(24);
  const hash = await sha256Hex(raw);
  const existing = await getEmailPrefs(db, userId);
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO email_prefs (
           user_id, digest_hour_utc, double_opt_in_at, unsubscribed_at, unsubscribe_token_hash
         ) VALUES (?, 10, NULL, NULL, ?)`,
      )
      .bind(userId, hash)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE email_prefs SET unsubscribe_token_hash = ? WHERE user_id = ?`,
      )
      .bind(hash, userId)
      .run();
  }
  return raw;
}

export function canSendAlertEmail(prefs: EmailPrefs | null): boolean {
  if (!prefs) return false;
  if (prefs.unsubscribed_at) return false;
  if (!prefs.double_opt_in_at) return false;
  return true;
}
