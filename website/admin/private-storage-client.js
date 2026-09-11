// Keep operational S3 objects private while preserving the legacy admin UI API.
// This script loads after admin-script.js and replaces the direct S3 readers
// with authenticated calls through /admin-api/scouts.
(function () {
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
            const result = await sendScoutsCommand({
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
            const result = await sendScoutsCommand({
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

    // Keep issue #91's approval controller isolated from the legacy admin bundle.
    // Loading it here avoids changing the large static index while guaranteeing it
    // runs after admin-script.js has established the existing UI helpers/state.
    if (!document.querySelector('script[data-scouts-approval-workflow]')) {
        const script = document.createElement('script');
        script.src = 'admin-approval-workflow.js';
        script.defer = true;
        script.dataset.scoutsApprovalWorkflow = 'true';
        document.body.appendChild(script);
    }
})();
