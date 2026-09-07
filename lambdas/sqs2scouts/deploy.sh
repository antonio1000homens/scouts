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

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/sqs2scouts}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-${HOME}/.npm}"

FUNCTION_NAME="${FUNCTION_NAME:-sqs2scouts}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
ROLE_NAME="${ROLE_NAME:-sqs2scouts-lambda-role}"
RUNTIME="${RUNTIME:-nodejs24.x}"
HANDLER="${HANDLER:-image-provider-adapter.lambdaHandler}"
QUEUE_ARN="${QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsProcessing}"
QUEUE_URL="${QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing}"
SCOUTS_DECISION_QUEUE_ARN="${SCOUTS_DECISION_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsDecision}"
SCOUTS_DECISION_QUEUE_URL="${SCOUTS_DECISION_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsDecision}"
DLQ_ARN="${DLQ_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsProcessingDLQ}"
DLQ_URL="${DLQ_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ}"
BATCH_SIZE="${BATCH_SIZE:-1}"
TIMEOUT="${TIMEOUT:-90}"
MEMORY_SIZE="${MEMORY_SIZE:-256}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
CLOUDFLARE_AI_API_TOKEN="${CLOUDFLARE_AI_API_TOKEN:-}"
SLACK_SIGNING_SECRET_PARAMETER="${SLACK_SIGNING_SECRET_PARAMETER:-/scouts/shared/slack-signing-secret}"
SLACK_BOT_TOKEN_PARAMETER="${SLACK_BOT_TOKEN_PARAMETER:-/scouts/shared/slack-bot-token}"
GEMINI_API_KEY_PARAMETER="${GEMINI_API_KEY_PARAMETER:-/scouts/sqs2scouts/gemini-api-key}"
CLOUDFLARE_AI_API_TOKEN_PARAMETER="${CLOUDFLARE_AI_API_TOKEN_PARAMETER:-/scouts/sqs2scouts/cloudflare-ai-api-token}"
GEMINI_API_VERSION="${GEMINI_API_VERSION:-}"
GEMINI_IMAGE_API_VERSION="${GEMINI_IMAGE_API_VERSION:-}"
GEMINI_IMAGE_MODEL="${GEMINI_IMAGE_MODEL:-}"
GEMINI_TEXT_MODEL="${GEMINI_TEXT_MODEL:-}"
GEMINI_ENABLED="${GEMINI_ENABLED:-}"
GEMINI_IMAGES_ENABLED="${GEMINI_IMAGES_ENABLED:-}"
GEMINI_DAILY_REQUEST_LIMIT="${GEMINI_DAILY_REQUEST_LIMIT:-10}"
GEMINI_USAGE_TABLE_NAME="${GEMINI_USAGE_TABLE_NAME:-scouts-gemini-usage}"
GEMINI_ENRICHMENT_STATE_TABLE_NAME="${GEMINI_ENRICHMENT_STATE_TABLE_NAME:-scouts-enrichment-state}"
GEMINI_MAX_ATTEMPTS_PER_STAGE="${GEMINI_MAX_ATTEMPTS_PER_STAGE:-3}"
GEMINI_RETRY_DELAY_ATTEMPT_2_SECONDS="${GEMINI_RETRY_DELAY_ATTEMPT_2_SECONDS:-3600}"
GEMINI_RETRY_DELAY_ATTEMPT_3_SECONDS="${GEMINI_RETRY_DELAY_ATTEMPT_3_SECONDS:-21600}"
GEMINI_IN_PROGRESS_LEASE_SECONDS="${GEMINI_IN_PROGRESS_LEASE_SECONDS:-1800}"
GEMINI_PROMPT_VERSION="${GEMINI_PROMPT_VERSION:-1}"
IMAGE_GENERATION_DAILY_REQUEST_LIMIT="${IMAGE_GENERATION_DAILY_REQUEST_LIMIT:-10}"
IMAGE_GENERATION_PROVIDER="${IMAGE_GENERATION_PROVIDER:-disabled}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
CLOUDFLARE_AI_MODEL="${CLOUDFLARE_AI_MODEL:-@cf/black-forest-labs/flux-1-schnell}"
CLOUDFLARE_AI_STEPS="${CLOUDFLARE_AI_STEPS:-4}"
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

put_standard_secure_parameter() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter --region "${REGION}" --name "${name}" --type SecureString --tier Standard --overwrite --value "${value}" >/dev/null
}

require_existing_secure_parameter() {
  local parameter_name="$1"
  if ! aws ssm get-parameter --region "${REGION}" --name "${parameter_name}" --query 'Parameter.ARN' --output text >/dev/null; then
    echo -e "${RED}Required SSM parameter is missing: ${parameter_name}${NC}"
    exit 1
  fi
}

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
  bws_export_if_unset "CLOUDFLARE_AI_API_TOKEN" "${BWS_CLOUDFLARE_AI_API_TOKEN_SECRET_ID:-}" || true
fi

