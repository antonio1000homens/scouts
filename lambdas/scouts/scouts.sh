#!/bin/bash

# Test Lambda Function Script
# Invoke the Lambda function and display results

# --- Start of improvement ---
# Function to restore artefacts on failure
ARTIFACT_FILES=("events.json" "programme.json")

restore_artifacts() {
  for file in "${ARTIFACT_FILES[@]}"; do
    if [ -f "${file}.bak" ]; then
      echo "Restoring ${file} from backup..."
      mv "${file}.bak" "${file}"
    fi
  done
}

# Set up trap to restore artefacts on script error
trap 'restore_artifacts' ERR

# Backup and remove artefact files if they exist
for file in "${ARTIFACT_FILES[@]}"; do
  if [ -f "${file}" ]; then
    echo "Backing up and removing ${file}"
    mv "${file}" "${file}.bak"
  fi
done
# --- End of improvement ---

set -e

FUNCTION_NAME="scouts"
REGION="eu-west-2"
# Default output file set to output.log (user requested)
OUTPUT_FILE="output.log"
RESET_FLAG=false
MAX_LIMIT=""

POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --function-name|-f)
      if [[ -z "$2" ]]; then
        echo "Error: --function-name requires a value" >&2
        exit 1
      fi
      FUNCTION_NAME="$2"
      shift 2
      ;;
    --region|-r)
      if [[ -z "$2" ]]; then
        echo "Error: --region requires a value" >&2
        exit 1
      fi
      REGION="$2"
      shift 2
      ;;
    --output|-o)
      if [[ -z "$2" ]]; then
        echo "Error: --output requires a value" >&2
        exit 1
      fi
      OUTPUT_FILE="$2"
      shift 2
    ;;
    --reset|-R|reset)
      RESET_FLAG=true
      shift
      ;;
    --max|-m)
      if [[ -z "$2" ]]; then
        echo "Error: --max requires a value" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --max expects a non-negative integer" >&2
        exit 1
      fi
      MAX_LIMIT="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: ./test-function.sh [options] [function [region [output]]]

Options:
  -f, --function-name NAME   Lambda function name (default: scouts)
  -r, --region REGION        AWS region (default: eu-west-2)
  -o, --output FILE          Output file (default: .log)
  -R, --reset                Invoke with {"realm":"scouts","subject":"agenda","action":"reset"}
  -m, --max NUM              Invoke with {"realm":"scouts","subject":"events","action":NUM}
  -h, --help                 Show this help message

Legacy positional arguments are still accepted. Append "reset" anywhere to set the reset flag.
USAGE
      exit 0
      ;;
    *)
      POSITIONALS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONALS[@]} -ge 1 ]]; then
  FUNCTION_NAME="${POSITIONALS[0]}"
fi

if [[ ${#POSITIONALS[@]} -ge 2 ]]; then
  REGION="${POSITIONALS[1]}"
fi

if [[ ${#POSITIONALS[@]} -ge 3 ]]; then
  OUTPUT_FILE="${POSITIONALS[2]}"
fi

if [[ ${#POSITIONALS[@]} -ge 4 ]]; then
  for extra in "${POSITIONALS[@]:3}"; do
    if [[ "$extra" =~ ^reset$ ]]; then
      RESET_FLAG=true
    else
      echo "Warning: ignoring unexpected argument '$extra'" >&2
    fi
  done
fi

if ${RESET_FLAG} && [[ -n "${MAX_LIMIT}" ]]; then
  echo "Error: --reset cannot be combined with --max" >&2
  exit 1
fi

echo "Invoking Lambda function: ${FUNCTION_NAME}"
echo "Region: ${REGION}"
echo "Output file: ${OUTPUT_FILE}"
echo "Reset flag: ${RESET_FLAG}"
echo "Max events limit: ${MAX_LIMIT:-none}"
echo ""

AWS_ARGS=(
  aws lambda invoke
  --function-name "${FUNCTION_NAME}"
  --region "${REGION}"
  --log-type Tail
  --query 'LogResult'
  --output text
)

# Ensure the output file exists and is writable. Create or truncate it when starting a new invocation.
if ! touch "${OUTPUT_FILE}" 2>/dev/null; then
  echo "Error: cannot create or write to output file ${OUTPUT_FILE}" >&2
  exit 1
fi

PAYLOAD=""
if ${RESET_FLAG}; then
    PAYLOAD='{"realm":"scouts","subject":"agenda","action":"reset"}'
    echo "Invoking with reset payload."
elif [[ -n "${MAX_LIMIT}" ]]; then
    printf -v PAYLOAD '{"realm":"scouts","subject":"events","action":%s}' "${MAX_LIMIT}"
    echo "Invoking with max payload (action=${MAX_LIMIT})."
else
    echo "Invoking without payload."
fi

if [[ -n "${PAYLOAD}" ]]; then
    AWS_ARGS+=(--cli-binary-format raw-in-base64-out --payload "${PAYLOAD}")
fi

AWS_ARGS+=("${OUTPUT_FILE}")

LOG_RESULT="$("${AWS_ARGS[@]}")"

if [[ -n "${LOG_RESULT}" && "${LOG_RESULT}" != "None" ]]; then
    if DECODED_LOGS="$(printf '%s' "${LOG_RESULT}" | base64 --decode 2>/dev/null)"; then
        printf '%s\n' "${DECODED_LOGS}"
    else
        echo "(Log output not base64, printing raw value)"
        echo "${LOG_RESULT}"
    fi
else
    echo "(No log output returned)"
fi

echo ""
echo "========================================="
echo "Function Response:"
echo "========================================="
if command -v jq &> /dev/null; then
    # The body of the response is a JSON string, so we parse it in-place.
    jq '.body |= fromjson' "${OUTPUT_FILE}"
else
    cat "${OUTPUT_FILE}"
fi
echo ""

# Check if response indicates success
if grep -q '"statusCode": 200' "${OUTPUT_FILE}" 2>/dev/null; then
    echo "✓ Function executed successfully"
    # --- Start of improvement ---
    # On success, remove any backups
    for file in "${ARTIFACT_FILES[@]}"; do
      if [ -f "${file}.bak" ]; then
        echo "Removing ${file} backup"
        rm "${file}.bak"
      fi
    done
    # --- End of improvement ---
elif grep -q 'errorMessage' "${OUTPUT_FILE}" 2>/dev/null; then
    echo "✗ Function returned an error"
    exit 1
fi

echo ""
echo "To view CloudWatch logs:"
echo "  aws logs tail /aws/lambda/${FUNCTION_NAME} --follow --region ${REGION}"

# --- Start of improvement ---
# Untrap on successful exit
trap - ERR
# --- End of improvement ---
