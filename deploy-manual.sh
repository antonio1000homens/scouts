#!/bin/bash

# Manual deployment script for scouts website to S3
# This syncs the local files to the S3 bucket

echo "Deploying scouts website to S3..."

# Deploy root index.html
echo "Uploading index.html..."
aws s3 cp index.html s3://2ndtolworth/ --cache-control "max-age=0, no-cache, no-store, must-revalidate"

# Sync website directory
echo "Syncing website directory..."
aws s3 sync website/ s3://2ndtolworth/website/ --delete --cache-control "max-age=0, no-cache, no-store, must-revalidate"

echo ""
echo "✅ Deployment complete!"
echo "Website URL: http://2ndtolworth.s3-website.eu-west-2.amazonaws.com"
echo ""
echo "⚠️  Note: If you still see old content, try:"
echo "   1. Hard refresh in browser (Ctrl+Shift+R or Cmd+Shift+R)"
echo "   2. Clear browser cache"
echo "   3. Open in incognito/private window"
