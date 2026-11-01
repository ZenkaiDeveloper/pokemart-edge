/**
 * Deliver pending alert events: email (digest / immediate), Discord, RSS (pull).
 * Caps: 1 digest email/user/day, 3 immediate threshold emails/user/day.
 */
import type { DbPort } from "../ports/db";
import type { EmailPort, EmailMessage } from "../email";
import { isoNow } from "../crypto_util";
import { decryptWebhookUrl, redactWebhookUrl } from "./webhook_crypto";
import type { AlertEventPayload } from "./evaluate";
import {
  renderAlertEmail,
  renderDiscordContent,
} from "./templates";
import { canSendAlertEmail, getEmailPrefs, rawUnsubscribeTokenForUser } from "./prefs";

const IMMEDIATE_KINDS = new Set([
  "median_above",
  "median_below",
  "pct_move_7d",
]);

const MAX_DIGEST_PER_DAY = 1;
const MAX_IMMEDIATE_PER_DAY = 3;

export type DeliverStats = {
  pending: number;
  sent: number;
  skipped: number;
  failed: number;
  writes: number;
};

async function getBudget(
  db: DbPort,
  userId: string,
  day: string,
): Promise<{ digest_sent: number; immediate_sent: number }> {
  const row = await db
    .prepare(
      `SELECT digest_sent, immediate_sent FROM alert_delivery_budget
       WHERE user_id = ? AND day = ?`,
    )
    .bind(userId, day)
    .first<{ digest_sent: number; immediate_sent: number }>();
  return {
    digest_sent: Number(row?.digest_sent || 0),
    immediate_sent: Number(row?.immediate_sent || 0),
  };
}

async function bumpBudget(
  db: DbPort,
  userId: string,
  day: string,
  field: "digest_sent" | "immediate_sent",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_delivery_budget (user_id, day, digest_sent, immediate_sent)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         digest_sent = alert_delivery_budget.digest_sent + excluded.digest_sent,
         immediate_sent = alert_delivery_budget.immediate_sent + excluded.immediate_sent`,
    )
    .bind(
      userId,
      day,
      field === "digest_sent" ? 1 : 0,
      field === "immediate_sent" ? 1 : 0,
    )
    .run();
}

async function markDelivery(
  db: DbPort,
  eventId: string,
  channel: string,
  status: string,
  now: Date,
  providerId?: string | null,
  error?: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE delivery SET status = ?, provider_id = ?, attempted_at = ?, error = ?
       WHERE event_id = ? AND channel = ?`,
    )
    .bind(
      status,
      providerId || null,
      isoNow(now),
      error || null,
      eventId,
      channel,
    )
    .run();
}

export type PendingRow = {
  event_id: string;
  channel: string;
  rule_id: string;
  user_id: string;
  kind: string;
  payload_json: string;
  user_email: string;
  webhook_cipher: string | null;
};

export async function loadPending(db: DbPort): Promise<PendingRow[]> {
  // Events with no delivery row yet, or an explicit pending row.
  const { results } = await db
    .prepare(
      `SELECT e.id AS event_id, r.channel AS channel,
              e.rule_id AS rule_id, e.payload_json AS payload_json,
              r.user_id AS user_id, r.kind AS kind,
              r.webhook_url AS webhook_cipher,
              u.email AS user_email
       FROM alert_event e
       JOIN alert_rule r ON r.id = e.rule_id
       JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
       LEFT JOIN delivery d ON d.event_id = e.id AND d.channel = r.channel
       WHERE d.event_id IS NULL OR d.status = 'pending'
       ORDER BY e.created_at ASC`,
    )
    .all<PendingRow>();
  return results || [];
}

