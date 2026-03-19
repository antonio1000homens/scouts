#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="cloudflare/wrangler.toml"

require_env() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "Missing required environment variable: $name" >&2
        exit 1
    fi
}

require_env "CF_DEPLOY_API_TOKEN"

export CLOUDFLARE_API_TOKEN="$CF_DEPLOY_API_TOKEN"

npx wrangler deploy --config "$CONFIG_PATH"
