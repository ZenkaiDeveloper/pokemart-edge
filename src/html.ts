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
      <p>Alerts and portfolio arrive in later milestones. For now this account holds your email and session only.</p>
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
