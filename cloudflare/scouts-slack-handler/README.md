# scouts-slack-handler worker

This worker provides a dedicated Cloudflare custom domain for Scouts Slack interactivity:

- `https://slack.2ndtolworth.org.uk/interactive`

It accepts requests only on that host/path and proxies them unchanged to the Scouts AWS
`scouts-slack-handler` Lambda Function URL.

No other path on `slack.2ndtolworth.org.uk` is served by this worker.

## Configuration

The worker requires one deploy-time variable:

- `SCOUTS_SLACK_HANDLER_URL`

Set that to the live Lambda Function URL for `scouts-slack-handler`.

## Deploy

From the repo root:

```bash
cd scouts
SCOUTS_SLACK_HANDLER_URL=https://<lambda-url>.lambda-url.eu-west-2.on.aws/ \
bash cloudflare/scouts-slack-handler/deploy-ci.sh
```

`CF_DEPLOY_API_TOKEN` can be exported directly, or the deploy script can resolve it from
Bitwarden using a secret ID in `lambdas/scouts/.env` via `BW_SCOUTS_CF_DEPLOY`,
`BWS_SCOUTS_CF_DEPLOY_SECRET_ID`, or `BW_SECRET_ID_CF_DEPLOY_API_TOKEN`.

## Custom Domain

Wrangler is configured with:

- `slack.2ndtolworth.org.uk` as a `custom_domain`

After deploy, Slack should use this request URL:

- `https://slack.2ndtolworth.org.uk/interactive`