async function ensurePendingDelivery(
  db: DbPort,
  eventId: string,
  channel: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO delivery (event_id, channel, status, provider_id, attempted_at, error)
       VALUES (?, ?, 'pending', NULL, NULL, NULL)
       ON CONFLICT(event_id, channel) DO NOTHING`,
    )
    .bind(eventId, channel)
    .run();
}

async function sendDiscord(
  webhookUrl: string,
  content: string,
): Promise<{ ok: true; providerId: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        error: `discord ${res.status}: ${body.slice(0, 120)} (${redactWebhookUrl(webhookUrl)})`,
      };
    }
    return { ok: true, providerId: `discord-${res.status}` };
  } catch (err) {
    return { ok: false, error: `discord_fetch: ${String(err).slice(0, 120)}` };
  }
}

export async function deliverPending(
  db: DbPort,
  opts: {
    emailPort: EmailPort;
    encSecret: string;
    siteOrigin: string;
    now?: Date;
    /** Extra headers for List-Unsubscribe (provider-dependent). */
    sendEmail?: (msg: EmailMessage & { headers?: Record<string, string> }) => Promise<{
      ok: boolean;
      providerId?: string;
      error?: string;
    }>;
  },
): Promise<DeliverStats> {
  const now = opts.now || new Date();
  const day = isoNow(now).slice(0, 10);
  const stats: DeliverStats = {
    pending: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    writes: 0,
  };

  const pending = await loadPending(db);
  stats.pending = pending.length;
  for (const row of pending) {
    await ensurePendingDelivery(db, row.event_id, row.channel);
    stats.writes += 1;
  }

  // Group email digests (non-immediate) per user; send immediate separately.
  const digestBuckets = new Map<string, PendingRow[]>();
  const immediate: PendingRow[] = [];
  const discord: PendingRow[] = [];
  const rss: PendingRow[] = [];

  for (const row of pending) {
    if (row.channel === "discord_webhook") discord.push(row);
    else if (row.channel === "rss") rss.push(row);
    else if (row.channel === "email") {
      if (IMMEDIATE_KINDS.has(row.kind)) immediate.push(row);
      else {
        const list = digestBuckets.get(row.user_id) || [];
        list.push(row);
        digestBuckets.set(row.user_id, list);
      }
    } else {
      await markDelivery(db, row.event_id, row.channel, "skipped", now, null, "unknown_channel");
      stats.skipped += 1;
      stats.writes += 1;
    }
  }

  const mail =
    opts.sendEmail ||
    (async (msg) => {
      const r = await opts.emailPort.send(msg);
      return r.ok
        ? { ok: true, providerId: r.providerId }
        : { ok: false, error: r.error };
    });

  // Immediate threshold emails
  for (const row of immediate) {
    const prefs = await getEmailPrefs(db, row.user_id);
    if (!canSendAlertEmail(prefs)) {
      await markDelivery(
        db,
        row.event_id,
        "email",
        "skipped",
        now,
        null,
        prefs?.unsubscribed_at
          ? "unsubscribed"
          : "double_opt_in_required",
      );
      stats.skipped += 1;
      stats.writes += 1;
      continue;
    }
    const budget = await getBudget(db, row.user_id, day);
    if (budget.immediate_sent >= MAX_IMMEDIATE_PER_DAY) {
      await markDelivery(db, row.event_id, "email", "skipped", now, null, "immediate_cap");
      stats.skipped += 1;
      stats.writes += 1;
      continue;
    }
    const payload = JSON.parse(row.payload_json) as AlertEventPayload;
    const unsubRaw = await rawUnsubscribeTokenForUser(db, row.user_id);
    const unsubUrl = `${opts.siteOrigin.replace(/\/$/, "")}/account/unsubscribe?token=${encodeURIComponent(unsubRaw)}`;
    const body = renderAlertEmail({
      siteOrigin: opts.siteOrigin,
      items: [payload],
      unsubscribeUrl: unsubUrl,
    });
    const sent = await mail({
      to: row.user_email,
      subject: body.subject,
      text: body.text,
      html: body.html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (sent.ok) {
      await markDelivery(db, row.event_id, "email", "sent", now, sent.providerId || null);
      await bumpBudget(db, row.user_id, day, "immediate_sent");
      stats.sent += 1;
      stats.writes += 2;
    } else {
      await markDelivery(db, row.event_id, "email", "failed", now, null, sent.error || "send_failed");
      stats.failed += 1;
      stats.writes += 1;
    }
  }

  // Digests
  for (const [userId, rows] of digestBuckets) {
    const prefs = await getEmailPrefs(db, userId);
    if (!canSendAlertEmail(prefs)) {
      for (const row of rows) {
        await markDelivery(
          db,
          row.event_id,
          "email",
          "skipped",
          now,
          null,
          prefs?.unsubscribed_at ? "unsubscribed" : "double_opt_in_required",
        );
        stats.skipped += 1;
        stats.writes += 1;
      }
      continue;
    }
    const budget = await getBudget(db, userId, day);
    if (budget.digest_sent >= MAX_DIGEST_PER_DAY) {
      for (const row of rows) {
        await markDelivery(db, row.event_id, "email", "skipped", now, null, "digest_cap");
        stats.skipped += 1;
        stats.writes += 1;
      }
      continue;
    }
    const items = rows.map((r) => JSON.parse(r.payload_json) as AlertEventPayload);
    const unsubRaw = await rawUnsubscribeTokenForUser(db, userId);
    const unsubUrl = `${opts.siteOrigin.replace(/\/$/, "")}/account/unsubscribe?token=${encodeURIComponent(unsubRaw)}`;
    const body = renderAlertEmail({
      siteOrigin: opts.siteOrigin,
      items,
      unsubscribeUrl: unsubUrl,
    });
    const sent = await mail({
      to: rows[0]!.user_email,
      subject: body.subject,
      text: body.text,
      html: body.html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (sent.ok) {
      for (const row of rows) {
        await markDelivery(db, row.event_id, "email", "sent", now, sent.providerId || null);
        stats.sent += 1;
        stats.writes += 1;
      }
      await bumpBudget(db, userId, day, "digest_sent");
      stats.writes += 1;
    } else {
      for (const row of rows) {
        await markDelivery(db, row.event_id, "email", "failed", now, null, sent.error || "send_failed");
        stats.failed += 1;
        stats.writes += 1;
      }
    }
  }

  // Discord
  for (const row of discord) {
    if (!row.webhook_cipher) {
      await markDelivery(db, row.event_id, "discord_webhook", "failed", now, null, "missing_webhook");
      stats.failed += 1;
      stats.writes += 1;
      continue;
    }
    let url: string;
    try {
      url = await decryptWebhookUrl(opts.encSecret, row.webhook_cipher);
    } catch {
      await markDelivery(db, row.event_id, "discord_webhook", "failed", now, null, "decrypt_failed");
      stats.failed += 1;
      stats.writes += 1;
      continue;
    }
    const payload = JSON.parse(row.payload_json) as AlertEventPayload;
    const content = renderDiscordContent(opts.siteOrigin, payload);
    const sent = await sendDiscord(url, content);
    if (sent.ok) {
      await markDelivery(db, row.event_id, "discord_webhook", "sent", now, sent.providerId);
      stats.sent += 1;
      stats.writes += 1;
    } else {
      await markDelivery(db, row.event_id, "discord_webhook", "failed", now, null, sent.error);
      stats.failed += 1;
      stats.writes += 1;
    }
  }

  // RSS is pull-based — mark delivered so cron does not retry; feed reads alert_event.
  for (const row of rss) {
    await markDelivery(db, row.event_id, "rss", "sent", now, "rss-feed");
    stats.sent += 1;
    stats.writes += 1;
  }

  return stats;
}

export { MAX_DIGEST_PER_DAY, MAX_IMMEDIATE_PER_DAY, IMMEDIATE_KINDS };
