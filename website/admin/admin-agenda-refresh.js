// Agenda reconciliation controller.
//
// Keep three concerns deliberately separate:
// 1. admin-script.js status polling reads agenda/runtime state frequently;
// 2. this controller performs a real calendar + agenda reconciliation at a
//    much slower cadence (or when the user explicitly clicks Refresh now);
// 3. enrichment remains asynchronous and is throttled/idempotent in the backend.
//
// This is intentionally separate from the historical browser "Auto Lambda"
// heartbeat. That legacy timer remains retired by admin-diagnostics-enhancements;
// automatic agenda reconciliation has its own preference and timer.

(function () {
    const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 300;
    const MIN_RECONCILIATION_INTERVAL_SECONDS = 60;
    const INITIAL_REFRESH_RETRY_MS = 5000;
    const MAX_INITIAL_REFRESH_AUTH_CHECKS = 12;
    const AUTO_REFRESH_ENABLED_STORAGE_KEY = 'scoutsAdminAgendaAutoRefreshEnabledV1';
    const AUTO_REFRESH_INTERVAL_STORAGE_KEY = 'scoutsAdminAgendaAutoRefreshIntervalSecondsV1';

    // Metadata completeness is deliberately separate from workflow state.
    // Approval and visibility each have their own admin filters; an otherwise
    // enriched event must not appear under "Missing Metadata" just because it
    // is awaiting approval or is hidden.
    window.getMissingMetadataFields = function (event) {
        const missing = [];
        if (!hasText(getAIPrompt(event))) {
            missing.push('Tagline');
        }
        if (!hasText(getImageThemeOrLegacyPrompt(event))) {
            missing.push('Image Theme');
        }
        if (!hasRelativeImageUrl(event)) {
            missing.push('Image URL');
        }
        return missing;
    };

    let agendaRefreshExecutionInFlight = false;
    let agendaAutoRefreshEnabled = true;
    let agendaAutoRefreshIntervalSeconds = DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
    let agendaAutoRefreshTimer = null;
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

    function optionalFiniteNumber(value) {
        if (value === undefined || value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function readStoredBoolean(key, fallback) {
        try {
            const stored = window.localStorage.getItem(key);
            if (stored === null) return fallback;
            return stored === 'true';
        } catch {
            return fallback;
        }
    }

    function readStoredInterval() {
        try {
            const stored = Number(window.localStorage.getItem(AUTO_REFRESH_INTERVAL_STORAGE_KEY));
            if (Number.isFinite(stored) && stored >= MIN_RECONCILIATION_INTERVAL_SECONDS) {
                return Math.round(stored);
            }
        } catch {
            // Local storage is optional; defaults remain safe.
        }
        return DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
    }

    function storePreference(key, value) {
        try {
            window.localStorage.setItem(key, String(value));
        } catch {
            // The feature still works for the current page when storage is unavailable.
        }
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
        const modifiedCount = optionalFiniteNumber(result?.modifiedEventsCount) ?? modifiedEvents.length;
        const started = optionalFiniteNumber(result?.enrichmentRequestsStarted);
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

    function updateAutoRefreshUi() {
        const toggle = document.getElementById('agenda-auto-refresh-toggle');
        if (toggle) toggle.checked = agendaAutoRefreshEnabled;
        const interval = document.getElementById('agenda-auto-refresh-interval-seconds');
        if (interval) interval.value = String(agendaAutoRefreshIntervalSeconds);
        const status = document.getElementById('agenda-auto-refresh-status');
        if (status) {
            status.textContent = agendaAutoRefreshEnabled
                ? `Auto refresh: every ${agendaAutoRefreshIntervalSeconds}s`
                : 'Auto refresh: off';
        }
    }

    function stopAutoRefreshTimer() {
        if (agendaAutoRefreshTimer !== null) {
            clearInterval(agendaAutoRefreshTimer);
            agendaAutoRefreshTimer = null;
        }
    }

    function startAutoRefreshTimer() {
        stopAutoRefreshTimer();
        if (!agendaAutoRefreshEnabled) return;
        agendaAutoRefreshTimer = setInterval(() => {
            void performAgendaReconciliation({ automatic: true });
        }, agendaAutoRefreshIntervalSeconds * 1000);
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
        if (agendaRefreshExecutionInFlight || uiCommandInFlight) {
            if (!automatic && statusElement) {
                statusElement.textContent = 'Agenda refresh already in progress.';
                statusElement.className = 'refresh-status loading';
            }
            return null;
        }

        agendaRefreshExecutionInFlight = true;
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
            const modifiedCount = optionalFiniteNumber(result?.modifiedEventsCount) ?? modifiedEvents.length;
            const started = optionalFiniteNumber(result?.enrichmentRequestsStarted);
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

    window.toggleAgendaAutoRefresh = function (enabled) {
        agendaAutoRefreshEnabled = Boolean(enabled);
        storePreference(AUTO_REFRESH_ENABLED_STORAGE_KEY, agendaAutoRefreshEnabled);
        updateAutoRefreshUi();
        startAutoRefreshTimer();
        if (agendaAutoRefreshEnabled && apiAuthReady) {
            void performAgendaReconciliation({ automatic: true });
        }
    };

    window.updateAgendaAutoRefreshInterval = function (value) {
        const parsed = Number(value);
        agendaAutoRefreshIntervalSeconds = Number.isFinite(parsed)
            ? Math.max(MIN_RECONCILIATION_INTERVAL_SECONDS, Math.round(parsed))
            : DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
        storePreference(AUTO_REFRESH_INTERVAL_STORAGE_KEY, agendaAutoRefreshIntervalSeconds);
        updateAutoRefreshUi();
        startAutoRefreshTimer();
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

        agendaAutoRefreshEnabled = readStoredBoolean(AUTO_REFRESH_ENABLED_STORAGE_KEY, true);
        agendaAutoRefreshIntervalSeconds = readStoredInterval();
        updateAutoRefreshUi();
        startAutoRefreshTimer();
    }

    function attemptInitialAutomaticRefresh() {
        if (!agendaAutoRefreshEnabled) return;
        if (apiAuthReady) {
            void performAgendaReconciliation({ automatic: true });
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
