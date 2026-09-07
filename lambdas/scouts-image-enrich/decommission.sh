#!/bin/bash

# One-time guarded decommission for the retired scouts-image-enrich stack.
# Refuses to delete the stack while any legacy execution is still RUNNING.

set -euo pipefail

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-image-enrich}"
STATE_MACHINE_NAME="${STATE_MACHINE_NAME:-scouts-image-enrich}"
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-553490163883}"
CONFIRM_DECOMMISSION="${CONFIRM_DECOMMISSION:-false}"

if ! command -v aws >/dev/null 2>&1; then
  echo "Missing required command: aws" >&2
  exit 1
fi

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null || true)"
if [ "${CALLER_ACCOUNT}" != "${EXPECTED_AWS_ACCOUNT}" ]; then
  echo "Unexpected AWS account ${CALLER_ACCOUNT:-<unknown>}; expected ${EXPECTED_AWS_ACCOUNT}." >&2
  exit 1
fi

if ! aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK_NAME}" >/dev/null 2>&1; then
  echo "Legacy stack ${STACK_NAME} is already absent."
  exit 0
fi

STATE_MACHINE_ARN="$(aws stepfunctions list-state-machines \
  --region "${REGION}" \
  --query "stateMachines[?name=='${STATE_MACHINE_NAME}'].stateMachineArn | [0]" \
  --output text 2>/dev/null || true)"

if [ -n "${STATE_MACHINE_ARN}" ] && [ "${STATE_MACHINE_ARN}" != "None" ] && [ "${STATE_MACHINE_ARN}" != "null" ]; then
  RUNNING_COUNT="$(aws stepfunctions list-executions \
    --region "${REGION}" \
    --state-machine-arn "${STATE_MACHINE_ARN}" \
    --status-filter RUNNING \
    --max-results 100 \
    --query 'length(executions)' \
    --output text)"
  if [ "${RUNNING_COUNT}" != "0" ]; then
    echo "Refusing to decommission ${STACK_NAME}: ${RUNNING_COUNT} legacy execution(s) still RUNNING." >&2
    exit 2
  fi
fi

if [ "${CONFIRM_DECOMMISSION}" != "true" ]; then
  echo "Preflight passed: no running legacy executions detected."
  echo "Re-run with CONFIRM_DECOMMISSION=true to delete CloudFormation stack ${STACK_NAME}."
  exit 3
fi

echo "Deleting retired CloudFormation stack ${STACK_NAME}..."
aws cloudformation delete-stack --region "${REGION}" --stack-name "${STACK_NAME}"
aws cloudformation wait stack-delete-complete --region "${REGION}" --stack-name "${STACK_NAME}"
echo "Legacy image-enrich stack removed."
