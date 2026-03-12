#!/bin/bash

set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
AWS_REGION_NAME="${AWS_REGION_NAME:-us-east-1}"
DOMAIN_NAME="${DOMAIN_NAME:-2ndtolworth.org.uk}"

echo "Requesting ACM certificate for ${DOMAIN_NAME} in ${AWS_REGION_NAME} using profile ${AWS_PROFILE_NAME}..."

CERT_ARN="$(
  AWS_PROFILE="${AWS_PROFILE_NAME}" aws acm request-certificate \
    --region "${AWS_REGION_NAME}" \
    --domain-name "${DOMAIN_NAME}" \
    --validation-method DNS \
    --idempotency-token scouts2026 \
    --options CertificateTransparencyLoggingPreference=ENABLED \
    --query 'CertificateArn' \
    --output text
)"

echo "Certificate ARN: ${CERT_ARN}"
echo "Waiting briefly for DNS validation records to appear..."
sleep 5

AWS_PROFILE="${AWS_PROFILE_NAME}" aws acm describe-certificate \
  --region "${AWS_REGION_NAME}" \
  --certificate-arn "${CERT_ARN}" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' \
  --output table

echo
echo "Add the CNAME above in Cloudflare, then wait for ACM status ISSUED."
