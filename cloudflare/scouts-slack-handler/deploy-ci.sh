#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BWS_HELPER="${REPO_ROOT}/lambdas/tools/bws-env.sh"
SCOUTS_ENV_FILE="${REPO_ROOT}/lambdas/scouts/.env"

if [ -f "${SCOUTS_ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${SCOUTS_ENV_FILE}"
    set +a
fi

if [ -f "${BWS_HELPER}" ]; then
    # shellcheck disable=SC1090
    source "${BWS_HELPER}"
fi

CONFIG_PATH="cloudflare/scouts-slack-handler/wrangler.toml"

require_env() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "Missing required environment variable: $name" >&2
        exit 1
    fi
}

if declare -F bws_export_if_unset >/dev/null 2>&1; then
    bws_export_if_unset \
        "CF_DEPLOY_API_TOKEN" \
        "${BW_SCOUTS_CF_DEPLOY:-${BWS_SCOUTS_CF_DEPLOY_SECRET_ID:-${BW_SECRET_ID_CF_DEPLOY_API_TOKEN:-}}}" || true
fi

require_env "CF_DEPLOY_API_TOKEN"
require_env "SCOUTS_SLACK_HANDLER_URL"

export CLOUDFLARE_API_TOKEN="$CF_DEPLOY_API_TOKEN"

npx wrangler deploy \
    --config "$CONFIG_PATH" \
    --var "SCOUTS_SLACK_HANDLER_URL=${SCOUTS_SLACK_HANDLER_URL}"
