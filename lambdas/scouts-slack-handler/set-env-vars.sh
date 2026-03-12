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



# Get Slack signing secret from scouts-slack-handler function
SLACK_SECRET=$(aws lambda get-function-configuration \
    --function-name "${FUNCTION_NAME}" \
    --region "$REGION" \
    --query 'Environment.Variables.SLACK_SIGNING_SECRET' \
    --output text 2>/dev/null || echo "")

if [ -z "$SLACK_SECRET" ] || [ "$SLACK_SECRET" = "None" ]; then
    error "Could not get SLACK_SIGNING_SECRET from ${FUNCTION_NAME}"
fi

log "Setting environment variables for $FUNCTION_NAME..."
log "SLACK_SIGNING_SECRET: [REDACTED]"
log "SCOUTS_REQUEST_QUEUE_URL: https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests"

# Update function environment variables
aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --environment "Variables={SLACK_SIGNING_SECRET=$SLACK_SECRET,SCOUTS_REQUEST_QUEUE_URL=https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}" \
    --region "$REGION" >/dev/null

log "Environment variables updated successfully!"
