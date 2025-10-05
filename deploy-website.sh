#!/bin/bash

# Deploy website files to S3 bucket
# This mimics what the GitHub Action will do

BUCKET_NAME="2ndtolworth"
REGION="eu-west-2"

echo "Deploying website files to S3..."

# Sync web files only
aws s3 sync . s3://${BUCKET_NAME}/ \
  --exclude "*" \
  --include "*.html" \
  --include "*.css" \
  --include "*.js" \
  --include "fonts/*" \
  --include "images/*" \
  --include "scouts-img/*" \
  --include "2tolworthcub_booklet_html/*" \
  --delete \
  --cache-control "public, max-age=3600" \
  --metadata-directive REPLACE

echo ""
echo "✅ Website deployed successfully!"
echo ""
echo "Website URL: http://${BUCKET_NAME}.s3-website.${REGION}.amazonaws.com"
echo ""
echo "Files deployed:"
aws s3 ls s3://${BUCKET_NAME}/ --recursive | grep -E '\.(html|css|js)$' | awk '{print "  " $4}'
