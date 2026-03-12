#!/bin/bash

# Manual deployment script for scouts website to S3
# This syncs the local files to the S3 bucket

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
WEBSITE_BUCKET="${WEBSITE_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
WEBSITE_URL="${WEBSITE_URL:-https://d1wv092irxi2lt.cloudfront.net}"

echo "Deploying scouts website to S3..."

# Deploy root index.html
echo "Uploading index.html..."
AWS_PROFILE="${AWS_PROFILE_NAME}" aws s3 cp index.html "s3://${WEBSITE_BUCKET}/" --cache-control "max-age=0, no-cache, no-store, must-revalidate"

# Remove legacy top-level directories that are now served from /website/
LEGACY_DIRS=(
  "beavers"
  "badges"
  "contact"
  "cubs"
  "fonts"
  "hiringtheden"
  "images"
  "history"
  "location"
  "scouts-page"
  "volunteering"
  "welcome"
)

for dir in "${LEGACY_DIRS[@]}"; do
  echo "Removing legacy path s3://${WEBSITE_BUCKET}/${dir} (if present)..."
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws s3 rm "s3://${WEBSITE_BUCKET}/${dir}" --recursive --quiet >/dev/null 2>&1 || true
done

# Sync website directory excluding generated event images
echo "Syncing website directory (excluding website/eventImages)..."

# Generate admin runtime config for Cloudflare Worker proxy mode.
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
} > website/admin/admin-config.js

AWS_PROFILE="${AWS_PROFILE_NAME}" aws s3 sync website/ "s3://${WEBSITE_BUCKET}/website/" \
  --delete \
  --exclude "eventImages/*" \
  --exclude "eventImages/**" \
  --cache-control "max-age=0, no-cache, no-store, must-revalidate"

# Sync website event images without deleting lambda-uploaded assets
if [ -d "website/eventImages" ]; then
  echo "Syncing website/eventImages without delete..."
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws s3 sync website/eventImages/ "s3://${WEBSITE_BUCKET}/website/eventImages/" \
    --cache-control "max-age=0, no-cache, no-store, must-revalidate"
fi

if [ -f "lambdas/sqs2scouts/scouts.conf" ]; then
  echo "Uploading lambdas/sqs2scouts/scouts.conf to s3://${WEBSITE_BUCKET}/scouts.conf..."
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws s3 cp lambdas/sqs2scouts/scouts.conf "s3://${WEBSITE_BUCKET}/scouts.conf" \
    --cache-control "max-age=0, no-cache, no-store, must-revalidate"
else
  echo "No lambdas/sqs2scouts/scouts.conf found locally, skipping upload."
fi

echo ""
echo "✅ Deployment complete!"
echo "Website bucket: s3://${WEBSITE_BUCKET}"
echo "Website URL: ${WEBSITE_URL}"

if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  echo "Creating CloudFront invalidation for ${CLOUDFRONT_DISTRIBUTION_ID}..."
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws cloudfront create-invalidation \
    --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
    --paths "/index.html" "/scouts.conf" "/website/*" "/agenda.json" "/runtime/*" "/events/*" >/dev/null
  echo "CloudFront invalidation submitted."
else
  echo "Skipping CloudFront invalidation (set CLOUDFRONT_DISTRIBUTION_ID to enable)."
fi
echo ""
echo "⚠️  Note: If you still see old content, try:"
echo "   1. Hard refresh in browser (Ctrl+Shift+R or Cmd+Shift+R)"
echo "   2. Clear browser cache"
echo "   3. Open in incognito/private window"
