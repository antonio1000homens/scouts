#!/bin/bash

# Scouts Lambda deployment via CloudFormation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BWS_HELPER="${ROOT_DIR}/tools/bws-env.sh"
SHARED_LAYER_HELPER="${ROOT_DIR}/tools/shared-layer-artifact.sh"
CFN_HELPER="${ROOT_DIR}/tools/cloudformation-deploy.sh"
SHARED_LAYER_DIR="${ROOT_DIR}/shared-layer"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -f "${BWS_HELPER}" ]; then
  # shellcheck disable=SC1090
  source "${BWS_HELPER}"
fi
# shellcheck disable=SC1090
source "${SHARED_LAYER_HELPER}"
# shellcheck disable=SC1090
source "${CFN_HELPER}"

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-lambda}"
CODE_BUCKET="${CODE_BUCKET:-aws2022-lambda-code-eu-west-2-553490163883}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%d%H%M%S)}"
S3_PREFIX="${S3_PREFIX:-lambdas/scouts}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-${HOME}/.npm}"

FUNCTION_NAME="${FUNCTION_NAME:-scouts}"
LAYER_NAME="${LAYER_NAME:-scouts-shared}"
ROLE_NAME="${ROLE_NAME:-scouts-lambda-role}"
RUNTIME="${RUNTIME:-nodejs24.x}"
HANDLER="${HANDLER:-scouts-entry.handler}"
DATA_BUCKET_NAME="${DATA_BUCKET_NAME:-scouts-2ndtolworth-prod-553490163883}"
CREATE_DATA_BUCKET="${CREATE_DATA_BUCKET:-true}"
FUNCTION_URL_AUTH_TYPE="${FUNCTION_URL_AUTH_TYPE:-NONE}"
TIMEOUT="${TIMEOUT:-30}"
MEMORY_SIZE="${MEMORY_SIZE:-256}"
REQUIRED_API_KEY="${REQUIRED_API_KEY:-${SCOUTS_REQUIRED_API_KEY:-}}"
REQUIRED_API_KEY_PARAMETER="${REQUIRED_API_KEY_PARAMETER:-/scouts/shared/required-api-key}"
CUBS_EVENTS_CALENDAR_URL="${CUBS_EVENTS_CALENDAR_URL:-}"
CUBS_PROGRAMME_CALENDAR_URL="${CUBS_PROGRAMME_CALENDAR_URL:-${CUBS_PROGRAME_CALENDAR_URL:-}}"
SCOUTS_EVENTS_CALENDAR_URL="${SCOUTS_EVENTS_CALENDAR_URL:-}"
SCOUTS_PROGRAMME_CALENDAR_URL="${SCOUTS_PROGRAMME_CALENDAR_URL:-}"
BEAVERS_EVENTS_CALENDAR_URL="${BEAVERS_EVENTS_CALENDAR_URL:-}"
BEAVERS_PROGRAMME_CALENDAR_URL="${BEAVERS_PROGRAMME_CALENDAR_URL:-}"
SCOUTS_REQUESTS_QUEUE_ARN="${SCOUTS_REQUESTS_QUEUE_ARN:-arn:aws:sqs:eu-west-2:553490163883:scoutsRequests}"
SCOUTS_REQUESTS_QUEUE_URL="${SCOUTS_REQUESTS_QUEUE_URL:-https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests}"
SCOUTS2SQS_FUNCTION_URL="${SCOUTS2SQS_FUNCTION_URL:-}"
FULL_ENRICH_STATE_MACHINE_ARN="${FULL_ENRICH_STATE_MACHINE_ARN:-}"
GEMINI_ENRICH_STATE_TABLE_NAME="${GEMINI_ENRICH_STATE_TABLE_NAME:-scouts-enrichment-state}"
SCOUTS_REQUEST_ACTIVITY_TABLE_NAME="${SCOUTS_REQUEST_ACTIVITY_TABLE_NAME:-scouts-request-activity}"

TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/scouts.yaml"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== Scouts CloudFormation Deployment ===${NC}"

