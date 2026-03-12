#!/bin/bash

# View S3 Objects Script
# Check and display the JSON files created by the Lambda function

set -e

BUCKET_NAME="${1:-2ndtolworth}"
REGION="${2:-eu-west-2}"

echo "Checking S3 bucket: ${BUCKET_NAME}"
echo ""

# List all objects
echo "Objects in bucket:"
aws s3 ls "s3://${BUCKET_NAME}/" --region "${REGION}"
echo ""

# Note: checks for events.json and programme.json removed per repository update
echo "Note: this script no longer checks for events.json or programme.json. Use aws s3 ls to inspect bucket contents if needed."

echo "To download files:"
echo "  aws s3 cp s3://${BUCKET_NAME}/events.json events.json --region ${REGION}"
echo "  aws s3 cp s3://${BUCKET_NAME}/programme.json programme.json --region ${REGION}"
