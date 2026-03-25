#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/scouts-account-bootstrap.yaml"

REGION="${AWS_REGION:-eu-west-2}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-553490163883}"
STACK_NAME="${STACK_NAME:-scouts-account-bootstrap}"
ARTIFACT_BUCKET_NAME="${ARTIFACT_BUCKET_NAME:-aws2022-lambda-code-eu-west-2-553490163883}"
CLOUDFORMATION_ROLE_ARN="${CLOUDFORMATION_ROLE_ARN:-}"
BOOTSTRAP_PRINCIPAL_ARN="${BOOTSTRAP_PRINCIPAL_ARN:-}"
SCOUTS_REPO_OWNER="${SCOUTS_REPO_OWNER:-antonio1000homens}"
SCOUTS_REPO_NAME="${SCOUTS_REPO_NAME:-scouts}"
SCOUTS_BRANCH="${SCOUTS_BRANCH:-master}"

if [ -z "${BOOTSTRAP_PRINCIPAL_ARN}" ]; then
  EXISTING_BOOTSTRAP_PRINCIPAL_ARN="$(aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Parameters[?ParameterKey=='BootstrapPrincipalArn'].ParameterValue | [0]" \
    --output text 2>/dev/null || true)"

  if [ -n "${EXISTING_BOOTSTRAP_PRINCIPAL_ARN}" ] && [ "${EXISTING_BOOTSTRAP_PRINCIPAL_ARN}" != "None" ] && [ "${EXISTING_BOOTSTRAP_PRINCIPAL_ARN}" != "null" ]; then
    BOOTSTRAP_PRINCIPAL_ARN="${EXISTING_BOOTSTRAP_PRINCIPAL_ARN}"
  fi
fi

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE_NAME:-${AWS_PROFILE:-scouts}}"
fi

if [ -z "${BOOTSTRAP_PRINCIPAL_ARN}" ]; then
  echo "BOOTSTRAP_PRINCIPAL_ARN is required." >&2
  exit 1
fi

for cmd in aws; do
  command -v "${cmd}" >/dev/null 2>&1 || {
    echo "Missing required command: ${cmd}" >&2
    exit 1
  }
done

print_recent_stack_events() {
  aws cloudformation describe-stack-events \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --max-items 25 \
    --query 'StackEvents[].{Time:Timestamp,LogicalResourceId:LogicalResourceId,ResourceStatus:ResourceStatus,Reason:ResourceStatusReason}' \
    --output table 2>/dev/null || true
}

wait_for_stack_recovery() {
  local max_attempts="${1:-60}"
  local attempt=1

  while [ "${attempt}" -le "${max_attempts}" ]; do
    local status
    status="$(aws cloudformation describe-stacks \
      --region "${REGION}" \
      --stack-name "${STACK_NAME}" \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || true)"

    case "${status}" in
      UPDATE_ROLLBACK_COMPLETE|UPDATE_COMPLETE|CREATE_COMPLETE)
        return 0
        ;;
      UPDATE_ROLLBACK_FAILED)
        echo "Stack ${STACK_NAME} is still in ${status} after recovery attempt." >&2
        print_recent_stack_events >&2
        return 1
        ;;
      UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_COMPLETE_CLEANUP_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
        sleep 10
        ;;
      "")
        sleep 5
        ;;
      *)
        echo "Stack ${STACK_NAME} is in unexpected state ${status} during recovery." >&2
        print_recent_stack_events >&2
        return 1
        ;;
    esac

    attempt=$((attempt + 1))
  done

  echo "Timed out waiting for ${STACK_NAME} rollback recovery." >&2
  print_recent_stack_events >&2
  return 1
}

recover_stack_if_needed() {
  local status
  status="$(aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || true)"

  if [ "${status}" = "UPDATE_ROLLBACK_FAILED" ]; then
    echo "Stack ${STACK_NAME} is in UPDATE_ROLLBACK_FAILED. Attempting continue-update-rollback." >&2
    aws cloudformation continue-update-rollback \
      --region "${REGION}" \
      --stack-name "${STACK_NAME}"
    wait_for_stack_recovery
  fi
}

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)"
if [ "${CALLER_ACCOUNT}" != "${ACCOUNT_ID}" ]; then
  echo "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${ACCOUNT_ID}." >&2
  exit 1
fi

recover_stack_if_needed

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
    BootstrapPrincipalArn="${BOOTSTRAP_PRINCIPAL_ARN}"
    ArtifactBucketName="${ARTIFACT_BUCKET_NAME}"
    ScoutsRepoOwner="${SCOUTS_REPO_OWNER}"
    ScoutsRepoName="${SCOUTS_REPO_NAME}"
    ScoutsBranch="${SCOUTS_BRANCH}"
)

if ! aws cloudformation deploy "${CFN_ARGS[@]}"; then
  echo "Bootstrap deploy failed. Recent CloudFormation events:" >&2
  print_recent_stack_events >&2
  exit 1
fi

aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table
