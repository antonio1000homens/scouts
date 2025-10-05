#!/bin/bash

# Configure S3 bucket for static website hosting
# Run this once to set up the bucket

BUCKET_NAME="2ndtolworth"
REGION="eu-west-2"

echo "Configuring S3 bucket for static website hosting..."

# Enable static website hosting
aws s3 website s3://${BUCKET_NAME}/ \
  --index-document index.html \
  --error-document index.html

# Allow public access (disable block public access)
echo "Allowing public access to bucket..."
aws s3api put-public-access-block \
  --bucket ${BUCKET_NAME} \
  --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Set bucket policy for public read access
echo "Setting bucket policy for public read access..."
cat > /tmp/bucket-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
    }
  ]
}
EOF

aws s3api put-bucket-policy --bucket ${BUCKET_NAME} --policy file:///tmp/bucket-policy.json

echo ""
echo "✅ S3 bucket configured for static website hosting!"
echo ""
echo "Website URL: http://${BUCKET_NAME}.s3-website.${REGION}.amazonaws.com"
echo ""
echo "To deploy your website, run: ./deploy-website.sh"
