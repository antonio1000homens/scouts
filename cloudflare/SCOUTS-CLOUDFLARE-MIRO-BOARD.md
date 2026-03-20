# Scouts Cloudflare Current Architecture Miro Board Spec

This file is a Miro-ready build spec derived from:
`scouts/cloudflare/SCOUTS-CLOUDFLARE-CURRENT-ARCHITECTURE.md`

## Board title

`Scouts Cloudflare - Current Architecture`

## Verification status

- Miro MCP configured in the IDE points to `https://mcp.miro.com/`
- Endpoint is reachable from this environment
- Current auth status is not valid for board creation from this session
- Browser session is also not signed in to Miro

## Frame layout

Use a single frame with four vertical columns from left to right:

1. `Public / Browser / Slack edge`
2. `Cloudflare`
3. `AWS`
4. `External services`

## Shapes

Create one rounded rectangle per item.

### Column 1

- `Admin browser`
- `Public contact form`
- `Slack interactivity`

### Column 2

- `Cloudflare Access`
- `scouts-admin-proxy worker`
- `Turnstile verification`
- `scouts-slack-handler worker`

### Column 3

- `scouts lambda URL`
  Label detail: `SCOUTS_URL`
- `scouts-slack-handler Lambda URL`
- `scoutsRequests SQS`
- `scouts2sqs Lambda`
- `scoutsProcessing SQS`
- `sqs2scouts Lambda`

### Column 4

- `IFTTT webhook`

## Connectors

Create directed arrows with these labels:

- `Admin browser` -> `Cloudflare Access`
  Label: `GET/POST /admin-api/*`
- `Cloudflare Access` -> `scouts-admin-proxy worker`
- `scouts-admin-proxy worker` -> `scouts lambda URL`
  Label: `POST /admin-api/scouts`
- `scouts-admin-proxy worker` -> `scouts lambda URL`
  Label: `POST /admin-api/persist`
- `scouts-admin-proxy worker` -> `scouts lambda URL`
  Label: `POST /admin-api/queue`
- `scouts-admin-proxy worker` -> `scouts lambda URL`
  Label: `POST /admin-api/refresh`
- `scouts-admin-proxy worker` -> `scouts-admin-proxy worker`
  Label: `GET /admin-api/auth-status`
- `Public contact form` -> `scouts-admin-proxy worker`
  Label: `POST /api/contact`
- `scouts-admin-proxy worker` -> `Turnstile verification`
  Label: `verify captcha`
- `scouts-admin-proxy worker` -> `IFTTT webhook`
  Label: `forward notification`
- `Slack interactivity` -> `scouts-slack-handler worker`
  Label: `POST /interactive`
- `scouts-slack-handler worker` -> `scouts-slack-handler Lambda URL`
  Label: `proxy unchanged`
- `scouts lambda URL` -> `scoutsRequests SQS`
  Label: `publishes work`
- `scoutsRequests SQS` -> `scouts2sqs Lambda`
- `scouts2sqs Lambda` -> `scoutsProcessing SQS`
- `scoutsProcessing SQS` -> `sqs2scouts Lambda`

## Explicit removals

Show these as faded or struck-through notes near the Cloudflare section:

- `Removed from Cloudflare: /admin-api/scouts2sqs`
- `Removed direct worker target: scouts2sqs`

Do not draw any active connector from a Cloudflare worker directly to `scouts2sqs Lambda`.

## Suggested visual treatment

- Column headers: bold, centered
- Cloudflare column: orange
- AWS column: light yellow
- Public column: light blue
- External services column: light green
- Removed items: red dashed border or red strikethrough

## Build order

1. Create frame and four columns
2. Add all shapes in column order
3. Add directed connectors with labels
4. Add the two removal notes
5. Verify there is no direct Cloudflare -> `scouts2sqs Lambda` path
