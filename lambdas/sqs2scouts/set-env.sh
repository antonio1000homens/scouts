#!/bin/bash

# Set environment variables for local testing.
# Source this file before running tests: source ./set-env.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BWS_HELPER="${ROOT_DIR}/tools/bws-env.sh"

if [ -f "${ROOT_DIR}/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "${ROOT_DIR}/.env"
    set +a
fi

if [ -f "${BWS_HELPER}" ]; then
    # shellcheck disable=SC1090
    source "${BWS_HELPER}"
fi

if declare -F bws_export_if_unset >/dev/null 2>&1; then
    bws_export_if_unset "SLACK_BOT_TOKEN" "${BWS_SLACK_BOT_TOKEN_SECRET_ID:-}" || true
    bws_export_if_unset "SLACK_SIGNING_SECRET" "${BWS_SLACK_SIGNING_SECRET_SECRET_ID:-}" || true
    bws_export_if_unset "GEMINI_API_KEY" "${BWS_GEMINI_API_KEY_SECRET_ID:-}" || true
fi

export SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-https://slack.com/api/chat.postMessage}"

echo "Environment variables set for sqs2scouts Lambda function"
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
    echo "SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN:0:10}..."
else
    echo "SLACK_BOT_TOKEN: not set"
fi
echo "SLACK_WEBHOOK_URL: $SLACK_WEBHOOK_URL"
