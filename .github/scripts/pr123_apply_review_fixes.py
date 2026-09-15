from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_between(path, start, end, old, new):
    p = Path(path)
    text = p.read_text()
    start_at = text.index(start)
    end_at = text.index(end, start_at)
    segment = text[start_at:end_at]
    count = segment.count(old)
    if count != 1:
        raise SystemExit(
            f"{path} between {start!r} and {end!r}: expected one match, found {count}: {old[:160]!r}"
        )
    segment = segment.replace(old, new, 1)
    p.write_text(text[:start_at] + segment + text[end_at:])


admin = "website/admin/admin-script.js"

# Occurrence-level notification/change identity must precede shared HEX.
replace_once(
    admin,
    "    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};\n"
    "    const hex = String(metadata.hex || metadata.hexId || event.hex || event.hexId || '').trim().toLowerCase();\n"
    "    if (hex) return `hex:${hex}`;",
    "    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};\n"
    "    const occurrenceId = String(entry?.occurrenceId || event.occurrenceId || '').trim();\n"
    "    if (occurrenceId) return `occurrence:${occurrenceId}`;\n"
    "    const hex = String(metadata.hex || metadata.hexId || event.hex || event.hexId || '').trim().toLowerCase();\n"
    "    if (hex) return `hex:${hex}`;",
)

# Authentication refresh must respect action-scoped pending state.
replace_once(
    admin,
    "function refreshApiActionButtons() {\n"
    "    const enabled = apiAuthReady;\n"
    "    const actionButtons = document.querySelectorAll('.requires-api');\n"
    "    actionButtons.forEach((button) => {\n"
    "        button.disabled = !enabled;\n"
    "        button.classList.toggle('btn-disabled', !enabled);\n"
    "    });\n"
    "}",
    "function refreshApiActionButtons() {\n"
    "    const actionButtons = document.querySelectorAll('.requires-api');\n"
    "    actionButtons.forEach((button) => {\n"
    "        const pending = button.dataset.apiPending === 'true';\n"
    "        const enabled = apiAuthReady && !pending;\n"
    "        button.disabled = !enabled;\n"
    "        button.classList.toggle('btn-disabled', !enabled);\n"
    "    });\n"
    "}",
)

# Card generation actions explicitly target the card occurrence.
replace_once(
    admin,
    "requestGeneratedField('full', this.value, this)",
    "requestGeneratedField('full', this.value, this, ${index})",
)
replace_once(
    admin,
    "requestGeneratedField('imageUrl', this.value, this)",
    "requestGeneratedField('imageUrl', this.value, this, ${index})",
)

# Save fields: duplicate-click protection belongs to this entry/action only.
persist_start = "async function persistCurrentField("
persist_end = "async function requestGeneratedField("
replace_between(
    admin,
    persist_start,
    persist_end,
    "    const subject = {\n        hex,\n        [config.subjectKey]: nextValue,\n    };",
    "    const operationKey = uiOperationKey(entry, `persist:${field}`);\n"
    "    if (pendingUiOperations.has(operationKey)) return;\n"
    "    pendingUiOperations.set(operationKey, true);\n\n"
    "    const subject = {\n        hex,\n        [config.subjectKey]: nextValue,\n    };",
)
replace_between(
    admin,
    persist_start,
    persist_end,
    "    if (button) { button.disabled = true; button.textContent = 'Saving…'; }",
    "    if (button) {\n"
    "        button.dataset.apiPending = 'true';\n"
    "        button.disabled = true;\n"
    "        button.textContent = 'Saving…';\n"
    "    }",
)
replace_between(
    admin,
    persist_start,
    persist_end,
    "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n"
    "        refreshApiActionButtons();",
    "        pendingUiOperations.delete(operationKey);\n"
    "        if (button) {\n"
    "            delete button.dataset.apiPending;\n"
    "            button.textContent = originalButtonLabel;\n"
    "        }\n"
    "        refreshApiActionButtons();",
)