if [ -z "${SLACK_SIGNING_SECRET}" ]; then require_existing_secure_parameter "${SLACK_SIGNING_SECRET_PARAMETER}"; fi
if [ -z "${SLACK_BOT_TOKEN}" ]; then require_existing_secure_parameter "${SLACK_BOT_TOKEN_PARAMETER}"; fi
if [ -z "${GEMINI_API_KEY}" ]; then require_existing_secure_parameter "${GEMINI_API_KEY_PARAMETER}"; fi

if [ -z "${GEMINI_TEXT_MODEL}" ]; then
  CURRENT_GEMINI_TEXT_MODEL="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_TEXT_MODEL' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_TEXT_MODEL}" ] && [ "${CURRENT_GEMINI_TEXT_MODEL}" != "None" ] && [ "${CURRENT_GEMINI_TEXT_MODEL}" != "null" ]; then GEMINI_TEXT_MODEL="${CURRENT_GEMINI_TEXT_MODEL}"; fi
fi
if [ -z "${GEMINI_API_VERSION}" ]; then
  CURRENT_GEMINI_API_VERSION="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_API_VERSION' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_API_VERSION}" ] && [ "${CURRENT_GEMINI_API_VERSION}" != "None" ] && [ "${CURRENT_GEMINI_API_VERSION}" != "null" ]; then GEMINI_API_VERSION="${CURRENT_GEMINI_API_VERSION}"; fi
fi
if [ -z "${GEMINI_IMAGE_MODEL}" ]; then
  CURRENT_GEMINI_IMAGE_MODEL="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_IMAGE_MODEL' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_IMAGE_MODEL}" ] && [ "${CURRENT_GEMINI_IMAGE_MODEL}" != "None" ] && [ "${CURRENT_GEMINI_IMAGE_MODEL}" != "null" ]; then GEMINI_IMAGE_MODEL="${CURRENT_GEMINI_IMAGE_MODEL}"; fi
fi
if [ -z "${GEMINI_IMAGE_API_VERSION}" ]; then
  CURRENT_GEMINI_IMAGE_API_VERSION="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_IMAGE_API_VERSION' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_GEMINI_IMAGE_API_VERSION}" ] && [ "${CURRENT_GEMINI_IMAGE_API_VERSION}" != "None" ] && [ "${CURRENT_GEMINI_IMAGE_API_VERSION}" != "null" ]; then GEMINI_IMAGE_API_VERSION="${CURRENT_GEMINI_IMAGE_API_VERSION}"; fi
fi
if [ -z "${GEMINI_ENABLED}" ]; then
  CURRENT_GEMINI_ENABLED="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI' --output text 2>/dev/null || true)"
  if [ "${CURRENT_GEMINI_ENABLED}" = "true" ] || [ "${CURRENT_GEMINI_ENABLED}" = "false" ]; then GEMINI_ENABLED="${CURRENT_GEMINI_ENABLED}"; else GEMINI_ENABLED="false"; fi
fi
if [ -z "${GEMINI_IMAGES_ENABLED}" ]; then
  CURRENT_GEMINI_IMAGES_ENABLED="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.GEMINI_IMAGES' --output text 2>/dev/null || true)"
  if [ "${CURRENT_GEMINI_IMAGES_ENABLED}" = "true" ] || [ "${CURRENT_GEMINI_IMAGES_ENABLED}" = "false" ]; then GEMINI_IMAGES_ENABLED="${CURRENT_GEMINI_IMAGES_ENABLED}"; else GEMINI_IMAGES_ENABLED="false"; fi
fi

if [ "${REQUIRE_GEMINI_API_KEY}" = "true" ] && [ -z "${GEMINI_API_KEY}" ]; then
  echo -e "${RED}GEMINI_API_KEY is required but missing.${NC}"
  exit 1
fi

case "${IMAGE_GENERATION_PROVIDER}" in
  disabled|cloudflare|gemini) ;;
  *) echo -e "${RED}IMAGE_GENERATION_PROVIDER must be disabled, cloudflare, or gemini.${NC}"; exit 1 ;;
esac

if [ "${IMAGE_GENERATION_PROVIDER}" = "cloudflare" ]; then
  # Billing-safety invariant: selecting Cloudflare must never leave a legacy Gemini
  # image path enabled. Text Gemini remains independent via GEMINI_ENABLED.
  GEMINI_IMAGES_ENABLED='false'
  if [ -z "${CLOUDFLARE_ACCOUNT_ID}" ]; then
    echo -e "${RED}CLOUDFLARE_ACCOUNT_ID is required when IMAGE_GENERATION_PROVIDER=cloudflare.${NC}"
    exit 1
  fi
  if [ -z "${CLOUDFLARE_AI_API_TOKEN}" ]; then
    require_existing_secure_parameter "${CLOUDFLARE_AI_API_TOKEN_PARAMETER}"
  fi
fi

