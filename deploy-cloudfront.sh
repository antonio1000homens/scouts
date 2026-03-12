#!/bin/bash

set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
AWS_REGION_NAME="${AWS_REGION_NAME:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-cloudfront}"
DOMAIN_NAME="${DOMAIN_NAME:-2ndtolworth.org.uk}"
ORIGIN_DOMAIN_NAME="${ORIGIN_DOMAIN_NAME:-scouts-2ndtolworth-prod-553490163883.s3-website.eu-west-2.amazonaws.com}"
TEMPLATE_FILE="${TEMPLATE_FILE:-cloudfront-stack.yaml}"
ENABLE_ALIAS="${ENABLE_ALIAS:-false}"

if [ -z "${CERTIFICATE_ARN:-}" ]; then
  echo "CERTIFICATE_ARN must be set to an ISSUED us-east-1 ACM certificate ARN."
  exit 1
fi

echo "Deploying CloudFront stack ${STACK_NAME} using profile ${AWS_PROFILE_NAME}..."

AWS_PROFILE="${AWS_PROFILE_NAME}" aws cloudformation deploy \
  --region "${AWS_REGION_NAME}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DomainName="${DOMAIN_NAME}" \
    EnableAlias="${ENABLE_ALIAS}" \
    CertificateArn="${CERTIFICATE_ARN}" \
    OriginDomainName="${ORIGIN_DOMAIN_NAME}"

AWS_PROFILE="${AWS_PROFILE_NAME}" aws cloudformation describe-stacks \
  --region "${AWS_REGION_NAME}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table
