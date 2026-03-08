# Cloudflare Admin Proxy (Scouts)

This Worker keeps the Lambda API key server-side in Cloudflare and exposes safe admin endpoints:

- `GET /admin-api/auth-status`
- `POST /admin-api/persist`
- `POST /admin-api/refresh`

It also handles the public contact form endpoint:

- `POST /api/contact`

## Why this exists

The admin browser should never hold the Lambda API key.  
The Worker injects `apiKey` when forwarding requests to Lambda.

The contact form should never expose the IFTTT webhook key or the Turnstile secret key.  
The Worker verifies the CAPTCHA token and forwards submissions to IFTTT.

## Files

- `wrangler.toml`: Worker project config
- `worker.js`: Proxy logic, auth-status endpoint, and contact form handler
- `.dev.vars.example`: local variable template

## Required configuration

Set these in Cloudflare Worker settings (or via `wrangler secret put`):

### Admin proxy secrets / vars
- Secret: `SCOUTS_LAMBDA_API_KEY`
- Vars:
  - `SCOUTS2SQS_URL`
  - `SCOUTS_REFRESH_URL`
  - `REQUIRE_CF_ACCESS` (`true` in production)

### Contact form secrets
- Secret: `TURNSTILE_SECRET_KEY` – from the Cloudflare Turnstile dashboard (the **secret** key)
- Secret: `IFTTT_WEBHOOK_KEY` – from https://ifttt.com/maker_webhooks/settings
- Var: `IFTTT_EVENT_NAME` – the event name in your IFTTT Webhooks applet (default: `scouts_contact`)

### Cloudflare Turnstile site key
The **public** site key must be placed in `website/contact/index.html` in the
`data-sitekey` attribute of the `<div class="cf-turnstile">` element. Obtain it
from the Cloudflare Turnstile dashboard and replace the placeholder value
`0x4AAAAAAA_REPLACE_WITH_YOUR_SITEKEY`.

## Contact form request flow

```
User Browser → Contact Form → Turnstile CAPTCHA → POST /api/contact → Cloudflare Worker
  → Turnstile verification → IFTTT Webhook → Notification
```

The Worker returns:
- `200 { ok: true }` on success
- `400 { ok: false, code: "CAPTCHA_FAILED" }` if CAPTCHA verification fails
- `400 { ok: false, code: "MISSING_FIELDS" }` if required fields are missing
- `502 { ok: false, code: "NOTIFICATION_FAILED" }` if the IFTTT call fails
- `500 { ok: false, code: "MISSING_CONFIG" }` if secrets are not configured

## Deploy steps (run locally)

1. Install Wrangler (if needed):
   - `npm install -g wrangler`
2. Login:
   - `wrangler login`
3. Set secrets:
   - `wrangler secret put SCOUTS_LAMBDA_API_KEY`
   - `wrangler secret put TURNSTILE_SECRET_KEY`
   - `wrangler secret put IFTTT_WEBHOOK_KEY`
4. Deploy:
   - `cd scouts/cloudflare`
   - `wrangler deploy --var SCOUTS2SQS_URL=https://... --var SCOUTS_REFRESH_URL=https://... --var REQUIRE_CF_ACCESS=true --var IFTTT_EVENT_NAME=scouts_contact`

## Admin page integration

Update the admin frontend to call:

- `/admin-api/persist` (instead of direct `SCOUTS2SQS_URL`)
- `/admin-api/refresh` (instead of direct `SCOUTS_REFRESH_URL`)
- `/admin-api/auth-status` on load to drive "ready/missing" UI status

