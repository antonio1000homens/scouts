#!/usr/bin/env bash

# Resolve or publish the content-addressed scouts-shared Lambda layer version.
# This is safe to call repeatedly: unchanged runtime content reuses the existing
# layer version and does not rebuild or upload the layer ZIP.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARED_LAYER_HELPER="${ROOT_DIR}/tools/shared-layer-artifact.sh"

# shellcheck disable=SC1090
source "${SHARED_LAYER_HELPER}"

REGION="${AWS_REGION:-eu-west-2}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-${HOME}/.npm}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
RUNTIME="${RUNTIME:-nodejs24.x}"

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null || true)"
if [ -z "${CALLER_ACCOUNT}" ] || [ "${CALLER_ACCOUNT}" = "None" ]; then
  echo "Unable to resolve AWS caller identity." >&2
  exit 1
fi
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  echo "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}." >&2
  exit 1
fi

resolve_shared_layer_version \
  "${SCRIPT_DIR}" \
  "${CODE_BUCKET}" \
  "${REGION}" \
  "${NPM_CACHE_DIR}" \
  "${LAYER_NAME}" \
  "${RUNTIME}"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "SCOUTS_SHARED_LAYER_VERSION_ARN=${SCOUTS_SHARED_LAYER_VERSION_ARN}" >> "${GITHUB_ENV}"
fi

printf '%s\n' "${SCOUTS_SHARED_LAYER_VERSION_ARN}"
