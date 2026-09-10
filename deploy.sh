#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Developer/deployment-specific values must be supplied explicitly. In CI, AWS
# credentials are normally provided by OIDC, so an AWS profile is optional.
AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-${AWS_PROFILE:-}}"
WEBSITE_BUCKET="${WEBSITE_BUCKET:-}"
WEBSITE_URL="${WEBSITE_URL:-}"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh <target> [target...]

Targets:
  website
  queues
  scouts
  lambdas
  all

Environment for website deployment:
  WEBSITE_BUCKET                 required
  AWS_PROFILE or AWS_PROFILE_NAME optional when ambient/OIDC credentials exist
  WEBSITE_URL                    optional display URL
  CLOUDFRONT_DISTRIBUTION_ID     optional cache invalidation target

Examples:
  WEBSITE_BUCKET=my-scouts-site AWS_PROFILE=my-profile ./deploy.sh website
  ./deploy.sh queues scouts
  ./deploy.sh lambdas
  ./deploy.sh all
EOF
}

run_aws() {
  if [ -n "${AWS_PROFILE_NAME}" ]; then
    AWS_PROFILE="${AWS_PROFILE_NAME}" aws "$@"
  else
    aws "$@"
  fi
}

require_website_config() {
  if [ -z "${WEBSITE_BUCKET}" ]; then
    echo "WEBSITE_BUCKET must be set for website deployment." >&2
    echo "Keep deployment-specific bucket names in local/GitHub environment configuration rather than relying on a repository default." >&2
    exit 1
  fi
}

deploy_website() {
  require_website_config

  local legacy_dirs=(
    beavers badges contact cubs fonts hiringtheden images
    history location scouts-page volunteering welcome
  )

  echo "Deploying scouts website to S3..."
  echo "Uploading index.html..."
  run_aws s3 cp "${SCRIPT_DIR}/index.html" "s3://${WEBSITE_BUCKET}/" \
    --cache-control "max-age=0, no-cache, no-store, must-revalidate"

  for dir in "${legacy_dirs[@]}"; do
    echo "Removing legacy path s3://${WEBSITE_BUCKET}/${dir} (if present)..."
    run_aws s3 rm "s3://${WEBSITE_BUCKET}/${dir}" --recursive --quiet >/dev/null 2>&1 || true
  done

  echo "Generating website/admin/admin-config.js for Cloudflare proxy..."
  ADMIN_API_BASE_VALUE="${ADMIN_API_BASE:-/admin-api}"
  {
    echo "// Generated during manual deploy for Cloudflare Worker proxy mode."
    echo "window.ADMIN_API_BASE = '${ADMIN_API_BASE_VALUE}';"
    if [ -n "${SCOUTS_AUTH_STATUS_URL:-}" ]; then
      echo "window.SCOUTS_AUTH_STATUS_URL = '${SCOUTS_AUTH_STATUS_URL}';"
    fi
    # Keep the Lambda URL server-side in the Cloudflare Worker. Writing
    # SCOUTS_URL here would make the browser bypass /admin-api and lose the
    # Worker-injected API key.
    if [ -n "${SCOUTS_CONFIG_URL:-}" ]; then
      echo "window.SCOUTS_CONFIG_URL = '${SCOUTS_CONFIG_URL}';"
    fi
  } > "${SCRIPT_DIR}/website/admin/admin-config.js"

  echo "Syncing website directory..."
  run_aws s3 sync "${SCRIPT_DIR}/website/" "s3://${WEBSITE_BUCKET}/website/" \
    --delete \
    --exclude "eventImages/*" \
    --exclude "eventImages/**" \
    --cache-control "max-age=0, no-cache, no-store, must-revalidate"

  if [ -d "${SCRIPT_DIR}/website/eventImages" ]; then
    echo "Syncing website/eventImages without delete..."
    run_aws s3 sync "${SCRIPT_DIR}/website/eventImages/" "s3://${WEBSITE_BUCKET}/website/eventImages/" \
      --cache-control "max-age=0, no-cache, no-store, must-revalidate"
  fi

  if [ -f "${SCRIPT_DIR}/lambdas/scouts/scouts.conf" ]; then
    echo "Uploading lambdas/scouts/scouts.conf to the configured website bucket..."
    run_aws s3 cp "${SCRIPT_DIR}/lambdas/scouts/scouts.conf" "s3://${WEBSITE_BUCKET}/scouts.conf" \
      --cache-control "max-age=0, no-cache, no-store, must-revalidate"
  else
    echo "No lambdas/scouts/scouts.conf found locally, skipping upload."
  fi

  echo "Website bucket configured."
  if [ -n "${WEBSITE_URL}" ]; then
    echo "Website URL: ${WEBSITE_URL}"
  fi

  if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
    echo "Creating configured CloudFront invalidation..."
    run_aws cloudfront create-invalidation \
      --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
      --paths "/index.html" "/scouts.conf" "/website/*" "/agenda.json" "/runtime/*" "/events/*" >/dev/null
    echo "CloudFront invalidation submitted."
  else
    echo "Skipping CloudFront invalidation (set CLOUDFRONT_DISTRIBUTION_ID to enable)."
  fi
}

deploy_target() {
  local target="$1"
  case "${target}" in
    website)
      deploy_website
      ;;
    queues)
      (cd "${SCRIPT_DIR}/lambdas/scouts-queues" && bash ./deploy.sh)
      ;;
    scouts)
      (cd "${SCRIPT_DIR}/lambdas/scouts" && bash ./deploy.sh)
      ;;
    lambdas)
      deploy_target queues
      deploy_target scouts
      ;;
    all)
      deploy_target website
      deploy_target lambdas
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown target: ${target}" >&2
      usage >&2
      exit 1
      ;;
  esac
}

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 1
fi

for target in "$@"; do
  deploy_target "${target}"
done
