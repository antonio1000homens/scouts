# Scouts Slack Handler Lambda

A Scouts-owned Slack interaction handler that publishes messages to the Scouts SQS queue.

## Purpose

This lambda serves as the dedicated Slack endpoint for Scouts interactions in the Scouts AWS account.

## Architecture

```text
Slack -> scouts-slack-handler -> scoutsRequest SQS
```

## Routing Logic

- Scouts interactions with action IDs like `scouts_request_approve`, `scouts_request_edit`, `scouts_request_hide`, and `scouts_request_skip` are published to the `scoutsRequest` SQS queue in account `553490163883`.

## Environment Variables

- `SLACK_SIGNING_SECRET`: Slack app signing secret for request verification
- `SLACK_BOT_TOKEN`: Slack bot token for sending responses
- `SCOUTS_REQUEST_QUEUE_URL`: URL of the Scouts request queue
- `TARGET_BUCKET`: Scouts website bucket
- `SCOUTS_CONFIG_KEY`: S3 key for `scouts.conf`

## Deployment

```bash
export SLACK_SIGNING_SECRET="your-slack-signing-secret"
export SLACK_BOT_TOKEN="your-slack-bot-token"
export SCOUTS_REQUEST_QUEUE_URL="https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests"

./deploy.sh
```

## Configuration in Slack

1. Deploy the `scouts-slack-handler` lambda.
2. Note the Function URL from the deployment output.
3. Configure this URL as the Request URL in your Slack app's Interactivity settings.

