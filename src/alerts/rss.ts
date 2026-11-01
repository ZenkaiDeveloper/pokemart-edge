import type { DbPort } from "../ports/db";
import { userIdForRssToken } from "./rules";
import { kindLabel } from "./templates";
import type { AlertEventPayload } from "./evaluate";

function escXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function buildUserRss(
  db: DbPort,
  opts: { rawToken: string; siteOrigin: string; limit?: number },
): Promise<{ ok: true; xml: string } | { ok: false; status: number; error: string }> {
  const userId = await userIdForRssToken(db, opts.rawToken);
  if (!userId) return { ok: false, status: 404, error: "invalid_token" };
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const { results } = await db
    .prepare(
      `SELECT e.id, e.payload_json, e.created_at, e.snapshot_date
       FROM alert_event e
       JOIN alert_rule r ON r.id = e.rule_id
       WHERE r.user_id = ? AND r.channel = 'rss' AND r.disabled_at IS NULL
       ORDER BY e.created_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<{
      id: string;
      payload_json: string;
      created_at: string;
      snapshot_date: string;
    }>();

  const o = opts.siteOrigin.replace(/\/$/, "");
  const items = (results || [])
    .map((row) => {
      const p = JSON.parse(row.payload_json) as AlertEventPayload;
      const title = `${kindLabel(p.kind)} — ${p.print_id} / ${p.grade_label}`;
      const link = `${o}${p.evidence_path}`;
      const desc =
        `median n=${p.n}, Passport ${p.passport_grade}. ${p.capture_note}`;
      return (
        `<item>` +
        `<title>${escXml(title)}</title>` +
        `<link>${escXml(link)}</link>` +
        `<guid isPermaLink="false">${escXml(row.id)}</guid>` +
        `<pubDate>${escXml(row.created_at)}</pubDate>` +
        `<description>${escXml(desc)}</description>` +
        `</item>`
      );
    })
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0"><channel>` +
    `<title>PokeMart sold-evidence alerts</title>` +
    `<link>${escXml(o)}/account/alerts</link>` +
    `<description>Private RSS feed of sold-evidence changes for cards you follow.</description>` +
    items +
    `</channel></rss>`;
  return { ok: true, xml };
}
