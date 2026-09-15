from pathlib import Path
import re


def load(path):
    return Path(path).read_text()


def save(path, text):
    Path(path).write_text(text)


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}: {old[:120]!r}")
    return text.replace(old, new, 1)


def function_segment(text, start, end):
    a = text.index(start)
    b = text.index(end, a)
    return a, b, text[a:b]


# ---------- Admin controller ----------
path = "website/admin/admin-script.js"
text = load(path)

text = one(
    text,
    "    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};\n    const hex = String(metadata.hex || metadata.hexId || event.hex || event.hexId || '').trim().toLowerCase();\n    if (hex) return `hex:${hex}`;",
    "    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};\n    const occurrenceId = String(entry?.occurrenceId || event.occurrenceId || '').trim();\n    if (occurrenceId) return `occurrence:${occurrenceId}`;\n    const hex = String(metadata.hex || metadata.hexId || event.hex || event.hexId || '').trim().toLowerCase();\n    if (hex) return `hex:${hex}`;",
    "notification occurrence identity",
)

text = one(
    text,
    "function refreshApiActionButtons() {\n    const enabled = apiAuthReady;\n    const actionButtons = document.querySelectorAll('.requires-api');\n    actionButtons.forEach((button) => {\n        button.disabled = !enabled;\n        button.classList.toggle('btn-disabled', !enabled);\n    });\n}",
    "function refreshApiActionButtons() {\n    const actionButtons = document.querySelectorAll('.requires-api');\n    actionButtons.forEach((button) => {\n        const pending = button.dataset.apiPending === 'true';\n        const enabled = apiAuthReady && !pending;\n        button.disabled = !enabled;\n        button.classList.toggle('btn-disabled', !enabled);\n    });\n}",
    "pending-aware refreshApiActionButtons",
)

text = one(text, "requestGeneratedField('full', this.value, this)", "requestGeneratedField('full', this.value, this, ${index})", "card full generation target")
text = one(text, "requestGeneratedField('imageUrl', this.value, this)", "requestGeneratedField('imageUrl', this.value, this, ${index})", "card image generation target")

# Occurrence-scoped optimistic visibility state: replace the two complete helpers.
a, b, segment = function_segment(text, "function applyLocalHiddenState(", "async function persistCurrentField(")
replacement = '''function applyLocalHiddenState(entry, hiddenAtIso, hidden = true) {
    if (!entry || !entry.event) return;
    const event = entry.event;
    const occurrenceId = entry.occurrenceId || event.occurrenceId;
    if (!occurrenceId) return;
    if (hidden) {
        event.isHidden = true;
        event.hiddenAt = hasText(hiddenAtIso) ? hiddenAtIso : new Date().toISOString();
        entry.allHidden = true;
        localVisibilityOverrides.set(occurrenceId, {
            hidden: true,
            hiddenAt: event.hiddenAt,
        });
    } else {
        event.isHidden = false;
        event.hiddenAt = null;
        entry.allHidden = false;
        localVisibilityOverrides.set(occurrenceId, {
            hidden: false,
            hiddenAt: null,
        });
    }
}

function applyVisibilityOverrides(entries, options = {}) {
    if (!Array.isArray(entries) || localVisibilityOverrides.size === 0) return false;
    const allowConfirm = options.allowConfirm !== false;
    let changed = false;

    entries.forEach((entry) => {
        const event = entry?.event;
        const occurrenceId = entry?.occurrenceId || event?.occurrenceId;
        if (!occurrenceId) return;

        const override = localVisibilityOverrides.get(occurrenceId);
        if (!override) return;

        const backendStateMatches = isHiddenEvent(event) === Boolean(override.hidden);
        if (allowConfirm && backendStateMatches) {
            localVisibilityOverrides.delete(occurrenceId);
            return;
        }

        if (override.hidden) {
            const nextHiddenAt = hasText(override.hiddenAt) ? override.hiddenAt : (event.hiddenAt || new Date().toISOString());
            if (event.isHidden !== true || event.hiddenAt !== nextHiddenAt || entry.allHidden !== true) {
                event.isHidden = true;
                event.hiddenAt = nextHiddenAt;
                entry.allHidden = true;
                changed = true;
            }
            return;
        }

        if (event.isHidden !== false || event.hiddenAt !== null || entry.allHidden !== false) {
            event.isHidden = false;
            event.hiddenAt = null;
            entry.allHidden = false;
            changed = true;
        }
    });

    return changed;
}

'''
text = text[:a] + replacement + text[b:]

