#!/usr/bin/env bash

# Shared Lambda-layer packaging helper.
#
# The layer is content-addressed by the production source/dependency inputs.
# This prevents every unrelated Lambda deployment from uploading the same layer
# under a timestamped key and forcing CloudFormation to publish a new version.

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

prepare_shared_layer_artifact() {
  local shared_layer_dir="$1"
  local code_bucket="$2"
  local region="$3"
  local npm_cache_dir="$4"
  local layer_hash

  layer_hash="$(shared_layer_source_hash "${shared_layer_dir}")"
  LAYER_CODE_KEY="lambdas/shared-layer/${layer_hash}/scouts-shared-layer.zip"

  if aws s3api head-object \
      --bucket "${code_bucket}" \
      --key "${LAYER_CODE_KEY}" \
      --region "${region}" >/dev/null 2>&1; then
    echo "Reusing shared Lambda layer artifact s3://${code_bucket}/${LAYER_CODE_KEY}"
    export LAYER_CODE_KEY
    return 0
  fi

  echo "Shared Lambda layer changed (${layer_hash}); building a new artifact."
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
