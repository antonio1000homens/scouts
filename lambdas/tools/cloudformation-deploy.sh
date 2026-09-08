#!/usr/bin/env bash

print_cloudformation_failure_events() {
  local stack_name="$1"
  local region="$2"

  echo >&2
  echo "CloudFormation deployment failed for ${stack_name}. Recent failed/rollback events:" >&2
  aws cloudformation describe-stack-events \
    --region "${region}" \
    --stack-name "${stack_name}" \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED') || contains(ResourceStatus, 'ROLLBACK')].[Timestamp,LogicalResourceId,ResourceType,ResourceStatus,ResourceStatusReason]" \
    --output table >&2 2>/dev/null || true
}

deploy_cloudformation_with_diagnostics() {
  local stack_name="$1"
  local region="$2"
  shift 2

  if aws cloudformation deploy "$@"; then
    return 0
  fi

  print_cloudformation_failure_events "${stack_name}" "${region}"
  return 1
}