# Generation: explicit card target plus scoped duplicate protection.
replace_once(
    admin,
    "async function requestGeneratedField(field, action = 'generate', button = null) {",
    "async function requestGeneratedField(field, action = 'generate', button = null, eventIndex = null) {",
)
generate_start = "async function requestGeneratedField("
generate_end = "function buildVisibilityCommand("
replace_between(
    admin,
    generate_start,
    generate_end,
    "    const entry = getSelectedModalEntry();\n    if (!entry) return;",
    "    const entry = Number.isInteger(eventIndex) ? visibleEventEntries[eventIndex] : getSelectedModalEntry();\n"
    "    if (!entry?.event) {\n"
    "        const message = 'Unable to find selected event entry.';\n"
    "        if (Number.isInteger(eventIndex)) pinRuntimeDetails(message, 'error');\n"
    "        else updateModalStatus(message, 'error');\n"
    "        return;\n"
    "    }",
)
replace_between(
    admin,
    generate_start,
    generate_end,
    "    const eventLabel = event.summary || event.title || `Event ${currentEventIndex + 1}`;",
    "    const displayIndex = Number.isInteger(eventIndex) ? eventIndex : currentEventIndex;\n"
    "    const eventLabel = event.summary || event.title || `Event ${(displayIndex ?? 0) + 1}`;",
)
replace_between(
    admin,
    generate_start,
    generate_end,
    "    const payload = {\n        realm: 'scouts',",
    "    const operationKey = uiOperationKey(entry, `${action}:${field}`);\n"
    "    if (pendingUiOperations.has(operationKey)) return;\n"
    "    pendingUiOperations.set(operationKey, true);\n\n"
    "    const payload = {\n        realm: 'scouts',",
)
replace_between(
    admin,
    generate_start,
    generate_end,
    "    if (button) { button.disabled = true; button.textContent = action === 'generateFull' ? 'Generating…' : 'Regenerating…'; }",
    "    if (button) {\n"
    "        button.dataset.apiPending = 'true';\n"
    "        button.disabled = true;\n"
    "        button.textContent = action === 'generateFull' ? 'Generating…' : 'Regenerating…';\n"
    "    }",
)
replace_between(
    admin,
    generate_start,
    generate_end,
    "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n"
    "        refreshApiActionButtons();",
    "        pendingUiOperations.delete(operationKey);\n"
    "        if (button) {\n"
    "            delete button.dataset.apiPending;\n"
    "            button.textContent = originalButtonLabel;\n"
    "        }\n"
    "        refreshApiActionButtons();",
)

# Optimistic visibility overlays are occurrence-scoped, never HEX-scoped.
visibility_start = "function applyLocalHiddenState("
visibility_end = "async function persistCurrentField("
replace_between(
    admin,
    visibility_start,
    visibility_end,
    "    const hex = getEventHex(event);",
    "    const occurrenceId = entry.occurrenceId || event.occurrenceId;\n    if (!occurrenceId) return;",
)
replace_between(
    admin,
    visibility_start,
    visibility_end,
    "        if (hex) {\n"
    "            localVisibilityOverrides.set(hex, {\n"
    "                hidden: true,\n"
    "                hiddenAt: event.hiddenAt,\n"
    "            });\n"
    "        }",
    "        localVisibilityOverrides.set(occurrenceId, {\n"
    "            hidden: true,\n"
    "            hiddenAt: event.hiddenAt,\n"
    "        });",
)
replace_between(
    admin,
    visibility_start,
    visibility_end,
    "        if (hex) {\n"
    "            localVisibilityOverrides.set(hex, {\n"
    "                hidden: false,\n"
    "                hiddenAt: null,\n"
    "            });\n"
    "        }",
    "        localVisibilityOverrides.set(occurrenceId, {\n"
    "            hidden: false,\n"
    "            hiddenAt: null,\n"
    "        });",
)
replace_between(
    admin,
    visibility_start,
    visibility_end,
    "        const hex = getEventHex(event);\n"
    "        if (!hex) return;\n\n"
    "        const override = localVisibilityOverrides.get(hex);",
    "        const occurrenceId = entry?.occurrenceId || event?.occurrenceId;\n"
    "        if (!occurrenceId) return;\n\n"
    "        const override = localVisibilityOverrides.get(occurrenceId);",
)
replace_between(
    admin,
    visibility_start,
    visibility_end,
    "            localVisibilityOverrides.delete(hex);",
    "            localVisibilityOverrides.delete(occurrenceId);",
)

