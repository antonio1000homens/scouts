# scouts-slack-handler worker

This worker is the public ingress for Scouts Slack interactivity:

- `https://slack.2ndtolworth.org.uk/interactive`

No other path on `slack.2ndtolworth.org.uk` is served by this worker.

## Request flow

The worker validates Slack before forwarding anything to AWS:

1. require `X-Slack-Request-Timestamp` and `X-Slack-Signature`;
2. reject requests more than five minutes away from current time;
3. verify the Slack HMAC against the exact raw request body;
4. classify the interaction;
5. add a fresh Worker-to-Lambda HMAC proof;
6. forward the unchanged Slack body and signature headers to the Scouts Slack Lambda.

The AWS Lambda remains responsible for its own Slack signature validation. Its ingress wrapper
also requires the fresh Worker proof for Slack-shaped requests, so calling the public Function URL
directly does not bypass the Cloudflare ingress.

## Acknowledgement classes

### Modal-open fast path

`scouts_request_edit` contains a short-lived Slack `trigger_id`. The worker starts the AWS fetch
immediately, attaches it to `ctx.waitUntil()`, and returns HTTP 200 to Slack without waiting for
AWS. There is deliberately no queue between Cloudflare and the Lambda for this action because the
Lambda must call `views.open` while the trigger remains valid.

### Response-coupled modal submission

`view_submission` for callback `scouts_edit_modal` is different: the Lambda can return a Slack
`response_action` such as `clear`, `errors`, `update`, or `push`. The worker therefore waits for and
returns the Lambda response for this interaction rather than replacing it with an empty edge 200.

### Background interactions

Other actions such as approve/hide/skip are acknowledged with HTTP 200 at Cloudflare immediately.
The AWS hand-off continues under `ctx.waitUntil()` so Lambda cold starts or downstream processing do
not cause Slack's three-second acknowledgement timeout.

## Configuration

The worker requires:

- deploy-time variable `SCOUTS_SLACK_HANDLER_URL` — the live Lambda Function URL;
- Worker secret `SLACK_SIGNING_SECRET` — the Slack app signing secret.

`SLACK_SIGNING_SECRET` must be installed with `wrangler secret put`; do not pass it with `--var` or
store it in `wrangler.toml`. `.github/workflows/slack-edge-security.yml` retrieves the existing
Bitwarden secret and installs it as a Cloudflare Worker secret on trusted branch deployments.

## Worker-to-Lambda authentication

The Function URL remains `AuthType: NONE` because switching it to `AWS_IAM` would require the
Cloudflare Worker to obtain AWS credentials and SigV4-sign each request. Instead, the Worker adds a
fresh, request-bound HMAC proof derived from the Slack signing secret. The Lambda ingress wrapper
requires that proof (within 60 seconds) before delegating Slack traffic to the existing handler.

This is application-layer origin authentication: the Function URL is still reachable on the public
Internet, but Slack-shaped requests without a valid Worker proof are rejected before the existing
Slack handler runs. Admin JSON requests retain their separate API-key authentication path.

## Deploy

From the repo root, with the Worker secret already configured:

```bash
cd scouts
SCOUTS_SLACK_HANDLER_URL=https://<lambda-url>.lambda-url.eu-west-2.on.aws/ \
bash cloudflare/scouts-slack-handler/deploy-ci.sh
```

`CF_DEPLOY_API_TOKEN` can be exported directly, or the deploy script can resolve it from Bitwarden
using a secret ID in `lambdas/scouts/.env` via `BW_SCOUTS_CF_DEPLOY`,
`BWS_SCOUTS_CF_DEPLOY_SECRET_ID`, or `BW_SECRET_ID_CF_DEPLOY_API_TOKEN`.

## Custom Domain

Wrangler is configured with `slack.2ndtolworth.org.uk` as a `custom_domain`. Slack should use:

- `https://slack.2ndtolworth.org.uk/interactive`
