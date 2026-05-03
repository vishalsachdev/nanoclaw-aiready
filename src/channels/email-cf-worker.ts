/**
 * email-cf-worker — custom inbound email channel.
 *
 * Companion to the Cloudflare Email Worker `aiready-email-inbox`
 * (`workers/email-inbox/`). The Worker receives mail via Cloudflare Email
 * Routing on `aiready@illinihunt.org`, parses MIME, and POSTs a normalized
 * JSON payload to this adapter's HTTP endpoint with bearer auth.
 *
 * Outbound replies go via the Resend HTTP API (`https://api.resend.com/emails`).
 *
 * Why a custom channel instead of `/add-resend`: the Resend Chat SDK adapter
 * assumes Resend Inbound (the `email.received` webhook), which is not on every
 * Resend plan. Cloudflare Email Routing → Worker → bearer-auth POST is a
 * generic alternative pattern that works for any Resend plan.
 *
 * Wire format (POST /email body):
 *   {
 *     from: "vishal@illinois.edu",
 *     to: "aiready@illinihunt.org",
 *     subject: "...",
 *     message_id: "<...>",
 *     in_reply_to: "<...>" | null,
 *     references: "<...>" | null,
 *     date: "ISO-8601",
 *     text: "...",
 *     html: "...",
 *     attachments: [{ filename, mime_type, size }],
 *     raw_size: number,
 *     received_at: "ISO-8601"
 *   }
 *
 * Auth: `Authorization: Bearer <WEBHOOK_SECRET>` (must match the Worker's
 * `WEBHOOK_SECRET` and the value in `.env`).
 *
 * Self-registers on import.
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const CHANNEL_NAME = 'email-cf-worker';
const CHANNEL_TYPE = 'email';
const DEFAULT_PORT = 3007;
const RESEND_API_URL = 'https://api.resend.com/emails';

interface EmailWorkerPayload {
  from: string;
  to: string;
  subject: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  date: string | null;
  text: string;
  html: string;
  attachments: Array<{ filename: string; mime_type: string; size: number }>;
  raw_size: number;
  received_at: string;
}

interface EmailOutboundContent {
  text?: string;
  html?: string;
  subject?: string;
  in_reply_to?: string;
  references?: string;
}

/** Strip everything after the `@` in an email address; lowercase the local part. */
function normalizeAddress(addr: string): string {
  // RFC 5322 display-name + angle-addr form: "Name <user@domain>"
  const angleMatch = addr.match(/<([^>]+)>/);
  const raw = (angleMatch ? angleMatch[1] : addr).trim().toLowerCase();
  return raw;
}

/** Platform ID for an email conversation: the canonical sender address.
 *  Email "channels" don't really exist in the way Telegram chats do — every
 *  sender is its own conversation. */
function platformIdFor(payload: EmailWorkerPayload): string {
  return normalizeAddress(payload.from);
}

/** Thread ID: derived from References / In-Reply-To headers if present.
 *  Each References chain becomes its own thread; new mail without References
 *  starts a new thread keyed by Message-ID. */
function threadIdFor(payload: EmailWorkerPayload): string | null {
  if (payload.references) return payload.references.split(/\s+/)[0] || null;
  if (payload.in_reply_to) return payload.in_reply_to;
  return payload.message_id;
}

class EmailCfWorkerAdapter implements ChannelAdapter {
  readonly name = CHANNEL_NAME;
  readonly channelType = CHANNEL_TYPE;
  readonly supportsThreads = false;

  private server: http.Server | null = null;
  private setupConfig: ChannelSetup | null = null;
  private readonly port: number;
  private readonly webhookSecret: string;
  private readonly resendApiKey: string;
  private readonly fromAddress: string;
  private readonly fromName: string;

