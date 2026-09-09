// Agenda reconciliation controller.
//
// Keep three concerns deliberately separate:
// 1. admin-script.js status polling reads agenda/runtime state frequently;
// 2. this controller performs a real calendar + agenda reconciliation at a
//    much slower cadence (or when the user explicitly clicks Refresh now);
// 3. enrichment remains asynchronous and is throttled/idempotent in the backend.

(function () {
    const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 300;
    const MIN_RECONCILIATION_INTERVAL_SECONDS = 60;
    const LEGACY_FAST_INTERVAL_CUTOFF_SECONDS = 60;
    const INITIAL_REFRESH_RETRY_MS = 5000;
    const MAX_INITIAL_REFRESH_AUTH_CHECKS = 12;

    let agendaRefreshExecutionInFlight = false;
    let initialRefreshAuthChecks = 0;

    function reconciliationPayload() {
        return {
            realm: 'scouts',
            subject: 'calendars',
            action: 'refreshAllCalendars',
            calendar: 'all',
        };
    }

    function formatRefreshTime(value) {
        const date = value ? new Date(value) : new Date();
        if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString('en-GB');
        return date.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function formatChangeValue(value) {
        if (value === undefined || value === null || value === '') return 'missing';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }
        return String(value);
    }

    function normalizedStatus(value) {
        return value && typeof value === 'object' ? value : {};
    }

    function describeModifiedEventChanges(entry) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        const statusChange = changes.find((change) => change?.field === 'status');
        const descriptions = [];

        if (statusChange) {
            const before = normalizedStatus(statusChange.before);
            const after = normalizedStatus(statusChange.after);
            if (Boolean(before.isHidden) !== Boolean(after.isHidden)) {
                descriptions.push(`visibility: ${before.isHidden ? 'hidden' : 'visible'} → ${after.isHidden ? 'hidden' : 'visible'}`);
            }
            if (Boolean(before.isApproved) !== Boolean(after.isApproved)) {
                descriptions.push(`approval: ${before.isApproved ? 'approved' : 'pending'} → ${after.isApproved ? 'approved' : 'pending'}`);
            }
            if (descriptions.length === 0) {
                descriptions.push(`status: ${formatChangeValue(statusChange.before)} → ${formatChangeValue(statusChange.after)}`);
            }
        }

        for (const change of changes) {
            if (!change || change === statusChange || change.field === 'hiddenAt') continue;
            descriptions.push(`${change.field || 'field'}: ${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`);
        }

        if (descriptions.length === 0) {
            for (const change of changes) {
                if (!change) continue;
                descriptions.push(`${change.field || 'field'}: ${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`);
            }
        }
        return descriptions;
    }

    function eventNeedsEnrichment(event) {
        if (!event || typeof event !== 'object') return false;
        if (typeof isHiddenEvent === 'function' && isHiddenEvent(event)) return false;
        const tagline = typeof getAIPrompt === 'function' ? getAIPrompt(event) : null;
        const imageTheme = typeof getImageTheme === 'function' ? getImageTheme(event) : null;
        const imageUrl = typeof getImageUrl === 'function' ? getImageUrl(event) : null;
        return !hasText(tagline) || !hasText(imageTheme) || !hasText(imageUrl);
    }

    function currentAgendaCompletionCounts() {
        const entries = Array.isArray(uniqueEventEntries) ? uniqueEventEntries : [];
        const eligible = entries.filter((entry) => !(typeof isEntryHidden === 'function' && isEntryHidden(entry)));
        const incomplete = eligible.filter((entry) => eventNeedsEnrichment(entry?.event)).length;
        return {
            complete: Math.max(0, eligible.length - incomplete),
            incomplete,
        };
    }

    function ensureRefreshSummary() {
        let section = document.getElementById('agenda-refresh-summary');
        if (section) return section;

        const layout = document.querySelector('.events-layout');
        if (!layout) return null;

        section = document.createElement('section');
        section.id = 'agenda-refresh-summary';
        section.className = 'admin-primary-summary';
        section.hidden = true;

        const card = document.createElement('div');
        card.className = 'admin-activity-card';
        card.style.gridColumn = '1 / -1';

        const heading = document.createElement('div');
        heading.className = 'admin-activity-heading';
        const label = document.createElement('span');
        label.className = 'admin-summary-label';
        label.textContent = 'Agenda';
        const title = document.createElement('strong');
        title.id = 'agenda-refresh-summary-title';
        title.textContent = 'Agenda refresh';
        heading.append(label, title);

        const metrics = document.createElement('ul');
        metrics.id = 'agenda-refresh-summary-metrics';
        metrics.className = 'refresh-status';

        const details = document.createElement('details');
        details.id = 'agenda-refresh-modified-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Updated during refresh';
        const body = document.createElement('div');
        body.id = 'agenda-refresh-modified-list';
        details.append(summary, body);

        card.append(heading, metrics, details);
        section.appendChild(card);
        layout.insertAdjacentElement('beforebegin', section);
        return section;
    }

    function appendMetric(list, text) {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
    }

    function renderRefreshResult(result) {
        const section = ensureRefreshSummary();
        if (!section) return;

        const title = document.getElementById('agenda-refresh-summary-title');
        const metrics = document.getElementById('agenda-refresh-summary-metrics');
        const details = document.getElementById('agenda-refresh-modified-details');
        const modifiedList = document.getElementById('agenda-refresh-modified-list');
        if (!title || !metrics || !details || !modifiedList) return;

        const modifiedEvents = Array.isArray(result?.modifiedEvents) ? result.modifiedEvents : [];
        const modifiedCount = Number.isFinite(Number(result?.modifiedEventsCount))
            ? Number(result.modifiedEventsCount)
            : modifiedEvents.length;
        const started = Number.isFinite(Number(result?.enrichmentRequestsStarted))
            ? Number(result.enrichmentRequestsStarted)
            : null;
        const completion = currentAgendaCompletionCounts();

        title.textContent = `Agenda refreshed · ${formatRefreshTime(result?.generatedAt)}`;
        metrics.replaceChildren();
        appendMetric(metrics, `${modifiedCount} event${modifiedCount === 1 ? '' : 's'} updated`);
        appendMetric(metrics, started === null
            ? 'Enrichment jobs started: unavailable'
            : `${started} enrichment job${started === 1 ? '' : 's'} started`);
        appendMetric(metrics, `${completion.complete} events already complete`);
        appendMetric(metrics, `${completion.incomplete} events still require enrichment`);

        modifiedList.replaceChildren();
        if (modifiedEvents.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = 'No event metadata changed during this refresh.';
            modifiedList.appendChild(empty);
            details.open = false;
        } else {
            const list = document.createElement('ul');
            for (const entry of modifiedEvents) {
                const item = document.createElement('li');
                const eventTitle = document.createElement('strong');
                eventTitle.textContent = entry?.title || entry?.hex || entry?.uid || entry?.key || 'Unknown event';
                item.appendChild(eventTitle);

                const changes = describeModifiedEventChanges(entry);
                if (changes.length > 0) {
                    const changesList = document.createElement('ul');
                    for (const change of changes) {
                        const changeItem = document.createElement('li');
                        changeItem.textContent = change;
                        changesList.appendChild(changeItem);
                    }
                    item.appendChild(changesList);
                }
                list.appendChild(item);
            }
            modifiedList.appendChild(list);
            details.open = modifiedEvents.length <= 5;
        }

        section.hidden = false;
    }

    async function performAgendaReconciliation({ automatic = false } = {}) {
        const statusElement = document.getElementById('refresh-status');
        if (!apiAuthReady) {
            if (!automatic && statusElement) {
                statusElement.textContent = 'Admin API auth not ready';
                statusElement.className = 'refresh-status error';
            }
            return null;
        }
        if (agendaRefreshExecutionInFlight || autoLambdaInvokeInFlight || uiCommandInFlight) {
            if (!automatic && statusElement) {
                statusElement.textContent = 'Agenda refresh already in progress.';
                statusElement.className = 'refresh-status loading';
            }
            return null;
        }

        agendaRefreshExecutionInFlight = true;
        autoLambdaInvokeInFlight = automatic;
        uiCommandInFlight = true;
        refreshApiActionButtons();
        if (statusElement) {
            statusElement.textContent = automatic ? 'Automatic agenda refresh in progress…' : 'Refreshing agenda…';
            statusElement.className = 'refresh-status loading';
        }

        try {
            const result = await sendScoutsCommand(reconciliationPayload());
            updateRuntimePanelsFromResult(result);
            await loadEvents({
                silent: true,
                notifyOnAgendaChanges: true,
                onlyIfChanged: false,
                notificationSource: automatic ? 'Automatic agenda refresh' : 'Agenda refresh',
            });
            await pollQueueDepthSnapshots();
            renderRefreshResult(result);

            const modifiedEvents = Array.isArray(result?.modifiedEvents) ? result.modifiedEvents : [];
            const modifiedCount = Number.isFinite(Number(result?.modifiedEventsCount))
                ? Number(result.modifiedEventsCount)
                : modifiedEvents.length;
            const started = Number.isFinite(Number(result?.enrichmentRequestsStarted))
                ? Number(result.enrichmentRequestsStarted)
                : null;
            const startedText = started === null ? 'enrichment start count unavailable' : `${started} enrichment job${started === 1 ? '' : 's'} started`;
            if (statusElement) {
                statusElement.textContent = `Agenda refreshed · ${formatRefreshTime(result?.generatedAt)} · ${modifiedCount} updated · ${startedText}`;
                statusElement.className = 'refresh-status success';
            }
            return result;
        } catch (error) {
            console.error('[Admin] Agenda reconciliation failed:', error);
            if (statusElement) {
                statusElement.textContent = `Agenda refresh failed: ${error?.message || error}`;
                statusElement.className = 'refresh-status error';
            }
            return null;
        } finally {
            agendaRefreshExecutionInFlight = false;
            autoLambdaInvokeInFlight = false;
            uiCommandInFlight = false;
            refreshApiActionButtons();
        }
    }

    // Replace the legacy count-based manual request. The argument is accepted
    // for backwards-compatible inline onclick calls, but it no longer controls
    // enrichment volume.
    refreshLambda = async function () {
        return performAgendaReconciliation({ automatic: false });
    };

    // Re-purpose the old heartbeat timer as a real, slow reconciliation timer.
    // Status polling remains separate in runStatusPollingJob().
    invokeLambdaHeartbeat = async function () {
        if (!autoLambdaInvokeEnabled) return null;
        return performAgendaReconciliation({ automatic: true });
    };

    function configureRefreshControls() {
        const countControl = document.getElementById('refresh-action');
        if (countControl) countControl.remove();

        const refreshButton = document.getElementById('refresh-button');
        if (refreshButton) {
            refreshButton.textContent = 'Refresh now';
            refreshButton.title = 'Refresh calendar feeds and reconcile the agenda now. Backend policy controls enrichment throttling and retries.';
            refreshButton.removeAttribute('value');
        }

        const autoLabel = document.querySelector('label[for="auto-lambda-toggle"]');
        if (autoLabel) {
            const checkbox = document.getElementById('auto-lambda-toggle');
            autoLabel.childNodes.forEach((node) => {
                if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) node.textContent = '\n                Auto refresh\n            ';
            });
            if (checkbox) checkbox.title = 'Automatically reconcile the agenda while this authenticated admin page remains open.';
        }

        const intervalInput = document.getElementById('auto-lambda-interval-seconds');
        if (intervalInput) {
            intervalInput.min = String(MIN_RECONCILIATION_INTERVAL_SECONDS);
            intervalInput.title = 'Automatic agenda reconciliation interval in seconds (status polling is separate).';
        }

        // Existing browsers may have persisted the old 20-second heartbeat.
        // Migrate only legacy fast values; preserve deliberate slower choices.
        const currentSeconds = Math.max(0, Math.round(Number(autoLambdaInvokeIntervalMs) / 1000));
        if (!Number.isFinite(currentSeconds) || currentSeconds < LEGACY_FAST_INTERVAL_CUTOFF_SECONDS) {
            updateAutoLambdaInvocationInterval(DEFAULT_RECONCILIATION_INTERVAL_SECONDS, true);
        } else {
            updateAutoLambdaInvocationInterval(Math.max(MIN_RECONCILIATION_INTERVAL_SECONDS, currentSeconds), false);
        }
    }

    function attemptInitialAutomaticRefresh() {
        if (!autoLambdaInvokeEnabled) return;
        if (apiAuthReady) {
            void invokeLambdaHeartbeat();
            return;
        }
        initialRefreshAuthChecks += 1;
        if (initialRefreshAuthChecks < MAX_INITIAL_REFRESH_AUTH_CHECKS) {
            setTimeout(attemptInitialAutomaticRefresh, INITIAL_REFRESH_RETRY_MS);
        }
    }

    // Remove the raw numeric control immediately, before admin-simplify's
    // DOMContentLoaded handler has a chance to convert it into AI off/1/5/10.
    document.getElementById('refresh-action')?.remove();

    document.addEventListener('DOMContentLoaded', () => {
        configureRefreshControls();
        ensureRefreshSummary();
        setTimeout(attemptInitialAutomaticRefresh, INITIAL_REFRESH_RETRY_MS);
    });
})();