# Save field pending state.
a, b, seg = function_segment(text, "async function persistCurrentField(", "async function requestGeneratedField(")
seg = one(seg, "    const subject = {\n        hex,\n        [config.subjectKey]: nextValue,\n    };", "    const operationKey = uiOperationKey(entry, `persist:${field}`);\n    if (pendingUiOperations.has(operationKey)) return;\n    pendingUiOperations.set(operationKey, true);\n\n    const subject = {\n        hex,\n        [config.subjectKey]: nextValue,\n    };", "persist operation key")
seg = one(seg, "    if (button) { button.disabled = true; button.textContent = 'Saving…'; }", "    if (button) {\n        button.dataset.apiPending = 'true';\n        button.disabled = true;\n        button.textContent = 'Saving…';\n    }", "persist button pending")
seg = one(seg, "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n        refreshApiActionButtons();", "        pendingUiOperations.delete(operationKey);\n        if (button) {\n            delete button.dataset.apiPending;\n            button.textContent = originalButtonLabel;\n        }\n        refreshApiActionButtons();", "persist pending cleanup")
text = text[:a] + seg + text[b:]

# Generation target/pending state.
text = one(text, "async function requestGeneratedField(field, action = 'generate', button = null) {", "async function requestGeneratedField(field, action = 'generate', button = null, eventIndex = null) {", "generation signature")
a, b, seg = function_segment(text, "async function requestGeneratedField(", "function buildVisibilityCommand(")
seg = one(seg, "    const entry = getSelectedModalEntry();\n    if (!entry) return;", "    const entry = Number.isInteger(eventIndex) ? visibleEventEntries[eventIndex] : getSelectedModalEntry();\n    if (!entry?.event) {\n        const message = 'Unable to find selected event entry.';\n        if (Number.isInteger(eventIndex)) pinRuntimeDetails(message, 'error');\n        else updateModalStatus(message, 'error');\n        return;\n    }", "generation selected entry")
seg = one(seg, "    const eventLabel = event.summary || event.title || `Event ${currentEventIndex + 1}`;", "    const displayIndex = Number.isInteger(eventIndex) ? eventIndex : currentEventIndex;\n    const eventLabel = event.summary || event.title || `Event ${(displayIndex ?? 0) + 1}`;", "generation label")
seg = one(seg, "    const payload = {\n        realm: 'scouts',", "    const operationKey = uiOperationKey(entry, `${action}:${field}`);\n    if (pendingUiOperations.has(operationKey)) return;\n    pendingUiOperations.set(operationKey, true);\n\n    const payload = {\n        realm: 'scouts',", "generation operation key")
seg = one(seg, "    if (button) { button.disabled = true; button.textContent = action === 'generateFull' ? 'Generating…' : 'Regenerating…'; }", "    if (button) {\n        button.dataset.apiPending = 'true';\n        button.disabled = true;\n        button.textContent = action === 'generateFull' ? 'Generating…' : 'Regenerating…';\n    }", "generation button pending")
seg = one(seg, "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n        refreshApiActionButtons();", "        pendingUiOperations.delete(operationKey);\n        if (button) {\n            delete button.dataset.apiPending;\n            button.textContent = originalButtonLabel;\n        }\n        refreshApiActionButtons();", "generation pending cleanup")
text = text[:a] + seg + text[b:]

# Hide/unhide selector validation and pending state.
for name, end_marker, verb, pending_label in [
    ("hideEvent", "async function unhideEvent(", "hide", "Hiding…"),
    ("unhideEvent", "function toggleCurrentEventHidden(", "unhide", "Unhiding…"),
]:
    start_marker = f"async function {name}("
    a, b, seg = function_segment(text, start_marker, end_marker)
    old_order = f"    const operationKey = uiOperationKey(entry, '{verb}');\n    if (pendingUiOperations.has(operationKey)) return;\n    pendingUiOperations.set(operationKey, true);\n    if (!hex) {{"
    seg = one(seg, old_order, "    if (!hex) {", f"{verb} validate before pending")
    close = "        return;\n    }\n\n"
    error_at = seg.index(f"const message = 'Cannot {verb} event: missing HEX.';")
    close_at = seg.index(close, error_at)
    seg = seg[:close_at] + seg[close_at:].replace(
        close,
        "        return;\n    }\n"
        f"    const operationKey = uiOperationKey(entry, '{verb}');\n"
        "    if (pendingUiOperations.has(operationKey)) return;\n"
        "    pendingUiOperations.set(operationKey, true);\n\n",
        1,
    )
    seg = one(seg, f"    if (button) {{ button.disabled = true; button.textContent = '{pending_label}'; }}", "    if (button) {\n        button.dataset.apiPending = 'true';\n        button.disabled = true;\n        button.textContent = '" + pending_label + "';\n    }", f"{verb} button pending")
    seg = one(seg, "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n        pendingUiOperations.delete(operationKey);\n        refreshApiActionButtons();", "        pendingUiOperations.delete(operationKey);\n        if (button) {\n            delete button.dataset.apiPending;\n            button.textContent = originalButtonLabel;\n        }\n        refreshApiActionButtons();", f"{verb} pending cleanup")
    text = text[:a] + seg + text[b:]

