// Issue #91: event-level, snapshot-based approval.
//
// This controller deliberately loads after admin-script.js and replaces only the
// approval action. The legacy handler remains available during deployment
// rollback, while all normal approval clicks use the revisioned backend contract.
(function () {
    function optionalText(value) {
        if (value === undefined || value === null) return null;
        const result = String(value).trim();
        return result || null;
    }

    function eventReviewValues(event, hex) {
        const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        const image = metadata.image && typeof metadata.image === 'object'
            ? metadata.image
            : (event?.image && typeof event.image === 'object' ? event.image : {});
        const status = metadata.status && typeof metadata.status === 'object'
            ? metadata.status
            : (event?.status && typeof event.status === 'object' ? event.status : {});
        return {
            hex: String(hex || metadata.hex || event?.hex || '').trim().toLowerCase(),
            tagline: optionalText(metadata.tagline ?? event?.tagline ?? event?.AI ?? event?.ai),
            imageTheme: optionalText(image.theme ?? event?.imageTheme),
            imageUrl: optionalText(image.url ?? image.src ?? event?.imageUrl),
            isHidden: status.isHidden === true || event?.isHidden === true || event?.status === 'hidden',
            title: optionalText(event?.title ?? event?.summary ?? event?.name),
            uid: optionalText(event?.uid ?? event?.originalUid ?? metadata.uid),
        };
    }

    async function sha256Prefix(value) {
        if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
            throw new Error('This browser cannot create the approval revision token.');
        }
        const encoded = new TextEncoder().encode(value);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
        return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 24);
    }

    async function buildReviewSnapshot(event, hex) {
        const snapshot = eventReviewValues(event, hex);
        const reviewable = {
            hex: snapshot.hex,
            tagline: snapshot.tagline,
            imageTheme: snapshot.imageTheme,
            imageUrl: snapshot.imageUrl,
            isHidden: snapshot.isHidden,
        };
        return {
            ...snapshot,
            revision: await sha256Prefix(JSON.stringify(reviewable)),
        };
    }

    function selectedEntry(eventIndex, fromModal) {
        if (fromModal && typeof getSelectedModalEntry === 'function') {
            const selected = getSelectedModalEntry();
            if (selected) return selected;
        }
        return visibleEventEntries?.[eventIndex]
            ?? uniqueEventEntries?.[eventIndex]
            ?? (eventsData?.[eventIndex] ? { event: eventsData[eventIndex] } : null);
    }

    function eventFromEntry(entry) {
        return entry?.event && typeof entry.event === 'object' ? entry.event : entry;
    }

    function fieldChecklist(snapshot) {
        const imageLabel = snapshot.imageUrl ? 'image ✓' : 'image missing — final review required';
        return [
            `tagline ${snapshot.tagline ? '✓' : '—'}`,
            `image theme ${snapshot.imageTheme ? '✓' : '—'}`,
            imageLabel,
            `visibility ${snapshot.isHidden ? 'hidden' : 'visible'}`,
        ].join(' · ');
    }

    function relabelApprovalButtons(root = document) {
        root.querySelectorAll('button[value="approve"]').forEach((button) => {
            button.textContent = 'Approve shown changes';
            button.title = 'Approve the tagline, image theme, image and visibility currently shown for this event.';
        });
    }

    const legacyApproveEvent = typeof approveEvent === 'function' ? approveEvent : null;

    window.approveEvent = async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve') {
        if (String(action || '').toLowerCase() !== 'approve') {
            return legacyApproveEvent?.(eventIndex, fromModal, action);
        }
        if (!apiAuthReady) {
            updateApiAuthStatus(
                'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
                'error',
            );
            return null;
        }
        if (uiCommandInFlight) return null;

        const entry = selectedEntry(eventIndex, fromModal);
        const event = eventFromEntry(entry);
        if (!event) {
            updateRuntimeDetails('Cannot approve: event data is unavailable.', 'error');
            return null;
        }
        if (typeof isEntryApproved === 'function' && isEntryApproved(entry)) {
            updateRuntimeDetails('This event is already approved.', 'success');
            return null;
        }

        const hex = typeof getEventHex === 'function' ? getEventHex(event) : null;
        if (!hex) {
            updateRuntimeDetails('Cannot approve: event has no canonical HEX.', 'error');
            return null;
        }

        uiCommandInFlight = true;
        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();
        try {
            const reviewSnapshot = await buildReviewSnapshot(event, hex);
            const checklist = fieldChecklist(reviewSnapshot);
            if (fromModal && typeof updateModalStatus === 'function') {
                updateModalStatus(`Approving shown changes: ${checklist}`, 'info');
            }
            updateRuntimeDetails(`Approving shown changes for "${reviewSnapshot.title || hex}": ${checklist}`, 'info');

            const result = await sendScoutsCommand({
                realm: 'scouts',
                subject: { hex: reviewSnapshot.hex },
                action: 'approve',
                reviewSnapshot,
            });
            const rootRequestId = result?.rootRequestId || extractBackendRequestId(result);
            if (rootRequestId) updateRuntimeRequestId(rootRequestId, 'Approval operation ID');

            if (result?.requiresGeneratedImage) {
                const message = 'Generating image — final review required.';
                updateRuntimeDetails(message, 'info');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'info');
            } else {
                if (typeof applyLocalApprovalState === 'function') applyLocalApprovalState(event, true);
                const message = 'Approve shown changes submitted.';
                updateRuntimeDetails(message, 'success');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'success');
            }

            if (typeof pollQueueDepthSnapshots === 'function') {
                await pollQueueDepthSnapshots({ updatePanels: true }).catch(() => {});
            }
            if (rootRequestId && typeof pollGeneratedRequestUntilSettled === 'function') {
                pollGeneratedRequestUntilSettled(rootRequestId, {
                    hex: reviewSnapshot.hex,
                    config: {
                        label: result?.requiresGeneratedImage ? 'Approval workflow' : 'Approval',
                        queueLabel: result?.requiresGeneratedImage ? 'image generation' : 'approval',
                    },
                    eventLabel: reviewSnapshot.title || reviewSnapshot.hex,
                }).catch(() => {});
            }
            return result;
        } catch (error) {
            const message = String(error?.message || error || 'Approval failed');
            if (message.includes('HTTP 409') || message.includes('STALE_REVIEW')) {
                const staleMessage = 'This event changed after it was displayed. Reloading the current review; no stale values were approved.';
                updateRuntimeDetails(staleMessage, 'error');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(staleMessage, 'error');
                if (typeof loadEvents === 'function') await loadEvents().catch(() => {});
                if (fromModal && typeof updateModalContent === 'function') updateModalContent();
                return null;
            }
            updateRuntimeDetails(`Approval failed: ${message}`, 'error');
            if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(`Approval failed: ${message}`, 'error');
            throw error;
        } finally {
            uiCommandInFlight = false;
            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();
            relabelApprovalButtons();
        }
    };

    relabelApprovalButtons();
    if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(() => relabelApprovalButtons());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
