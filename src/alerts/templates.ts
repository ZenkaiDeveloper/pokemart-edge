import { assertNoBanned } from "./banned";
import type { AlertEventPayload } from "./evaluate";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "median_above":
      return "Median moved above your threshold";
    case "median_below":
      return "Median moved below your threshold";
    case "pct_move_7d":
      return "7-day median move";
    case "new_comp":
      return "New sold-evidence comps";
    case "passport_change":
      return "Price Passport grade changed";
    default:
      return "Sold-evidence update";
  }
}

export function renderAlertEmail(opts: {
  siteOrigin: string;
  items: AlertEventPayload[];
  unsubscribeUrl: string;
}): { subject: string; text: string; html: string } {
  const o = opts.siteOrigin.replace(/\/$/, "");
  const n = opts.items.length;
  const subject =
    n === 1
      ? `PokeMart alert: ${kindLabel(opts.items[0]!.kind)}`
      : `PokeMart daily digest: ${n} sold-evidence updates`;

  const lines: string[] = [
    n === 1 ? "A card you follow has a sold-evidence update." : "Your PokeMart daily digest:",
    "",
  ];
  const htmlParts: string[] = [
    `<p>${n === 1 ? "A card you follow has a sold-evidence update." : "Your PokeMart daily digest:"}</p>`,
    "<ul>",
  ];

  for (const it of opts.items) {
    const evidence = `${o}${it.evidence_path}`;
    const block =
      `${kindLabel(it.kind)} — ${it.print_id} / ${it.grade_label}\n` +
      `  median ${fmtUsd(it.p50)} · n=${it.n} · Passport ${it.passport_grade}\n` +
      `  ${it.capture_note}\n` +
      `  Evidence: ${evidence}\n`;
    lines.push(block);
    htmlParts.push(
      `<li><strong>${esc(kindLabel(it.kind))}</strong> — ` +
        `${esc(it.print_id)} / ${esc(it.grade_label)}<br>` +
        `median ${esc(fmtUsd(it.p50))} · n=${esc(String(it.n))} · Passport ${esc(it.passport_grade)}<br>` +
        `<span>${esc(it.capture_note)}</span><br>` +
        `<a href="${esc(evidence)}">Open evidence</a></li>`,
    );
  }
  htmlParts.push("</ul>");
  lines.push("", `Unsubscribe: ${opts.unsubscribeUrl}`);
  htmlParts.push(
    `<p><a href="${esc(opts.unsubscribeUrl)}">Unsubscribe</a> from alert emails.</p>`,
  );

  const text = lines.join("\n");
  const html = htmlParts.join("\n");
  assertNoBanned(subject + "\n" + text + "\n" + html);
  return { subject, text, html };
}

export function renderDiscordContent(
  siteOrigin: string,
  item: AlertEventPayload,
): string {
  const o = siteOrigin.replace(/\/$/, "");
  const body =
    `**${kindLabel(item.kind)}**\n` +
    `${item.print_id} / ${item.grade_label}\n` +
    `median ${fmtUsd(item.p50)} · n=${item.n} · Passport ${item.passport_grade}\n` +
    `${item.capture_note}\n` +
    `${o}${item.evidence_path}`;
  assertNoBanned(body);
  return body;
}

export function renderOptInEmail(opts: {
  confirmUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = "Confirm PokeMart sold-evidence alerts";
  const text =
    `Confirm you want sold-evidence alert emails from PokeMart (at most one digest per day).\n\n` +
    `${opts.confirmUrl}\n\n` +
    `If you did not request this, ignore this message.\n`;
  const html =
    `<p>Confirm you want sold-evidence alert emails from PokeMart ` +
    `(at most one digest per day).</p>` +
    `<p><a href="${esc(opts.confirmUrl)}">Confirm alerts</a></p>` +
    `<p>If you did not request this, ignore this message.</p>`;
  assertNoBanned(subject + text + html);
  return { subject, text, html };
}