# Hide/unhide: validate selectors before marking pending and preserve per-button lock.
for function_name, end_marker, verb, pending_label in [
    ("hideEvent", "async function unhideEvent(", "hide", "Hiding…"),
    ("unhideEvent", "function toggleCurrentEventHidden(", "unhide", "Unhiding…"),
]:
    start_marker = f"async function {function_name}("
    replace_between(
        admin,
        start_marker,
        end_marker,
        f"    const operationKey = uiOperationKey(entry, '{verb}');\n"
        "    if (pendingUiOperations.has(operationKey)) return;\n"
        "    pendingUiOperations.set(operationKey, true);\n"
        "    if (!hex) {",
        "    if (!hex) {",
    )
    p = Path(admin)
    text = p.read_text()
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    segment = text[start:end]
    error_marker = f"const message = 'Cannot {verb} event: missing HEX.';"
    error_at = segment.index(error_marker)
    return_marker = "        return;\n    }\n\n"
    insert_at = segment.index(return_marker, error_at)
    segment = (
        segment[:insert_at]
        + segment[insert_at:].replace(
            return_marker,
            "        return;\n"
            "    }\n"
            f"    const operationKey = uiOperationKey(entry, '{verb}');\n"
            "    if (pendingUiOperations.has(operationKey)) return;\n"
            "    pendingUiOperations.set(operationKey, true);\n\n",
            1,
        )
    )
    p.write_text(text[:start] + segment + text[end:])
    replace_between(
        admin,
        start_marker,
        end_marker,
        f"    if (button) {{ button.disabled = true; button.textContent = '{pending_label}'; }}",
        "    if (button) {\n"
        "        button.dataset.apiPending = 'true';\n"
        "        button.disabled = true;\n"
        f"        button.textContent = '{pending_label}';\n"
        "    }",
    )
    replace_between(
        admin,
        start_marker,
        end_marker,
        "        if (button) { button.disabled = !apiAuthReady; button.textContent = originalButtonLabel; }\n"
        "        pendingUiOperations.delete(operationKey);\n"
        "        refreshApiActionButtons();",
        "        pendingUiOperations.delete(operationKey);\n"
        "        if (button) {\n"
        "            delete button.dataset.apiPending;\n"
        "            button.textContent = originalButtonLabel;\n"
        "        }\n"
        "        refreshApiActionButtons();",
    )

# The approval override accepts the clicked button and joins scoped pending state.
approval = "website/admin/admin-approval-workflow.js"
replace_once(
    approval,
    "window.approveEvent = async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve') {",
    "window.approveEvent = async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve', button = null) {",
)
replace_once(
    approval,
    "return legacyApproveEvent?.(eventIndex, fromModal, action);",
    "return legacyApproveEvent?.(eventIndex, fromModal, action, button);",
)
replace_once(
    approval,
    "        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n"
    "        let operationStage = 'canonical review';",
    "        const operationKey = typeof uiOperationKey === 'function'\n"
    "            ? uiOperationKey(entry, 'approve')\n"
    "            : `${entry?.occurrenceId || event?.occurrenceId || hex}:approve`;\n"
    "        if (typeof pendingUiOperations !== 'undefined' && pendingUiOperations.has(operationKey)) return null;\n"
    "        if (typeof pendingUiOperations !== 'undefined') pendingUiOperations.set(operationKey, true);\n"
    "        const originalButtonLabel = button?.textContent;\n"
    "        if (button) {\n"
    "            button.dataset.apiPending = 'true';\n"
    "            button.disabled = true;\n"
    "            button.textContent = 'Approving…';\n"
    "        }\n\n"
    "        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n"
    "        let operationStage = 'canonical review';",
)
replace_once(
    approval,
    "        } finally {\n"
    "            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n"
    "            relabelApprovalButtons();\n"
    "        }",
    "        } finally {\n"
    "            if (typeof pendingUiOperations !== 'undefined') pendingUiOperations.delete(operationKey);\n"
    "            if (button) {\n"
    "                delete button.dataset.apiPending;\n"
    "                button.textContent = originalButtonLabel;\n"
    "            }\n"
    "            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();\n"
    "            relabelApprovalButtons();\n"
    "        }",
)

