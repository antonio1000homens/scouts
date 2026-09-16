from pathlib import Path

path = Path('lambdas/scouts/function/scouts-service.mjs')
text = path.read_text()
old = """          const existingHexStatus = getEventStatusObject(existingHexFile);
          if (existingHexStatus) {
            baseEvent.status = existingHexStatus;
            baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object'
              ? baseEvent.metadata
              : {};
            baseEvent.metadata.status = {
              isHidden: existingHexStatus.isHidden === true,
              isApproved: existingHexStatus.isApproved === true,
            };
          }
          if (isEventApproved(existingHexFile)) {
            baseEvent.approved = true;
          }
          if (!isHidden && isEventHidden(existingHexFile)) {
            isHidden = true;
          }
"""
new = """          const existingHexStatus = getEventStatusObject(existingHexFile);
          if (existingHexStatus) {
            isHidden = existingHexStatus.isHidden === true;
            baseEvent.approved = existingHexStatus.isApproved === true;
            baseEvent.status = existingHexStatus;
            baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object'
              ? baseEvent.metadata
              : {};
            baseEvent.metadata.status = {
              isHidden,
              isApproved: existingHexStatus.isApproved === true,
            };
          }
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one canonical status reconciliation block, found {count}')
path.write_text(text.replace(old, new, 1))
