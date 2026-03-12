#!/bin/bash

# sqs2scouts Lambda deployment via CloudFormation

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
STACK_NAME="${STACK_NAME:-sqs2scouts-lambda}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"
DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/sqs2scouts}"

FUNCTION_NAME="${FUNCTION_NAME:-sqs2scouts}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
ROLE_NAME="${ROLE_NAME:-sqs2scouts-lambda-role}"
RUNTIME="${RUNTIME:-nodejs22.x}"
HANDLER="${HANDLER:-sqs2scouts.lambdaHandler}"
QUEUE_ARN="${QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsProcessing}"
QUEUE_URL="${QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing}"
SCOUTS_DECISION_QUEUE_ARN="${SCOUTS_DECISION_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsDecision}"
SCOUTS_DECISION_QUEUE_URL="${SCOUTS_DECISION_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsDecision}"
DLQ_ARN="${DLQ_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsProcessingDLQ}"
DLQ_URL="${DLQ_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ}"
BATCH_SIZE="${BATCH_SIZE:-1}"
TIMEOUT="${TIMEOUT:-30}"
MEMORY_SIZE="${MEMORY_SIZE:-256}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
GEMINI_API_VERSION="${GEMINI_API_VERSION:-}"
GEMINI_IMAGE_API_VERSION="${GEMINI_IMAGE_API_VERSION:-}"
GEMINI_IMAGE_MODEL="${GEMINI_IMAGE_MODEL:-}"
GEMINI_TEXT_MODEL="${GEMINI_TEXT_MODEL:-}"
REQUIRE_GEMINI_API_KEY="${REQUIRE_GEMINI_API_KEY:-false}"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-https://slack.com/api/chat.postMessage}"
TARGET_BUCKET="${TARGET_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
SCOUTS_CONFIG_KEY="${SCOUTS_CONFIG_KEY:-scouts.conf}"
APPROVAL_METADATA_PREFIX="${APPROVAL_METADATA_PREFIX:-approvals}"
SCOUTS2SQS_FUNCTION_URL="${SCOUTS2SQS_FUNCTION_URL:-}"
S3_WEBSITE_BASE_URL="${S3_WEBSITE_BASE_URL:-https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com}"

TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/sqs2scouts.yaml"
CONFIG_SOURCE_FILE="${CONFIG_SOURCE_FILE:-${SCRIPT_DIR}/scouts.conf}"
UPLOAD_SCOUTS_CONFIG="${UPLOAD_SCOUTS_CONFIG:-false}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== sqs2scouts CloudFormation Deployment ===${NC}"

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
  bws_export_if_unset "SLACK_SIGNING_SECRET" "${BWS_SLACK_SIGNING_SECRET_SECRET_ID:-}" || true
  bws_export_if_unset "SLACK_BOT_TOKEN" "${BWS_SLACK_BOT_TOKEN_SECRET_ID:-}" || true
  bws_export_if_unset "GEMINI_API_KEY" "${BWS_GEMINI_API_KEY_SECRET_ID:-}" || true
fi

if [ -z "${SLACK_SIGNING_SECRET}" ] || [ -z "${SLACK_BOT_TOKEN}" ]; then
  CURRENT_SIGNING_SECRET="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.SLACK_SIGNING_SECRET' --output text 2>/dev/null || true)"
  CURRENT_BOT_TOKEN="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.SLACK_BOT_TOKEN' --output text 2>/dev/null || true)"
  if [ -z "${SLACK_SIGNING_SECRET}" ] && [ -n "${CURRENT_SIGNING_SECRET}" ] && [ "${CURRENT_SIGNING_SECRET}" != "None" ] && [ "${CURRENT_SIGNING_SECRET}" != "null" ]; then
    SLACK_SIGNING_SECRET="${CURRENT_SIGNING_SECRET}"
  fi
  if [ -z "${SLACK_BOT_TOKEN}" ] && [ -n "${CURRENT_BOT_TOKEN}" ] && [ "${CURRENT_BOT_TOKEN}" != "None" ] && [ "${CURRENT_BOT_TOKEN}" != "null" ]; then
    SLACK_BOT_TOKEN="${CURRENT_BOT_TOKEN}"
  fi
fi

if [ -z "${GEMINI_API_KEY}" ]; then
  CURRENT_GEMINI_API_KEY="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_API_KEY' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_API_KEY}" ] && [ "${CURRENT_GEMINI_API_KEY}" != "None" ] && [ "${CURRENT_GEMINI_API_KEY}" != "null" ]; then
    GEMINI_API_KEY="${CURRENT_GEMINI_API_KEY}"
  fi
fi

if [ -z "${GEMINI_TEXT_MODEL}" ]; then
  CURRENT_GEMINI_TEXT_MODEL="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_TEXT_MODEL' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_TEXT_MODEL}" ] && [ "${CURRENT_GEMINI_TEXT_MODEL}" != "None" ] && [ "${CURRENT_GEMINI_TEXT_MODEL}" != "null" ]; then
    GEMINI_TEXT_MODEL="${CURRENT_GEMINI_TEXT_MODEL}"
  fi
fi

if [ -z "${GEMINI_API_VERSION}" ]; then
  CURRENT_GEMINI_API_VERSION="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_API_VERSION' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_API_VERSION}" ] && [ "${CURRENT_GEMINI_API_VERSION}" != "None" ] && [ "${CURRENT_GEMINI_API_VERSION}" != "null" ]; then
    GEMINI_API_VERSION="${CURRENT_GEMINI_API_VERSION}"
  fi
