#!/bin/bash

# Add SQS SendMessage permission for sqs2scouts lambda to publish to scoutsDecision queue

ROLE_NAME="sqs2scouts-lambda-role"
QUEUE_ARN="arn:aws:sqs:eu-west-2:243857182133:scoutsDecision"

# Create policy document
cat > sqs-send-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "sqs:SendMessage",
            "Resource": "${QUEUE_ARN}"
        }
    ]
}
EOF

# Attach policy to role
aws iam put-role-policy \
    --role-name ${ROLE_NAME} \
    --policy-name sqs2scouts-send-to-scoutsDecision \
    --policy-document file://sqs-send-policy.json

echo "✅ Added SQS SendMessage permission for ${ROLE_NAME} to ${QUEUE_ARN}"

# Clean up
rm sqs-send-policy.json