cleanup_failed_stack() {
  local stack_status
  if ! aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" >/dev/null 2>&1; then return 0; fi
  stack_status="$(aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" --query 'Stacks[0].StackStatus' --output text)"
  if [ "${stack_status}" = "ROLLBACK_COMPLETE" ]; then
    echo -e "${YELLOW}Stack ${STACK_NAME} is in ROLLBACK_COMPLETE; deleting before redeploy.${NC}"
    aws cloudformation delete-stack --region "${REGION}" --stack-name "${STACK_NAME}"
    aws cloudformation wait stack-delete-complete --region "${REGION}" --stack-name "${STACK_NAME}"
  fi
}

for cmd in aws npm zip; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then echo -e "${RED}Missing required command: ${cmd}${NC}"; exit 1; fi
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
  echo -e "${RED}Unable to resolve AWS caller identity. Ensure credentials are configured for local/CI.${NC}"; exit 1
fi
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  echo -e "${RED}Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}.${NC}"; exit 1
fi
echo "Using AWS identity: ${CALLER_ARN}"

cd "${SCRIPT_DIR}"

if declare -F bws_export_if_unset >/dev/null 2>&1; then
  bws_export_if_unset "REQUIRED_API_KEY" "${BWS_REQUIRED_API_KEY_SECRET_ID:-${BWS_SCOUTS_REQUIRED_API_KEY_SECRET_ID:-}}" || true
fi

if [ -z "${REQUIRED_API_KEY}" ]; then require_existing_secure_parameter "${REQUIRED_API_KEY_PARAMETER}"; fi

reuse_lambda_env_if_unset() {
  local env_key="$1"
  local current_value=""
  current_value="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --query "Environment.Variables.${env_key}" --output text 2>/dev/null || true)"
  if [ -n "${current_value}" ] && [ "${current_value}" != "None" ] && [ "${current_value}" != "null" ]; then printf '%s' "${current_value}"; fi
}

if [ -z "${CUBS_EVENTS_CALENDAR_URL}" ]; then CUBS_EVENTS_CALENDAR_URL="$(reuse_lambda_env_if_unset "CUBS_EVENTS_CALENDAR_URL")"; fi
if [ -z "${CUBS_PROGRAMME_CALENDAR_URL}" ]; then CUBS_PROGRAMME_CALENDAR_URL="$(reuse_lambda_env_if_unset "CUBS_PROGRAMME_CALENDAR_URL")"; fi
if [ -z "${SCOUTS_EVENTS_CALENDAR_URL}" ]; then SCOUTS_EVENTS_CALENDAR_URL="$(reuse_lambda_env_if_unset "SCOUTS_EVENTS_CALENDAR_URL")"; fi
if [ -z "${SCOUTS_PROGRAMME_CALENDAR_URL}" ]; then SCOUTS_PROGRAMME_CALENDAR_URL="$(reuse_lambda_env_if_unset "SCOUTS_PROGRAMME_CALENDAR_URL")"; fi
if [ -z "${BEAVERS_EVENTS_CALENDAR_URL}" ]; then BEAVERS_EVENTS_CALENDAR_URL="$(reuse_lambda_env_if_unset "BEAVERS_EVENTS_CALENDAR_URL")"; fi
if [ -z "${BEAVERS_PROGRAMME_CALENDAR_URL}" ]; then BEAVERS_PROGRAMME_CALENDAR_URL="$(reuse_lambda_env_if_unset "BEAVERS_PROGRAMME_CALENDAR_URL")"; fi

if [ -z "${SCOUTS2SQS_FUNCTION_URL}" ]; then
  DISCOVERED_SCOUTS2SQS_URL="$(aws lambda get-function-url-config --function-name scouts2sqs --region "${REGION}" --query 'FunctionUrl' --output text 2>/dev/null || true)"
  if [ -n "${DISCOVERED_SCOUTS2SQS_URL}" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "None" ] && [ "${DISCOVERED_SCOUTS2SQS_URL}" != "null" ]; then SCOUTS2SQS_FUNCTION_URL="${DISCOVERED_SCOUTS2SQS_URL}"; fi
fi

if [ -z "${FULL_ENRICH_STATE_MACHINE_ARN}" ]; then
  for candidate_stack in scouts-full-enrich-managed-poc scouts-full-enrich; do
    DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN="$(aws cloudformation describe-stacks --region "${REGION}" --stack-name "${candidate_stack}" --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text 2>/dev/null || true)"
    if [ -n "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" ] && [ "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" != "None" ] && [ "${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}" != "null" ]; then
      FULL_ENRICH_STATE_MACHINE_ARN="${DISCOVERED_FULL_ENRICH_STATE_MACHINE_ARN}"
      echo "Discovered full-enrich state machine from stack ${candidate_stack}"
      break
    fi
  done
