#!/bin/bash
set -e

STACK_NAME="scouts-cloudfront"
DISTRIBUTION_ID="E3I6EACBCFE736"

echo "Importing existing CloudFront distribution into CloudFormation..."

# Create resources-to-import.json
cat > resources-to-import.json <<EOF
[
  {
    "ResourceType": "AWS::CloudFront::Distribution",
    "LogicalResourceId": "CloudFrontDistribution",
    "ResourceIdentifier": {
      "Id": "${DISTRIBUTION_ID}"
    }
  }
]
EOF

# Import the distribution
aws cloudformation create-change-set \
  --stack-name ${STACK_NAME} \
  --change-set-name import-cloudfront \
  --change-set-type IMPORT \
  --resources-to-import file://resources-to-import.json \
  --template-body file://cloudfront-stack.yaml \
  --capabilities CAPABILITY_IAM

echo "Waiting for change set to be created..."
aws cloudformation wait change-set-create-complete \
  --stack-name ${STACK_NAME} \
  --change-set-name import-cloudfront

echo "Executing change set..."
aws cloudformation execute-change-set \
  --stack-name ${STACK_NAME} \
  --change-set-name import-cloudfront

echo "Waiting for stack import to complete..."
aws cloudformation wait stack-import-complete --stack-name ${STACK_NAME}

echo "✅ CloudFront distribution imported successfully!"
echo "Stack: ${STACK_NAME}"
echo "Distribution ID: ${DISTRIBUTION_ID}"

rm resources-to-import.json
