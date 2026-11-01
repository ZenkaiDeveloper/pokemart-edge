/** Minimal account UI — no marketing, no trackers, links to static privacy/terms. */

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function layout(opts: {
  title: string;
  body: string;
  siteOrigin: string;
}): string {
  const o = opts.siteOrigin.replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${esc(opts.title)} — PokeMart</title>
  <style>
    :root { --ink:#1a1a18; --muted:#5c5a54; --line:#e4e0d8; --bg:#f7f5f0; --accent:#0b6e4f; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.5 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      color:var(--ink); background:linear-gradient(180deg,#f3f0e8 0%,var(--bg) 40%,#efebe3 100%); min-height:100vh; }
    main { max-width:28rem; margin:0 auto; padding:2.5rem 1.25rem 4rem; }
    h1 { font-size:1.75rem; letter-spacing:-0.02em; margin:0 0 .5rem; }
    .brand { font-weight:700; font-size:1.1rem; margin-bottom:2rem; display:block; color:var(--ink); text-decoration:none; }
    .brand span { color:var(--accent); }
    p, label { color:var(--muted); }
    form { display:grid; gap:.75rem; margin:1.25rem 0; }
    input[type=email] { font:inherit; padding:.65rem .75rem; border:1px solid var(--line); border-radius:4px; background:#fff; }
    button, .btn { font:inherit; padding:.65rem 1rem; border:0; border-radius:4px; background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; display:inline-block; text-align:center; }
    button.danger { background:#8b2e2e; }
    .msg { padding:.75rem; border:1px solid var(--line); background:#fff; border-radius:4px; }
    .msg.err { border-color:#c45; color:#8b2e2e; }
    .foot { margin-top:2.5rem; font-size:.85rem; }
    .foot a { color:var(--accent); }
    hr { border:0; border-top:1px solid var(--line); margin:1.5rem 0; }
  </style>
</head>
<body>
  <main>
    <a class="brand" href="${esc(o)}/">Poke<span>Mart</span></a>
    ${opts.body}
    <p class="foot">
      <a href="${esc(o)}/privacy/">Privacy</a> ·
      <a href="${esc(o)}/terms/">Terms</a> ·
      <a href="${esc(o)}/">Back to guides</a>
    </p>
  </main>
</body>
</html>`;
}

export function loginPage(opts: {
  siteOrigin: string;
  notice?: string;
  error?: string;
}): string {
  const notice = opts.notice
    ? `<p class="msg">${esc(opts.notice)}</p>`
    : "";
  const error = opts.error
    ? `<p class="msg err">${esc(opts.error)}</p>`
    : "";
  return layout({
    title: "Sign in",
    siteOrigin: opts.siteOrigin,
    body: `
      <h1>Sign in</h1>
      <p>Email a one-time link. No passwords. Session cookie lasts 30 days.</p>
      ${notice}${error}
      <form method="post" action="/account/login">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" maxlength="254">
        <button type="submit">Email me a link</button>
      </form>
      <p>By continuing you agree to the <a href="${esc(opts.siteOrigin)}/terms/">Terms</a>
         and <a href="${esc(opts.siteOrigin)}/privacy/">Privacy</a> pages.</p>
    `,
  });
}

export function accountPage(opts: {
  siteOrigin: string;
  email: string;
}): string {
  return layout({
    title: "Account",
    siteOrigin: opts.siteOrigin,
    body: `
      <h1>Your account</h1>
      <p>Signed in as <strong>${esc(opts.email)}</strong>.</p>
      <p><a class="btn" href="/account/portfolio">Portfolio</a></p>
      <p><a class="btn" href="/account/alerts">Sold-evidence alerts</a></p>
      <p>Portfolio values Passport A–C cells only. Alerts fire on sold-evidence changes, at most daily.</p>
      <form method="post" action="/account/logout"><button type="submit">Sign out</button></form>
      <hr>
      <form method="post" action="/account/delete"
            onsubmit="return confirm('Permanently delete your account and all related data?');">
        <p>Delete removes your user row and every dependent record in this request.</p>
        <button class="danger" type="submit">Delete account</button>
      </form>
    `,
  });
}

export type AlertRuleView = {
  id: string;
  print_id: string;
  grade_label: string;
  kind: string;
  threshold: number | null;
  channel: string;
  disabled_at: string | null;
};

export function alertsPage(opts: {
  siteOrigin: string;
  email: string;
  rules: AlertRuleView[];
  emailOptedIn: boolean;
  emailUnsubscribed: boolean;
  rssUrl?: string | null;
  notice?: string;
  error?: string;
  prefill?: { print_id?: string; grade_label?: string };
}): string {
  const notice = opts.notice ? `<p class="msg">${esc(opts.notice)}</p>` : "";
  const error = opts.error ? `<p class="msg err">${esc(opts.error)}</p>` : "";
  const status = opts.emailUnsubscribed
    ? `<p class="msg">Email alerts are unsubscribed. Create a rule and confirm again to re-enable.</p>`
    : opts.emailOptedIn
      ? `<p class="msg">Email alerts confirmed (double opt-in).</p>`
      : `<p class="msg">Email alerts need a one-time confirmation before anything is sent.</p>`;

  const rows = opts.rules.length
    ? `<ul>${opts.rules
        .map((r) => {
          const th =
            r.threshold == null
              ? ""
              : r.kind === "pct_move_7d"
                ? ` · ${r.threshold} bps`
                : ` · $${(Number(r.threshold) / 100).toFixed(2)}`;
          const dis = r.disabled_at ? " (disabled)" : "";
          return (
            `<li><code>${esc(r.print_id)}</code> / ${esc(r.grade_label)} — ` +
            `${esc(r.kind)}${esc(th)} via ${esc(r.channel)}${esc(dis)}` +
            (r.disabled_at
              ? ""
              : ` <form style="display:inline" method="post" action="/account/alerts/disable">` +
                `<input type="hidden" name="id" value="${esc(r.id)}">` +
                `<button type="submit">Disable</button></form>`) +
            `</li>`
          );
        })
        .join("")}</ul>`
    : `<p>No alert rules yet. Follow cards on <a href="/watch/">Watch</a>, then create a rule below.</p>`;

  const prefPrint = esc(opts.prefill?.print_id || "");
  const prefGrade = esc(opts.prefill?.grade_label || "Ungraded");
  const rss = opts.rssUrl
    ? `<p>Your private RSS feed: <a href="${esc(opts.rssUrl)}">${esc(opts.rssUrl)}</a></p>`
    : "";

  return layout({
    title: "Alerts",
    siteOrigin: opts.siteOrigin,
    body: `
      <h1>Sold-evidence alerts</h1>
      <p>Email, Discord webhook, or private RSS when a followed card’s Passport A–C median or evidence changes. At most one digest email per day. No live-listing or restock alerts.</p>
      ${notice}${error}${status}
      <p>Signed in as ${esc(opts.email)}. <a href="/account/">Account</a> · <a href="/help/alerts/">How alerts work</a></p>
      <h2>Your rules (${opts.rules.filter((r) => !r.disabled_at).length} / 20 free)</h2>
      ${rows}
      <hr>
      <h2>Create alert</h2>
      <form method="post" action="/account/alerts">
        <label for="print_id">Print id</label>
        <input id="print_id" name="print_id" required maxlength="128" value="${prefPrint}"
               placeholder="from Watch / card page">
        <label for="grade_label">Grade label</label>
        <input id="grade_label" name="grade_label" required maxlength="64" value="${prefGrade}">
        <label for="kind">Kind</label>
        <select id="kind" name="kind">
          <option value="median_above">Median above (cents)</option>
          <option value="median_below">Median below (cents)</option>
          <option value="pct_move_7d">7-day % move (basis points)</option>
          <option value="new_comp">New comps</option>
          <option value="passport_change">Passport grade change</option>
        </select>
        <label for="threshold">Threshold (cents or bps; blank for new_comp / passport_change)</label>
        <input id="threshold" name="threshold" inputmode="numeric" placeholder="e.g. 5000 or 1000">
        <label for="channel">Channel</label>
        <select id="channel" name="channel">
          <option value="email">Email</option>
          <option value="discord_webhook">Discord webhook</option>
          <option value="rss">Private RSS</option>
        </select>
        <label for="webhook_url">Discord webhook URL (Discord channel only)</label>
        <input id="webhook_url" name="webhook_url" type="url" maxlength="300"
               placeholder="https://discord.com/api/webhooks/…">
        <button type="submit">Create alert</button>
      </form>
      <form method="post" action="/account/alerts/opt-in" style="margin-top:1rem">
        <button type="submit">Send email confirmation (double opt-in)</button>
      </form>
      <form method="post" action="/account/alerts/rss-token" style="margin-top:.5rem">
        <button type="submit">Mint / rotate RSS token</button>
      </form>
      ${rss}
    `,
  });
}

export function unsubscribePage(opts: {
  siteOrigin: string;
  ok?: boolean;
  error?: string;
}): string {
  if (opts.ok) {
    return layout({
      title: "Unsubscribed",
      siteOrigin: opts.siteOrigin,
      body: `<h1>Unsubscribed</h1><p>You will not receive further alert emails. Sign in anytime to re-confirm.</p>`,
    });
  }
  return layout({
    title: "Unsubscribe",
    siteOrigin: opts.siteOrigin,
    body: `<h1>Unsubscribe</h1><p class="msg err">${esc(opts.error || "Invalid link.")}</p>`,
  });
}

export type PortfolioLineView = {
  id: string;
  print_id: string;
  grade_label: string;
  qty: number;
  remaining_qty: number;
  cost_cents: number | null;
  priced: boolean;
  unpriced_reason: string | null;
  line_value_cents: number | null;
  line_low_cents: number | null;
  line_high_cents: number | null;
  passport_grade: string | null;
};

function usd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(Number(cents))) return "—";
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function portfolioPage(opts: {
  siteOrigin: string;
  email: string;
  summary: {
    n_priced: number;
    n_unpriced: number;
    value_cents: number;
    low_cents: number;
    high_cents: number;
    cost_basis_cents: number;
    unrealized_cents: number | null;
    realized_cents: number;
  };
  lines: PortfolioLineView[];
  shareUrl?: string | null;
  notice?: string;
  error?: string;
  readOnly?: boolean;
  showCost?: boolean;
}): string {
  const notice = opts.notice ? `<p class="msg">${esc(opts.notice)}</p>` : "";
  const error = opts.error ? `<p class="msg err">${esc(opts.error)}</p>` : "";
  const totalLabel = `Priced ${opts.summary.n_priced} of ${
    opts.summary.n_priced + opts.summary.n_unpriced
  } items`;
  const costBit =
    opts.showCost === false
      ? ""
      : `<p>Cost basis (priced, known): <strong>${usd(opts.summary.cost_basis_cents)}</strong>
         · Unrealized: <strong>${usd(opts.summary.unrealized_cents)}</strong>
         · Realized: <strong>${usd(opts.summary.realized_cents)}</strong></p>`;
  const rows = opts.lines.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:.9rem">
        <thead><tr>
          <th align="left">Print</th><th>Grade</th><th>Qty</th>
          ${opts.showCost === false ? "" : "<th>Cost</th>"}
          <th>Value</th><th>Passport</th><th></th>
        </tr></thead><tbody>${opts.lines
          .map((l) => {
            const val = l.priced
              ? `${usd(l.line_value_cents)} <span style="color:var(--muted)">(${usd(l.line_low_cents)}–${usd(l.line_high_cents)})</span>`
              : `<em>unpriced</em>${l.unpriced_reason ? ` · ${esc(l.unpriced_reason)}` : ""}`;
            const cost =
              opts.showCost === false
                ? ""
                : `<td align="right">${usd(
                    l.cost_cents == null
                      ? null
                      : l.cost_cents * l.remaining_qty,
                  )}</td>`;
            const del =
              opts.readOnly
                ? ""
                : `<td><form style="display:inline" method="post" action="/account/portfolio/delete">
                     <input type="hidden" name="id" value="${esc(l.id)}">
                     <button type="submit">Remove</button></form></td>`;
            return `<tr style="border-top:1px solid var(--line)">
              <td><code>${esc(l.print_id)}</code></td>
              <td align="center">${esc(l.grade_label)}</td>
              <td align="center">${l.remaining_qty}/${l.qty}</td>
              ${cost}
              <td align="right">${val}</td>
              <td align="center">${esc(l.passport_grade || "—")}</td>
              ${del}
            </tr>`;
          })
          .join("")}</tbody></table>`
    : `<p>No holdings yet. Add a row below, import CSV, or migrate your browser Watch/Collection.</p>`;

  const forms = opts.readOnly
    ? ""
    : `
      <hr>
      <h2>Add holding</h2>
      <form method="post" action="/account/portfolio">
        <label for="print_id">Print id</label>
        <input id="print_id" name="print_id" required maxlength="256" placeholder="card key / print id">
        <label for="grade_label">Grade label</label>
        <input id="grade_label" name="grade_label" value="Ungraded" maxlength="64">
        <label for="qty">Qty</label>
        <input id="qty" name="qty" type="number" min="1" max="9999" value="1">
        <label for="cost_cents">Cost per unit (cents, blank = unknown)</label>
        <input id="cost_cents" name="cost_cents" inputmode="numeric" placeholder="e.g. 1250">
        <label for="acquired_on">Acquired on (YYYY-MM-DD)</label>
        <input id="acquired_on" name="acquired_on" placeholder="2026-10-01">
        <button type="submit">Add</button>
      </form>
      <hr>
      <h2>Import CSV</h2>
      <p>Generic template: <code>print_id,grade_label,qty,cost_cents</code>. We do not promise Collectr/TCGplayer layouts until sample files are reviewed.</p>
      <form method="post" action="/account/portfolio/import" enctype="multipart/form-data">
        <input type="file" name="file" accept=".csv,text/csv" required>
        <button type="submit">Import</button>
      </form>
      <p><a href="/account/portfolio/export.csv">Export CSV</a></p>
      <hr>
      <h2>Migrate browser lists</h2>
      <p>Paste <code>pokemart_watchlist_v1</code> or <code>pokemart_collection_v1</code> JSON (from Watch / Collection export).</p>
      <form method="post" action="/account/portfolio/migrate">
        <label for="local_json">JSON</label>
        <textarea id="local_json" name="local_json" rows="6" style="font:inherit;width:100%;padding:.5rem;border:1px solid var(--line);border-radius:4px"></textarea>
        <button type="submit">Migrate into portfolio</button>
      </form>
      <hr>
      <h2>Share (read-only)</h2>
      <form method="post" action="/account/portfolio/share">
        <label><input type="checkbox" name="show_cost" value="1"> Include cost basis on the shared view</label>
        <button type="submit">Create share link</button>
      </form>
      ${
        opts.shareUrl
          ? `<p class="msg">Share URL (save it): <a href="${esc(opts.shareUrl)}">${esc(opts.shareUrl)}</a></p>`
          : ""
      }
      <form method="post" action="/account/portfolio/clear"
            onsubmit="return confirm('Soft-delete all holdings?');">
        <button class="danger" type="submit">Clear all holdings</button>
      </form>
    `;

  return layout({
    title: opts.readOnly ? "Shared portfolio" : "Portfolio",
    siteOrigin: opts.siteOrigin,
    body: `
      <h1>${opts.readOnly ? "Shared portfolio" : "Portfolio"}</h1>
      <p>Values use sold medians only when Price Passport is <strong>A–C</strong>. D-grade and missing cells stay <em>unpriced</em> — never zero, never guessed. ${esc(totalLabel)}.</p>
      ${notice}${error}
      ${
        opts.readOnly
          ? ""
          : `<p>Signed in as ${esc(opts.email)}. <a href="/account/">Account</a> · <a href="/help/portfolio/">How portfolio works</a> · <a href="/collection/">Browser Collection</a></p>`
      }
      <p>Value: <strong>${usd(opts.summary.value_cents)}</strong>
         · Range: ${usd(opts.summary.low_cents)} – ${usd(opts.summary.high_cents)}</p>
      ${costBit}
      ${rows}
      ${forms}
    `,
  });
}
