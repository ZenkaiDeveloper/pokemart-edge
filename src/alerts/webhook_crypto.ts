/** Encrypt Discord webhook URLs at rest. Never log plaintext. */

import { b64url, b64urlToBytes } from "../crypto_util";

const te = new TextEncoder();
const td = new TextDecoder();

const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export function isValidDiscordWebhookUrl(url: string): boolean {
  return DISCORD_WEBHOOK_RE.test(String(url || "").trim());
}

async function importKey(secret: string): Promise<CryptoKey> {
  const dig = await crypto.subtle.digest("SHA-256", te.encode(secret));
  return crypto.subtle.importKey("raw", dig, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Ciphertext format: v1.<iv_b64url>.<ct_b64url> */
export async function encryptWebhookUrl(
  secret: string,
  plaintext: string,
): Promise<string> {
  if (!secret) throw new Error("webhook_enc_secret_missing");
  const key = await importKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(plaintext),
  );
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptWebhookUrl(
  secret: string,
  ciphertext: string,
): Promise<string> {
  const parts = String(ciphertext || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("bad_webhook_ciphertext");
  }
  const key = await importKey(secret);
  const iv = b64urlToBytes(parts[1]!);
  const ct = b64urlToBytes(parts[2]!);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return td.decode(pt);
}

/** Redact for logs — never emit the token path. */
export function redactWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    // /api/webhooks/{id}/{token}
    if (segs.length >= 4) {
      return `${u.origin}/api/webhooks/${segs[2]}/…`;
    }
  } catch {
    /* ignore */
  }
  return "[webhook]";
}
