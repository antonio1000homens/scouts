#!/usr/bin/env bash

# Slack handler Lambda deployment via CloudFormation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/slack-handler.yaml"
SHARED_LAYER_DIR="${ROOT_DIR}/shared-layer"
SHARED_LAYER_HELPER="${ROOT_DIR}/tools/shared-layer-artifact.sh"

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-slack-handler-lambda}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/scouts-slack-handler}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-${HOME}/.npm}"

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

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
SLACK_SIGNING_SECRET_PARAMETER="${SLACK_SIGNING_SECRET_PARAMETER:-/scouts/shared/slack-signing-secret}"
SLACK_BOT_TOKEN_PARAMETER="${SLACK_BOT_TOKEN_PARAMETER:-/scouts/shared/slack-bot-token}"
REQUIRED_API_KEY_PARAMETER="${REQUIRED_API_KEY_PARAMETER:-/scouts/shared/required-api-key}"
SCOUTS_REQUEST_QUEUE_URL="${SCOUTS_REQUEST_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
SCOUTS_REQUEST_QUEUE_ARN="${SCOUTS_REQUEST_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
NFC_QUEUE_URL="${NFC_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
NFC_QUEUE_ARN="${NFC_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
TARGET_BUCKET="${TARGET_BUCKET:-scouts-2ndtolworth-prod-553490163883}"
SCOUTS_CONFIG_KEY="${SCOUTS_CONFIG_KEY:-scouts.conf}"

# shellcheck disable=SC1090
source "${SHARED_LAYER_HELPER}"

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

put_standard_secure_parameter() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter \
    --region "${REGION}" \
    --name "${name}" \
    --type SecureString \
    --tier Standard \
    --overwrite \
    --value "${value}" >/dev/null
}

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)"
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  error "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}."
fi

cd "${SCRIPT_DIR}"

if [ -z "${SLACK_SIGNING_SECRET}" ] || [ -z "${SLACK_BOT_TOKEN}" ] || [ -z "${REQUIRED_API_KEY}" ]; then
  error "SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, and REQUIRED_API_KEY must be set before deploying."
fi

log "Resolving shared Lambda layer version..."
prepare_shared_layer_artifact \
  "${SHARED_LAYER_DIR}" \
  "${CODE_BUCKET}" \
  "${REGION}" \
  "${NPM_CACHE_DIR}"

log "Building lambda function..."
(
  cd function
  rm -f slack-handler-lambda.zip
  zip -q slack-handler-lambda.zip slack-handler.mjs
)

log "Uploading function artifact to S3..."
FUNCTION_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/slack-handler-lambda.zip"
aws s3 cp function/slack-handler-lambda.zip "s3://${CODE_BUCKET}/${FUNCTION_CODE_KEY}" --region "${REGION}"

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
    SlackSigningSecretParameter="${SLACK_SIGNING_SECRET_PARAMETER}"
    SlackBotTokenParameter="${SLACK_BOT_TOKEN_PARAMETER}"
    RequiredApiKeyParameter="${REQUIRED_API_KEY_PARAMETER}"
    ScoutsRequestQueueUrl="${SCOUTS_REQUEST_QUEUE_URL}"
    ScoutsRequestQueueArn="${SCOUTS_REQUEST_QUEUE_ARN}"
    NfcQueueUrl="${NFC_QUEUE_URL}"
    NfcQueueArn="${NFC_QUEUE_ARN}"
    TargetBucket="${TARGET_BUCKET}"
    ScoutsConfigKey="${SCOUTS_CONFIG_KEY}"
)

aws cloudformation deploy "${CFN_ARGS[@]}"

put_standard_secure_parameter "${SLACK_SIGNING_SECRET_PARAMETER}" "${SLACK_SIGNING_SECRET}"
put_standard_secure_parameter "${SLACK_BOT_TOKEN_PARAMETER}" "${SLACK_BOT_TOKEN}"
put_standard_secure_parameter "${REQUIRED_API_KEY_PARAMETER}" "${REQUIRED_API_KEY}"

log "Stack outputs:"
aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table

log "Deployment completed successfully"
