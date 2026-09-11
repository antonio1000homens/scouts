#!/bin/bash

# Update environment variables for sqs2scouts Lambda function
# Secret values are stored in SSM Parameter Store; this script only writes parameter names.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BWS_HELPER="${ROOT_DIR}/tools/bws-env.sh"

FUNCTION_NAME="sqs2scouts"
REGION="${AWS_REGION:-eu-west-2}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Updating sqs2scouts Environment Variables ===${NC}\n"

# Load environment variables from the main scouts .env file
if [ -f "${ROOT_DIR}/.env" ]; then
    echo -e "${YELLOW}Loading environment variables from ${ROOT_DIR}/.env${NC}"
    set -a
    source "${ROOT_DIR}/.env"
    set +a
else
    echo -e "${RED}Error: ${ROOT_DIR}/.env file not found${NC}"
    exit 1
fi

# Check if function exists
if ! aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}" &>/dev/null; then
    echo -e "${RED}Error: Lambda function ${FUNCTION_NAME} not found${NC}"
    exit 1
fi

echo -e "${YELLOW}Updating environment variables for ${FUNCTION_NAME}...${NC}"

# Update environment variables
aws lambda update-function-configuration \
    --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" \
    --environment "Variables={
        SLACK_BOT_TOKEN_PARAMETER=${SLACK_BOT_TOKEN_PARAMETER:-/scouts/shared/slack-bot-token},
        SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL:-https://slack.com/api/chat.postMessage},
        SCOUTS_NOTIFICATION_CHANNEL=${SCOUTS_NOTIFICATION_CHANNEL:-C0C1996TGQZ},
        SLACK_CHAT_UPDATE_URL=${SLACK_CHAT_UPDATE_URL:-https://slack.com/api/chat.update},
        SLACK_VIEWS_OPEN_URL=${SLACK_VIEWS_OPEN_URL:-https://slack.com/api/views.open},
        SLACK_SIGNING_SECRET_PARAMETER=${SLACK_SIGNING_SECRET_PARAMETER:-/scouts/shared/slack-signing-secret},
        TARGET_BUCKET=${TARGET_BUCKET:-2ndtolworth},
        GEMINI_API_KEY_PARAMETER=${GEMINI_API_KEY_PARAMETER:-/scouts/sqs2scouts/gemini-api-key},
        GEMINI_API_VERSION=${GEMINI_API_VERSION:-},
        GEMINI_IMAGE_API_VERSION=${GEMINI_IMAGE_API_VERSION:-},
        GEMINI_IMAGE_MODEL=${GEMINI_IMAGE_MODEL:-},
        GEMINI_TEXT_MODEL=${GEMINI_TEXT_MODEL:-},
        UNSPLASH_ACCESS_KEY=${UNSPLASH_ACCESS_KEY:-},
        SLACK_HANDLER_URL=${SLACK_HANDLER_URL:-},
        AWS_REGION=${AWS_REGION:-eu-west-2},
        APPROVAL_METADATA_PREFIX=${APPROVAL_METADATA_PREFIX:-approvals},
        SCOUTS_CONFIG_KEY=${SCOUTS_CONFIG_KEY:-scouts.conf},
        SCOUTS_CONFIG_TTL_MS=${SCOUTS_CONFIG_TTL_MS:-300000}
    }" \
    --output json > /dev/null

echo -e "${GREEN}✓ Environment variables updated successfully${NC}"

# Wait for the update to complete
echo -e "${YELLOW}Waiting for function update to complete...${NC}"
aws lambda wait function-updated --function-name "${FUNCTION_NAME}" --region "${REGION}"

echo -e "${GREEN}✓ Function update completed${NC}"

# Verify the environment variables were set
echo -e "\n${YELLOW}Verifying environment variables...${NC}"
ENV_VARS=$(aws lambda get-function-configuration \
    --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" \
    --query 'Environment.Variables' \
    --output json)

echo "Current environment variables:"
echo "$ENV_VARS" | jq -r 'to_entries[] | "\(.key)=\(.value)"' | while read -r line; do
    key=$(echo "$line" | cut -d'=' -f1)
    value=$(echo "$line" | cut -d'=' -f2-)
    
    # Mask sensitive values
    case "$key" in
        *TOKEN*|*SECRET*|*KEY*)
            if [ ${#value} -gt 10 ]; then
                masked_value="${value:0:10}..."
            else
                masked_value="***"
            fi
            echo "  $key=$masked_value"
            ;;
        *)
            echo "  $key=$value"
            ;;
    esac
done

echo -e "\n${GREEN}=== Environment Variables Update Complete ===${NC}"
