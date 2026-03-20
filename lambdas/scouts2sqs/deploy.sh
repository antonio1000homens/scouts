#!/bin/bash

# scouts2sqs Lambda deployment via CloudFormation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BWS_HELPER="${ROOT_DIR}/tools/bws-env.sh"
SHARED_LAYER_DIR="${ROOT_DIR}/shared-layer"
SHARED_LAYER_ZIP="${SHARED_LAYER_DIR}/lambda-layer.zip"

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

if [ -f "${BWS_HELPER}" ]; then
  # shellcheck disable=SC1090
  source "${BWS_HELPER}"
fi

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts2sqs-lambda}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"
DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/scouts2sqs}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-${HOME}/.npm}"

FUNCTION_NAME="${FUNCTION_NAME:-scouts2sqs}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
ROLE_NAME="${ROLE_NAME:-scouts2sqs-lambda-role}"
RUNTIME="${RUNTIME:-nodejs24.x}"
HANDLER="${HANDLER:-scouts2sqs.lambdaHandler}"
QUEUE_ARN="${QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsProcessing}"
QUEUE_URL="${QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing}"
SCOUTS_REQUESTS_QUEUE_ARN="${SCOUTS_REQUESTS_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
SCOUTS_REQUESTS_QUEUE_URL="${SCOUTS_REQUESTS_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
BATCH_SIZE="${BATCH_SIZE:-1}"
FUNCTION_URL_AUTH_TYPE="${FUNCTION_URL_AUTH_TYPE:-NONE}"
TIMEOUT="${TIMEOUT:-30}"
MEMORY_SIZE="${MEMORY_SIZE:-256}"
TARGET_BUCKET="${TARGET_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
SCOUTS_CONFIG_KEY="${SCOUTS_CONFIG_KEY:-scouts.conf}"
REQUIRED_API_KEY="${REQUIRED_API_KEY:-${SCOUTS_REQUIRED_API_KEY:-}}"
SCOUTS2SQS_PUBLISH_ENABLED="${SCOUTS2SQS_PUBLISH_ENABLED:-true}"
DLQ_URL="${DLQ_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ}"
FULL_ENRICH_STATE_MACHINE_ARN="${FULL_ENRICH_STATE_MACHINE_ARN:-}"

TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/scouts2sqs.yaml"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== scouts2sqs CloudFormation Deployment ===${NC}"

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

for cmd in aws npm zip; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo -e "${RED}Missing required command: ${cmd}${NC}"
    exit 1
  fi
done

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

cd "${SCRIPT_DIR}"

if declare -F bws_export_if_unset >/dev/null 2>&1; then
  bws_export_if_unset "REQUIRED_API_KEY" "${BWS_REQUIRED_API_KEY_SECRET_ID:-${BWS_SCOUTS_REQUIRED_API_KEY_SECRET_ID:-}}" || true
fi

if [ -z "${REQUIRED_API_KEY}" ]; then
  CURRENT_REQUIRED_API_KEY="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.REQUIRED_API_KEY' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_REQUIRED_API_KEY}" ] && [ "${CURRENT_REQUIRED_API_KEY}" != "None" ] && [ "${CURRENT_REQUIRED_API_KEY}" != "null" ]; then
    REQUIRED_API_KEY="${CURRENT_REQUIRED_API_KEY}"
  fi
fi

if [ -z "${FULL_ENRICH_STATE_MACHINE_ARN}" ]; then
  DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN="$(aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name scouts-full-enrich \
    --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" \
    --output text 2>/dev/null || true)"
  if [ -n "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" ] && [ "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" != "None" ] && [ "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" != "null" ]; then
    FULL_ENRICH_STATE_MACHINE_ARN="${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}"
  fi
fi

echo -e "\n${YELLOW}Step 1: Build shared Lambda layer...${NC}"
(
  cd "${SHARED_LAYER_DIR}/nodejs"
  npm install --production --cache "${NPM_CACHE_DIR}"
)
(
  cd "${SHARED_LAYER_DIR}"
  rm -f lambda-layer.zip
  zip -qr lambda-layer.zip nodejs
)

echo -e "\n${YELLOW}Step 2: Package Lambda function...${NC}"
(
  cd function
  rm -f scouts2sqs-lambda.zip
  zip -q scouts2sqs-lambda.zip scouts2sqs.mjs
)

echo -e "\n${YELLOW}Step 3: Upload artifacts to S3...${NC}"
FUNCTION_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/scouts2sqs-lambda.zip"
LAYER_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/scouts-shared-layer.zip"

aws s3 cp function/scouts2sqs-lambda.zip "s3://${CODE_BUCKET}/${FUNCTION_CODE_KEY}" --region "${REGION}"
aws s3 cp "${SHARED_LAYER_ZIP}" "s3://${CODE_BUCKET}/${LAYER_CODE_KEY}" --region "${REGION}"

echo -e "\n${YELLOW}Step 4: Deploy CloudFormation stack...${NC}"
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
    CodeBucket="${CODE_BUCKET}"
    FunctionCodeKey="${FUNCTION_CODE_KEY}"
    LayerCodeKey="${LAYER_CODE_KEY}"
    FunctionName="${FUNCTION_NAME}"
    LayerName="${LAYER_NAME}"
    RoleName="${ROLE_NAME}"
    Runtime="${RUNTIME}"
    Handler="${HANDLER}"
    QueueArn="${QUEUE_ARN}"
    ScoutsRequestsQueueArn="${SCOUTS_REQUESTS_QUEUE_ARN}"
    BatchSize="${BATCH_SIZE}"
    FunctionUrlAuthType="${FUNCTION_URL_AUTH_TYPE}"
    Timeout="${TIMEOUT}"
    MemorySize="${MEMORY_SIZE}"
    RequiredApiKey="${REQUIRED_API_KEY}"
    Scouts2SqsPublishEnabled="${SCOUTS2SQS_PUBLISH_ENABLED}"
    TargetBucket="${TARGET_BUCKET}"
    ScoutsConfigKey="${SCOUTS_CONFIG_KEY}"
    ScoutsRequestsQueueUrl="${SCOUTS_REQUESTS_QUEUE_URL}"
    ProcessingQueueUrl="${QUEUE_URL}"
    DlqUrl="${DLQ_URL}"
    FullEnrichStateMachineArn="${FULL_ENRICH_STATE_MACHINE_ARN}"
)

aws cloudformation deploy \
  "${CFN_DEPLOY_ARGS[@]}"

echo -e "\n${YELLOW}Step 5: Read stack outputs...${NC}"
aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table

echo -e "\n${GREEN}Deployment complete.${NC}"
