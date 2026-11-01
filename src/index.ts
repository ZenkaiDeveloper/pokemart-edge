/**
 * PokeMart Edge Worker — /account/* + /api/user/* + signed ladder export ingest.
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
import { accountPage, loginPage } from "./html";
import { ingestExport, verifyExportHmac } from "./export_ingest";
import { clientIp, makeEmailPort, num, siteOrigin, type EdgeEnv } from "./env";

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
): Promise<{ id: string; email: string } | null> {
  const db = asDb(env.DB);
  const sess = await resolveSession(db, readSessionCookie(req));
  if (!sess) return null;
  const row = await db
    .prepare(
      `SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(sess.userId)
    .first<{ id: string; email: string }>();
  return row || null;
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
    return json({ id: user.id, email: user.email, tier: "free" });
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
    return json({ ok: true, service: "pokemart-edge" });
  }
  return json({ error: "not_found" }, 404);
}

export default { fetch: fetchHandler };
export { fetchHandler as handleRequest };
