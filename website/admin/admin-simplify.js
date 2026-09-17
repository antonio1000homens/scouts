// Admin v2 shell owner: keeps the primary event workflow small and provides the
// Operations drawer used by scheduled-refresh and recovery controls.
(function () {
    let eventScope = 'agenda';
    let eventScopeLoadInFlight = false;

    function buildOperationsDrawer() {
        if (document.getElementById('admin-diagnostics-drawer')) return;
        const drawer = document.createElement('aside');
        drawer.id = 'admin-diagnostics-drawer';
        drawer.className = 'admin-diagnostics-drawer';
        drawer.setAttribute('aria-hidden', 'true');
        drawer.innerHTML = `
            <div class="admin-diagnostics-header">
                <div>
                    <h2>Operations</h2>
                    <p>Scheduled refresh and recovery controls.</p>
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
        button.textContent = 'Operations';
        document.getElementById('api-ready-indicator')?.insertAdjacentElement('afterend', button);

        const close = () => {
            drawer.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
        };
        button.addEventListener('click', () => {
            drawer.classList.add('open');
            drawer.setAttribute('aria-hidden', 'false');
        });
        drawer.querySelector('#diagnostics-close')?.addEventListener('click', close);
    }

    function removeLegacyOperatorUi() {
        document.querySelector('.viewer-menu-shell')?.remove();
        ['agenda-viewer', 'events-json-viewer', 'scouts-config-viewer', 'runtime-json-viewer'].forEach((id) => document.getElementById(id)?.remove());
        document.querySelector('.requests-sidebar')?.remove();
        document.querySelector('.admin-runtime-footer')?.remove();
        document.getElementById('admin-primary-summary')?.remove();
    }

    function updateEventScopeUi() {
        document.querySelectorAll('[data-event-scope]').forEach((button) => {
            const isActive = button.dataset.eventScope === eventScope;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            button.disabled = eventScopeLoadInFlight;
        });
        const description = document.getElementById('event-scope-description');
        if (description) {
            description.textContent = eventScope === 'agenda'
                ? 'Showing events currently published in the agenda.'
                : 'Showing all stored event entries, including entries no longer in the agenda.';
        }
    }

    function buildEventScopeControls() {
        const sidebar = document.querySelector('.events-sidebar');
        const title = sidebar?.querySelector('.sidebar-title');
        if (!sidebar || !title || document.getElementById('event-scope-controls')) return;

        const controls = document.createElement('div');
        controls.id = 'event-scope-controls';
        controls.className = 'event-scope-controls';
        controls.setAttribute('aria-label', 'Event scope');
        controls.innerHTML = `
            <button type="button" class="sidebar-filter-btn event-scope-btn active" data-event-scope="agenda" aria-pressed="true">
                In agenda
            </button>
            <button type="button" class="sidebar-filter-btn event-scope-btn" data-event-scope="all" aria-pressed="false">
                Show all
            </button>
            <p id="event-scope-description" class="refresh-status">Showing events currently published in the agenda.</p>
        `;
        title.insertAdjacentElement('afterend', controls);
        controls.querySelectorAll('[data-event-scope]').forEach((button) => {
            button.addEventListener('click', () => setEventScope(button.dataset.eventScope));
        });
        updateEventScopeUi();
    }

    function replaceAdminEventDataset(rawEvents) {
        const sourceEvents = Array.isArray(rawEvents) ? rawEvents : [];
        eventsData = sourceEvents.map((event) => normaliseEventTaglineFields(cloneEventRecord(event)));
        uniqueEventEntries = buildUniqueEventEntries(eventsData);
        applyVisibilityOverrides(uniqueEventEntries);
        updateEventsCount(
            uniqueEventEntries.length,
            eventsData.length,
            uniqueEventEntries.filter((entry) => isEntryHidden(entry)).length,
            uniqueEventEntries.filter((entry) => isEntryComplete(entry)).length,
        );
        updateSidebarUi();
        renderEvents();
    }

    async function loadAllStoredEvents() {
        const result = await sendScoutsReadCommand({
            realm: 'runtime',
            subject: 'event',
            action: 'list',
        });
        if (!Array.isArray(result?.events)) {
            throw new Error('Stored event list was not returned by the Admin API.');
        }
        replaceAdminEventDataset(result.events);
        return result.events;
    }

    async function reloadEventScope(options = {}) {
        if (eventScope === 'all') {
            return loadAllStoredEvents();
        }
        return loadEvents({
            silent: true,
            notifyOnAgendaChanges: false,
            onlyIfChanged: false,
            notificationSource: 'Admin event scope',
            ...options,
        });
    }

    async function setEventScope(nextScope) {
        const normalizedScope = nextScope === 'all' ? 'all' : 'agenda';
        if (eventScopeLoadInFlight || normalizedScope === eventScope) return;

        const previousScope = eventScope;
        eventScope = normalizedScope;
        eventScopeLoadInFlight = true;
        updateEventScopeUi();
        try {
            await reloadEventScope();
        } catch (error) {
            eventScope = previousScope;
            if (typeof showAdminNotification === 'function') {
                showAdminNotification(`Unable to change event scope: ${error?.message || error}`, 'error', 7000);
            }
            console.error('[AdminEventScope] Unable to load requested event scope', error);
        } finally {
            eventScopeLoadInFlight = false;
            updateEventScopeUi();
        }
    }

    window.adminEventScopeController = Object.freeze({
        getScope: () => eventScope,
        setScope: setEventScope,
        reload: reloadEventScope,
    });

    document.addEventListener('DOMContentLoaded', () => {
        try {
            setAutoLambdaInvocationEnabled(false, false);
            setStatusPollingEnabled(false, false);
            buildOperationsDrawer();
            buildEventScopeControls();
            removeLegacyOperatorUi();
            document.body.classList.add('admin-simplify-ready');
        } catch (error) {
            console.error('Failed to initialize Admin v2 shell', error);
            document.body.classList.remove('admin-simplify-ready');
        }
    });
})();
