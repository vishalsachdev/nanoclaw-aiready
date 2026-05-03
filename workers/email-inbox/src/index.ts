/**
 * aiready-email-inbox — Cloudflare Email Worker
 *
 * Triggered by Cloudflare Email Routing rule on `aiready@illinihunt.org`.
 * Parses the inbound MIME and POSTs a normalized JSON payload to the bot
 * on the VPS, authenticated with a shared bearer token.
 *
 * On non-2xx response, throws — Cloudflare retries with backoff so the
 * email isn't lost during transient VPS downtime. Senders never see a
 * bounce; the bot's email allowlist handles auth (we forward everything
 * that hits this routing rule).
 */
import PostalMime from 'postal-mime';

interface Env {
  WEBHOOK_URL: string;     // https://aiready.illinihunt.org/email
  WEBHOOK_SECRET: string;  // shared bearer; matches nanoclaw-aiready/.env
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
  reply(message: EmailMessage): Promise<void>;
}

interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream | string;
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const rawBuf = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(new Uint8Array(rawBuf));

    const payload = {
      from: message.from,
      to: message.to,
      subject: parsed.subject ?? '',
      message_id: parsed.messageId ?? null,
      in_reply_to: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      date: parsed.date ?? null,
      text: parsed.text ?? '',
      html: parsed.html ?? '',
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename,
        mime_type: a.mimeType,
        // postal-mime types content as `string | ArrayBuffer | Uint8Array`.
        // ArrayBuffer/Uint8Array have `byteLength`; string has `length` in
        // chars (close-enough proxy here since we only use this for the
        // payload metadata, not security accounting).
        size:
          typeof a.content === 'string'
            ? a.content.length
            : (a.content?.byteLength ?? 0),
        // Content omitted to keep payload light; bot can request raw via Worker if needed later.
      })),
      raw_size: message.rawSize,
      received_at: new Date().toISOString(),
    };

    const resp = await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WEBHOOK_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `webhook returned ${resp.status} for ${message.from} → ${message.to}: ${body.slice(0, 500)}`,
      );
      // Throw so Cloudflare retries; do NOT setReject (sender shouldn't see a bounce
      // for a transient VPS issue, and the allowlist filter lives on the VPS, not here).
      throw new Error(`webhook ${resp.status}`);
    }
  },
};
