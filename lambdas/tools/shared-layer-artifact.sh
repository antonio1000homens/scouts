#!/usr/bin/env bash

# Shared Lambda-layer resolver.
#
# The runtime payload is content-addressed by production source/dependency
# inputs. A matching scouts-shared Lambda layer version is reused when it
# already exists; otherwise the payload is built/uploaded and exactly one new
# layer version is published for that content hash.

shared_layer_digest_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    echo 'Neither sha256sum nor shasum is available' >&2
    return 1
  fi
}

shared_layer_source_hash() {
  local shared_layer_dir="$1"
  local nodejs_dir="${shared_layer_dir}/nodejs"

  if [ ! -f "${nodejs_dir}/package.json" ] || [ ! -f "${nodejs_dir}/package-lock.json" ]; then
    echo "Shared layer package files are missing under ${nodejs_dir}" >&2
    return 1
  fi

  (
    cd "${nodejs_dir}"
    find . -type f \
      ! -path './node_modules/*' \
      ! -name '*.test.mjs' \
      ! -name '*.integration.test.mjs' \
      \( -name '*.mjs' -o -name 'package.json' -o -name 'package-lock.json' \) \
      -print \
      | LC_ALL=C sort \
      | while IFS= read -r file; do
          printf '%s\n' "${file}"
          cat "${file}"
          printf '\n'
        done
  ) | shared_layer_digest_stream
}

prepare_shared_layer_zip() {
  local shared_layer_dir="$1"
  local code_bucket="$2"
  local region="$3"
  local npm_cache_dir="$4"
  local layer_hash="$5"

  LAYER_CODE_KEY="lambdas/shared-layer/${layer_hash}/scouts-shared-layer.zip"

  if aws s3api head-object \
      --bucket "${code_bucket}" \
      --key "${LAYER_CODE_KEY}" \
      --region "${region}" >/dev/null 2>&1; then
    echo "Reusing shared Lambda layer artifact s3://${code_bucket}/${LAYER_CODE_KEY}"
    export LAYER_CODE_KEY
    return 0
  fi

  echo "Shared Lambda layer artifact missing for ${layer_hash}; building once."
  (
    cd "${shared_layer_dir}/nodejs"
    npm ci --omit=dev --cache "${npm_cache_dir}"
  )

  rm -f "${shared_layer_dir}/lambda-layer.zip"
  (
    cd "${shared_layer_dir}"
    zip -qr lambda-layer.zip nodejs \
      -x 'nodejs/*.test.mjs' \
         'nodejs/*.integration.test.mjs'
  )

  aws s3 cp \
    "${shared_layer_dir}/lambda-layer.zip" \
    "s3://${code_bucket}/${LAYER_CODE_KEY}" \
    --region "${region}"

  export LAYER_CODE_KEY
}

find_shared_layer_version_arn() {
  local layer_name="$1"
  local layer_hash="$2"
  local region="$3"
  local description="source-sha256:${layer_hash}"
  local arn

  arn="$(aws lambda list-layer-versions \
    --layer-name "${layer_name}" \
    --region "${region}" \
    --query "LayerVersions[?Description=='${description}'].LayerVersionArn | [0]" \
    --output text 2>/dev/null || true)"

  if [ -n "${arn}" ] && [ "${arn}" != "None" ] && [ "${arn}" != "null" ]; then
    printf '%s' "${arn}"
  fi
}

resolve_shared_layer_version() {
  local shared_layer_dir="$1"
  local code_bucket="$2"
  local region="$3"
  local npm_cache_dir="$4"
  local layer_name="${5:-scouts-shared}"
  local runtime="${6:-nodejs24.x}"
  local layer_hash
  local existing_arn
  local published_arn

  layer_hash="$(shared_layer_source_hash "${shared_layer_dir}")"
  LAYER_CODE_KEY="lambdas/shared-layer/${layer_hash}/scouts-shared-layer.zip"
  export LAYER_CODE_KEY

  # A caller (for example the consolidated CI deploy job) may resolve the
  # canonical layer once and pass it through to every function deployment.
  if [ -n "${SCOUTS_SHARED_LAYER_VERSION_ARN:-}" ]; then
    echo "Using supplied shared Lambda layer ${SCOUTS_SHARED_LAYER_VERSION_ARN}"
    export SCOUTS_SHARED_LAYER_VERSION_ARN
    return 0
  fi

  existing_arn="$(find_shared_layer_version_arn "${layer_name}" "${layer_hash}" "${region}")"
  if [ -n "${existing_arn}" ]; then
    SCOUTS_SHARED_LAYER_VERSION_ARN="${existing_arn}"
    export SCOUTS_SHARED_LAYER_VERSION_ARN
    echo "Reusing shared Lambda layer version ${SCOUTS_SHARED_LAYER_VERSION_ARN} (${layer_hash})"
    return 0
  fi

  prepare_shared_layer_zip "${shared_layer_dir}" "${code_bucket}" "${region}" "${npm_cache_dir}" "${layer_hash}"

  echo "Publishing shared Lambda layer version for ${layer_hash}."
  published_arn="$(aws lambda publish-layer-version \
    --layer-name "${layer_name}" \
    --description "source-sha256:${layer_hash}" \
    --content "S3Bucket=${code_bucket},S3Key=${LAYER_CODE_KEY}" \
    --compatible-runtimes "${runtime}" \
    --region "${region}" \
    --query 'LayerVersionArn' \
    --output text)"

  if [ -z "${published_arn}" ] || [ "${published_arn}" = "None" ] || [ "${published_arn}" = "null" ]; then
    echo "Lambda did not return a shared layer version ARN" >&2
    return 1
  fi

  SCOUTS_SHARED_LAYER_VERSION_ARN="${published_arn}"
  export SCOUTS_SHARED_LAYER_VERSION_ARN
  echo "Published shared Lambda layer ${SCOUTS_SHARED_LAYER_VERSION_ARN}"
}

# Backwards-compatible entrypoint used by the four local deploy scripts. It now
# resolves the centrally owned Lambda layer version, not merely the S3 ZIP.
#
# Existing scripts historically pass LAYER_CODE_KEY to CloudFormation. Until
# those callers are all migrated, carry the resolved ARN in that variable too;
# templates accept it only as a deprecated fallback and never publish a layer.
prepare_shared_layer_artifact() {
  resolve_shared_layer_version "$@" "${LAYER_NAME:-scouts-shared}" "${RUNTIME:-nodejs24.x}"
  LAYER_CODE_KEY="${SCOUTS_SHARED_LAYER_VERSION_ARN}"
  export LAYER_CODE_KEY
}
