# Cloudflare Workers Proxy (Scouts)

This Worker covers two responsibilities:

1. **Admin proxy** – keeps the Lambda API key server-side and exposes safe admin endpoints.
2. **Contact-form proxy** – validates Cloudflare Turnstile captcha and forwards contact messages to an IFTTT webhook.

## Admin endpoints

- `GET /admin-api/auth-status`
- `POST /admin-api/persist`
- `POST /admin-api/refresh`

## Contact-form endpoint

- `POST /contact-api/submit`

The browser POSTs `{ name, email, message, "cf-turnstile-response" }` as JSON.  
The Worker:
1. Verifies the Turnstile token with Cloudflare's siteverify API.
2. If valid, fires a POST to the IFTTT Maker webhook (`value1=name`, `value2=email`, `value3=message`).
3. Returns `{ ok: true }` on success or an error response.

## Why this exists

The admin browser should never hold the Lambda API key.  
The Worker injects `apiKey` when forwarding requests to Lambda.  
The contact form should not expose the IFTTT webhook key, and must be protected against bots with Cloudflare Turnstile.

## Files

- `wrangler.toml`: Worker project config
- `worker.js`: Proxy logic, auth-status, and contact-form endpoints
- `.dev.vars.example`: local variable template

## Required configuration

### Admin proxy

Set these in Cloudflare Worker settings (or via `wrangler secret put` / `wrangler deploy --var`):

- Secret: `SCOUTS_LAMBDA_API_KEY`
- Vars:
  - `SCOUTS2SQS_URL`
  - `SCOUTS_REFRESH_URL`
  - `REQUIRE_CF_ACCESS` (`true` in production)

### Contact form

- Secret: `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile **secret** key)
- Secret: `IFTTT_WEBHOOK_KEY` (IFTTT Maker webhook API key)
- Var: `IFTTT_WEBHOOK_EVENT` (IFTTT event name, e.g. `scouts_contact_form`)

> **Contact page HTML** – update the `data-sitekey` attribute on the `.cf-turnstile` div in  
> `website/contact/index.html` with your Turnstile **site key** (public, safe to commit).

Also configure routes in `wrangler.toml`:

```toml
routes = [
  { pattern = "your-domain.example/admin-api/*", zone_name = "your-domain.example" },
  { pattern = "your-domain.example/contact-api/*", zone_name = "your-domain.example" }
]
```

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
   - `wrangler deploy --var SCOUTS2SQS_URL=https://... --var SCOUTS_REFRESH_URL=https://... --var REQUIRE_CF_ACCESS=true --var IFTTT_WEBHOOK_EVENT=scouts_contact_form`

## Admin page integration

Update the admin frontend to call:

- `/admin-api/persist` (instead of direct `SCOUTS2SQS_URL`)
- `/admin-api/refresh` (instead of direct `SCOUTS_REFRESH_URL`)
- `/admin-api/auth-status` on load to drive "ready/missing" UI status
