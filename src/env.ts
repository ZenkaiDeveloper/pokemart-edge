import type { EmailPort } from "./email";
import {
  captureEmail,
  postmarkEmail,
  resendEmail,
  type CaptureBox,
} from "./email";

export type EdgeEnv = {
  DB: D1Database;
  ARCHIVE?: R2Bucket;
  SITE_ORIGIN: string;
  EMAIL_FROM: string;
  EMAIL_PROVIDER?: string;
  MAGIC_LINK_TTL_MINUTES?: string;
  SESSION_TTL_DAYS?: string;
  RATE_LIMIT_EMAIL_PER_HOUR?: string;
  RATE_LIMIT_IP_PER_HOUR?: string;
  SESSION_SECRET?: string;
  EXPORT_HMAC_SECRET: string;
  RESEND_API_KEY?: string;
  POSTMARK_SERVER_TOKEN?: string;
  /** Test-only: when "1", login responses may include raw token. */
  TEST_EXPOSE_TOKEN?: string;
};

export function num(env: EdgeEnv, key: keyof EdgeEnv, fallback: number): number {
  const v = env[key];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function siteOrigin(env: EdgeEnv, req: Request): string {
  return (env.SITE_ORIGIN || new URL(req.url).origin).replace(/\/$/, "");
}

export function makeEmailPort(
  env: EdgeEnv,
  capture?: CaptureBox,
): EmailPort {
  if (capture) return captureEmail(capture);
  const from = env.EMAIL_FROM || "PokeMart <noreply@mail.pokemart.online>";
  const provider = (env.EMAIL_PROVIDER || "resend").toLowerCase();
  if (provider === "postmark" && env.POSTMARK_SERVER_TOKEN) {
    return postmarkEmail(env.POSTMARK_SERVER_TOKEN, from);
  }
  if (env.RESEND_API_KEY) {
    return resendEmail(env.RESEND_API_KEY, from);
  }
  if (env.POSTMARK_SERVER_TOKEN) {
    return postmarkEmail(env.POSTMARK_SERVER_TOKEN, from);
  }
  // Dev fallback: capture nowhere useful — callers should set a secret.
  const box: CaptureBox = { messages: [] };
  return captureEmail(box);
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}
