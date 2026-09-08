// Single browser-facing request lifecycle client. Request IDs own progress;
// agenda polling only confirms that the affected HEX is now rendered.
(function () {
    const STORAGE_KEY = 'scouts_admin_tracked_request_ids';
    const SEEN_KEY = 'scouts_admin_activity_seen';
    const POLL_MS = 5000;
    const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'manual_review']);
    const originalSend = window.sendScoutsCommand;
    const tracked = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').filter(Boolean));
    const known = new Map();
    let pollTimer = null;
    let unread = 0;

    function text(value) { return value == null ? '' : String(value).trim(); }
    function saveTracked() { localStorage.setItem(STORAGE_KEY, JSON.stringify([...tracked].slice(-100))); }
    function requestLabel(request) { return request.title || request.hex || 'Event change'; }
    function activityCommand(action, extra = {}) { return originalSend({ realm: 'runtime', subject: 'activity', action, ...extra }); }
    function stateLabel(request) { return text(request?.state).replaceAll('_', ' ') || 'processing'; }

    function ensureUi() {
        if (document.getElementById('activity-centre-open')) return;
        const button = document.createElement('button');
        button.id = 'activity-centre-open'; button.type = 'button'; button.className = 'btn btn-secondary btn-header';
        button.innerHTML = 'Activity <span id="activity-centre-unread" hidden>0</span>';
        button.addEventListener('click', () => { unread = 0; renderUnread(); document.getElementById('activity-centre-drawer')?.classList.add('open'); loadHistory(); });
        document.getElementById('api-ready-indicator')?.insertAdjacentElement('afterend', button);

        const stack = document.createElement('div'); stack.id = 'activity-toast-stack'; stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack);
        const drawer = document.createElement('aside'); drawer.id = 'activity-centre-drawer'; drawer.setAttribute('aria-label', 'Activity log');
        drawer.innerHTML = '<header><div><h2>Activity</h2><p>Changes from the last seven days.</p></div><button type="button" class="btn btn-secondary" id="activity-centre-close">Close</button></header><div class="activity-log-filters"><input id="activity-log-hex" placeholder="Filter by HEX"><select id="activity-log-state"><option value="">All states</option><option value="completed">Completed</option><option value="needs_attention">Needs attention</option><option value="failed">Failed</option><option value="processing">Processing</option></select><button type="button" class="btn btn-secondary" id="activity-log-filter">Filter</button></div><div id="activity-log-list"><p>Loading activity…</p></div>';
        document.body.appendChild(drawer);
        drawer.querySelector('#activity-centre-close').addEventListener('click', () => drawer.classList.remove('open'));
        drawer.querySelector('#activity-log-filter').addEventListener('click', () => loadHistory());
    }

    function renderUnread() { const badge = document.getElementById('activity-centre-unread'); if (badge) { badge.hidden = unread === 0; badge.textContent = String(unread); } }
    function notify(request, initial = false) {
        if (initial) return;
        unread += 1; renderUnread();
        const toast = document.createElement('article'); toast.className = `activity-toast activity-${request.state}`;
        const failure = request.failure?.message ? `: ${request.failure.message}` : '';
        toast.innerHTML = `<button type="button" aria-label="Dismiss">×</button><strong>${requestLabel(request)}</strong><span>${stateLabel(request)}${failure}</span><a href="#">View activity</a>`;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        toast.querySelector('a').addEventListener('click', (event) => { event.preventDefault(); document.getElementById('activity-centre-open')?.click(); });
        document.getElementById('activity-toast-stack')?.appendChild(toast);
        setTimeout(() => toast.remove(), TERMINAL.has(request.state) ? 8000 : 5000);
    }
    function notifyMessage(message, tone = 'info', duration = 5000) {
        const toast = document.createElement('article'); toast.className = `activity-toast activity-${tone}`;
        toast.innerHTML = `<button type="button" aria-label="Dismiss">×</button><strong>${message}</strong><a href="#">View activity</a>`;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        toast.querySelector('a').addEventListener('click', (event) => { event.preventDefault(); document.getElementById('activity-centre-open')?.click(); });
        document.getElementById('activity-toast-stack')?.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    async function reconcileAgenda(requests) {
        const published = requests.filter((request) => request.state === 'completed' && request.hex);
        if (!published.length || typeof window.loadEvents !== 'function') return;
        await window.loadEvents({ silent: true, notifyOnAgendaChanges: true, onlyIfChanged: true, notificationSource: 'Activity published' });
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
            for (const request of requests) {
                const fingerprint = `${request.state}|${request.stage}|${request.updatedAt}|${request.failure?.message || ''}`;
                const previous = known.get(request.requestId);
                known.set(request.requestId, fingerprint);
                if (request.requestId && !TERMINAL.has(request.state)) { tracked.add(request.requestId); saveTracked(); }
                if (request.requestId && TERMINAL.has(request.state)) { tracked.delete(request.requestId); saveTracked(); }
                if (previous !== fingerprint) notify(request, previous === undefined && !tracked.has(request.requestId));
            }
            await reconcileAgenda(requests);
        } catch (error) { console.warn('[ActivityCentre] Activity refresh failed', error); }
    }

    function renderLog(requests) {
        const target = document.getElementById('activity-log-list'); if (!target) return;
        target.replaceChildren();
        if (!requests.length) { target.textContent = 'No activity found.'; return; }
        requests.forEach((request) => {
            const item = document.createElement('article'); item.className = `activity-log-item activity-${request.state}`;
            const failure = request.failure?.message ? `<p>${request.failure.message}</p>` : '';
            const timeline = (request.timeline || []).map((entry) => `<li>${new Date(entry.at).toLocaleString('en-GB')} · ${text(entry.state).replaceAll('_', ' ')}</li>`).join('');
            item.innerHTML = `<h3>${requestLabel(request)}</h3><p>${stateLabel(request)} · ${request.action || 'change'} · ${request.publication || 'not published'}</p><code>${request.hex || ''}</code>${failure}<details><summary>Timeline</summary><ol>${timeline}</ol></details>`;
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
            const requestId = text(result?.requestId || result?.request?.requestId || result?.activity?.requestId);
            if (requestId) { tracked.add(requestId); saveTracked(); poll(); }
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
