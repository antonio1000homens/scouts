// Authoritative admin presentation for issues #34 and #43.
// The legacy controller remains responsible for event editing; this layer owns
// lifecycle/activity presentation and replaces snapshot-age inference with the
// lightweight runtime activity endpoint.

(function () {
    const PRIMARY_STATUS_LABELS = new Map([
        ['Queued', 'Waiting'],
        ['Queued Stalled', 'Waiting'],
        ['Processing Stall', 'Processing'],
        ['Completed Archive', 'Completed'],
    ]);
    const OBSERVER_OPTIONS = {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
    };
    const ACTIVE_STATES = new Set([
        'accepted', 'queued', 'processing', 'orchestrating', 'persisting',
        'waiting_for_tagline', 'waiting_for_image_theme', 'waiting_for_image',
        'waiting_for_retry',
    ]);
    const PROCESSING_STATES = new Set([
        'processing', 'orchestrating', 'persisting',
        'waiting_for_tagline', 'waiting_for_image_theme', 'waiting_for_image',
    ]);

    let observer = null;
    let presentationRefreshInProgress = false;
    let activityRefreshPromise = null;
    let latestActivity = null;
    let lastActivityCheckedAt = null;
    let lastActivitySuccessAt = null;
    let lastActivityError = null;

    const legacySendScoutsCommand = sendScoutsCommand;

    function sanitizeStatusText(value) {
        if (!value) return '';
        let text = String(value);
        for (const [from, to] of PRIMARY_STATUS_LABELS.entries()) {
            text = text.replaceAll(from, to);
        }
        return text
            .replace(/queued-stalled/gi, 'Waiting')
            .replace(/processing-stall/gi, 'Processing')
            .replace(/\bqueue\b/gi, 'work')
            .replace(/request id:\s*[^\s]+/gi, '')
            .replace(/message id:\s*[^\s]+/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function isDiagnosticsNode(el) {
        return Boolean(el?.closest?.('#admin-diagnostics-drawer'));
    }

    function normalizeStatusClasses(root) {
        root.querySelectorAll('.badge-queued-stalled, .runtime-queued-stalled').forEach((el) => {
            if (isDiagnosticsNode(el)) return;
            el.classList.remove('badge-queued-stalled', 'runtime-queued-stalled');
            el.classList.add('badge-queued');
        });
        root.querySelectorAll('.badge-processing-stall, .runtime-processing-stall').forEach((el) => {
            if (isDiagnosticsNode(el)) return;
            el.classList.remove('badge-processing-stall', 'runtime-processing-stall');
            el.classList.add('badge-processing');
        });
    }

    function sanitizeRenderedStatuses(root = document) {
        normalizeStatusClasses(root);
        root.querySelectorAll('.request-card-badge, .event-badge, .status-text, .refresh-status').forEach((el) => {
            if (isDiagnosticsNode(el)) return;
            const sanitized = sanitizeStatusText(el.textContent);
            if (sanitized && sanitized !== el.textContent.trim()) el.textContent = sanitized;
        });
    }

    function makeDiagnosticsSection(id, title, description = '') {
        const section = document.createElement('section');
        section.id = id;
        section.className = 'admin-diagnostics-section';
        const heading = document.createElement('h3');
        heading.textContent = title;
        section.appendChild(heading);
        if (description) {
            const p = document.createElement('p');
            p.className = 'admin-diagnostics-section-description';
            p.textContent = description;
            section.appendChild(p);
        }
        return section;
    }

    function buildDiagnosticsDrawer() {
        const drawer = document.createElement('aside');
        drawer.id = 'admin-diagnostics-drawer';
        drawer.className = 'admin-diagnostics-drawer';
        drawer.setAttribute('aria-hidden', 'true');
        drawer.innerHTML = `
            <div class="admin-diagnostics-header">
                <div>
                    <h2>Diagnostics</h2>
                    <p>Authoritative requests, infrastructure health and raw state.</p>
                </div>
                <button type="button" class="btn btn-secondary" id="diagnostics-close">Close</button>
            </div>
            <div class="admin-diagnostics-body"></div>
        `;
        document.body.appendChild(drawer);

        const button = document.createElement('button');
        button.id = 'diagnostics-open';
        button.type = 'button';
        button.className = 'btn btn-secondary btn-header diagnostics-open';
        button.textContent = 'Diagnostics';
        const apiIndicator = document.getElementById('api-ready-indicator');
        apiIndicator?.insertAdjacentElement('afterend', button);

        const close = () => {
            drawer.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
        };
        button.addEventListener('click', () => {
            drawer.classList.add('open');
            drawer.setAttribute('aria-hidden', 'false');
        });
        drawer.querySelector('#diagnostics-close')?.addEventListener('click', close);

        const body = drawer.querySelector('.admin-diagnostics-body');
        const statusSection = makeDiagnosticsSection('diagnostics-activity-status', 'Status freshness');
        statusSection.appendChild(document.createElement('div')).id = 'diagnostics-freshness-content';
        body.appendChild(statusSection);

        const requestsSection = makeDiagnosticsSection(
            'diagnostics-authoritative-requests',
            'Requests',
            'One monotonic lifecycle per request ID. Queue age is telemetry, not request state.',
        );
        requestsSection.appendChild(document.createElement('div')).id = 'diagnostics-request-list';
        body.appendChild(requestsSection);

        const queueSection = makeDiagnosticsSection(
            'diagnostics-queue-health',
            'Queue health',
            'Infrastructure telemetry is kept separate from request lifecycle.',
        );
        queueSection.appendChild(document.createElement('div')).id = 'diagnostics-queue-health-content';
        body.appendChild(queueSection);

        const workflowSection = makeDiagnosticsSection('diagnostics-step-functions', 'Step Functions');
        workflowSection.appendChild(document.createElement('div')).id = 'diagnostics-step-functions-content';
        body.appendChild(workflowSection);

        const pollingSection = makeDiagnosticsSection('diagnostics-polling', 'Polling controls');
        const pollingNodes = [
            document.querySelector('label[for="status-polling-toggle"]'),
            document.getElementById('status-polling-interval-seconds'),
            document.getElementById('status-polling-status'),
            document.querySelector('label[for="auto-lambda-toggle"]'),
            document.getElementById('auto-lambda-interval-seconds'),
        ];
        pollingNodes.filter(Boolean).forEach((node) => pollingSection.appendChild(node));
        body.appendChild(pollingSection);

        const rawSection = makeDiagnosticsSection(
            'diagnostics-raw-state',
            'Raw snapshots and tools',
            'Legacy S3 snapshots remain available for debugging but no longer determine Activity state.',
        );
        const rawDetails = document.createElement('details');
        const rawSummary = document.createElement('summary');
        rawSummary.textContent = 'Show raw runtime data';
        rawDetails.appendChild(rawSummary);
        const diagnosticNodes = [
            document.querySelector('.viewer-menu-shell'),
            document.querySelector('.requests-sidebar'),
            document.querySelector('.admin-runtime-footer'),
        ];
        diagnosticNodes.filter(Boolean).forEach((node) => rawDetails.appendChild(node));
        rawSection.appendChild(rawDetails);
        body.appendChild(rawSection);
    }

    function replaceAgendaCountInput() {
        const input = document.getElementById('refresh-action');
        if (!input || input.tagName === 'SELECT') return;
        const select = document.createElement('select');
        select.id = 'refresh-action';
        select.className = input.className;
        select.setAttribute('aria-label', 'AI enrichment events');
        select.title = 'Choose how many events may start AI enrichment during this agenda refresh.';
        [
            ['0', 'AI off'],
            ['1', '1 event'],
            ['5', '5 events'],
            ['10', '10 events'],
        ].forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            if ((input.value || input.placeholder || '5') === value) option.selected = true;
            select.appendChild(option);
        });
        input.replaceWith(select);
    }

    function buildPrimarySummary() {
        const layout = document.querySelector('.events-layout');
        if (!layout) return;
        const summary = document.createElement('section');
        summary.id = 'admin-primary-summary';
        summary.className = 'admin-primary-summary';
        summary.innerHTML = `
            <div class="admin-health-card">
                <span class="admin-summary-label">System</span>
                <strong id="admin-health-text">Checking services…</strong>
                <span id="admin-health-detail" class="admin-health-detail"></span>
            </div>
            <div class="admin-activity-card">
                <div class="admin-activity-heading">
                    <span class="admin-summary-label">Activity</span>
                    <span id="admin-activity-count"></span>
                </div>
                <div id="admin-activity-list" class="admin-activity-list"><p>Loading activity…</p></div>
                <div id="admin-activity-freshness" class="admin-activity-freshness"></div>
            </div>
        `;
        layout.insertAdjacentElement('afterend', summary);
    }

    function requestTitle(request) {
        if (request?.title) return String(request.title);
        if (request?.hex) {
            const known = typeof resolveEventTitleByHex === 'function' ? resolveEventTitleByHex(request.hex) : null;
            if (known) return known;
            const decoded = typeof decodeHexToText === 'function' ? decodeHexToText(request.hex) : null;
            if (decoded) return decoded;
        }
        return request?.subject || 'Background work';
    }

    function stateLabel(request) {
        const state = String(request?.state || '').toLowerCase();
        const stage = String(request?.stage || '').toLowerCase();
        if (state === 'completed') return 'Completed';
        if (state === 'needs_attention' || state === 'failed' || state === 'manual_review') return 'Needs attention';
        if (state === 'waiting_for_retry') return 'Waiting for retry';
        if (stage.includes('image') && !stage.includes('theme')) return 'Generating image';
        if (stage.includes('image') && stage.includes('theme')) return 'Creating image theme';
        if (stage.includes('tagline')) return 'Generating tagline';
        if (state === 'persisting') return 'Saving';
        if (state === 'orchestrating') return 'Enrichment running';
        if (state === 'processing') return request?.realm === 'persist' ? 'Saving' : 'Processing';
        if (state === 'queued' || state === 'accepted') return 'Waiting';
        return sanitizeStatusText(state || 'Processing');
    }

    function formatAge(request) {
        const seconds = Number(request?.ageSeconds);
        if (!Number.isFinite(seconds) || seconds < 0) return '';
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    function buildTimelineDetails(request) {
        const details = document.createElement('details');
        details.className = 'activity-timeline';
        const summary = document.createElement('summary');
        summary.textContent = 'Timeline';
        details.appendChild(summary);
        const list = document.createElement('ol');
        for (const item of Array.isArray(request?.timeline) ? request.timeline : []) {
            const li = document.createElement('li');
            const at = item?.at ? formatTrackerTimestamp(item.at) : 'n/a';
            li.textContent = `${at} — ${stateLabel({ state: item?.state, stage: item?.stage })}${item?.stage ? ` (${item.stage})` : ''}`;
            list.appendChild(li);
        }
        if (!list.childNodes.length) {
            const li = document.createElement('li');
            li.textContent = 'No lifecycle history available.';
            list.appendChild(li);
        }
        details.appendChild(list);
        return details;
    }

    function renderCanonicalActivity(activity = latestActivity) {
        const target = document.getElementById('admin-activity-list');
        const count = document.getElementById('admin-activity-count');
        const freshness = document.getElementById('admin-activity-freshness');
        if (!target) return;
        const requests = Array.isArray(activity?.requests) ? activity.requests : [];
        const active = requests.filter((request) => ACTIVE_STATES.has(request?.state));
        const recentCompleted = requests.filter((request) => request?.state === 'completed' && Number(request?.ageSeconds) <= 600);
        const attention = requests.filter((request) => ['needs_attention', 'failed', 'manual_review'].includes(request?.state));
        const candidates = [...attention, ...active, ...recentCompleted]
            .filter((request, index, array) => array.findIndex((candidate) => candidate?.requestId === request?.requestId && candidate?.hex === request?.hex) === index)
            .slice(0, 8);

        target.replaceChildren();
        if (!candidates.length) {
            const empty = document.createElement('p');
            empty.textContent = activity ? 'No active work.' : 'Activity status unavailable.';
            target.appendChild(empty);
        } else {
            candidates.forEach((request) => {
                const item = document.createElement('div');
                item.className = 'admin-activity-item';
                item.dataset.state = request?.state || 'unknown';

                const statusEl = document.createElement('span');
                statusEl.className = 'activity-status';
                statusEl.textContent = stateLabel(request);

                const body = document.createElement('div');
                body.className = 'activity-body';
                const titleEl = document.createElement('span');
                titleEl.className = 'activity-title';
                titleEl.textContent = requestTitle(request);
                const meta = document.createElement('span');
                meta.className = 'activity-meta';
                meta.textContent = [formatAge(request), request?.stage].filter(Boolean).join(' • ');
                body.append(titleEl, meta, buildTimelineDetails(request));
                item.append(statusEl, body);
                target.appendChild(item);
            });
        }
        if (count) count.textContent = active.length || attention.length ? `${active.length + attention.length} active` : '';
        if (freshness) {
            const success = lastActivitySuccessAt ? lastActivitySuccessAt.toLocaleTimeString('en-GB') : 'n/a';
            freshness.textContent = activity?.stale
                ? `Status data may be stale · last successful refresh ${success}`
                : `Last successful refresh ${success}`;
            freshness.dataset.stale = activity?.stale ? 'true' : 'false';
        }
    }

    function updateSystemHealth(activity = latestActivity) {
        const indicator = document.getElementById('api-ready-indicator');
        const target = document.getElementById('admin-health-text');
        const detail = document.getElementById('admin-health-detail');
        if (!target || !indicator) return;
        const label = indicator.textContent.trim();
        const apiBad = /error|offline|failed|unavailable/i.test(label) || indicator.classList.contains('api-error');
        const apiReady = /ready|ok|online|api/i.test(label) && !indicator.classList.contains('api-loading');
        const requests = Array.isArray(activity?.requests) ? activity.requests : [];
        const needsAttention = requests.some((request) => ['needs_attention', 'failed', 'manual_review'].includes(request?.state));
        const dlqCount = activity?.queueHealth
            ? Object.entries(activity.queueHealth)
                .filter(([name]) => /dlq$/i.test(name))
                .reduce((sum, [, queue]) => sum + (Number(queue?.visible) || 0), 0)
            : 0;
        const bad = apiBad || needsAttention || dlqCount > 0;
        if (bad) {
            target.textContent = 'Needs attention';
            target.dataset.tone = 'warning';
            if (detail) detail.textContent = dlqCount > 0 ? `${dlqCount} message(s) in DLQ` : (lastActivityError || 'A request or service needs attention.');
        } else if (activity?.stale) {
            target.textContent = 'Status data stale';
            target.dataset.tone = 'warning';
            if (detail) detail.textContent = 'The backend is reachable, but lifecycle source data has not advanced recently.';
        } else if (apiReady && activity) {
            target.textContent = 'All services available';
            target.dataset.tone = 'ok';
            if (detail) detail.textContent = 'Request tracking is up to date.';
        } else {
            target.textContent = 'Checking services…';
            target.dataset.tone = 'neutral';
            if (detail) detail.textContent = '';
        }
    }

    function appendDefinition(container, label, value) {
        const row = document.createElement('div');
        row.className = 'diagnostics-kv';
        const key = document.createElement('strong');
        key.textContent = label;
        const val = document.createElement('span');
        val.textContent = value == null || value === '' ? 'n/a' : String(value);
        row.append(key, val);
        container.appendChild(row);
    }

    function renderDiagnostics(activity = latestActivity) {
        const freshness = document.getElementById('diagnostics-freshness-content');
        if (freshness) {
            freshness.replaceChildren();
            appendDefinition(freshness, 'Last checked', lastActivityCheckedAt ? lastActivityCheckedAt.toLocaleString('en-GB') : 'n/a');
            appendDefinition(freshness, 'Last successful update', lastActivitySuccessAt ? lastActivitySuccessAt.toLocaleString('en-GB') : 'n/a');
            appendDefinition(freshness, 'Source updated', activity?.sourceUpdatedAt ? new Date(activity.sourceUpdatedAt).toLocaleString('en-GB') : 'n/a');
            appendDefinition(freshness, 'Stale', activity?.stale ? 'Yes' : 'No');
            if (lastActivityError) appendDefinition(freshness, 'Last error', lastActivityError);
        }

        const requestsEl = document.getElementById('diagnostics-request-list');
        if (requestsEl) {
            requestsEl.replaceChildren();
            const requests = Array.isArray(activity?.requests) ? activity.requests.slice(0, 20) : [];
            if (!requests.length) {
                requestsEl.textContent = 'No tracked requests.';
            } else {
                requests.forEach((request) => {
                    const card = document.createElement('article');
                    card.className = 'diagnostics-request-card';
                    const header = document.createElement('div');
                    header.className = 'diagnostics-request-header';
                    const title = document.createElement('strong');
                    title.textContent = requestTitle(request);
                    const badge = document.createElement('span');
                    badge.className = 'activity-status';
                    badge.textContent = stateLabel(request);
                    header.append(title, badge);
                    card.appendChild(header);
                    appendDefinition(card, 'Request ID', request?.requestId);
                    appendDefinition(card, 'HEX', request?.hex);
                    appendDefinition(card, 'Realm', request?.realm);
                    appendDefinition(card, 'Operation', request?.operation);
                    appendDefinition(card, 'Stage', request?.stage);
                    appendDefinition(card, 'Age', formatAge(request));
                    appendDefinition(card, 'Execution', request?.executionArn);
                    card.appendChild(buildTimelineDetails(request));
                    requestsEl.appendChild(card);
                });
            }
        }

        const queuesEl = document.getElementById('diagnostics-queue-health-content');
        if (queuesEl) {
            queuesEl.replaceChildren();
            Object.values(activity?.queueHealth || {}).forEach((queue) => {
                const row = document.createElement('div');
                row.className = 'diagnostics-queue-row';
                appendDefinition(row, queue?.name || 'Queue', `visible ${queue?.visible ?? 'n/a'} · in-flight ${queue?.inFlight ?? 'n/a'} · delayed ${queue?.delayed ?? 'n/a'}`);
                queuesEl.appendChild(row);
            });
            if (!queuesEl.childNodes.length) queuesEl.textContent = 'Queue health unavailable.';
        }

        const workflowsEl = document.getElementById('diagnostics-step-functions-content');
        if (workflowsEl) {
            workflowsEl.replaceChildren();
            for (const [name, data] of Object.entries(activity?.stepFunctions || {})) {
                const section = document.createElement('div');
                section.className = 'diagnostics-workflow-row';
                appendDefinition(section, name === 'fullEnrich' ? 'Full enrichment' : 'Image enrichment', data?.configured ? `${data?.activeExecutionCount || 0} active` : 'not configured');
                for (const execution of Array.isArray(data?.executions) ? data.executions : []) {
                    appendDefinition(section, requestTitle(execution), `${execution?.status || 'RUNNING'} · ${execution?.executionArn || 'n/a'}`);
                }
                workflowsEl.appendChild(section);
            }
            if (!workflowsEl.childNodes.length) workflowsEl.textContent = 'Workflow status unavailable.';
        }
    }

    function applyActivityToLegacySnapshots(activity) {
        const requests = Array.isArray(activity?.requests) ? activity.requests : [];
        const toLegacy = (request, status) => ({
            requestId: request?.requestId || null,
            messageId: request?.queueMessageIds?.requests || request?.queueMessageIds?.processing || null,
            hex: request?.hex || null,
            title: requestTitle(request),
            subject: request?.subject || null,
            realm: request?.realm || null,
            action: request?.operation || null,
            requestTime: request?.createdAt || null,
            processedAt: request?.updatedAt || null,
            orchestrationType: request?.orchestrationType || null,
            orchestrationStep: request?.stage || null,
            status,
        });
        latestQueuedSnapshot = {
            updatedAt: activity?.generatedAt || null,
            requests: requests.filter((request) => ['accepted', 'queued', 'waiting_for_retry'].includes(request?.state)).map((request) => toLegacy(request, 'queued')),
        };
        latestProcessingSnapshot = {
            updatedAt: activity?.generatedAt || null,
            requests: requests.filter((request) => PROCESSING_STATES.has(request?.state)).map((request) => toLegacy(request, 'processing')),
        };
        latestCompletedSnapshot = {
            updatedAt: activity?.generatedAt || null,
            requests: requests.filter((request) => request?.state === 'completed').map((request) => toLegacy(request, 'completed')),
        };
        if (uniqueEventEntries.length > 0 && typeof refreshVisibleEventRuntimeBadges === 'function') {
            refreshVisibleEventRuntimeBadges();
        }
    }

    async function pollAuthoritativeActivity() {
        if (activityRefreshPromise) return activityRefreshPromise;
        activityRefreshPromise = (async () => {
            lastActivityCheckedAt = new Date();
            const checkedEl = document.getElementById('queue-depth-checked');
            if (checkedEl) checkedEl.textContent = `Last checked: ${lastActivityCheckedAt.toLocaleString('en-GB')}`;
            try {
                const result = await legacySendScoutsCommand({ realm: 'runtime', subject: 'activity', action: 'status' });
                if (!result?.activity || typeof result.activity !== 'object') throw new Error('Activity payload missing from backend response');
                latestActivity = result.activity;
                lastActivitySuccessAt = new Date();
                lastActivityError = null;
                applyActivityToLegacySnapshots(latestActivity);
                renderCanonicalActivity(latestActivity);
                renderDiagnostics(latestActivity);
                updateSystemHealth(latestActivity);

                const updatedEl = document.getElementById('queue-depth-updated');
                if (updatedEl) updatedEl.textContent = `Last successful update: ${lastActivitySuccessAt.toLocaleString('en-GB')}`;
                if (typeof updateRuntimeStatus === 'function') updateRuntimeStatus('Authoritative request lifecycle ready.', 'success');
                if (typeof updateRuntimeDetails === 'function') {
                    const requests = Array.isArray(latestActivity.requests) ? latestActivity.requests : [];
                    const waiting = requests.filter((request) => ['accepted', 'queued', 'waiting_for_retry'].includes(request?.state)).length;
                    const processing = requests.filter((request) => PROCESSING_STATES.has(request?.state)).length;
                    const completed = requests.filter((request) => request?.state === 'completed').length;
                    updateRuntimeDetails(`Waiting ${waiting} | Processing ${processing} | Completed ${completed}`, 'info');
                }
                return latestActivity;
            } catch (error) {
                lastActivityError = error?.message || String(error);
                console.error('[AdminActivity] Authoritative activity refresh failed', error);
                renderCanonicalActivity(latestActivity);
                renderDiagnostics(latestActivity);
                updateSystemHealth(latestActivity);
                if (typeof updateRuntimeStatus === 'function') updateRuntimeStatus('Activity status unavailable; retaining last good result.', 'error');
                return latestActivity;
            } finally {
                activityRefreshPromise = null;
            }
        })();
        return activityRefreshPromise;
    }

    // Remove age-derived lifecycle states from the legacy event-badge model too.
    classifyAggregateRuntimeRequestStatus = function ({ hasQueued = false, hasProcessing = false, hasCompleted = false } = {}) {
        if (hasCompleted) return hasQueued || hasProcessing ? 'completed' : 'completed-archive';
        if (hasProcessing) return 'processing';
        if (hasQueued) return 'queued';
        return '';
    };

    // All status polling now goes through one authoritative endpoint.
    pollQueueDepthSnapshots = pollAuthoritativeActivity;

    // Refresh activity immediately after successful user mutations, then let the
    // existing single status-poll timer continue until the request settles.
    sendScoutsCommand = async function (payload) {
        const result = await legacySendScoutsCommand(payload);
        const isActivityPoll = payload?.realm === 'runtime' && payload?.subject === 'activity' && payload?.action === 'status';
        if (!isActivityPoll) {
            setTimeout(() => { pollAuthoritativeActivity(); }, 0);
        }
        return result;
    };

    function hideImplementationLanguage() {
        document.querySelectorAll('[title]').forEach((el) => {
            if (isDiagnosticsNode(el)) return;
            if (/queue publish count|max queue/i.test(el.title)) {
                el.title = 'Runs agenda refresh and optionally starts AI enrichment for the selected number of events.';
            }
        });
    }

    function refreshPresentation() {
        if (presentationRefreshInProgress) return;
        presentationRefreshInProgress = true;
        observer?.disconnect();
        try {
            sanitizeRenderedStatuses(document);
            updateSystemHealth(latestActivity);
            hideImplementationLanguage();
        } finally {
            presentationRefreshInProgress = false;
            if (observer) observer.observe(document.body, OBSERVER_OPTIONS);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        try {
            replaceAgendaCountInput();
            buildDiagnosticsDrawer();
            buildPrimarySummary();
            refreshPresentation();
            document.body.classList.add('admin-simplify-ready');
            observer = new MutationObserver(() => refreshPresentation());
            observer.observe(document.body, OBSERVER_OPTIONS);
            pollAuthoritativeActivity();
        } catch (error) {
            console.error('Failed to initialize authoritative admin presentation', error);
            document.body.classList.remove('admin-simplify-ready');
        }
    });
})();