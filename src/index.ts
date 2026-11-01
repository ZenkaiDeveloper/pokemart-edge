/**
 * PokeMart Edge Worker — /account/* + /api/user/* + signed ladder export ingest
 * + M2.1 sold-evidence alerts (cron 10:00 UTC)
 * + M2.2 portfolio with cost basis.
 * Does not write price data except via authenticated Mac export.
 */
import { asDb, countUserOwned } from "./ports/db";
import {
  hardDeleteUser,
  requestMagicLink,
  verifyMagicLink,
} from "./auth/magic";
import {
  clearSessionCookieHeader,
  destroySession,
  readSessionCookie,
  resolveSession,
} from "./auth/session";
import {
  accountPage,
  alertsPage,
  loginPage,
  portfolioPage,
  unsubscribePage,
} from "./html";
import { ingestExport, verifyExportHmac } from "./export_ingest";
import {
  clientIp,
  makeEmailPort,
  num,
  siteOrigin,
  webhookEncSecret,
  type EdgeEnv,
} from "./env";
import { createRule, disableRule, listRules, mintRssToken } from "./alerts/rules";
import {
  confirmDoubleOptIn,
  ensureEmailPrefs,
  getEmailPrefs,
  unsubscribeByToken,
} from "./alerts/prefs";
import { renderOptInEmail } from "./alerts/templates";
import { buildUserRss } from "./alerts/rss";
import { runAlertsCron } from "./alerts/run_cron";
import { isoNow } from "./crypto_util";
import {
  createHolding,
  deleteAllHoldings,
  listHoldings,
  migrateLocalLists,
  recomputePortfolio,
  softDeleteHolding,
} from "./portfolio/holdings";
import { holdingsToCsv, importCsvHoldings } from "./portfolio/import_csv";
import { createShareLink, resolveShareView } from "./portfolio/share";

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function currentUser(
  env: EdgeEnv,
  req: Request,
): Promise<{ id: string; email: string; tier: string } | null> {
  const db = asDb(env.DB);
  const sess = await resolveSession(db, readSessionCookie(req));
  if (!sess) return null;
  const row = await db
    .prepare(
      `SELECT id, email, tier FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(sess.userId)
    .first<{ id: string; email: string; tier: string }>();
  return row || null;
}

async function renderPortfolio(
  env: EdgeEnv,
  req: Request,
  user: { id: string; email: string },
  extra: { notice?: string; error?: string; shareUrl?: string | null } = {},
): Promise<Response> {
  const origin = siteOrigin(env, req);
  const db = asDb(env.DB);
  const summary = await recomputePortfolio(db, user.id);
  return html(
    portfolioPage({
      siteOrigin: origin,
      email: user.email,
      summary,
      lines: summary.lines,
      shareUrl: extra.shareUrl,
      notice: extra.notice,
      error: extra.error,
      showCost: true,
    }),
  );
}

async function renderAlerts(
  env: EdgeEnv,
  req: Request,
  user: { id: string; email: string },
  extra: { notice?: string; error?: string; rssUrl?: string | null } = {},
): Promise<Response> {
  const origin = siteOrigin(env, req);
  const db = asDb(env.DB);
  const rules = await listRules(db, user.id);
  const prefs = await getEmailPrefs(db, user.id);
  const url = new URL(req.url);
  return html(
    alertsPage({
      siteOrigin: origin,
      email: user.email,
      rules,
      emailOptedIn: Boolean(prefs?.double_opt_in_at),
      emailUnsubscribed: Boolean(prefs?.unsubscribed_at),
      rssUrl: extra.rssUrl,
      notice: extra.notice,
      error: extra.error,
      prefill: {
        print_id: url.searchParams.get("print_id") || undefined,
        grade_label: url.searchParams.get("grade_label") || undefined,
      },
    }),
  );
}

async function handleAccount(
  req: Request,
  env: EdgeEnv,
  path: string,
): Promise<Response> {
  const origin = siteOrigin(env, req);
  const db = asDb(env.DB);

  if (path === "/account" || path === "/account/") {
    const user = await currentUser(env, req);
    if (!user) {
      return Response.redirect(`${origin}/account/login`, 302);
    }
    return html(accountPage({ siteOrigin: origin, email: user.email }));
  }

  if (path === "/account/login" || path === "/account/login/") {
    if (req.method === "GET") {
      return html(loginPage({ siteOrigin: origin }));
    }
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let email = "";
      if (ct.includes("application/json")) {
        const body = (await req.json()) as { email?: string };
        email = String(body.email || "");
      } else {
        const form = await req.formData();
        email = String(form.get("email") || "");
      }
      const result = await requestMagicLink({
        db,
        emailPort: makeEmailPort(env),
        email,
        ip: clientIp(req),
        origin,
        ttlMinutes: num(env, "MAGIC_LINK_TTL_MINUTES", 15),
        emailLimit: num(env, "RATE_LIMIT_EMAIL_PER_HOUR", 3),
        ipLimit: num(env, "RATE_LIMIT_IP_PER_HOUR", 10),
        exposeToken: env.TEST_EXPOSE_TOKEN === "1",
      });
      if (!result.ok) {
        const headers: Record<string, string> = {};
        if (result.retryAfterSec) {
          headers["Retry-After"] = String(result.retryAfterSec);
        }
        if (ct.includes("application/json")) {
          return json(
            { error: result.error },
            result.status,
            headers,
          );
        }
        return html(
          loginPage({
            siteOrigin: origin,
            error:
              result.status === 429
                ? "Too many requests. Try again later."
                : "Could not send a link. Check the address and try again.",
          }),
          result.status,
          headers,
        );
      }
      if (ct.includes("application/json")) {
        const payload: Record<string, unknown> = { ok: true };
        if (result.rawToken) payload.token = result.rawToken;
        return json(payload);
      }
      return html(
        loginPage({
          siteOrigin: origin,
          notice: "Check your email for a one-time sign-in link (15 minutes).",
        }),
      );
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (path.startsWith("/account/verify")) {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const verified = await verifyMagicLink({
      db,
      token,
      ttlDays: num(env, "SESSION_TTL_DAYS", 30),
      ua: req.headers.get("User-Agent"),
    });
    if (!verified.ok) {
      return html(
        loginPage({
          siteOrigin: origin,
          error:
            verified.error === "token_reused"
              ? "That link was already used."
              : verified.error === "token_expired"
                ? "That link expired. Request a new one."
                : "That sign-in link is not valid.",
        }),
        400,
      );
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/account/`,
        "Set-Cookie": verified.cookie,
      },
    });
  }

  if (path === "/account/logout" || path === "/account/logout/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    await destroySession(db, readSessionCookie(req));
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/account/login`,
        "Set-Cookie": clearSessionCookieHeader(),
      },
    });
  }

  if (path === "/account/delete" || path === "/account/delete/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    await hardDeleteUser(db, user.id);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/account/login?deleted=1`,
        "Set-Cookie": clearSessionCookieHeader(),
      },
    });
  }

  // --- M2.2 portfolio ---
  if (path === "/account/portfolio/share/view" || path === "/account/portfolio/share/view/") {
    const token = new URL(req.url).searchParams.get("token") || "";
    const view = await resolveShareView(db, token);
    if (!view.ok) {
      return html(
        loginPage({
          siteOrigin: origin,
          error:
            view.error === "revoked"
              ? "That share link was revoked."
              : "That share link is not valid.",
        }),
        view.status,
      );
    }
    return html(
      portfolioPage({
        siteOrigin: origin,
        email: "shared",
        summary: view.summary,
        lines: view.summary.lines,
        readOnly: true,
        showCost: view.showCost,
      }),
    );
  }

  if (path === "/account/portfolio" || path === "/account/portfolio/") {
    const user = await currentUser(env, req);
    if (!user) {
      return Response.redirect(`${origin}/account/login?next=%2Faccount%2Fportfolio`, 302);
    }
    if (req.method === "GET") return renderPortfolio(env, req, user);
    if (req.method === "POST") {
      const form = await req.formData();
      const costRaw = String(form.get("cost_cents") || "").trim();
      const result = await createHolding({
        db,
        userId: user.id,
        printId: String(form.get("print_id") || ""),
        gradeLabel: String(form.get("grade_label") || "Ungraded"),
        qty: Number(form.get("qty") || 1),
        costCents: costRaw === "" ? null : Number(costRaw),
        acquiredOn: String(form.get("acquired_on") || "").trim() || null,
      });
      if (!result.ok) {
        return renderPortfolio(env, req, user, { error: result.error });
      }
      return renderPortfolio(env, req, user, { notice: "Holding added." });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (path === "/account/portfolio/delete" || path === "/account/portfolio/delete/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const form = await req.formData();
    const ok = await softDeleteHolding(db, user.id, String(form.get("id") || ""));
    return renderPortfolio(env, req, user, {
      notice: ok ? "Holding removed." : undefined,
      error: ok ? undefined : "Holding not found.",
    });
  }

  if (path === "/account/portfolio/clear" || path === "/account/portfolio/clear/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const n = await deleteAllHoldings(db, user.id);
    return renderPortfolio(env, req, user, {
      notice: `Cleared ${n} holding${n === 1 ? "" : "s"}.`,
    });
  }

  if (path === "/account/portfolio/import" || path === "/account/portfolio/import/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const form = await req.formData();
    const file = form.get("file");
    let text = "";
    if (file && typeof file === "object" && "text" in file) {
      text = await (file as File).text();
    } else {
      text = String(form.get("csv") || "");
    }
    const result = await importCsvHoldings({
      db,
      userId: user.id,
      csvText: text,
      mapping: {
        print_id: "print_id",
        grade_label: "grade_label",
        qty: "qty",
        cost_cents: "cost_cents",
        cost_dollars: "cost_dollars",
        acquired_on: "acquired_on",
        notes: "notes",
      },
    });
    return renderPortfolio(env, req, user, {
      notice: `Imported ${result.imported} · skipped ${result.skipped} · ${result.ms} ms`,
      error: result.errors.length ? result.errors.slice(0, 5).join("; ") : undefined,
    });
  }

  if (path === "/account/portfolio/export.csv" || path === "/account/portfolio/export.csv/") {
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const holdings = await listHoldings(db, user.id);
    const csv = holdingsToCsv(holdings);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="pokemart-portfolio.csv"',
      },
    });
  }

  if (path === "/account/portfolio/migrate" || path === "/account/portfolio/migrate/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const form = await req.formData();
    let watchlist: Array<Record<string, unknown>> = [];
    let collection: Array<Record<string, unknown>> = [];
    try {
      const raw = JSON.parse(String(form.get("local_json") || "null"));
      if (Array.isArray(raw)) {
        // Heuristic: collection rows often have qty; watchlist is flat Follow list.
        const hasQty = raw.some(
          (r) => r && typeof r === "object" && "qty" in (r as object),
        );
        if (hasQty) collection = raw;
        else watchlist = raw;
      } else if (raw && typeof raw === "object") {
        if (Array.isArray(raw.items)) collection = raw.items;
        else if (Array.isArray(raw.watchlist)) watchlist = raw.watchlist;
        else if (Array.isArray(raw.collection)) collection = raw.collection;
      }
    } catch {
      return renderPortfolio(env, req, user, { error: "invalid_json" });
    }
    const result = await migrateLocalLists({
      db,
      userId: user.id,
      watchlist,
      collection,
    });
    return renderPortfolio(env, req, user, {
      notice: `Migrated +${result.added} · skipped ${result.skipped}`,
    });
  }

  if (path === "/account/portfolio/share" || path === "/account/portfolio/share/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const form = await req.formData();
    const showCost = String(form.get("show_cost") || "") === "1";
    const link = await createShareLink({
      db,
      userId: user.id,
      showCost,
    });
    const shareUrl = `${origin}/account/portfolio/share/view?token=${encodeURIComponent(link.rawToken)}`;
    return renderPortfolio(env, req, user, {
      notice: "Share link created (cost hidden by default unless checked).",
      shareUrl,
    });
  }

  // --- M2.1 alerts ---
  if (path === "/account/unsubscribe" || path === "/account/unsubscribe/") {
    // One-click / List-Unsubscribe-Post — no login required.
    let token = "";
    if (req.method === "GET") {
      token = new URL(req.url).searchParams.get("token") || "";
    } else if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const form = await req.formData();
        token = String(form.get("token") || form.get("List-Unsubscribe") || "");
      } else {
        token = new URL(req.url).searchParams.get("token") || "";
      }
      // RFC 8058 body may be List-Unsubscribe=One-Click with token in query.
      if (!token) token = new URL(req.url).searchParams.get("token") || "";
    } else {
      return json({ error: "method_not_allowed" }, 405);
    }
    const result = await unsubscribeByToken(db, token);
    if (!result.ok) {
      return html(
        unsubscribePage({ siteOrigin: origin, error: "That unsubscribe link is not valid." }),
        400,
      );
    }
    return html(unsubscribePage({ siteOrigin: origin, ok: true }));
  }

  if (path === "/account/alerts/confirm" || path === "/account/alerts/confirm/") {
    const user = await currentUser(env, req);
    if (!user) return Response.redirect(`${origin}/account/login`, 302);
    await confirmDoubleOptIn(db, user.id);
    return renderAlerts(env, req, user, {
      notice: "Email alerts confirmed. You can create rules now.",
    });
  }

  if (path === "/account/alerts/opt-in" || path === "/account/alerts/opt-in/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    await ensureEmailPrefs(db, user.id);
    const confirmUrl = `${origin}/account/alerts/confirm`;
    const body = renderOptInEmail({ confirmUrl });
    await makeEmailPort(env).send({
      to: user.email,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });
    return renderAlerts(env, req, user, {
      notice: "Confirmation email sent — open the link to enable alert mail.",
    });
  }

  if (path === "/account/alerts/rss-token" || path === "/account/alerts/rss-token/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const raw = await mintRssToken(db, user.id);
    const rssUrl = `${origin}/account/alerts/rss.xml?token=${encodeURIComponent(raw)}`;
    return renderAlerts(env, req, user, {
      notice: "RSS token minted. Save this URL — it is shown once.",
      rssUrl,
    });
  }

  if (path === "/account/alerts/rss.xml" || path === "/account/alerts/rss.xml/") {
    const token = new URL(req.url).searchParams.get("token") || "";
    const feed = await buildUserRss(db, { rawToken: token, siteOrigin: origin });
    if (!feed.ok) return json({ error: feed.error }, feed.status);
    return new Response(feed.xml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "private, max-age=300",
      },
    });
  }

  if (path === "/account/alerts/disable" || path === "/account/alerts/disable/") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const form = await req.formData();
    const id = String(form.get("id") || "");
    const ok = await disableRule(db, user.id, id);
    return renderAlerts(env, req, user, {
      notice: ok ? "Rule disabled." : undefined,
      error: ok ? undefined : "Rule not found.",
    });
  }

  if (path === "/account/alerts" || path === "/account/alerts/") {
    const user = await currentUser(env, req);
    if (!user) {
      const next = encodeURIComponent(
        `/account/alerts${new URL(req.url).search || ""}`,
      );
      return Response.redirect(`${origin}/account/login?next=${next}`, 302);
    }
    if (req.method === "GET") {
      return renderAlerts(env, req, user);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const thresholdRaw = String(form.get("threshold") || "").trim();
      const result = await createRule({
        db,
        userId: user.id,
        printId: String(form.get("print_id") || ""),
        gradeLabel: String(form.get("grade_label") || ""),
        kind: String(form.get("kind") || ""),
        threshold: thresholdRaw === "" ? null : Number(thresholdRaw),
        channel: String(form.get("channel") || "email"),
        webhookUrl: String(form.get("webhook_url") || "") || null,
        encSecret: webhookEncSecret(env),
        tier: user.tier,
      });
      if (!result.ok) {
        return renderAlerts(env, req, user, { error: result.error });
      }
      if (result.rule.channel === "email") {
        await ensureEmailPrefs(db, user.id);
      }
      return renderAlerts(env, req, user, { notice: "Alert rule created." });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  return json({ error: "not_found" }, 404);
}

async function handleApiUser(
  req: Request,
  env: EdgeEnv,
  path: string,
): Promise<Response> {
  const db = asDb(env.DB);
  if (path === "/api/user/me" || path === "/api/user/me/") {
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ id: user.id, email: user.email, tier: user.tier || "free" });
  }
  if (path === "/api/user/delete" || path === "/api/user/delete/") {
    if (req.method !== "POST" && req.method !== "DELETE") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    await hardDeleteUser(db, user.id);
    const leftover = await countUserOwned(db, user.id);
    return json(
      { ok: true, leftover },
      200,
      { "Set-Cookie": clearSessionCookieHeader() },
    );
  }
  if (path === "/api/user/alerts" || path === "/api/user/alerts/") {
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") {
      return json({ rules: await listRules(db, user.id) });
    }
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const result = await createRule({
        db,
        userId: user.id,
        printId: String(body.print_id || ""),
        gradeLabel: String(body.grade_label || ""),
        kind: String(body.kind || ""),
        threshold:
          body.threshold == null || body.threshold === ""
            ? null
            : Number(body.threshold),
        channel: String(body.channel || "email"),
        webhookUrl: body.webhook_url ? String(body.webhook_url) : null,
        encSecret: webhookEncSecret(env),
        tier: user.tier,
      });
      if (!result.ok) return json({ error: result.error }, result.status);
      return json({ ok: true, rule: result.rule }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (path === "/api/user/portfolio" || path === "/api/user/portfolio/") {
    const user = await currentUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") {
      const summary = await recomputePortfolio(db, user.id);
      return json({ summary });
    }
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const result = await createHolding({
        db,
        userId: user.id,
        printId: String(body.print_id || ""),
        gradeLabel: String(body.grade_label || "Ungraded"),
        qty: body.qty == null ? 1 : Number(body.qty),
        costCents:
          body.cost_cents == null || body.cost_cents === ""
            ? null
            : Number(body.cost_cents),
        acquiredOn: body.acquired_on ? String(body.acquired_on) : null,
        notes: body.notes ? String(body.notes) : null,
      });
      if (!result.ok) return json({ error: result.error }, result.status);
      return json({ ok: true, holding: result.holding }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  return json({ error: "not_found" }, 404);
}

async function handleExport(req: Request, env: EdgeEnv): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = env.EXPORT_HMAC_SECRET;
  if (!secret) return json({ error: "export_not_configured" }, 503);

  const rawBody = await req.text();
  const sig = req.headers.get("X-Pokemart-Signature");
  const ts = req.headers.get("X-Pokemart-Timestamp");
  const auth = await verifyExportHmac(secret, rawBody, sig, ts);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const archivePut = env.ARCHIVE
    ? async (key: string, body: string) => {
        await env.ARCHIVE!.put(key, body, {
          httpMetadata: { contentType: "application/json" },
        });
      }
    : undefined;

  const result = await ingestExport(
    asDb(env.DB),
    payload as Parameters<typeof ingestExport>[1],
    archivePut,
  );
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result);
}

async function fetchHandler(req: Request, env: EdgeEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path.startsWith("/account")) {
    return handleAccount(req, env, path);
  }
  if (path.startsWith("/api/user")) {
    return handleApiUser(req, env, path);
  }
  if (
    path === "/api/internal/ladder-export" ||
    path === "/api/internal/ladder-export/"
  ) {
    return handleExport(req, env);
  }
  if (path === "/health" || path === "/health/") {
    return json({
      ok: true,
      service: "pokemart-edge",
      alerts: true,
      portfolio: true,
      at: isoNow(),
    });
  }
  return json({ error: "not_found" }, 404);
}

async function scheduledHandler(
  _event: ScheduledEvent,
  env: EdgeEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  await runAlertsCron(asDb(env.DB), {
    emailPort: makeEmailPort(env),
    encSecret: webhookEncSecret(env),
    siteOrigin: env.SITE_ORIGIN || "https://pokemart.online",
  });
}

export default {
  fetch: fetchHandler,
  scheduled: scheduledHandler,
};
export { fetchHandler as handleRequest, scheduledHandler };