# Backend change summaries prefer occurrence identity for occurrence-owned fields.
scouts = "lambdas/scouts/function/scouts-service.mjs"
replace_once(
    scouts,
    "function buildEventChangeKey(event, index = 0) {\n"
    "  if (!event || typeof event !== 'object') return `idx:${index}`;\n"
    "  const hex = typeof event.hex === 'string' ? event.hex.trim().toLowerCase() : '';",
    "function buildEventChangeKey(event, index = 0) {\n"
    "  if (!event || typeof event !== 'object') return `idx:${index}`;\n"
    "  const occurrenceId = typeof event.occurrenceId === 'string' ? event.occurrenceId.trim() : '';\n"
    "  if (occurrenceId) return `occurrence:${occurrenceId}`;\n"
    "  const hex = typeof event.hex === 'string' ? event.hex.trim().toLowerCase() : '';",
)

# Overlay reads happen in bounded-concurrency batches, not one serial S3 RTT per event.
replace_once(
    scouts,
    "  const liveQueuedProcessingByHex = new Map(); // Map<hexValue, Array<'tagline'|'imageTheme'|'image'>>\n\n"
    "  for (let index = 0; index < events.length; index++) {",
    "  const liveQueuedProcessingByHex = new Map(); // Map<hexValue, Array<'tagline'|'imageTheme'|'image'>>\n\n"
    "  const occurrenceStateById = new Map();\n"
    "  const occurrenceIds = [...new Set(events.map((event) => resolveOccurrenceId(event)).filter(Boolean))];\n"
    "  const occurrenceReadConcurrency = 8;\n"
    "  for (let offset = 0; offset < occurrenceIds.length; offset += occurrenceReadConcurrency) {\n"
    "    const batchIds = occurrenceIds.slice(offset, offset + occurrenceReadConcurrency);\n"
    "    const batch = await Promise.all(batchIds.map(async (occurrenceId) => {\n"
    "      try {\n"
    "        const state = await getJsonFromS3(bucketName, occurrenceStorageKey(occurrenceId), `occurrence:${occurrenceId}`);\n"
    "        return [occurrenceId, state];\n"
    "      } catch (error) {\n"
    "        if (!/NoSuchKey|not found/i.test(error?.name || error?.message || '')) {\n"
    "          console.warn(`[Occurrence] Failed to load visibility overlay ${occurrenceId}:`, error?.message || error);\n"
    "        }\n"
    "        return [occurrenceId, null];\n"
    "      }\n"
    "    }));\n"
    "    for (const [occurrenceId, state] of batch) occurrenceStateById.set(occurrenceId, state);\n"
    "  }\n\n"
    "  for (let index = 0; index < events.length; index++) {",
)
old_overlay = "\n".join([
    "    if (baseEvent.occurrenceId) {",
    "      try {",
    "        const occurrenceState = await getJsonFromS3(bucketName, occurrenceStorageKey(baseEvent.occurrenceId), `occurrence:${baseEvent.occurrenceId}`);",
    "        if (occurrenceState?.status && typeof occurrenceState.status.isHidden === 'boolean') {",
    "          isHidden = occurrenceState.status.isHidden;",
    "          baseEvent.status = {",
    "            ...(baseEvent.status && typeof baseEvent.status === 'object' ? baseEvent.status : {}),",
    "            isHidden,",
    "          };",
    "          baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object' ? baseEvent.metadata : {};",
    "          baseEvent.metadata.status = {",
    "            ...(baseEvent.metadata.status && typeof baseEvent.metadata.status === 'object' ? baseEvent.metadata.status : {}),",
    "            isHidden,",
    "          };",
    "        }",
    "      } catch (error) {",
    "        if (!/NoSuchKey|not found/i.test(error?.name || error?.message || '')) {",
    "          console.warn(`[Occurrence] Failed to load visibility overlay ${baseEvent.occurrenceId}:`, error?.message || error);",
    "        }",
    "      }",
    "    }",
]) + "\n"
new_overlay = "\n".join([
    "    if (baseEvent.occurrenceId) {",
    "      const occurrenceState = occurrenceStateById.get(baseEvent.occurrenceId) ?? null;",
    "      if (occurrenceState?.status && typeof occurrenceState.status.isHidden === 'boolean') {",
    "        isHidden = occurrenceState.status.isHidden;",
    "        baseEvent.status = {",
    "          ...(baseEvent.status && typeof baseEvent.status === 'object' ? baseEvent.status : {}),",
    "          isHidden,",
    "        };",
    "        baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object' ? baseEvent.metadata : {};",
    "        baseEvent.metadata.status = {",
    "          ...(baseEvent.metadata.status && typeof baseEvent.metadata.status === 'object' ? baseEvent.metadata.status : {}),",
    "          isHidden,",
    "        };",
    "      }",
    "    }",
]) + "\n"
replace_once(scouts, old_overlay, new_overlay)

