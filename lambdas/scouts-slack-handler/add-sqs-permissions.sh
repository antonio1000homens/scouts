#!/bin/bash

# Add SQS permissions to scouts-slack-handler Lambda function

set -e

ROLE_NAME="scouts-slack-handler-lambda-role"
QUEUE_NAME="scoutsRequests"
REGION="${AWS_REGION:-eu-west-2}"
ACCOUNT_ID="553490163883"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Adding SQS send permissions to ${ROLE_NAME}...${NC}"

# Create SQS send policy
cat > /tmp/sqs-send-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"
    }
  ]
}
EOF

aws iam put-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-name "SlackHandlerSQSSendAccess" \
    --policy-document file:///tmp/sqs-send-policy.json

echo -e "${GREEN}✓ SQS send permissions added${NC}"

# Cleanup
rm -f /tmp/sqs-send-policy.json

echo -e "\n${GREEN}=== Permissions Added ===${NC}"
