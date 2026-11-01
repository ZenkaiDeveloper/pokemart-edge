/** Provider-agnostic transactional email (Resend | Postmark | capture). */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailSendResult = { ok: true; providerId?: string } | { ok: false; error: string };

export interface EmailPort {
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export type CaptureBox = { messages: EmailMessage[] };

export function captureEmail(box: CaptureBox): EmailPort {
  return {
    async send(msg) {
      box.messages.push({ ...msg });
      return { ok: true, providerId: `capture-${box.messages.length}` };
    },
  };
}

export function resendEmail(apiKey: string, from: string): EmailPort {
  return {
    async send(msg) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `resend ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = (await res.json()) as { id?: string };
      return { ok: true, providerId: data.id };
    },
  };
}

export function postmarkEmail(serverToken: string, from: string): EmailPort {
  return {
    async send(msg) {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": serverToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          From: from,
          To: msg.to,
          Subject: msg.subject,
          TextBody: msg.text,
          HtmlBody: msg.html || undefined,
          MessageStream: "outbound",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: `postmark ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      const data = (await res.json()) as { MessageID?: string };
      return { ok: true, providerId: data.MessageID };
    },
  };
}

export function magicLinkEmailBody(opts: {
  link: string;
  minutes: number;
}): { subject: string; text: string; html: string } {
  const subject = "Your PokeMart sign-in link";
  const text =
    `Sign in to PokeMart with this one-time link (expires in ${opts.minutes} minutes):\n\n` +
    `${opts.link}\n\n` +
    `If you did not request this, you can ignore this email.\n`;
  const html =
    `<p>Sign in to PokeMart with this one-time link ` +
    `(expires in ${opts.minutes} minutes):</p>` +
    `<p><a href="${opts.link}">${opts.link}</a></p>` +
    `<p>If you did not request this, you can ignore this email.</p>`;
  return { subject, text, html };
}
