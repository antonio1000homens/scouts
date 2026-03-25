#!/bin/bash

# Scouts image-enrich Step Functions deployment via CloudFormation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-image-enrich}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

STATE_MACHINE_NAME="${STATE_MACHINE_NAME:-scouts-image-enrich}"
REQUESTS_QUEUE_URL="${REQUESTS_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
REQUESTS_QUEUE_ARN="${REQUESTS_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"

TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/scouts-image-enrich.yaml"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== Scouts Image Enrich Step Functions Deployment ===${NC}"

cleanup_failed_stack() {
  local stack_status

  if ! aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" >/dev/null 2>&1; then
    return 0
  fi

  stack_status="$(aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" --query 'Stacks[0].StackStatus' --output text)"
  if [ "${stack_status}" = "ROLLBACK_COMPLETE" ]; then
    echo -e "${YELLOW}Stack ${STACK_NAME} is in ROLLBACK_COMPLETE; deleting before redeploy.${NC}"
    aws cloudformation delete-stack --region "${REGION}" --stack-name "${STACK_NAME}"
    aws cloudformation wait stack-delete-complete --region "${REGION}" --stack-name "${STACK_NAME}"
  fi
}

if ! command -v aws >/dev/null 2>&1; then
  echo -e "${RED}Missing required command: aws${NC}"
  exit 1
fi

echo -e "\n${YELLOW}AWS identity preflight...${NC}"
CALLER_ARN="$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null || true)"
CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null || true)"
if [ -z "${CALLER_ARN}" ] || [ -z "${CALLER_ACCOUNT}" ] || [ "${CALLER_ARN}" = "None" ]; then
  echo -e "${RED}Unable to resolve AWS caller identity. Ensure credentials are configured for local/CI.${NC}"
  exit 1
fi
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  echo -e "${RED}Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}.${NC}"
  exit 1
fi
echo "Using AWS identity: ${CALLER_ARN}"

echo -e "\n${YELLOW}Deploying CloudFormation stack...${NC}"
cleanup_failed_stack
CFN_DEPLOY_ARGS=(
  --region "${REGION}"
  --stack-name "${STACK_NAME}"
  --template-file "${TEMPLATE_FILE}"
  --capabilities CAPABILITY_NAMED_IAM
)

if [ -n "${CLOUDFORMATION_ROLE_ARN}" ]; then
  CFN_DEPLOY_ARGS+=(--role-arn "${CLOUDFORMATION_ROLE_ARN}")
fi

CFN_DEPLOY_ARGS+=(
  --parameter-overrides
    StateMachineName="${STATE_MACHINE_NAME}"
    RequestsQueueUrl="${REQUESTS_QUEUE_URL}"
    RequestsQueueArn="${REQUESTS_QUEUE_ARN}"
)

aws cloudformation deploy "${CFN_DEPLOY_ARGS[@]}"

echo -e "\n${YELLOW}Reading stack outputs...${NC}"
aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table

echo -e "\n${GREEN}Deployment complete.${NC}"