save(path, text)

# ---------- Approval UI ----------
path = "website/admin/admin-approval-workflow.js"
text = load(path)
text = one(text, "window.approveEvent = async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve') {", "window.approveEvent = async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve', button = null) {", "approval signature")
text = one(text, "return legacyApproveEvent?.(eventIndex, fromModal, action);", "return legacyApproveEvent?.(eventIndex, fromModal, action, button);", "legacy approval args")
text = one(text, "        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n        let operationStage = 'canonical review';", "        const operationKey = typeof uiOperationKey === 'function'\n            ? uiOperationKey(entry, 'approve')\n            : `${entry?.occurrenceId || event?.occurrenceId || hex}:approve`;\n        if (typeof pendingUiOperations !== 'undefined' && pendingUiOperations.has(operationKey)) return null;\n        if (typeof pendingUiOperations !== 'undefined') pendingUiOperations.set(operationKey, true);\n        const originalButtonLabel = button?.textContent;\n        if (button) {\n            button.dataset.apiPending = 'true';\n            button.disabled = true;\n            button.textContent = 'Approving…';\n        }\n\n        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n        let operationStage = 'canonical review';", "approval pending start")
text = one(text, "        } finally {\n            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n            relabelApprovalButtons();\n        }", "        } finally {\n            if (typeof pendingUiOperations !== 'undefined') pendingUiOperations.delete(operationKey);\n            if (button) {\n                delete button.dataset.apiPending;\n                button.textContent = originalButtonLabel;\n            }\n            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n            relabelApprovalButtons();\n        }", "approval pending cleanup")
save(path, text)

