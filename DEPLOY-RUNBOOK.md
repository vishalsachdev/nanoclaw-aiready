# aiready bot — VPS deploy runbook

Status: code prepared on laptop; not yet deployed to VPS. This runbook covers the remaining work to bring `aiready@illinihunt.org` + Telegram bot live.

## Already prepared (in this fork)

- v2 NanoClaw fork with Telegram + Resend channels cherry-picked from `upstream/channels`
- Custom `src/channels/email-cf-worker.ts` (~250 LOC) — accepts POST /email from the Cloudflare Email Worker `aiready-email-inbox` with bearer auth, dispatches inbound to NanoClaw's router, sends outbound via Resend's API
- `groups/aiready/CLAUDE.local.md` — Hub Coordinator persona, modes, citation format, per-channel formatting hints
- `groups/aiready/container.json` — mounts `/root/ai-ready-illinois` at `/workspace/extra/ai-ready-illinois`, persona name = "Hub Coordinator"
- `package.json` `chat@4.26.0` override + `@chat-adapter/telegram` + `@resend/chat-sdk-adapter` deps installed
- `workers/email-inbox/` — Cloudflare Email Worker, deployed and tested (see workers/email-inbox/README.md)
- Cloudflare DNS: `aiready.illinihunt.org` → `76.13.122.44` (proxied), null worker route to bypass catch-all
- Cloudflare Email Routing: `aiready@illinihunt.org` → worker `aiready-email-inbox`
- Cloudflare-side end-to-end validated: real email reaches the Worker, the Worker POSTs (currently 404s because VPS endpoint doesn't exist yet)

## Remaining (the deploy itself)

Run on the VPS via `ssh vps`. Most steps must run **interactively in a real TTY** — v2 setup uses `clack` prompts. Don't try to drive setup from this Claude Code session.

### 1. Clone the repo and the program repo

```bash
ssh vps
cd /root
gh auth status                                     # ensure gh is authed for the private repos
gh repo clone vishalsachdev/nanoclaw-aiready
gh repo clone vishalsachdev/ai-ready-illinois
cd nanoclaw-aiready
```

### 2. Install host deps + build

```bash
# Use pnpm to match supply-chain policy (npm works too but pnpm is canonical)
npm install -g pnpm
pnpm install
pnpm run build
pnpm run typecheck
```

### 3. Copy `.env` from laptop

From the laptop:

```bash
scp /Users/vishal/code/nanoclaw-aiready/.env vps:/root/nanoclaw-aiready/.env
```

The .env contains: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`, `RESEND_API_KEY`. Add on the VPS:

```bash
cat >> /root/nanoclaw-aiready/.env <<'EOF'
WEBHOOK_PORT=3007
RESEND_FROM_ADDRESS=aiready@illinihunt.org
RESEND_FROM_NAME=Hub Coordinator
EOF
chmod 600 /root/nanoclaw-aiready/.env
```

### 4. Run v2 setup (INTERACTIVE — real TTY required)

```bash
cd /root/nanoclaw-aiready
bash nanoclaw.sh
```

This walks through: bootstrap → environment → container build → OneCLI install → Anthropic credential registration → channel pairing.

When it gets to channels:
- Skip Telegram pairing during the interactive setup if it asks; we'll wire to the `aiready` group separately via `/manage-channels` (or do it now if it offers).
- Resend (Chat SDK) channel will fail/skip without `RESEND_WEBHOOK_SECRET` — fine, we're not using its inbound. It still works for outbound via our custom channel.
- Our custom `email-cf-worker` channel auto-registers; it'll start its HTTP server on port 3007 once the host comes up.

### 5. Wire the aiready group

If `/init-first-agent` offers to create the first group, name it `aiready`, persona `Hub Coordinator`. Otherwise:

```bash
# The groups/aiready/ files (CLAUDE.local.md, container.json) are already in
# the repo. Use the operational skill to register it in the central DB:
pnpm exec tsx scripts/init-first-agent.ts   # or follow whatever the skill prescribes
```

Then `/manage-channels` to wire:
- `telegram` → aiready (DM with allowlisted users)
- `email-cf-worker` → aiready (route email to this group)

### 6. nginx vhost

```bash
sudo tee /etc/nginx/sites-available/aiready <<'EOF'
server {
    listen 443 ssl;
    server_name aiready.illinihunt.org;

    ssl_certificate /etc/nginx/ssl/origin.crt;
    ssl_certificate_key /etc/nginx/ssl/origin.key;

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:3007;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}

server {
    listen 80;
    server_name aiready.illinihunt.org;
    return 301 https://$host$request_uri;
}
EOF
sudo ln -s /etc/nginx/sites-available/aiready /etc/nginx/sites-enabled/aiready
sudo nginx -t && sudo systemctl reload nginx
```

### 7. PM2

```bash
cd /root/nanoclaw-aiready
pm2 start "pnpm run start" --name nanoclaw-aiready
pm2 save
pm2 logs nanoclaw-aiready --lines 100   # watch startup
```

### 8. Smoke test

- Send email from `vishal@illinois.edu` → `aiready@illinihunt.org`. Watch:
  - `wrangler tail aiready-email-inbox` (from laptop) — should show 200 from VPS
  - `pm2 logs nanoclaw-aiready` — should show inbound dispatch + agent invocation
  - Inbox at vishal@illinois.edu — should receive a reply
  - `/root/ai-ready-illinois/discussions/audit-log/email/` — should have new in/out files
- Telegram: DM the bot from vishal's account. Expect a reply.

## Spec gaps to log in Phase 5 (after deploy)

- `chat@^4.24.0` in upstream main vs `@chat-adapter/telegram@4.26.0` peer = npm install ends up with two `chat` copies; needs explicit `overrides.chat = "4.26.0"` to dedupe. pnpm handles this; npm doesn't.
- v2's setup is interactive (clack); a programmatic non-TTY path would help cloud/CI deploys.
- The Resend (Chat SDK) channel assumes Resend Inbound; needs to be optional or split into "send-only" / "send + inbound" variants.
- Cloudflare Email Worker pattern is a clean alternative to Resend Inbound and worth blessing in the spec.

## Audit-log MCP tool — DEFERRED

Task #6 (audit-log MCP tool) is not yet implemented. Once the bot is running, the next iteration is to add a small MCP tool under `container/agent-runner/src/mcp-tools/audit-log.ts` that the agent calls per turn to write the inbound + outbound + commit SHAs to `/workspace/extra/ai-ready-illinois/discussions/audit-log/<channel>/<timestamp>-<in|out>.md`. Until then, the audit log discipline is enforced only by the persona prompt + manual review.
