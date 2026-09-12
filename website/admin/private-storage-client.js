// Keep operational S3 objects private while preserving the legacy admin UI API.
// This script loads after admin-script.js and replaces the direct S3 readers
// with authenticated calls through /admin-api/scouts.
(function () {
    // Capture the base transport before presentation/activity layers wrap the
    // mutation path. Runtime reads must not schedule mutation-side Activity
    // refreshes simply because they share the same HTTP endpoint.
    const readOnlySendScoutsCommand = sendScoutsCommand;
    window.sendScoutsReadCommand = async function sendScoutsReadCommand(payload) {
        return readOnlySendScoutsCommand(payload);
    };

    function snapshotName(value) {
        const textValue = String(value || '').toLowerCase();
        if (textValue === 'queued' || textValue.includes('scoutsqueued')) return 'queued';
        if (textValue === 'processing' || textValue.includes('scoutsprocessing')) return 'processing';
        if (textValue === 'completed' || textValue.includes('scoutscomplete')) return 'completed';
        return '';
    }

    fetchQueueSnapshot = async function (snapshotRef) {
        const snapshot = snapshotName(snapshotRef);
        if (!snapshot) return null;
        try {
            const result = await window.sendScoutsReadCommand({
                realm: 'runtime',
                subject: 'snapshot',
                action: 'get',
                snapshot,
            });
            return result?.snapshot && typeof result.snapshot === 'object'
                ? result.snapshot
                : null;
        } catch (error) {
            console.warn(`[PrivateStorage] Unable to load ${snapshot} runtime snapshot`, error?.message || error);
            return null;
        }
    };

    async function fetchPrivateEvent(hexValue, normaliseForUi) {
        const hex = typeof hexValue === 'string' ? hexValue.trim().toLowerCase() : '';
        if (!hex) return null;
        const now = Date.now();
        const nextRetryAt = missingHexRetryAtByHex.get(hex) || 0;
        if (nextRetryAt > now) return null;

        try {
            const result = await window.sendScoutsReadCommand({
                realm: 'runtime',
                subject: 'event',
                action: 'get',
                hex,
            });
            const event = result?.event && typeof result.event === 'object' ? result.event : null;
            if (!event) {
                missingHexRetryAtByHex.set(hex, now + HEX_NOT_FOUND_BACKOFF_MS);
                return null;
            }
            missingHexRetryAtByHex.delete(hex);
            return normaliseForUi ? normaliseEventRecordForUi(event) : event;
        } catch (error) {
            missingHexRetryAtByHex.set(hex, now + HEX_NOT_FOUND_BACKOFF_MS);
            console.warn(`[PrivateStorage] Unable to load event ${hex}`, error?.message || error);
            return null;
        }
    }

    fetchHexEventByHex = async function (hexValue) {
        return fetchPrivateEvent(hexValue, true);
    };

    fetchRawHexEventByHex = async function (hexValue) {
        return fetchPrivateEvent(hexValue, false);
    };

    // Do not allow a fast click during controller bootstrap to fall back to the
    // legacy approval contract. Non-approval legacy actions remain delegated.
    const bootstrapLegacyApproveEvent = typeof approveEvent === 'function' ? approveEvent : null;
    window.scoutsApprovalWorkflowReady = false;
    window.approveEvent = function approvalBootstrapGuard(eventIndex, fromModal = false, action = 'approve') {
        if (String(action || '').toLowerCase() === 'approve' && !window.scoutsApprovalWorkflowReady) {
            const message = 'Approval controls are still loading. Reload the Admin page if this message persists.';
            if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'error');
            else if (typeof updateRuntimeDetails === 'function') updateRuntimeDetails(message, 'error');
            return null;
        }
        return bootstrapLegacyApproveEvent?.(eventIndex, fromModal, action);
    };

    // Keep issue #91's approval controller isolated from the legacy admin bundle.
    // Dynamic scripts are async by default; explicitly disable async so this
    // bootstrap has deterministic ordering relative to any future dynamically
    // loaded admin controllers. The approval controller itself no longer relies
    // on a document-wide MutationObserver for correctness.
    if (!document.querySelector('script[data-scouts-approval-workflow]')) {
        const script = document.createElement('script');
        script.src = 'admin-approval-workflow.js';
        script.async = false;
        script.dataset.scoutsApprovalWorkflow = 'true';
        script.addEventListener('load', () => {
            window.scoutsApprovalWorkflowReady = true;
            window.refreshApprovalButtonLabels?.();
        }, { once: true });
        script.addEventListener('error', () => {
            window.scoutsApprovalWorkflowReady = false;
            console.error('[ApprovalWorkflow] Failed to load admin-approval-workflow.js');
            if (typeof showAdminNotification === 'function') {
                showAdminNotification('Approval controls failed to load. Reload the Admin page before approving events.', 'error', 10000);
            }
        }, { once: true });
        document.body.appendChild(script);
    }
})();
