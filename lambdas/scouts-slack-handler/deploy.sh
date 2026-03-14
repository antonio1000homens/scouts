#!/usr/bin/env bash

# Slack handler Lambda deployment via CloudFormation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/slack-handler.yaml"
SHARED_LAYER_DIR="${ROOT_DIR}/shared-layer"
SHARED_LAYER_ZIP="${SHARED_LAYER_DIR}/lambda-layer.zip"

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-slack-handler-lambda}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/scouts-slack-handler}"

FUNCTION_NAME="${FUNCTION_NAME:-scouts-slack-handler}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
ROLE_NAME="${ROLE_NAME:-scouts-slack-handler-lambda-role}"
ROLE_ARN="${ROLE_ARN:-}"
RUNTIME="${RUNTIME:-nodejs24.x}"
HANDLER="${HANDLER:-slack-handler.lambdaHandler}"
FUNCTION_URL_AUTH_TYPE="${FUNCTION_URL_AUTH_TYPE:-NONE}"
TIMEOUT="${TIMEOUT:-30}"
MEMORY_SIZE="${MEMORY_SIZE:-256}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
REQUIRED_API_KEY="${REQUIRED_API_KEY:-}"
SCOUTS_REQUEST_QUEUE_URL="${SCOUTS_REQUEST_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
SCOUTS_REQUEST_QUEUE_ARN="${SCOUTS_REQUEST_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
NFC_QUEUE_URL="${NFC_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
NFC_QUEUE_ARN="${NFC_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
TARGET_BUCKET="${TARGET_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
SCOUTS_CONFIG_KEY="${SCOUTS_CONFIG_KEY:-scouts.conf}"

log() {
  echo "==> $*"
}

error() {
  echo "ERROR: $*" >&2
  exit 1
}

for cmd in aws npm zip; do
  command -v "${cmd}" >/dev/null 2>&1 || error "Missing required command: ${cmd}"
done

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)"
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  error "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}."
fi

cd "${SCRIPT_DIR}"

if [ -z "${SLACK_SIGNING_SECRET}" ] || [ -z "${SLACK_BOT_TOKEN}" ]; then
  log "Attempting to reuse Slack env vars from existing slack-handler configuration"
  CURRENT_SIGNING_SECRET="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.SLACK_SIGNING_SECRET' --output text 2>/dev/null || true)"
  CURRENT_BOT_TOKEN="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.SLACK_BOT_TOKEN' --output text 2>/dev/null || true)"
  if [ -z "${SLACK_SIGNING_SECRET}" ] && [ -n "${CURRENT_SIGNING_SECRET}" ] && [ "${CURRENT_SIGNING_SECRET}" != "None" ] && [ "${CURRENT_SIGNING_SECRET}" != "null" ]; then
    SLACK_SIGNING_SECRET="${CURRENT_SIGNING_SECRET}"
  fi
  if [ -z "${SLACK_BOT_TOKEN}" ] && [ -n "${CURRENT_BOT_TOKEN}" ] && [ "${CURRENT_BOT_TOKEN}" != "None" ] && [ "${CURRENT_BOT_TOKEN}" != "null" ]; then
    SLACK_BOT_TOKEN="${CURRENT_BOT_TOKEN}"
  fi
fi

if [ -z "${REQUIRED_API_KEY}" ]; then
  log "Attempting to reuse REQUIRED_API_KEY from existing slack-handler configuration"
  CURRENT_REQUIRED_API_KEY="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query 'Environment.Variables.REQUIRED_API_KEY' --output text 2>/dev/null || true)"
  if [ -n "${CURRENT_REQUIRED_API_KEY}" ] && [ "${CURRENT_REQUIRED_API_KEY}" != "None" ] && [ "${CURRENT_REQUIRED_API_KEY}" != "null" ]; then
    REQUIRED_API_KEY="${CURRENT_REQUIRED_API_KEY}"
  fi
fi

log "Building shared lambda layer..."
(
  cd "${SHARED_LAYER_DIR}/nodejs"
  npm install --production
)
(
  cd "${SHARED_LAYER_DIR}"
  rm -f lambda-layer.zip
  zip -qr lambda-layer.zip nodejs
)

log "Building lambda function..."
(
  cd function
  rm -f slack-handler-lambda.zip
  zip -q slack-handler-lambda.zip slack-handler.mjs
)

log "Uploading artifacts to S3..."
FUNCTION_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/slack-handler-lambda.zip"
LAYER_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/scouts-shared-layer.zip"

aws s3 cp function/slack-handler-lambda.zip "s3://${CODE_BUCKET}/${FUNCTION_CODE_KEY}" --region "${REGION}"
aws s3 cp "${SHARED_LAYER_ZIP}" "s3://${CODE_BUCKET}/${LAYER_CODE_KEY}" --region "${REGION}"

log "Deploying CloudFormation stack..."
CFN_ARGS=(
  --region "${REGION}"
  --stack-name "${STACK_NAME}"
  --template-file "${TEMPLATE_FILE}"
  --capabilities CAPABILITY_NAMED_IAM
)

if [ -n "${CLOUDFORMATION_ROLE_ARN}" ]; then
  CFN_ARGS+=(--role-arn "${CLOUDFORMATION_ROLE_ARN}")
fi

CFN_ARGS+=(
  --parameter-overrides
    CodeBucket="${CODE_BUCKET}"
    FunctionCodeKey="${FUNCTION_CODE_KEY}"
    LayerCodeKey="${LAYER_CODE_KEY}"
    FunctionName="${FUNCTION_NAME}"
    LayerName="${LAYER_NAME}"
    RoleName="${ROLE_NAME}"
    RoleArn="${ROLE_ARN}"
    Runtime="${RUNTIME}"
    Handler="${HANDLER}"
    FunctionUrlAuthType="${FUNCTION_URL_AUTH_TYPE}"
    Timeout="${TIMEOUT}"
    MemorySize="${MEMORY_SIZE}"
    SlackSigningSecret="${SLACK_SIGNING_SECRET}"
    SlackBotToken="${SLACK_BOT_TOKEN}"
    RequiredApiKey="${REQUIRED_API_KEY}"
    ScoutsRequestQueueUrl="${SCOUTS_REQUEST_QUEUE_URL}"
    ScoutsRequestQueueArn="${SCOUTS_REQUEST_QUEUE_ARN}"
    NfcQueueUrl="${NFC_QUEUE_URL}"
    NfcQueueArn="${NFC_QUEUE_ARN}"
    TargetBucket="${TARGET_BUCKET}"
    ScoutsConfigKey="${SCOUTS_CONFIG_KEY}"
)

aws cloudformation deploy "${CFN_ARGS[@]}"

log "Stack outputs:"
aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table

log "Deployment completed successfully"
