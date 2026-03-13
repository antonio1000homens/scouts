#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
WEBSITE_BUCKET="${WEBSITE_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
WEBSITE_URL="${WEBSITE_URL:-https://d1wv092irxi2lt.cloudfront.net}"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh <target> [target...]

Targets:
  website
  queues
  scouts
  lambdas
  all

Examples:
  ./deploy.sh website
  ./deploy.sh queues scouts
  ./deploy.sh lambdas
  ./deploy.sh all
EOF
}

run_aws() {
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws "$@"
}

deploy_website() {
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
    if [ -n "${SCOUTS_REFRESH_URL:-}" ]; then
      echo "window.SCOUTS_REFRESH_URL = '${SCOUTS_REFRESH_URL}';"
    fi
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
    echo "Uploading lambdas/scouts/scouts.conf to s3://${WEBSITE_BUCKET}/scouts.conf..."
    run_aws s3 cp "${SCRIPT_DIR}/lambdas/scouts/scouts.conf" "s3://${WEBSITE_BUCKET}/scouts.conf" \
      --cache-control "max-age=0, no-cache, no-store, must-revalidate"
  else
    echo "No lambdas/scouts/scouts.conf found locally, skipping upload."
  fi

  echo "Website bucket: s3://${WEBSITE_BUCKET}"
  echo "Website URL: ${WEBSITE_URL}"

  if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
    echo "Creating CloudFront invalidation for ${CLOUDFRONT_DISTRIBUTION_ID}..."
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
