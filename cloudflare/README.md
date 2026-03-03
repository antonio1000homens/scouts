# Cloudflare Admin Proxy (Scouts)

This Worker keeps the Lambda API key server-side in Cloudflare and exposes safe admin endpoints:

- `GET /admin-api/auth-status`
- `POST /admin-api/persist`
- `POST /admin-api/refresh`

## Why this exists

The admin browser should never hold the Lambda API key.  
The Worker injects `apiKey` when forwarding requests to Lambda.

## Files

- `wrangler.toml`: Worker project config
- `worker.js`: Proxy logic and auth-status endpoint
- `.dev.vars.example`: local variable template

## Required configuration

Set these in Cloudflare Worker settings (or via `wrangler secret put` / `wrangler deploy --var`):

- Secret: `SCOUTS_LAMBDA_API_KEY`
- Vars:
  - `SCOUTS2SQS_URL`
  - `SCOUTS_REFRESH_URL`
  - `REQUIRE_CF_ACCESS` (`true` in production)

Also configure a route in `wrangler.toml`, for example:

```toml
routes = [
  { pattern = "your-domain.example/admin-api/*", zone_name = "your-domain.example" }
]
```

## Deploy steps (run locally)

1. Install Wrangler (if needed):
   - `npm install -g wrangler`
2. Login:
   - `wrangler login`
3. Deploy:
   - `cd scouts/cloudflare`
   - `wrangler secret put SCOUTS_LAMBDA_API_KEY`
   - `wrangler deploy --var SCOUTS2SQS_URL=https://... --var SCOUTS_REFRESH_URL=https://... --var REQUIRE_CF_ACCESS=true`

## Admin page integration

Update the admin frontend to call:

- `/admin-api/persist` (instead of direct `SCOUTS2SQS_URL`)
- `/admin-api/refresh` (instead of direct `SCOUTS_REFRESH_URL`)
- `/admin-api/auth-status` on load to drive "ready/missing" UI status

