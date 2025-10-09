#!/bin/bash

# Force S3 cache invalidation by uploading with no-cache headers
# This ensures browsers don't serve stale cached content

echo "🔄 Forcing S3 cache refresh..."
echo ""

# Upload index.html with aggressive no-cache headers
echo "📄 Uploading index.html with no-cache headers..."
aws s3 cp /home/windsor/github/scouts/index.html s3://2ndtolworth/index.html \
  --content-type "text/html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --metadata-directive REPLACE

# Remove legacy top-level directories that are no longer used
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
  echo "🧹 Cleaning legacy path s3://2ndtolworth/${dir}..."
  aws s3 rm "s3://2ndtolworth/${dir}" --recursive --quiet >/dev/null 2>&1 || true
done

# Upload all HTML files in website directory with no-cache headers
echo "📄 Uploading website HTML files with no-cache headers..."
aws s3 sync /home/windsor/github/scouts/website/ s3://2ndtolworth/website/ \
  --exclude "*" \
  --include "*.html" \
  --content-type "text/html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --metadata-directive REPLACE

# Upload all other website files (images, CSS, JS) with short cache
echo "📦 Uploading other website files..."
aws s3 sync /home/windsor/github/scouts/website/ s3://2ndtolworth/website/ \
  --exclude "*.html" \
  --cache-control "max-age=300" \
  --metadata-directive REPLACE

echo ""
echo "✅ Upload complete with cache headers set!"
echo ""
echo "🌐 Website URL: http://2ndtolworth.s3-website.eu-west-2.amazonaws.com"
echo ""
echo "⚠️  To see changes immediately:"
echo "   1. Hard refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)"
echo "   2. Clear browser cache completely:"
echo "      Chrome: Settings → Privacy → Clear browsing data → Cached images"
echo "      Firefox: Settings → Privacy → Clear Data → Cached Web Content"
echo "   3. Open in incognito/private window"
echo "   4. Wait 1-2 minutes for S3 to propagate changes"
