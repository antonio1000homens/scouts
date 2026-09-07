// Simplified admin presentation for issue #34.
// This file intentionally leaves the existing admin controller authoritative and
// only changes presentation/visibility of its rendered state.

(function () {
    const PRIMARY_STATUS_LABELS = new Map([
        ['Queued', 'Waiting'],
        ['Queued Stalled', 'Waiting'],
        ['Processing Stall', 'Processing'],
        ['Completed Archive', 'Completed'],
    ]);

    function sanitizeStatusText(value) {
        if (!value) return '';
        let text = String(value);
        for (const [from, to] of PRIMARY_STATUS_LABELS.entries()) {
            text = text.replaceAll(from, to);
        }
        text = text
            .replace(/queued-stalled/gi, 'Waiting')
            .replace(/processing-stall/gi, 'Processing')
            .replace(/\bqueue\b/gi, 'work')
            .replace(/request id:\s*[^\s]+/gi, '')
            .replace(/message id:\s*[^\s]+/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        return text;
    }

    function normalizeStatusClasses(root) {
        root.querySelectorAll('.badge-queued-stalled, .runtime-queued-stalled').forEach((el) => {
            el.classList.remove('badge-queued-stalled', 'runtime-queued-stalled');
            el.classList.add('badge-queued');
        });
        root.querySelectorAll('.badge-processing-stall, .runtime-processing-stall').forEach((el) => {
            el.classList.remove('badge-processing-stall', 'runtime-processing-stall');
            el.classList.add('badge-processing');
        });
    }

    function sanitizeRenderedStatuses(root = document) {
        normalizeStatusClasses(root);
        root.querySelectorAll('.request-card-badge, .event-badge, .status-text, .refresh-status').forEach((el) => {
            const sanitized = sanitizeStatusText(el.textContent);
            if (sanitized && sanitized !== el.textContent.trim()) el.textContent = sanitized;
        });
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
                    <p>Runtime, polling and raw state tools.</p>
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
        const diagnosticNodes = [
            document.querySelector('.viewer-menu-shell'),
            document.querySelector('label[for="auto-lambda-toggle"]'),
            document.getElementById('auto-lambda-interval-seconds'),
            document.querySelector('label[for="status-polling-toggle"]'),
            document.getElementById('status-polling-interval-seconds'),
            document.getElementById('status-polling-status'),
            document.querySelector('.requests-sidebar'),
            document.querySelector('.admin-runtime-footer'),
        ];
        diagnosticNodes.filter(Boolean).forEach((node) => body.appendChild(node));
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
            </div>
            <div class="admin-activity-card">
                <div class="admin-activity-heading">
                    <span class="admin-summary-label">Activity</span>
                    <span id="admin-activity-count"></span>
                </div>
                <div id="admin-activity-list" class="admin-activity-list"><p>No active work.</p></div>
            </div>
        `;
        layout.insertAdjacentElement('afterend', summary);
    }

    function updateSystemHealth() {
        const indicator = document.getElementById('api-ready-indicator');
        const target = document.getElementById('admin-health-text');
        if (!target || !indicator) return;

        const label = indicator.textContent.trim();
        const isBad = /error|offline|failed|unavailable/i.test(label) || indicator.classList.contains('api-error');
        const isReady = /ready|ok|online|api/i.test(label) && !indicator.classList.contains('api-loading');
        target.textContent = isBad ? 'Needs attention' : (isReady ? 'All services available' : 'Checking services…');
        target.dataset.tone = isBad ? 'warning' : (isReady ? 'ok' : 'neutral');
    }

    function cloneActivityCards() {
        const target = document.getElementById('admin-activity-list');
        const count = document.getElementById('admin-activity-count');
        const source = document.querySelector('.requests-sidebar');
        if (!target || !source) return;

        const candidates = [...source.querySelectorAll('.request-card')].slice(0, 6);
        if (!candidates.length) {
            target.innerHTML = '<p>No active work.</p>';
            if (count) count.textContent = '';
            return;
        }

        target.innerHTML = '';
        candidates.forEach((card) => {
            const item = document.createElement('div');
            item.className = 'admin-activity-item';
            const badge = card.querySelector('.request-card-badge')?.textContent || 'Processing';
            const title = card.querySelector('.request-card-title, strong, h4')?.textContent || 'Background work';
            item.innerHTML = `<span class="activity-status">${sanitizeStatusText(badge)}</span><span class="activity-title">${sanitizeStatusText(title)}</span>`;
            target.appendChild(item);
        });
        if (count) count.textContent = `${candidates.length} active`;
    }

    function hideImplementationLanguage() {
        document.querySelectorAll('[title]').forEach((el) => {
            if (/queue publish count|max queue/i.test(el.title)) {
                el.title = 'Runs agenda refresh and optionally starts AI enrichment for the selected number of events.';
            }
        });
    }

    function refreshPresentation() {
        sanitizeRenderedStatuses(document);
        updateSystemHealth();
        cloneActivityCards();
        hideImplementationLanguage();
    }

    document.addEventListener('DOMContentLoaded', () => {
        replaceAgendaCountInput();
        buildDiagnosticsDrawer();
        buildPrimarySummary();
        refreshPresentation();

        const observer = new MutationObserver(() => refreshPresentation());
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    });
})();
