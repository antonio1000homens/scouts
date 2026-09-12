// Issue #91: event-level, snapshot-based approval.
//
// This controller deliberately loads after admin-script.js and replaces only the
// approval action. The legacy handler remains available during deployment
// rollback, while all normal approval clicks use the revisioned backend contract.
(function () {
    const REVIEW_REQUEST_TIMEOUT_MS = 15000;

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

    function approvalReadiness(event) {
        return {
            tagline: typeof getAIPrompt === 'function' && hasText(getAIPrompt(event)),
            imageTheme: typeof getImageThemeOrLegacyPrompt === 'function' && hasText(getImageThemeOrLegacyPrompt(event)),
            imageUrl: typeof hasRelativeImageUrl === 'function' && hasRelativeImageUrl(event),
        };
    }

    function isEventReadyForApproval(event) {
        if (!event || typeof event !== 'object') return false;
        const readiness = approvalReadiness(event);
        return readiness.tagline && readiness.imageTheme && readiness.imageUrl;
    }
    window.isEventReadyForApproval = isEventReadyForApproval;

    function missingApprovalMetadata(event) {
        const readiness = approvalReadiness(event);
        const missing = [];
        if (!readiness.tagline) missing.push('Tagline');
        if (!readiness.imageTheme) missing.push('Image Theme');
        if (!readiness.imageUrl) missing.push('Image URL');
        return missing;
    }

    function isEntryReadyForApproval(entry) {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof isEntryHidden === 'function' && isEntryHidden(entry)) return false;
        if (typeof isEntryApproved === 'function' && isEntryApproved(entry)) return false;
        const event = entry?.event && typeof entry.event === 'object' ? entry.event : entry;
        const hex = typeof getEventHex === 'function' ? getEventHex(event) : event?.hex;
        return hasText(hex) && isEventReadyForApproval(event);
    }

    // "Need Approval" is a workflow state only after enrichment has completed.
    // Incomplete events remain under Missing Metadata and must not expose any
    // approval affordance.
    window.isEntryPendingApproval = function enrichedEntryPendingApproval(entry) {
        return isEntryReadyForApproval(entry);
    };

    function sameReviewableValues(left, right) {
        if (!left || !right) return false;
        return String(left.hex || '').toLowerCase() === String(right.hex || '').toLowerCase()
            && optionalText(left.tagline) === optionalText(right.tagline)
            && optionalText(left.imageTheme) === optionalText(right.imageTheme)
            && optionalText(left.imageUrl) === optionalText(right.imageUrl)
            && Boolean(left.isHidden) === Boolean(right.isHidden);
    }

    async function withReadTimeout(promise, timeoutMs, message) {
        let timer = null;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function fetchServerReview(hex) {
        const sendRead = typeof window.sendScoutsReadCommand === 'function'
            ? window.sendScoutsReadCommand
            : sendScoutsCommand;
        const result = await withReadTimeout(
            sendRead({
                realm: 'runtime',
                subject: 'event',
                action: 'review',
                hex,
            }),
            REVIEW_REQUEST_TIMEOUT_MS,
            'REVIEW_TIMEOUT: canonical review did not respond within 15 seconds',
        );
        if (!result?.review?.revision) {
            throw new Error('Server review snapshot is unavailable.');
        }
        return result;
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

    function isGeneratedServerReview(workflow, review) {
        return workflow?.state === 'awaiting_review'
            && workflow?.source === 'generated_image'
            && Boolean(review?.imageUrl);
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

    function entryForApprovalButton(button) {
        if (button?.id === 'modal-approve-button') {
            return selectedEntry(typeof currentEventIndex === 'number' ? currentEventIndex : 0, true);
        }
        const onclick = button?.getAttribute?.('onclick') || '';
        const match = onclick.match(/approveEvent\((\d+)/);
        if (!match) return null;
        return selectedEntry(Number(match[1]), false);
    }

    function eventForApprovalButton(button) {
        return eventFromEntry(entryForApprovalButton(button));
    }

    function syncApprovalBadges(root = document) {
        root.querySelectorAll('#events-container .event-card[data-event-card-index]').forEach((card) => {
            const index = Number(card.dataset.eventCardIndex);
            const entry = Number.isInteger(index) ? selectedEntry(index, false) : null;
            const showApproval = isEntryReadyForApproval(entry);
            card.querySelectorAll('.event-badge.approval').forEach((badge) => {
                if (badge.hidden === showApproval) badge.hidden = !showApproval;
            });
        });
    }

    function relabelApprovalButtons(root = document) {
        root.querySelectorAll('button[value="approve"]').forEach((button) => {
            const entry = entryForApprovalButton(button);
            const event = eventFromEntry(entry);
            const showApproval = isEntryReadyForApproval(entry);
            if (button.hidden === showApproval) button.hidden = !showApproval;
            if (!showApproval) return;

            const generatedReview = isGeneratedImageReview(event);
            const label = generatedReview ? 'Approve generated image' : 'Approve shown changes';
            const title = generatedReview
                ? 'Approve the generated image and complete this event workflow.'
                : 'Approve the tagline, image theme, image and visibility currently shown for this event.';
            if (button.textContent !== label) button.textContent = label;
            if (button.title !== title) button.title = title;
        });
        syncApprovalBadges(root);
    }

    function relabelAfterRender(original) {
        if (typeof original !== 'function') return original;
        return function approvalAwareRender(...args) {
            const result = original.apply(this, args);
            relabelApprovalButtons();
            return result;
        };
    }

    function refreshApprovedPresentation(entry, fromModal = false) {
        const approvedHex = typeof getEventHex === 'function'
            ? String(getEventHex(entry?.event) || '').trim().toLowerCase()
            : '';

        if (typeof updateEventsCount === 'function') {
            updateEventsCount(
                uniqueEventEntries.length,
                eventsData.length,
                uniqueEventEntries.filter((candidate) => isEntryHidden(candidate)).length,
                uniqueEventEntries.filter((candidate) => isEntryComplete(candidate)).length,
            );
        }
        if (typeof updateSidebarUi === 'function') updateSidebarUi();
        if (typeof renderEvents === 'function') renderEvents();

        if (!fromModal) return;
        const refreshedIndex = approvedHex && Array.isArray(visibleEventEntries)
            ? visibleEventEntries.findIndex((candidate) => {
                return String(getEventHex(candidate?.event) || '').trim().toLowerCase() === approvedHex;
            })
            : -1;
        if (refreshedIndex >= 0 && typeof updateModalContent === 'function') {
            currentEventIndex = refreshedIndex;
            updateModalContent(refreshedIndex);
            return;
        }
        if (typeof closeUploadModal === 'function') closeUploadModal();
    }

    // Approval copy and visibility are derived from application state at the points
    // where the event grid/modal are rendered. Do not observe the entire document:
    // broad MutationObservers can turn presentation writes into self-sustaining
    // microtask loops and starve clicks/timers on the main thread.
    if (typeof window.renderEvents === 'function') window.renderEvents = relabelAfterRender(window.renderEvents);
    if (typeof window.openUploadModal === 'function') window.openUploadModal = relabelAfterRender(window.openUploadModal);
    if (typeof window.updateModalContent === 'function') window.updateModalContent = relabelAfterRender(window.updateModalContent);
    window.refreshApprovalButtonLabels = relabelApprovalButtons;

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
        if (!isEventReadyForApproval(event)) {
            const missing = missingApprovalMetadata(event);
            const message = `Cannot approve until enrichment completes. Missing: ${missing.join(', ') || 'metadata'}.`;
            updateRuntimeDetails(message, 'error');
            if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'error');
            relabelApprovalButtons();
            return null;
        }

        const hex = typeof getEventHex === 'function' ? getEventHex(event) : null;
        if (!hex) {
            updateRuntimeDetails('Cannot approve: event has no canonical HEX.', 'error');
            return null;
        }

        uiCommandInFlight = true;
        if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();
        let operationStage = 'canonical review';
        try {
            const displayedReview = eventReviewValues(event, hex);
            const reviewMessage = `Checking current review for "${displayedReview.title || hex}"…`;
            updateRuntimeDetails(reviewMessage, 'info');
            if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(reviewMessage, 'info');

            const serverResult = await fetchServerReview(hex);
            const reviewSnapshot = serverResult.review;
            if (!sameReviewableValues(displayedReview, reviewSnapshot)) {
                throw new Error('STALE_REVIEW: server review no longer matches the values displayed in Admin');
            }

            const workflow = serverResult.approvalWorkflow || approvalWorkflow(event);
            const generatedReview = isGeneratedServerReview(workflow, reviewSnapshot);
            const checklist = fieldChecklist(reviewSnapshot, generatedReview);
            const approvalLabel = generatedReview ? 'generated image' : 'shown changes';
            if (fromModal && typeof updateModalStatus === 'function') {
                updateModalStatus(`Approving ${approvalLabel}: ${checklist}`, 'info');
            }
            updateRuntimeDetails(`Approving ${approvalLabel} for "${reviewSnapshot.title || hex}": ${checklist}`, 'info');

            operationStage = 'approval submission';
            const result = await sendScoutsCommand({
                realm: 'scouts',
                subject: { hex: reviewSnapshot.hex },
                action: 'approve',
                reviewSnapshot,
                baseRevision: reviewSnapshot.revision,
                ...(generatedReview && workflow?.rootRequestId ? { rootRequestId: workflow.rootRequestId } : {}),
            });
            const rootRequestId = result?.rootRequestId || extractBackendRequestId(result);
            if (rootRequestId) updateRuntimeRequestId(rootRequestId, 'Approval operation ID');

            if (result?.requiresGeneratedImage) {
                const message = 'Generating image — final review required.';
                updateRuntimeDetails(message, 'info');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'info');
            } else {
                if (typeof applyLocalApprovalState === 'function') applyLocalApprovalState(entry, true);
                refreshApprovedPresentation(entry, fromModal);
                const message = result?.message || (generatedReview ? 'Generated image approval submitted.' : 'Approve shown changes submitted.');
                updateRuntimeDetails(message, 'success');
                if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(message, 'success');
            }

            // The mutation has already been accepted at this point. Activity is
            // presentation/telemetry and must never keep the approval button locked
            // while a secondary status request is slow or unavailable.
            if (typeof pollQueueDepthSnapshots === 'function') {
                void Promise.resolve(pollQueueDepthSnapshots({ updatePanels: true })).catch(() => {});
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
            const failureMessage = `Approval failed during ${operationStage}: ${message}`;
            updateRuntimeDetails(failureMessage, 'error');
            if (fromModal && typeof updateModalStatus === 'function') updateModalStatus(failureMessage, 'error');
            throw error;
        } finally {
            uiCommandInFlight = false;
            if (typeof refreshApiActionButtons === 'function') refreshApiActionButtons();
            relabelApprovalButtons();
        }
    };

    relabelApprovalButtons();
    window.scoutsApprovalWorkflowReady = true;
})();