# ---------- Scouts reconciliation ----------
path = "lambdas/scouts/function/scouts-service.mjs"
text = load(path)
text = one(text, "function buildEventChangeKey(event, index = 0) {\n  if (!event || typeof event !== 'object') return `idx:${index}`;\n  const hex = typeof event.hex === 'string' ? event.hex.trim().toLowerCase() : '';", "function buildEventChangeKey(event, index = 0) {\n  if (!event || typeof event !== 'object') return `idx:${index}`;\n  const occurrenceId = typeof event.occurrenceId === 'string' ? event.occurrenceId.trim() : '';\n  if (occurrenceId) return `occurrence:${occurrenceId}`;\n  const hex = typeof event.hex === 'string' ? event.hex.trim().toLowerCase() : '';", "backend occurrence change key")
text = one(text, "  const liveQueuedProcessingByHex = new Map(); // Map<hexValue, Array<'tagline'|'imageTheme'|'image'>>\n\n  for (let index = 0; index < events.length; index++) {", "  const liveQueuedProcessingByHex = new Map(); // Map<hexValue, Array<'tagline'|'imageTheme'|'image'>>\n\n  const occurrenceStateById = new Map();\n  const occurrenceIds = [...new Set(events.map((event) => resolveOccurrenceId(event)).filter(Boolean))];\n  const occurrenceReadConcurrency = 8;\n  for (let offset = 0; offset < occurrenceIds.length; offset += occurrenceReadConcurrency) {\n    const batchIds = occurrenceIds.slice(offset, offset + occurrenceReadConcurrency);\n    const batch = await Promise.all(batchIds.map(async (occurrenceId) => {\n      try {\n        const state = await getJsonFromS3(bucketName, occurrenceStorageKey(occurrenceId), `occurrence:${occurrenceId}`);\n        return [occurrenceId, state];\n      } catch (error) {\n        if (!/NoSuchKey|not found/i.test(error?.name || error?.message || '')) {\n          console.warn(`[Occurrence] Failed to load visibility overlay ${occurrenceId}:`, error?.message || error);\n        }\n        return [occurrenceId, null];\n      }\n    }));\n    for (const [occurrenceId, state] of batch) occurrenceStateById.set(occurrenceId, state);\n  }\n\n  for (let index = 0; index < events.length; index++) {", "bounded overlay prefetch")
old_overlay = """    if (baseEvent.occurrenceId) {
      try {
        const occurrenceState = await getJsonFromS3(bucketName, occurrenceStorageKey(baseEvent.occurrenceId), `occurrence:${baseEvent.occurrenceId}`);
        if (occurrenceState?.status && typeof occurrenceState.status.isHidden === 'boolean') {
          isHidden = occurrenceState.status.isHidden;
          baseEvent.status = {
            ...(baseEvent.status && typeof baseEvent.status === 'object' ? baseEvent.status : {}),
            isHidden,
          };
          baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object' ? baseEvent.metadata : {};
          baseEvent.metadata.status = {
            ...(baseEvent.metadata.status && typeof baseEvent.metadata.status === 'object' ? baseEvent.metadata.status : {}),
            isHidden,
          };
        }
      } catch (error) {
        if (!/NoSuchKey|not found/i.test(error?.name || error?.message || '')) {
          console.warn(`[Occurrence] Failed to load visibility overlay ${baseEvent.occurrenceId}:`, error?.message || error);
        }
      }
    }
"""
new_overlay = """    if (baseEvent.occurrenceId) {
      const occurrenceState = occurrenceStateById.get(baseEvent.occurrenceId) ?? null;
      if (occurrenceState?.status && typeof occurrenceState.status.isHidden === 'boolean') {
        isHidden = occurrenceState.status.isHidden;
        baseEvent.status = {
          ...(baseEvent.status && typeof baseEvent.status === 'object' ? baseEvent.status : {}),
          isHidden,
        };
        baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object' ? baseEvent.metadata : {};
        baseEvent.metadata.status = {
          ...(baseEvent.metadata.status && typeof baseEvent.metadata.status === 'object' ? baseEvent.metadata.status : {}),
          isHidden,
        };
      }
    }
"""
text = one(text, old_overlay, new_overlay, "overlay map lookup")
save(path, text)

# ---------- Persistence ----------
path = "lambdas/sqs2scouts/function/persistence-processor.mjs"
text = load(path)
text = one(text, "    const overlay = {\n        occurrenceId,\n        metadataId: hex,\n        sourceUid: sourceUid || matches[0].uid || null,\n        lastKnownStart: lastKnownStart || matches[0].dtstart || null,", "    const occurrence = matches[0];\n    const occurrenceHex = String(occurrence?.metadata?.hex || '').trim().toLowerCase();\n    const requestedHex = String(hex || '').trim().toLowerCase();\n    if (!occurrenceHex || occurrenceHex !== requestedHex) {\n        const error = new Error(`Visibility occurrence ${occurrenceId} does not belong to HEX ${requestedHex}`);\n        error.code = 'VISIBILITY_OCCURRENCE_HEX_MISMATCH';\n        throw error;\n    }\n    const overlay = {\n        occurrenceId,\n        metadataId: occurrenceHex,\n        sourceUid: sourceUid || occurrence.uid || null,\n        lastKnownStart: lastKnownStart || occurrence.dtstart || null,", "visibility occurrence/HEX validation")
text = one(text, "            if (!actionIsHidden && !statusIsHidden) {\n                setImageApprovalState(event, true);\n            }", "            if (!visibility && !actionIsHidden && !statusIsHidden) {\n                setImageApprovalState(event, true);\n            }", "visibility avoids approval promotion")
save(path, text)

# ---------- Regression assertions ----------
path = "tests/issue-39-admin-actions.test.mjs"
text = load(path)
if "admin v2 action scoping guards card generation and pending buttons" not in text:
    text += """

test('admin v2 action scoping guards card generation and pending buttons', () => {
  assert.match(adminSource, /requestGeneratedField\('full', this\.value, this, \$\{index\}\)/);
  assert.match(adminSource, /button\.dataset\.apiPending === 'true'/);
  assert.match(adminSource, /localVisibilityOverrides\.set\(occurrenceId/);
  assert.match(adminSource, /localVisibilityOverrides\.get\(occurrenceId\)/);
});
"""
    save(path, text)