fi

if [ -z "${GEMINI_IMAGE_MODEL}" ]; then
  CURRENT_GEMINI_IMAGE_MODEL="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_IMAGE_MODEL' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_IMAGE_MODEL}" ] && [ "${CURRENT_GEMINI_IMAGE_MODEL}" != "None" ] && [ "${CURRENT_GEMINI_IMAGE_MODEL}" != "null" ]; then
    GEMINI_IMAGE_MODEL="${CURRENT_GEMINI_IMAGE_MODEL}"
  fi
fi

if [ -z "${GEMINI_IMAGE_API_VERSION}" ]; then
  CURRENT_GEMINI_IMAGE_API_VERSION="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_IMAGE_API_VERSION' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_IMAGE_API_VERSION}" ] && [ "${CURRENT_GEMINI_IMAGE_API_VERSION}" != "None" ] && [ "${CURRENT_GEMINI_IMAGE_API_VERSION}" != "null" ]; then
    GEMINI_IMAGE_API_VERSION="${CURRENT_GEMINI_IMAGE_API_VERSION}"
  fi
fi

if [ "${REQUIRE_GEMINI_API_KEY}" = "true" ] && [ -z "${GEMINI_API_KEY}" ]; then
  echo -e "${RED}GEMINI_API_KEY is required but missing. Set it via environment/secrets before deploying.${NC}"
  exit 1
fi

if [ -z "${SCOUTS2SQS_FUNCTION_URL}" ]; then
  DISCOVERED_SCOUTS2SQS_URL="$(aws lambda get-function-url-config --function-name scouts2sqs --region "${REGION}" --query 'FunctionUrl' --output text 2>/dev/null || true)"
  if [ -n "${DISCOVERED_SCOUTS2SQS_URL}" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "None" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "null" ]; then
    SCOUTS2SQS_FUNCTION_URL="${DISCOVERED_SCOUTS2SQS_URL}"
  fi
fi

echo -e "\n${YELLOW}Step 1: Build shared Lambda layer...${NC}"
(
  cd "${SHARED_LAYER_DIR}/nodejs"
  npm install --production --cache /tmp/.npm
)
(
  cd "${SHARED_LAYER_DIR}"
  rm -f lambda-layer.zip
  zip -qr lambda-layer.zip nodejs
)

echo -e "\n${YELLOW}Step 2: Package Lambda function...${NC}"
(
  cd function
  rm -f sqs2scouts-lambda.zip
  zip -jq sqs2scouts-lambda.zip sqs2scouts.mjs ../scouts.conf
)

echo -e "\n${YELLOW}Step 3: Upload artifacts to S3...${NC}"
FUNCTION_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/sqs2scouts-lambda.zip"
LAYER_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/scouts-shared-layer.zip"

aws s3 cp function/sqs2scouts-lambda.zip "s3://${CODE_BUCKET}/${FUNCTION_CODE_KEY}" --region "${REGION}"
aws s3 cp "${SHARED_LAYER_ZIP}" "s3://${CODE_BUCKET}/${LAYER_CODE_KEY}" --region "${REGION}"

if [ "${UPLOAD_SCOUTS_CONFIG}" = "true" ] && [ -f "${CONFIG_SOURCE_FILE}" ]; then
  echo -e "\n${YELLOW}Step 3b: Upload Scouts runtime config...${NC}"
  aws s3 cp "${CONFIG_SOURCE_FILE}" "s3://${TARGET_BUCKET}/${SCOUTS_CONFIG_KEY}" --region "${REGION}" --content-type "application/json"
else
  echo -e "\n${YELLOW}Step 3b: Skipping Scouts runtime config upload (UPLOAD_SCOUTS_CONFIG=${UPLOAD_SCOUTS_CONFIG})${NC}"
fi

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
    ScoutsDecisionQueueArn="${SCOUTS_DECISION_QUEUE_ARN}"
    ScoutsDecisionQueueUrl="${SCOUTS_DECISION_QUEUE_URL}"
    DlqArn="${DLQ_ARN}"
    DlqUrl="${DLQ_URL}"
    BatchSize="${BATCH_SIZE}"
    Timeout="${TIMEOUT}"
    MemorySize="${MEMORY_SIZE}"
    SlackSigningSecret="${SLACK_SIGNING_SECRET}"
    SlackBotToken="${SLACK_BOT_TOKEN}"
    GeminiApiKey="${GEMINI_API_KEY}"
    GeminiApiVersion="${GEMINI_API_VERSION}"
    GeminiImageApiVersion="${GEMINI_IMAGE_API_VERSION}"
    GeminiImageModel="${GEMINI_IMAGE_MODEL}"
    GeminiTextModel="${GEMINI_TEXT_MODEL}"
    SlackWebhookUrl="${SLACK_WEBHOOK_URL}"
    Scouts2SqsFunctionUrl="${SCOUTS2SQS_FUNCTION_URL}"
    ProcessingQueueUrl="${QUEUE_URL}"
    TargetBucket="${TARGET_BUCKET}"
    ScoutsConfigKey="${SCOUTS_CONFIG_KEY}"
    ApprovalMetadataPrefix="${APPROVAL_METADATA_PREFIX}"
    S3WebsiteBaseUrl="${S3_WEBSITE_BASE_URL}"
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
