#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

default_function_url="https://rc23djdoaofiwwvueboxe5ycue0jqtrx.lambda-url.eu-west-2.on.aws/"
FUNCTION_URL="${FUNCTION_URL:-$default_function_url}"
QUEUE_URL="${QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing}"
API_KEY_ENV="${REQUIRED_API_KEY:-${SCOUTS_REQUIRED_API_KEY:-}}"

CONFIG_PATHS=(
  "$SCRIPT_DIR/../shared-layer/config.json"
  "$SCRIPT_DIR/../shared-layer/nodejs/config.json"
)

PAYLOAD_FILE=""
POLL_SQS=false

usage() {
  cat <<'EOF'
Usage: local-scouts-sqs.sh [options]

Options:
  -f, --file PATH      Path to JSON payload to POST to the scouts2sqs Lambda URL.
                       If omitted a sample payload is generated automatically.
  -p, --poll-sqs       After sending the request, attempt to receive a message
                       from the Scouts SQS queue using the AWS CLI.
  -h, --help           Show this help.

Environment variables:
  FUNCTION_URL         Override the scouts2sqs Lambda function URL.
  REQUIRED_API_KEY     API key to include in the x-api-key header (preferred).
  SCOUTS_REQUIRED_API_KEY
                       Alternate variable name for REQUIRED_API_KEY.
  QUEUE_URL            Override the target SQS queue URL for polling.

If no API key environment variable is provided, the script will attempt to
read REQUIRED_API_KEY from a local config.json.

Dependencies:
  - curl (required)
  - python3 (required to read config.json when key not set in env)
  - jq   (optional, for pretty-printing responses if installed)
  - aws  (optional, only required when using --poll-sqs)

EOF
}

log() {
  printf '==> %s\n' "$*"
}

error() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

ensure_command() {
  local cmd=$1
  command -v "$cmd" >/dev/null 2>&1 || error "Missing dependency: $cmd"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--file)
        PAYLOAD_FILE="$2"
        shift 2
        ;;
      -p|--poll-sqs)
        POLL_SQS=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        ;;
    esac
  done
}

CONFIG_PATH_USED=""

load_api_key_from_config() {
  local path
  for path in "${CONFIG_PATHS[@]}"; do
    if [[ -f "$path" ]]; then
      local key
      key="$(python3 - "$path" <<'PY'
import json, sys

path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)

value = data.get('REQUIRED_API_KEY') or ''
print(value)
PY
)"
      key="${key%$'\n'}"
      if [[ -n "$key" ]]; then
        CONFIG_PATH_USED="$path"
        echo "$key"
        return 0
      fi
    fi
  done
  echo ""
}

generate_sample_payload() {
  cat <<'EOF'
{
  "realm": "AI",
  "action": "request",
  "subject": "ABC"
}
EOF
}

resolve_payload() {
  if [[ -n "$PAYLOAD_FILE" ]]; then
    [[ -f "$PAYLOAD_FILE" ]] || error "Payload file not found: $PAYLOAD_FILE"
    cat "$PAYLOAD_FILE"
  else
    generate_sample_payload
  fi
}

pretty_print() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
  fi
}

poll_sqs_queue() {
  ensure_command aws
  log "Polling SQS queue: $QUEUE_URL"
  aws sqs receive-message \
    --queue-url "$QUEUE_URL" \
    --max-number-of-messages 1 \
    --wait-time-seconds 2 \
    --visibility-timeout 0 \
    --attribute-names All \
    --message-attribute-names All || log "No messages received or AWS CLI error."
}

main() {
  parse_args "$@"
  ensure_command curl

  API_KEY="$API_KEY_ENV"
  if [[ -z "$API_KEY" ]]; then
    ensure_command python3
    API_KEY="$(load_api_key_from_config)"
    if [[ -n "$API_KEY" && -n "$CONFIG_PATH_USED" ]]; then
      log "Loaded API key from config: $CONFIG_PATH_USED"
    fi
  fi

  [[ -n "$API_KEY" ]] || error "Unable to determine REQUIRED_API_KEY. Set it via environment variable or config.json."

  log "Using function URL: $FUNCTION_URL"
  log "Preparing payload..."
  payload="$(resolve_payload)"
  log "Payload:"
  printf '%s\n' "$payload" | pretty_print

  log "Sending request..."
  response="$(curl -sS -w '\n%{http_code}' -X POST "$FUNCTION_URL" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    --data "$payload")" || error "curl request failed"

  http_body="$(printf '%s' "$response" | sed '$d')"
  http_status="$(printf '%s' "$response" | tail -n1)"

  log "HTTP status: $http_status"
  log "Response body:"
  printf '%s\n' "$http_body" | pretty_print

  if [[ "$POLL_SQS" == true ]]; then
    poll_sqs_queue
  else
    log "Skipping SQS polling (use --poll-sqs to enable)."
  fi

  log "Done. Check Slack #scouts for notifications when applicable."
}

main "$@"
