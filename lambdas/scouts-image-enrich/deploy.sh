#!/bin/bash

# Compatibility deploy target retained for one cutover cycle.
# The legacy scouts-image-enrich state machine is no longer deployed; any caller
# using this historical target now deploys the canonical scouts-full-enrich
# workflow instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[deprecated] scouts-image-enrich has been retired."
echo "[deprecated] Redirecting deployment to scouts-full-enrich."

exec bash "${ROOT_DIR}/scouts-full-enrich/deploy.sh"
