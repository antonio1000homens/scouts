#!/usr/bin/env bash

set -euo pipefail

FUNCTION_NAME="scouts-slack-handler"
REGION="${AWS_REGION:-eu-west-2}"

log() {
    echo "==> $*"
}

error() {
    echo "ERROR: $*" >&2
    exit 1
}

# Check AWS CLI
command -v aws >/dev/null 2>&1 || error "AWS CLI not found"



log "Setting environment variables for $FUNCTION_NAME..."
log "SLACK_SIGNING_SECRET_PARAMETER: /scouts/shared/slack-signing-secret"
log "SLACK_BOT_TOKEN_PARAMETER: /scouts/shared/slack-bot-token"
log "REQUIRED_API_KEY_PARAMETER: /scouts/shared/required-api-key"
log "SCOUTS_REQUEST_QUEUE_URL: https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests"

# Update function environment variables
aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --environment "Variables={SLACK_SIGNING_SECRET_PARAMETER=/scouts/shared/slack-signing-secret,SLACK_BOT_TOKEN_PARAMETER=/scouts/shared/slack-bot-token,REQUIRED_API_KEY_PARAMETER=/scouts/shared/required-api-key,SCOUTS_REQUEST_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}" \
    --region "$REGION" >/dev/null

log "Environment variables updated successfully!"
