import type { DbPort } from "../ports/db";
import { isoNow, randomToken, sha256Hex } from "../crypto_util";
import {
  encryptWebhookUrl,
  isValidDiscordWebhookUrl,
} from "./webhook_crypto";

export const FREE_RULE_CAP = 20;

export const ALERT_KINDS = [
  "median_above",
  "median_below",
  "pct_move_7d",
  "new_comp",
  "passport_change",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_CHANNELS = ["email", "discord_webhook", "rss"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type AlertRuleRow = {
  id: string;
  user_id: string;
  print_id: string;
  grade_label: string;
  kind: string;
  threshold: number | null;
  channel: string;
  webhook_url: string | null;
  created_at: string;
  disabled_at: string | null;
};

export function isAlertKind(k: string): k is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(k);
}

export function isAlertChannel(c: string): c is AlertChannel {
  return (ALERT_CHANNELS as readonly string[]).includes(c);
}

export async function countActiveRules(
  db: DbPort,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM alert_rule
       WHERE user_id = ? AND disabled_at IS NULL`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

export type CreateRuleInput = {
  db: DbPort;
  userId: string;
  printId: string;
  gradeLabel: string;
  kind: string;
  threshold?: number | null;
  channel: string;
  webhookUrl?: string | null;
  encSecret: string;
  tier?: string;
  now?: Date;
};

export type CreateRuleResult =
  | { ok: true; rule: AlertRuleRow }
  | { ok: false; status: number; error: string };

export async function createRule(
  input: CreateRuleInput,
): Promise<CreateRuleResult> {
  const printId = String(input.printId || "").trim();
  const gradeLabel = String(input.gradeLabel || "").trim();
  const kind = String(input.kind || "").trim();
  const channel = String(input.channel || "").trim();
  if (!printId || printId.length > 128) {
    return { ok: false, status: 400, error: "invalid_print_id" };
  }
  if (!gradeLabel || gradeLabel.length > 64) {
    return { ok: false, status: 400, error: "invalid_grade_label" };
  }
  if (!isAlertKind(kind)) {
    return { ok: false, status: 400, error: "invalid_kind" };
  }
  if (!isAlertChannel(channel)) {
    return { ok: false, status: 400, error: "invalid_channel" };
  }

  const needsThreshold =
    kind === "median_above" ||
    kind === "median_below" ||
    kind === "pct_move_7d";
  let threshold: number | null =
    input.threshold == null || input.threshold === undefined
      ? null
      : Number(input.threshold);
  if (needsThreshold) {
    if (threshold == null || !Number.isFinite(threshold)) {
      return { ok: false, status: 400, error: "threshold_required" };
    }
    threshold = Math.trunc(threshold);
  } else {
    threshold = null;
  }

  let webhookCipher: string | null = null;
  if (channel === "discord_webhook") {
    const url = String(input.webhookUrl || "").trim();
    if (!isValidDiscordWebhookUrl(url)) {
      return { ok: false, status: 400, error: "invalid_discord_webhook" };
    }
    webhookCipher = await encryptWebhookUrl(input.encSecret, url);
  } else if (input.webhookUrl) {
    return { ok: false, status: 400, error: "webhook_only_for_discord" };
  }

  const tier = (input.tier || "free").toLowerCase();
  if (tier === "free") {
    const n = await countActiveRules(input.db, input.userId);
    if (n >= FREE_RULE_CAP) {
      return {
        ok: false,
        status: 403,
        error: `rule_cap_exceeded: free accounts may have at most ${FREE_RULE_CAP} active alert rules`,
      };
    }
  }

  const now = input.now || new Date();
  const id = await randomToken(16);
  const createdAt = isoNow(now);
  await input.db
    .prepare(
      `INSERT INTO alert_rule (
         id, user_id, print_id, grade_label, kind, threshold,
         channel, webhook_url, created_at, disabled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      input.userId,
      printId,
      gradeLabel,
      kind,
      threshold,
      channel,
      webhookCipher,
      createdAt,
    )
    .run();

  if (channel === "rss") {
    await ensureRssToken(input.db, input.userId, now);
  }

  return {
    ok: true,
    rule: {
      id,
      user_id: input.userId,
      print_id: printId,
      grade_label: gradeLabel,
      kind,
      threshold,
      channel,
      webhook_url: webhookCipher ? "[encrypted]" : null,
      created_at: createdAt,
      disabled_at: null,
    },
  };
}

export async function listRules(
  db: DbPort,
  userId: string,
): Promise<AlertRuleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, print_id, grade_label, kind, threshold,
              channel, webhook_url, created_at, disabled_at
       FROM alert_rule WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<AlertRuleRow>();
  return (results || []).map((r) => ({
    ...r,
    webhook_url: r.webhook_url ? "[encrypted]" : null,
  }));
}

export async function disableRule(
  db: DbPort,
  userId: string,
  ruleId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM alert_rule WHERE id = ? AND user_id = ? AND disabled_at IS NULL`,
    )
    .bind(ruleId, userId)
    .first<{ id: string }>();
  if (!row) return false;
  await db
    .prepare(`UPDATE alert_rule SET disabled_at = ? WHERE id = ?`)
    .bind(isoNow(now), ruleId)
    .run();
  return true;
}

export async function ensureRssToken(
  db: DbPort,
  userId: string,
  now: Date = new Date(),
): Promise<{ raw: string; hash: string }> {
  const existing = await db
    .prepare(`SELECT token_hash FROM rss_tokens WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<{ token_hash: string }>();
  if (existing?.token_hash) {
    // Caller that needs the raw token must mint a new one — hashes only at rest.
    return { raw: "", hash: existing.token_hash };
  }
  const raw = await randomToken(24);
  const hash = await sha256Hex(raw);
  await db
    .prepare(
      `INSERT INTO rss_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)`,
    )
    .bind(hash, userId, isoNow(now))
    .run();
  return { raw, hash };
}

export async function mintRssToken(
  db: DbPort,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  await db.prepare(`DELETE FROM rss_tokens WHERE user_id = ?`).bind(userId).run();
  const raw = await randomToken(24);
  const hash = await sha256Hex(raw);
  await db
    .prepare(
      `INSERT INTO rss_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)`,
    )
    .bind(hash, userId, isoNow(now))
    .run();
  return raw;
}

export async function userIdForRssToken(
  db: DbPort,
  rawToken: string,
): Promise<string | null> {
  const hash = await sha256Hex(String(rawToken || "").trim());
  const row = await db
    .prepare(`SELECT user_id FROM rss_tokens WHERE token_hash = ?`)
    .bind(hash)
    .first<{ user_id: string }>();
  return row?.user_id || null;
}