fi

if [ -z "${FULL_ENRICH_STATE_MACHINE_ARN}" ]; then
  echo -e "${RED}full-enrich StateMachineArn could not be resolved from scouts-full-enrich-managed-poc or scouts-full-enrich; refusing to deploy a partially wired Scouts Lambda.${NC}"
  exit 1
fi

echo -e "\n${YELLOW}Step 1: Resolve shared Lambda layer artifact...${NC}"
prepare_shared_layer_artifact "${SHARED_LAYER_DIR}" "${CODE_BUCKET}" "${REGION}" "${NPM_CACHE_DIR}"

echo -e "\n${YELLOW}Step 2: Package Lambda function...${NC}"
rm -f function/scouts-lambda.zip
(
  cd function
  zip -q scouts-lambda.zip \
    scouts-service.mjs \
    scouts-entry.mjs \
    agenda-hex-repair.mjs \
    runtime-activity.mjs \
    runtime-dlq.mjs \
    runtime-schedule.mjs
)

echo -e "\n${YELLOW}Step 3: Upload function artifact to S3...${NC}"
FUNCTION_CODE_KEY="${S3_PREFIX}/${DEPLOY_ID}/scouts-lambda.zip"
aws s3 cp function/scouts-lambda.zip "s3://${CODE_BUCKET}/${FUNCTION_CODE_KEY}" --region "${REGION}"

echo -e "\n${YELLOW}Step 4: Deploy CloudFormation stack...${NC}"
cleanup_failed_stack
CFN_DEPLOY_ARGS=(--region "${REGION}" --stack-name "${STACK_NAME}" --template-file "${TEMPLATE_FILE}" --capabilities CAPABILITY_NAMED_IAM)
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
    DataBucketName="${DATA_BUCKET_NAME}"
    CreateDataBucket="${CREATE_DATA_BUCKET}"
    FunctionUrlAuthType="${FUNCTION_URL_AUTH_TYPE}"
    Timeout="${TIMEOUT}"
    MemorySize="${MEMORY_SIZE}"
    RequiredApiKeyParameter="${REQUIRED_API_KEY_PARAMETER}"
    CubsEventsCalendarUrl="${CUBS_EVENTS_CALENDAR_URL}"
    CubsProgrammeCalendarUrl="${CUBS_PROGRAMME_CALENDAR_URL}"
    ScoutsEventsCalendarUrl="${SCOUTS_EVENTS_CALENDAR_URL}"
    ScoutsProgrammeCalendarUrl="${SCOUTS_PROGRAMME_CALENDAR_URL}"
    BeaversEventsCalendarUrl="${BEAVERS_EVENTS_CALENDAR_URL}"
    BeaversProgrammeCalendarUrl="${BEAVERS_PROGRAMME_CALENDAR_URL}"
    ScoutsRequestsQueueArn="${SCOUTS_REQUESTS_QUEUE_ARN}"
    ScoutsRequestsQueueUrl="${SCOUTS_REQUESTS_QUEUE_URL}"
    Scouts2SqsFunctionUrl="${SCOUTS2SQS_FUNCTION_URL}"
    FullEnrichStateMachineArn="${FULL_ENRICH_STATE_MACHINE_ARN}"
    GeminiEnrichmentStateTableName="${GEMINI_ENRICH_STATE_TABLE_NAME}"
    ScoutsRequestActivityTableName="${SCOUTS_REQUEST_ACTIVITY_TABLE_NAME}"
)

deploy_cloudformation_with_diagnostics "${STACK_NAME}" "${REGION}" "${CFN_DEPLOY_ARGS[@]}"
if [ -n "${REQUIRED_API_KEY}" ]; then put_standard_secure_parameter "${REQUIRED_API_KEY_PARAMETER}" "${REQUIRED_API_KEY}"; fi

echo -e "\n${YELLOW}Step 5: Read stack outputs...${NC}"
aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" --query 'Stacks[0].Outputs' --output table

echo -e "\n${GREEN}Deployment complete.${NC}"
