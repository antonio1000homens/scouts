#!/usr/bin/env bash

bws_bootstrap_access_token() {
    if [ -n "${BWS_ACCESS_TOKEN:-}" ]; then
        return 0
    fi

    if command -v bws-keychain >/dev/null 2>&1; then
        eval "$(bws-keychain export 2>/dev/null)" || true
    fi
}

bws_is_available() {
    bws_bootstrap_access_token
    command -v bws >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && [ -n "${BWS_ACCESS_TOKEN:-}" ]
}

bws_fetch_secret() {
    local secret_id="${1:-}"

    if [ -z "$secret_id" ] || ! bws_is_available; then
        return 1
    fi

    bws secret get "$secret_id" --output json 2>/dev/null | jq -r '.value // empty' 2>/dev/null
}

bws_export_if_unset() {
    local target_var="$1"
    local secret_id="${2:-}"
    local fetched_value=""

    if [ -n "${!target_var:-}" ] || [ -z "$secret_id" ]; then
        return 0
    fi

    fetched_value="$(bws_fetch_secret "$secret_id" || true)"
    if [ -z "$fetched_value" ]; then
        return 1
    fi

    export "$target_var=$fetched_value"
    return 0
}

load_simple_env_file() {
    local config_file="${1:-}"
    local raw_line=""
    local key=""
    local value=""

    if [ -z "$config_file" ] || [ ! -f "$config_file" ]; then
        return 0
    fi

    while IFS= read -r raw_line || [ -n "$raw_line" ]; do
        raw_line="${raw_line#"${raw_line%%[![:space:]]*}"}"
        raw_line="${raw_line%"${raw_line##*[![:space:]]}"}"

        if [ -z "$raw_line" ] || [[ "$raw_line" == \#* ]] || [[ "$raw_line" != *=* ]]; then
            continue
        fi

        key="${raw_line%%=*}"
        value="${raw_line#*=}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"

        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
            value="${value:1:${#value}-2}"
        fi

        if [ -z "${!key:-}" ]; then
            export "$key=$value"
        fi
    done < "$config_file"
}
