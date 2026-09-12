# Cloudflare Admin Proxy (Scouts)

This Worker keeps the Lambda API key server-side in Cloudflare and exposes safe admin endpoints:

- `GET /admin-api/auth-status`
- `POST /admin-api/scouts`
- `POST /admin-api/persist`
- `POST /admin-api/queue`
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

Set these in Cloudflare Worker settings (or via `wrangler secret put` where appropriate):

### Admin proxy secrets / vars
- Secret: `SCOUTS_LAMBDA_API_KEY`
- Vars:
  - `SCOUTS_URL`
  - `REQUIRE_CF_ACCESS` (`true` in production)

Production admin/private routes must be protected by a Cloudflare Access application. For a directly Access-protected Worker invocation, the Worker uses Cloudflare's authenticated `ctx.access` context as the primary identity/authentication signal; no separately managed JWT issuer/audience variables are required for that normal path.

The Worker retains its explicit raw-JWT verifier as a fail-closed fallback for invocation/test contexts where `ctx.access` is unavailable. These optional remote Worker variables pin that fallback:

- `TEAM_DOMAIN`: the Access team domain, for example `https://<team>.cloudflareaccess.com`
- `POLICY_AUD`: the Access application's Audience (AUD) tag

If `POLICY_AUD` is configured and `ctx.access` is present, the Worker also requires `ctx.access.aud` to match it. `deploy-ci.sh` uses `wrangler deploy --keep-vars` so existing remote fallback pins are preserved without making them a production availability prerequisite.

### Contact form secrets
- Secret: `TURNSTILE_SECRET_KEY` from the Cloudflare Turnstile dashboard
- Secret: `IFTTT_WEBHOOK_KEY` from https://ifttt.com/maker_webhooks/settings
- Var: `IFTTT_EVENT_NAME` for your IFTTT Webhooks event name (default: `scouts_contact`)

### Cloudflare Turnstile site key
The public site key must be placed in `website/contact/index.html` in the
`data-sitekey` attribute of the `<div class="cf-turnstile">` element. Obtain it
from the Cloudflare Turnstile dashboard and replace the placeholder value
`0x4AAAAAAA_REPLACE_WITH_YOUR_SITEKEY`.

## Contact form request flow

```text
User Browser -> Contact Form -> Turnstile CAPTCHA -> POST /api/contact -> Cloudflare Worker
  -> Turnstile verification -> IFTTT Webhook -> Notification
```

The Worker returns:
- `200 { ok: true }` on success
- `400 { ok: false, code: "CAPTCHA_FAILED" }` if CAPTCHA verification fails
- `400 { ok: false, code: "MISSING_FIELDS" }` if required fields are missing
- `502 { ok: false, code: "NOTIFICATION_FAILED" }` if the IFTTT call fails
- `500 { ok: false, code: "MISSING_CONFIG" }` if secrets are not configured

## Deploy steps (run locally)

1. Install Wrangler if needed:
   - `npm install -g wrangler`
2. Login:
   - `wrangler login`
3. Set secrets:
   - `wrangler secret put SCOUTS_LAMBDA_API_KEY`
   - `wrangler secret put TURNSTILE_SECRET_KEY`
   - `wrangler secret put IFTTT_WEBHOOK_KEY`
4. Confirm the `2ndtolworth.org.uk/admin-api/*`, `/runtime/*`, and `/events/*` routes are protected by the intended Cloudflare Access application.
5. Deploy:
   - `cd scouts/cloudflare/scouts-admin-proxy`
   - `wrangler deploy --var SCOUTS_URL=https://... --var REQUIRE_CF_ACCESS=true --var IFTTT_EVENT_NAME=scouts_contact --keep-vars`

For scripted deploys in this repo, `cloudflare/scouts-admin-proxy/deploy-ci.sh`
also supports resolving the deploy token from Bitwarden via the Scouts local env
file at `lambdas/scouts/.env`. Set one of these secret-ID variables there:

- `BW_SCOUTS_CF_DEPLOY`
- `BWS_SCOUTS_CF_DEPLOY_SECRET_ID`
- `BW_SECRET_ID_CF_DEPLOY_API_TOKEN`

Direct `CF_DEPLOY_API_TOKEN` still works as an override.

## Admin page integration

Update the admin frontend to call:

- `/admin-api/scouts`
- `/admin-api/persist`
- `/admin-api/queue`
- `/admin-api/refresh`
- `/admin-api/auth-status` on load to drive the ready/missing UI status

All admin write operations proxy to the single `SCOUTS_URL` backend. The legacy
`/admin-api/scouts2sqs` route is removed.
