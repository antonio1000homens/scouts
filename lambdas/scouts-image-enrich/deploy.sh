#!/bin/bash

# Compatibility target retained temporarily so stale manual/workflow references do
# not recreate the retired image-enrich state machine. The canonical workflow is
# deployed by lambdas/scouts-full-enrich/deploy.sh.

set -euo pipefail

echo "[deprecated] scouts-image-enrich has been retired; no legacy resources will be deployed."
echo "[deprecated] Use deploy target scouts-full-enrich for the canonical workflow."
exit 0
