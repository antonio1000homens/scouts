#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/cloudformation/templates/scouts-queues.yaml"

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-queues}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

REQUESTS_QUEUE_NAME="${REQUESTS_QUEUE_NAME:-scoutsRequests}"
REQUESTS_DLQ_NAME="${REQUESTS_DLQ_NAME:-scoutsRequestsDLQ}"
PROCESSING_QUEUE_NAME="${PROCESSING_QUEUE_NAME:-scoutsProcessing}"
DECISION_QUEUE_NAME="${DECISION_QUEUE_NAME:-scoutsDecision}"
PROCESSING_DLQ_NAME="${PROCESSING_DLQ_NAME:-scoutsProcessingDLQ}"
VISIBILITY_TIMEOUT="${VISIBILITY_TIMEOUT:-600}"
MESSAGE_RETENTION_SECONDS="${MESSAGE_RETENTION_SECONDS:-1209600}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)"
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  echo "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${EXPECTED_AWS_ACCOUNT}." >&2
  exit 1
fi

CFN_ARGS=(
  --region "${REGION}"
  --stack-name "${STACK_NAME}"
  --template-file "${TEMPLATE_FILE}"
)

if [ -n "${CLOUDFORMATION_ROLE_ARN}" ]; then
  CFN_ARGS+=(--role-arn "${CLOUDFORMATION_ROLE_ARN}")
fi

CFN_ARGS+=(
  --parameter-overrides
    RequestsQueueName="${REQUESTS_QUEUE_NAME}"
    RequestsDlqName="${REQUESTS_DLQ_NAME}"
    ProcessingQueueName="${PROCESSING_QUEUE_NAME}"
    DecisionQueueName="${DECISION_QUEUE_NAME}"
    ProcessingDlqName="${PROCESSING_DLQ_NAME}"
    VisibilityTimeout="${VISIBILITY_TIMEOUT}"
    MessageRetentionSeconds="${MESSAGE_RETENTION_SECONDS}"
    MaxReceiveCount="${MAX_RECEIVE_COUNT}"
)

aws cloudformation deploy "${CFN_ARGS[@]}"

aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table
