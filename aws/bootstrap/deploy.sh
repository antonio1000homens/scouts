#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/scouts-account-bootstrap.yaml"

REGION="${AWS_REGION:-eu-west-2}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-553490163883}"
STACK_NAME="${STACK_NAME:-scouts-account-bootstrap}"
ARTIFACT_BUCKET_NAME="${ARTIFACT_BUCKET_NAME:-aws2022-lambda-code-eu-west-2-553490163883}"
BOOTSTRAP_PRINCIPAL_ARN="${BOOTSTRAP_PRINCIPAL_ARN:-}"
SCOUTS_REPO_OWNER="${SCOUTS_REPO_OWNER:-antonio1000homens}"
SCOUTS_REPO_NAME="${SCOUTS_REPO_NAME:-scouts}"
LAMBDAS_REPO_NAME="${LAMBDAS_REPO_NAME:-lambdas}"
SCOUTS_BRANCH="${SCOUTS_BRANCH:-master}"
LAMBDAS_PRIMARY_BRANCH="${LAMBDAS_PRIMARY_BRANCH:-main}"
LAMBDAS_SECONDARY_BRANCH="${LAMBDAS_SECONDARY_BRANCH:-master}"

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

CALLER_ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)"
if [ "${CALLER_ACCOUNT}" != "${ACCOUNT_ID}" ]; then
  echo "Unexpected AWS account ${CALLER_ACCOUNT}. Expected ${ACCOUNT_ID}." >&2
  exit 1
fi

aws cloudformation deploy \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    BootstrapPrincipalArn="${BOOTSTRAP_PRINCIPAL_ARN}" \
    ArtifactBucketName="${ARTIFACT_BUCKET_NAME}" \
    ScoutsRepoOwner="${SCOUTS_REPO_OWNER}" \
    ScoutsRepoName="${SCOUTS_REPO_NAME}" \
    LambdasRepoName="${LAMBDAS_REPO_NAME}" \
    ScoutsBranch="${SCOUTS_BRANCH}" \
    LambdasPrimaryBranch="${LAMBDAS_PRIMARY_BRANCH}" \
    LambdasSecondaryBranch="${LAMBDAS_SECONDARY_BRANCH}"

aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' \
  --output table
