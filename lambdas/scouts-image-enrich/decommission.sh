#!/bin/bash

# One-time guarded decommission for the retired scouts-image-enrich stack.
# Refuses to delete the stack while any legacy execution is still RUNNING.

set -euo pipefail

REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-scouts-image-enrich}"
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

# Resolve the exact state machine owned by the stack we are about to delete.
# Do not fall back to list-state-machines: name lookup is paginated and could
# accidentally fail open if permissions or pagination hide the resource.
if ! STATE_MACHINE_ARN="$(aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue | [0]" \
  --output text)"; then
  echo "Unable to resolve StateMachineArn from ${STACK_NAME}; refusing to decommission." >&2
  exit 1
fi

if [ -z "${STATE_MACHINE_ARN}" ] || [ "${STATE_MACHINE_ARN}" = "None" ] || [ "${STATE_MACHINE_ARN}" = "null" ]; then
  echo "Stack ${STACK_NAME} does not expose StateMachineArn; refusing to decommission." >&2
  exit 1
fi

# We only need to know whether at least one RUNNING execution exists. Asking
# for one result avoids any pagination ambiguity while still failing closed on
# API/permission errors because this command is not wrapped in `|| true`.
if ! RUNNING_COUNT="$(aws stepfunctions list-executions \
  --region "${REGION}" \
  --state-machine-arn "${STATE_MACHINE_ARN}" \
  --status-filter RUNNING \
  --max-results 1 \
  --query 'length(executions)' \
  --output text)"; then
  echo "Unable to verify running executions for ${STATE_MACHINE_ARN}; refusing to decommission." >&2
  exit 1
fi

if [ "${RUNNING_COUNT}" != "0" ]; then
  echo "Refusing to decommission ${STACK_NAME}: at least one legacy execution is still RUNNING." >&2
  exit 2
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