# Visibility persistence validates occurrence/HEX coherence before any overlay write.
processor = "lambdas/sqs2scouts/function/persistence-processor.mjs"
replace_once(
    processor,
    "    const overlay = {\n"
    "        occurrenceId,\n"
    "        metadataId: hex,\n"
    "        sourceUid: sourceUid || matches[0].uid || null,\n"
    "        lastKnownStart: lastKnownStart || matches[0].dtstart || null,",
    "    const occurrence = matches[0];\n"
    "    const occurrenceHex = String(occurrence?.metadata?.hex || '').trim().toLowerCase();\n"
    "    const requestedHex = String(hex || '').trim().toLowerCase();\n"
    "    if (!occurrenceHex || occurrenceHex !== requestedHex) {\n"
    "        const error = new Error(`Visibility occurrence ${occurrenceId} does not belong to HEX ${requestedHex}`);\n"
    "        error.code = 'VISIBILITY_OCCURRENCE_HEX_MISMATCH';\n"
    "        throw error;\n"
    "    }\n"
    "    const overlay = {\n"
    "        occurrenceId,\n"
    "        metadataId: occurrenceHex,\n"
    "        sourceUid: sourceUid || occurrence.uid || null,\n"
    "        lastKnownStart: lastKnownStart || occurrence.dtstart || null,",
)
replace_once(
    processor,
    "            if (!actionIsHidden && !statusIsHidden) {\n"
    "                setImageApprovalState(event, true);\n"
    "            }",
    "            if (!visibility && !actionIsHidden && !statusIsHidden) {\n"
    "                setImageApprovalState(event, true);\n"
    "            }",
)

# Add lightweight CI regression assertions to an existing admin action suite.
tests = Path("tests/issue-39-admin-actions.test.mjs")
text = tests.read_text()
marker = "test('admin v2 action scoping guards card generation and pending buttons'"
if marker not in text:
    text += (
        "\n\ntest('admin v2 action scoping guards card generation and pending buttons', () => {\n"
        "  assert.match(adminSource, /requestGeneratedField\\('full', this\\.value, this, \\$\\{index\\}\\)/);\n"
        "  assert.match(adminSource, /button\\.dataset\\.apiPending === 'true'/);\n"
        "  assert.match(adminSource, /localVisibilityOverrides\\.set\\(occurrenceId/);\n"
        "  assert.match(adminSource, /localVisibilityOverrides\\.get\\(occurrenceId/);\n"
        "});\n"
    )
    tests.write_text(text)