  constructor(opts: {
    port: number;
    webhookSecret: string;
    resendApiKey: string;
    fromAddress: string;
    fromName: string;
  }) {
    this.port = opts.port;
    this.webhookSecret = opts.webhookSecret;
    this.resendApiKey = opts.resendApiKey;
    this.fromAddress = opts.fromAddress;
    this.fromName = opts.fromName;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        log.info('email-cf-worker listening', { port: this.port });
        resolve();
      });
    });
  }

  async teardown(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const content = (message.content ?? {}) as EmailOutboundContent;
    const subject = content.subject || 'Re: (no subject)';
    const html = content.html || (content.text ? `<pre>${escapeHtml(content.text)}</pre>` : '');
    const text = content.text || stripHtml(html);

    const headers: Record<string, string> = {};
    if (content.in_reply_to) headers['In-Reply-To'] = content.in_reply_to;
    if (content.references) headers['References'] = content.references;

    const body = {
      from: `${this.fromName} <${this.fromAddress}>`,
      to: [platformId],
      subject,
      text,
      html,
      headers,
    };

    const resp = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      log.error('Resend send failed', {
        status: resp.status,
        to: platformId,
        body: errBody.slice(0, 500),
      });
      throw new Error(`Resend ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { id?: string };
    log.info('email sent', { to: platformId, messageId: data.id });
    return data.id;
  }

  // ---- private ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST' || req.url !== '/email') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // Bearer auth
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${this.webhookSecret}`;
    if (auth !== expected) {
      log.warn('email-cf-worker rejected unauthorized POST', {
        from: req.socket.remoteAddress,
      });
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    // Parse body
    let payload: EmailWorkerPayload;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as EmailWorkerPayload;
    } catch (err) {
      log.warn('email-cf-worker bad JSON', { err });
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad json');
      return;
    }

    if (!this.setupConfig) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('adapter not yet ready');
      return;
    }

    // Convert to InboundMessage and dispatch.
    const platformId = platformIdFor(payload);
    const threadId = threadIdFor(payload);
    const inbound: InboundMessage = {
      id: payload.message_id ?? `cfworker-${Date.now()}`,
      kind: 'chat',
      content: {
        // Sender identity: v2's permissions module checks `senderId`,
        // `sender`, or `author.userId` on the message content. Without
        // one of these, default `strict` / `request_approval` policies
        // drop the message before the agent ever sees it. We set all
        // three to the canonicalized From address so any of those
        // resolvers picks it up.
        senderId: platformId,
        sender: platformId,
        author: { userId: platformId, displayName: payload.from },
        from: payload.from,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        in_reply_to: payload.in_reply_to,
        references: payload.references,
        attachments: payload.attachments,
      },
      timestamp: payload.received_at,
      isMention: true, // every email to aiready@ is by definition addressed to the bot
      isGroup: false,
    };

    try {
      await this.setupConfig.onInbound(platformId, threadId, inbound);
    } catch (err) {
      log.error('email-cf-worker onInbound threw', { err, platformId });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('handler error');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, platform_id: platformId }));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

registerChannelAdapter(CHANNEL_NAME, {
  factory: () => {
    const env = readEnvFile([
      'WEBHOOK_SECRET',
      'WEBHOOK_PORT',
      'RESEND_API_KEY',
      'RESEND_FROM_ADDRESS',
      'RESEND_FROM_NAME',
    ]);
    const webhookSecret = env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
    const resendApiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
    const fromAddress = env.RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
    if (!webhookSecret) {
      log.warn('email-cf-worker channel: WEBHOOK_SECRET not set, skipping');
      return null;
    }
    if (!resendApiKey) {
      log.warn('email-cf-worker channel: RESEND_API_KEY not set, skipping');
      return null;
    }
    if (!fromAddress) {
      log.warn('email-cf-worker channel: RESEND_FROM_ADDRESS not set, skipping');
      return null;
    }
    const port = parseInt(env.WEBHOOK_PORT || process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);
    const fromName = env.RESEND_FROM_NAME || process.env.RESEND_FROM_NAME || 'Hub Coordinator';
    return new EmailCfWorkerAdapter({ port, webhookSecret, resendApiKey, fromAddress, fromName });
  },
});
