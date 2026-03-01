#!/bin/bash

# Manual deployment script for scouts website to S3
# This syncs the local files to the S3 bucket

echo "Deploying scouts website to S3..."

# Deploy root index.html
echo "Uploading index.html..."
aws s3 cp index.html s3://2ndtolworth/ --cache-control "max-age=0, no-cache, no-store, must-revalidate"

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
  echo "Removing legacy path s3://2ndtolworth/${dir} (if present)..."
  aws s3 rm "s3://2ndtolworth/${dir}" --recursive --quiet >/dev/null 2>&1 || true
done

# Sync website directory excluding generated event images
echo "Syncing website directory (excluding website/eventImages)..."

# Generate admin runtime config from environment variables when provided
if [ -n "${SCOUTS2SQS_API_KEY:-}" ] || [ -n "${SCOUTS_REFRESH_URL:-}" ] || [ -n "${SCOUTS2SQS_URL:-}" ]; then
  echo "Generating website/admin/admin-config.js from environment variables..."
  {
    echo "// Generated during manual deploy from environment variables."
    echo "window.SCOUTS2SQS_API_KEY = '${SCOUTS2SQS_API_KEY:-}';"
    if [ -n "${SCOUTS_REFRESH_URL:-}" ]; then
      echo "window.SCOUTS_REFRESH_URL = '${SCOUTS_REFRESH_URL}';"
    fi
    if [ -n "${SCOUTS2SQS_URL:-}" ]; then
      echo "window.SCOUTS2SQS_URL = '${SCOUTS2SQS_URL}';"
    fi
  } > website/admin/admin-config.js
fi

aws s3 sync website/ s3://2ndtolworth/website/ \
  --delete \
  --exclude "eventImages/*" \
  --exclude "eventImages/**" \
  --cache-control "max-age=0, no-cache, no-store, must-revalidate"

# Sync website event images without deleting lambda-uploaded assets
if [ -d "website/eventImages" ]; then
  echo "Syncing website/eventImages without delete..."
  aws s3 sync website/eventImages/ s3://2ndtolworth/website/eventImages/ \
    --cache-control "max-age=0, no-cache, no-store, must-revalidate"
fi

echo ""
echo "✅ Deployment complete!"
echo "Website URL: http://2ndtolworth.s3-website.eu-west-2.amazonaws.com"

if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  echo "Creating CloudFront invalidation for ${CLOUDFRONT_DISTRIBUTION_ID}..."
  aws cloudfront create-invalidation \
    --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
    --paths "/index.html" "/website/*" >/dev/null
  echo "CloudFront invalidation submitted."
else
  echo "Skipping CloudFront invalidation (set CLOUDFRONT_DISTRIBUTION_ID to enable)."
fi
echo ""
echo "⚠️  Note: If you still see old content, try:"
echo "   1. Hard refresh in browser (Ctrl+Shift+R or Cmd+Shift+R)"
echo "   2. Clear browser cache"
echo "   3. Open in incognito/private window"
