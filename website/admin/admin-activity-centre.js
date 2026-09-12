// Single browser-facing request lifecycle client. Root operation IDs own progress;
// agenda polling only confirms that the affected HEX is now rendered.
(function () {
    const STORAGE_KEY = 'scouts_admin_tracked_request_ids';
    const SEEN_KEY = 'scouts_admin_activity_seen';
    const POLL_MS = 5000;
    const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'manual_review']);
    const RETRYABLE_ENRICHMENT_STAGES = new Set(['tagline', 'imageTheme', 'image']);
    const originalSend = window.sendScoutsCommand;
    const tracked = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').filter(Boolean));
    const known = new Map();
    let pollTimer = null;
    let unread = 0;

    function text(value) { return value == null ? '' : String(value).trim(); }
    function escapeHtml(value) {
        return text(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }
    function saveTracked() { localStorage.setItem(STORAGE_KEY, JSON.stringify([...tracked].slice(-100))); }
    function requestLabel(request) { return request.title || request.hex || 'Event change'; }
    function activityCommand(action, extra = {}) {
        const sendRead = typeof window.sendScoutsReadCommand === 'function'
            ? window.sendScoutsReadCommand
            : originalSend;
        return sendRead({ realm: 'runtime', subject: 'activity', action, ...extra });
    }
    function stateLabel(request) {
        if (text(request?.displayMessage)) return text(request.displayMessage);
        const state = text(request?.state).toLowerCase();
        if (state === 'awaiting_review') return 'Published — awaiting image approval';
        if (state === 'awaiting_image') return 'Generating image — final review required';
        if (state === 'waiting_for_retry') return 'Waiting for retry';
        if (state === 'needs_attention' || state === 'manual_review' || state === 'failed') return 'Needs attention';
        if (state === 'completed') return 'Completed';
        if (state === 'queued' || state === 'accepted') return 'Waiting';
        return state.replaceAll('_', ' ') || 'Processing';
    }

    function ensureUi() {
        if (document.getElementById('activity-centre-open')) return;
        const button = document.createElement('button');
        button.id = 'activity-centre-open'; button.type = 'button'; button.className = 'btn btn-secondary btn-header';
        button.innerHTML = 'Activity <span id="activity-centre-unread" hidden>0</span>';
        button.addEventListener('click', () => { unread = 0; renderUnread(); document.getElementById('activity-centre-drawer')?.classList.add('open'); loadHistory(); });
        document.getElementById('api-ready-indicator')?.insertAdjacentElement('afterend', button);

        const stack = document.createElement('div'); stack.id = 'activity-toast-stack'; stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack);
        const drawer = document.createElement('aside'); drawer.id = 'activity-centre-drawer'; drawer.setAttribute('aria-label', 'Activity log');
        drawer.innerHTML = '<header><div><h2>Activity</h2><p>Changes from the last seven days.</p></div><button type="button" class="btn btn-secondary" id="activity-centre-close">Close</button></header><div class="activity-log-filters"><input id="activity-log-hex" placeholder="Filter by HEX"><select id="activity-log-state"><option value="">All states</option><option value="completed">Completed</option><option value="needs_attention">Needs attention</option><option value="failed">Failed</option><option value="processing">Processing</option><option value="awaiting_image">Generating image</option><option value="awaiting_review">Awaiting image approval</option></select><button type="button" class="btn btn-secondary" id="activity-log-filter">Filter</button></div><div id="activity-log-list"><p>Loading activity…</p></div>';
        document.body.appendChild(drawer);
        drawer.querySelector('#activity-centre-close').addEventListener('click', () => drawer.classList.remove('open'));
        drawer.querySelector('#activity-log-filter').addEventListener('click', () => loadHistory());
    }

    function renderUnread() { const badge = document.getElementById('activity-centre-unread'); if (badge) { badge.hidden = unread === 0; badge.textContent = String(unread); } }
    function notify(request, initial = false) {
        if (initial) return;
        unread += 1; renderUnread();
        const toast = document.createElement('article'); toast.className = `activity-toast activity-${request.displayState || request.state}`;
        const failure = request.failure?.message ? `: ${request.failure.message}` : '';
        toast.innerHTML = `<button type="button" aria-label="Dismiss">×</button><strong>${escapeHtml(requestLabel(request))}</strong><span>${escapeHtml(stateLabel(request))}${escapeHtml(failure)}</span><a href="#">View activity</a>`;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        toast.querySelector('a').addEventListener('click', (event) => { event.preventDefault(); document.getElementById('activity-centre-open')?.click(); });
        document.getElementById('activity-toast-stack')?.appendChild(toast);
        setTimeout(() => toast.remove(), TERMINAL.has(request.state) ? 8000 : 5000);
    }
    function notifyMessage(message, tone = 'info', duration = 5000) {
        const toast = document.createElement('article'); toast.className = `activity-toast activity-${tone}`;
        toast.innerHTML = `<button type="button" aria-label="Dismiss">×</button><strong>${escapeHtml(message)}</strong><a href="#">View activity</a>`;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        toast.querySelector('a').addEventListener('click', (event) => { event.preventDefault(); document.getElementById('activity-centre-open')?.click(); });
        document.getElementById('activity-toast-stack')?.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    async function reconcileAgenda(requests) {
        const refreshable = requests.filter((request) => request.hex && (
            request.state === 'completed'
            || request.state === 'awaiting_review'
            || request.publication === 'published'
        ));
        if (!refreshable.length || typeof window.loadEvents !== 'function') return;
        await window.loadEvents({ silent: true, notifyOnAgendaChanges: true, onlyIfChanged: true, notificationSource: 'Activity workflow update' });
        if (typeof window.updateModalContent === 'function') window.updateModalContent();
    }

    async function viewEvent(hex) {
        if (!text(hex) || typeof window.loadEvents !== 'function' || typeof window.openAdminEventByHex !== 'function') {
            notifyMessage('Event navigation is unavailable.', 'warning');
            return;
        }
        try {
            await window.loadEvents({ silent: true, notifyOnAgendaChanges: false, onlyIfChanged: false, notificationSource: 'Activity event link' });
            const opened = window.openAdminEventByHex(hex);
            if (opened) document.getElementById('activity-centre-drawer')?.classList.remove('open');
        } catch (error) {
            notifyMessage(`Event could not be loaded: ${error.message}`, 'warning');
        }
    }

    function enrichmentStage(request) {
        const stage = text(request?.stage);
        return RETRYABLE_ENRICHMENT_STAGES.has(stage) ? stage : '';
    }

    async function retryManualReview(request, button) {
        const hex = text(request?.hex).toLowerCase();
        const stage = enrichmentStage(request);
        if (!hex || !stage || text(request?.state).toLowerCase() !== 'manual_review') return;
        if (!window.confirm(`Retry ${stage} enrichment for ${requestLabel(request)}?`)) return;

        const originalLabel = button.textContent;
        button.disabled = true;
        button.textContent = 'Retrying…';
        try {
            const result = await window.sendScoutsCommand({
                realm: 'runtime',
                subject: 'enrichment',
                action: 'retry',
                hex,
                stage,
                requestedBy: 'admin',
            });
            const requestId = text(result?.rootRequestId || result?.requestId || result?.request?.requestId || result?.activity?.requestId);
            if (requestId) { tracked.add(requestId); saveTracked(); }
            notifyMessage(`${stage} enrichment retry queued for ${requestLabel(request)}.`, 'success', 6000);
            await loadHistory();
            setTimeout(() => poll(), 500);
        } catch (error) {
            notifyMessage(`Enrichment retry failed: ${error?.message || error}`, 'error', 8000);
            button.disabled = false;
            button.textContent = originalLabel;
        }
    }

    async function poll() {
        try {
            const result = await activityCommand('status');
            const statusRequests = Array.isArray(result?.activity?.requests) ? result.activity.requests : [];
            const lookup = tracked.size
                ? await activityCommand('lookup', { requestIds: [...tracked] })
                : { activity: { requests: [] } };
            const requests = [...statusRequests, ...(lookup?.activity?.requests || [])]
                .filter((request, index, list) => list.findIndex((candidate) => candidate.requestId === request.requestId) === index);
            const changed = [];
            for (const request of requests) {
                const fingerprint = `${request.state}|${request.stage}|${request.displayMessage || ''}|${request.publication || ''}|${request.updatedAt}|${request.failure?.message || ''}`;
                const previous = known.get(request.requestId);
                known.set(request.requestId, fingerprint);
                if (request.requestId && !TERMINAL.has(request.state)) { tracked.add(request.requestId); saveTracked(); }
                if (request.requestId && TERMINAL.has(request.state)) { tracked.delete(request.requestId); saveTracked(); }
                if (previous !== fingerprint) {
                    changed.push(request);
                    notify(request, previous === undefined && !tracked.has(request.requestId));
                }
            }
            await reconcileAgenda(changed);
        } catch (error) { console.warn('[ActivityCentre] Activity refresh failed', error); }
    }

    function renderLog(requests) {
        const target = document.getElementById('activity-log-list'); if (!target) return;
        target.replaceChildren();
        if (!requests.length) { target.textContent = 'No activity found.'; return; }
        const latestByEnrichmentStage = new Map();
        requests.forEach((request) => {
            const stage = enrichmentStage(request);
            const hex = text(request?.hex).toLowerCase();
            const key = hex && stage ? `${hex}|${stage}` : '';
            if (key && !latestByEnrichmentStage.has(key)) latestByEnrichmentStage.set(key, request);
        });
        requests.forEach((request) => {
            const item = document.createElement('article'); item.className = `activity-log-item activity-${request.displayState || request.state}`;
            const failure = request.failure?.message ? `<p>${escapeHtml(request.failure.message)}</p>` : '';
            const timeline = (request.timeline || []).map((entry) => `<li>${new Date(entry.at).toLocaleString('en-GB')} · ${escapeHtml(stateLabel(entry))}</li>`).join('');
            const childIds = Array.isArray(request.childRequestIds) ? request.childRequestIds.filter(Boolean) : [];
            const diagnostics = [
                request.rootRequestId ? `<p><strong>Operation:</strong> <code>${escapeHtml(request.rootRequestId)}</code></p>` : '',
                request.hex ? `<p><strong>Event HEX:</strong> <code>${escapeHtml(request.hex)}</code></p>` : '',
                request.stage ? `<p><strong>Internal stage:</strong> <code>${escapeHtml(request.stage)}</code></p>` : '',
                request.action ? `<p><strong>Internal action:</strong> <code>${escapeHtml(request.action)}</code></p>` : '',
                request.publication ? `<p><strong>Publication:</strong> <code>${escapeHtml(request.publication)}</code></p>` : '',
                childIds.length ? `<p><strong>Child requests:</strong> ${childIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}</p>` : '',
            ].join('');
            item.innerHTML = `<h3>${escapeHtml(requestLabel(request))}</h3><p>${escapeHtml(stateLabel(request))}</p>${failure}<details><summary>Timeline and diagnostics</summary><ol>${timeline}</ol>${diagnostics}</details>`;
            const stage = enrichmentStage(request);
            const stageKey = text(request?.hex) && stage ? `${text(request.hex).toLowerCase()}|${stage}` : '';
            if (request.state === 'manual_review' && stageKey && latestByEnrichmentStage.get(stageKey) === request) {
                const retryButton = document.createElement('button');
                retryButton.type = 'button';
                retryButton.className = 'btn btn-primary requires-api activity-retry-enrichment';
                retryButton.textContent = 'Retry enrichment';
                retryButton.title = `Reset the ${stage} manual-review state and queue a new provider attempt.`;
                retryButton.addEventListener('click', () => retryManualReview(request, retryButton));
                item.appendChild(retryButton);
            }
            if (request.hex) {
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'btn btn-secondary activity-view-event'; button.textContent = 'View event';
                button.addEventListener('click', () => viewEvent(request.hex));
                item.appendChild(button);
            }
            target.appendChild(item);
        });
    }
    async function loadHistory() {
        const hex = text(document.getElementById('activity-log-hex')?.value);
        const state = text(document.getElementById('activity-log-state')?.value);
        try { const result = await activityCommand('history', { hex, states: state ? [state] : [], limit: 50 }); renderLog(result?.activity?.requests || []); }
        catch (error) { const target = document.getElementById('activity-log-list'); if (target) target.textContent = `Activity log unavailable: ${error.message}`; }
    }

    function removeLegacyUi() {
        document.querySelector('.viewer-menu-shell')?.remove();
        ['agenda-viewer', 'events-json-viewer', 'scouts-config-viewer', 'runtime-json-viewer'].forEach((id) => document.getElementById(id)?.remove());
        document.querySelector('.requests-sidebar')?.remove(); document.querySelector('.admin-runtime-footer')?.remove();
        document.getElementById('admin-primary-summary')?.remove();
        const diagnostics = document.getElementById('admin-diagnostics-drawer');
        if (diagnostics) {
            diagnostics.querySelector('h2').textContent = 'Operations';
            diagnostics.querySelector('.admin-diagnostics-header p').textContent = 'Scheduled refresh and recovery controls.';
            ['diagnostics-activity-status', 'diagnostics-authoritative-requests', 'diagnostics-step-functions', 'diagnostics-raw-state'].forEach((id) => document.getElementById(id)?.remove());
            // These two sections are the insertion points used by the retained
            // scheduled-refresh and DLQ recovery controls. Hide their raw telemetry.
            document.getElementById('diagnostics-queue-health-content')?.remove();
            const recovery = document.getElementById('diagnostics-queue-health');
            recovery?.querySelector('h3') && (recovery.querySelector('h3').textContent = 'Recovery');
            const open = document.getElementById('diagnostics-open'); if (open) open.textContent = 'Operations';
        }
    }

    window.sendScoutsCommand = async function activityAwareCommand(payload) {
        const result = await originalSend(payload);
        if (payload?.realm !== 'runtime') {
            const requestId = text(result?.rootRequestId || result?.requestId || result?.request?.requestId || result?.activity?.requestId);
            // Tracking is immediate, but canonical status refresh has one owner:
            // admin-simplify schedules it after the mutation. The Activity Centre's
            // own 5-second timer handles notifications/history without launching a
            // second request burst for the same click.
            if (requestId) { tracked.add(requestId); saveTracked(); }
        }
        return result;
    };
    document.addEventListener('DOMContentLoaded', () => {
        ensureUi();
        // Native-notification denial and agenda-change fallback share the same
        // stack and log affordance instead of reviving the single legacy toast.
        window.showAdminNotification = notifyMessage;
        removeLegacyUi(); poll(); pollTimer = setInterval(poll, POLL_MS);
        window.addEventListener('beforeunload', () => clearInterval(pollTimer));
    });
}());