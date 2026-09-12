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

    function approvalWorkflow(event) {
        return event?.approvalWorkflow && typeof event.approvalWorkflow === 'object'
            ? event.approvalWorkflow
            : null;
    }

    function isGeneratedImageReview(event) {
        const workflow = approvalWorkflow(event);
        const review = eventReviewValues(event, null);
        return workflow?.state === 'awaiting_review'
            && workflow?.source === 'generated_image'
            && Boolean(review.imageUrl);
    }

    function fieldChecklist(snapshot, generatedReview = false) {
        const imageLabel = generatedReview
            ? 'generated image ✓'
            : (snapshot.imageUrl ? 'image ✓' : 'image missing — final review required');
        return [
            `tagline ${snapshot.tagline ? '✓' : '—'}`,
            `image theme ${snapshot.imageTheme ? '✓' : '—'}`,
            imageLabel,
            `visibility ${snapshot.isHidden ? 'hidden' : 'visible'}`,
        ].join(' · ');
    }

    function eventForApprovalButton(button) {
        if (button?.id === 'modal-approve-button') {
            return eventFromEntry(selectedEntry(typeof currentEventIndex === 'number' ? currentEventIndex : 0, true));
        }
        const onclick = button?.getAttribute?.('onclick') || '';
        const match = onclick.match(/approveEvent\((\d+)/);
        if (!match) return null;
        return eventFromEntry(selectedEntry(Number(match[1]), false));
    }

    function relabelApprovalButtons(root = document) {
        root.querySelectorAll('button[value="approve"]').forEach((button) => {
            const generatedReview = isGeneratedImageReview(eventForApprovalButton(button));
            button.textContent = generatedReview ? 'Approve generated image' : 'Approve shown changes';
            button.title = generatedReview
                ? 'Approve the generated image and complete this event workflow.'
                : 'Approve the tagline, image theme, image and visibility currently shown for this event.';
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

        const generatedReview = isGeneratedImageReview(event);
        const workflow = approvalWorkflow(event);
        uiCommandInFlight = true;
        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();
        try {
            const reviewSnapshot = await buildReviewSnapshot(event, hex);
            const checklist = fieldChecklist(reviewSnapshot, generatedReview);
            const approvalLabel = generatedReview ? 'generated image' : 'shown changes';
            if (fromModal && typeof updateModalStatus === 'function') {
                updateModalStatus(`Approving ${approvalLabel}: ${checklist}`, 'info');
            }
            updateRuntimeDetails(`Approving ${approvalLabel} for "${reviewSnapshot.title || hex}": ${checklist}`, 'info');

            const result = await sendScoutsCommand({
                realm: 'scouts',
                subject: { hex: reviewSnapshot.hex },
                action: 'approve',
                reviewSnapshot,
                ...(generatedReview && workflow?.rootRequestId ? { rootRequestId: workflow.rootRequestId } : {}),
            });
            const rootRequestId = result?.rootRequestId || extractBackendRequestId(result);
            if (rootRequestId) updateRuntimeRequestId(rootRequestId, 'Approval operation ID');

            if (result?.requiresGeneratedImage) {
                const message = 'Generating image — final review required.';
                updateRuntimeDetails(message, 'info');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'info');
            } else {
                if (typeof applyLocalApprovalState === 'function') applyLocalApprovalState(event, true);
                const message = result?.message || (generatedReview ? 'Generated image approval submitted.' : 'Approve shown changes submitted.');
                updateRuntimeDetails(message, 'success');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'success');
            }

            if (typeof pollQueueDepthSnapshots === 'function') {
                await pollQueueDepthSnapshots({ updatePanels: true }).catch(() => {});
            }
            // Generated-image workflows deliberately remain active while waiting for
            // a human final review. The Activity Centre owns that long-lived phase
            // and refreshes agenda/modal state when awaiting_review is reached.
            if (rootRequestId && !result?.requiresGeneratedImage && typeof pollGeneratedRequestUntilSettled === 'function') {
                pollGeneratedRequestUntilSettled(rootRequestId, {
                    hex: reviewSnapshot.hex,
                    config: {
                        label: generatedReview ? 'Generated image approval' : 'Approval',
                        queueLabel: generatedReview ? 'generated image approval' : 'approval',
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