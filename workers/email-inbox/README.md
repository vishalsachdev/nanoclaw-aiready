# aiready-email-inbox

Cloudflare Email Worker. Triggered by the Cloudflare Email Routing rule on
`aiready@illinihunt.org`; parses the inbound MIME and POSTs a normalized
JSON payload to the bot at `https://aiready.illinihunt.org/email` with
a shared-secret bearer token.

## Deploy

One-time setup:

```bash
cd workers/email-inbox
npm install
# Set the shared secret. Value must match nanoclaw-aiready/.env's WEBHOOK_SECRET
# so the VPS handler can verify the bearer.
wrangler secret put WEBHOOK_SECRET
# Then deploy
wrangler deploy
```

After the first deploy, also create the Email Routing rule that points
`aiready@illinihunt.org` at this worker (done via API in the deploy
runbook; do not configure manually).

## Webhook payload shape

```json
{
  "from": "vishal@illinois.edu",
  "to": "aiready@illinihunt.org",
  "subject": "...",
  "message_id": "<...@mail.example>",
  "in_reply_to": "<...>",
  "references": "<...>",
  "date": "2026-05-03T12:34:56Z",
  "text": "plain-text body",
  "html": "<html>...</html>",
  "attachments": [
    { "filename": "x.pdf", "mime_type": "application/pdf", "size": 12345 }
  ],
  "raw_size": 67890,
  "received_at": "2026-05-03T12:34:57.123Z"
}
```

Attachment content is omitted to keep payload light. If the bot needs
raw attachment bytes, extend the worker to base64-encode (or store to R2
and pass a signed URL).

## Auth

`Authorization: Bearer <WEBHOOK_SECRET>`. The bot's channel handler
checks this header before dispatching.

## Failure handling

On non-2xx response, the worker throws. Cloudflare retries with backoff
(emails are not lost during transient VPS downtime). Senders never see
a bounce — the email allowlist lives on the VPS, not here.

## Logs

```bash
wrangler tail aiready-email-inbox
```