if [ -z "${SCOUTS2SQS_FUNCTION_URL}" ]; then
  DISCOVERED_SCOUTS2SQS_URL="$(aws lambda get-function-url-config --function-name scouts2sqs --region "${REGION}" --query 'FunctionUrl' --output text 2>/dev/null || true)"
  if [ -n "${DISCOVERED_SCOUTS2SQS_URL}" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "None" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "null" ]; then SCOUTS2SQS_FUNCTION_URL="${DISCOVERED_SCOUTS2SQS_URL}"; fi
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
  rm -f sqs2scouts-lambda.zip
  zip -jq sqs2scouts-lambda.zip sqs2scouts.mjs full-enrich-adapter.mjs full-enrich-helpers.mjs image-provider-adapter.mjs cloudflare-image-client.mjs ../scouts.conf
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
if [ -n "${CLOUDFORMATION_ROLE_ARN}" ]; then CFN_DEPLOY_ARGS+=(--role-arn "${CLOUDFORMATION_ROLE_ARN}"); fi
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
    SlackSigningSecretParameter="${SLACK_SIGNING_SECRET_PARAMETER}"
    SlackBotTokenParameter="${SLACK_BOT_TOKEN_PARAMETER}"
    GeminiApiKeyParameter="${GEMINI_API_KEY_PARAMETER}"
    GeminiApiVersion="${GEMINI_API_VERSION}"
    GeminiImageApiVersion="${GEMINI_IMAGE_API_VERSION}"
    GeminiImageModel="${GEMINI_IMAGE_MODEL}"
    GeminiTextModel="${GEMINI_TEXT_MODEL}"
    GeminiEnabled="${GEMINI_ENABLED}"
    GeminiImagesEnabled="${GEMINI_IMAGES_ENABLED}"
    GeminiDailyRequestLimit="${GEMINI_DAILY_REQUEST_LIMIT}"
    GeminiUsageTableName="${GEMINI_USAGE_TABLE_NAME}"
    GeminiEnrichmentStateTableName="${GEMINI_ENRICHMENT_STATE_TABLE_NAME}"
    GeminiMaxAttemptsPerStage="${GEMINI_MAX_ATTEMPTS_PER_STAGE}"
    GeminiRetryDelayAttempt2Seconds="${GEMINI_RETRY_DELAY_ATTEMPT_2_SECONDS}"
    GeminiRetryDelayAttempt3Seconds="${GEMINI_RETRY_DELAY_ATTEMPT_3_SECONDS}"
    GeminiInProgressLeaseSeconds="${GEMINI_IN_PROGRESS_LEASE_SECONDS}"
    GeminiPromptVersion="${GEMINI_PROMPT_VERSION}"
    ImageGenerationProvider="${IMAGE_GENERATION_PROVIDER}"
    ImageGenerationDailyRequestLimit="${IMAGE_GENERATION_DAILY_REQUEST_LIMIT}"
    CloudflareAccountId="${CLOUDFLARE_ACCOUNT_ID}"
    CloudflareAiApiTokenParameter="${CLOUDFLARE_AI_API_TOKEN_PARAMETER}"
    CloudflareAiModel="${CLOUDFLARE_AI_MODEL}"
    CloudflareAiSteps="${CLOUDFLARE_AI_STEPS}"
    SlackWebhookUrl="${SLACK_WEBHOOK_URL}"
    Scouts2SqsFunctionUrl="${SCOUTS2SQS_FUNCTION_URL}"
    ProcessingQueueUrl="${QUEUE_URL}"
    TargetBucket="${TARGET_BUCKET}"
    ScoutsConfigKey="${SCOUTS_CONFIG_KEY}"
    ApprovalMetadataPrefix="${APPROVAL_METADATA_PREFIX}"
    S3WebsiteBaseUrl="${S3_WEBSITE_BASE_URL}"
)
aws cloudformation deploy "${CFN_DEPLOY_ARGS[@]}"

if [ -n "${SLACK_SIGNING_SECRET}" ]; then put_standard_secure_parameter "${SLACK_SIGNING_SECRET_PARAMETER}" "${SLACK_SIGNING_SECRET}"; fi
if [ -n "${SLACK_BOT_TOKEN}" ]; then put_standard_secure_parameter "${SLACK_BOT_TOKEN_PARAMETER}" "${SLACK_BOT_TOKEN}"; fi
if [ -n "${GEMINI_API_KEY}" ]; then put_standard_secure_parameter "${GEMINI_API_KEY_PARAMETER}" "${GEMINI_API_KEY}"; fi
if [ -n "${CLOUDFLARE_AI_API_TOKEN}" ]; then put_standard_secure_parameter "${CLOUDFLARE_AI_API_TOKEN_PARAMETER}" "${CLOUDFLARE_AI_API_TOKEN}"; fi

echo -e "\n${YELLOW}Step 5: Read stack outputs...${NC}"
aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" --query 'Stacks[0].Outputs' --output table

echo -e "\n${GREEN}Deployment complete.${NC}"
