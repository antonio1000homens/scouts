// Admin Script for Event Images Management

let eventsData = [];
let uniqueEventEntries = [];
let visibleEventEntries = [];
let currentEventIndex = null;
let apiAuthReady = false;
let lambdaRuntimeRunning = false;
let uiCommandInFlight = false;
let activeFilter = 'new';
let agendaPayload = null;
let agendaLoadInFlight = false;
let lastAgendaScanAtIso = null;
let requeueTrackerEntries = [];
let latestQueuedSnapshot = null;
let latestProcessingSnapshot = null;
let pinnedRuntimeDetails = null;
const MIN_RUNTIME_DETAILS_VISIBLE_MS = 5000;
const AGENDA_POLL_INTERVAL_MS = 15000;
const MAX_TRACKED_REQUEUE_ENTRIES = 30;
let runtimeDetailsLastShownAt = 0;
let runtimeDetailsLastMessage = '';
let runtimeDetailsLastType = 'info';
let runtimeDetailsPending = null;
let runtimeDetailsFlushTimer = null;
const ADMIN_API_BASE = window.ADMIN_API_BASE || '/admin-api';
const SCOUTS_REFRESH_URL = window.SCOUTS_REFRESH_URL || `${ADMIN_API_BASE}/scouts`;
const AUTH_STATUS_URL = window.SCOUTS_AUTH_STATUS_URL || `${ADMIN_API_BASE}/auth-status`;
const QUEUED_REQUESTS_RUNTIME_URL = '../../runtime/queuedrequests.json';
const PROCESSING_REQUESTS_RUNTIME_URL = '../../runtime/processingrequests.json';

async function buildHttpError(response) {
    let details = '';
    try {
        const payload = await response.json();
        if (payload && typeof payload === 'object') {
            details = payload.error || payload.message || JSON.stringify(payload);
        }
    } catch {
        try {
            const text = await response.text();
            if (text) details = text;
        } catch {
            // Ignore body parsing issues
        }
    }

    const detailSuffix = details ? `: ${details}` : '';
    return new Error(`HTTP ${response.status}${detailSuffix}`);
}

function updateEventsCount(uniqueCount, rawCount = uniqueCount, hiddenCount = 0, completeCount = 0) {
    const countElement = document.getElementById('events-count');
    const hiddenSuffix = hiddenCount > 0 ? `, ${hiddenCount} hidden` : '';
    const completeSuffix = completeCount > 0 ? `, ${completeCount} complete` : '';
    countElement.textContent = `${uniqueCount} unique (${rawCount} raw${hiddenSuffix}${completeSuffix})`;
}

function applyRuntimeDetailsNow(message, type = 'info') {
    const detailsElement = document.getElementById('runtime-state-details');
    if (!detailsElement) return;
    detailsElement.textContent = message;
    detailsElement.className = `refresh-status ${type}`;
    runtimeDetailsLastShownAt = Date.now();
    runtimeDetailsLastMessage = message;
    runtimeDetailsLastType = type;
}

function flushPendingRuntimeDetails() {
    runtimeDetailsFlushTimer = null;
    if (!runtimeDetailsPending) return;
    const next = runtimeDetailsPending;
    runtimeDetailsPending = null;
    applyRuntimeDetailsNow(next.message, next.type);
}

function updateRuntimeDetails(message, type = 'info') {
    const nextMessage = typeof message === 'string' ? message : String(message ?? '');
    const nextType = typeof type === 'string' ? type : 'info';

    if (nextMessage === runtimeDetailsLastMessage && nextType === runtimeDetailsLastType) {
        return;
    }

    const now = Date.now();
    const elapsed = now - runtimeDetailsLastShownAt;
    if (runtimeDetailsLastShownAt === 0 || elapsed >= MIN_RUNTIME_DETAILS_VISIBLE_MS) {
        applyRuntimeDetailsNow(nextMessage, nextType);
        return;
    }

    runtimeDetailsPending = { message: nextMessage, type: nextType };
    const waitMs = Math.max(0, MIN_RUNTIME_DETAILS_VISIBLE_MS - elapsed);
    if (!runtimeDetailsFlushTimer) {
        runtimeDetailsFlushTimer = setTimeout(flushPendingRuntimeDetails, waitMs);
    }
}

function pinRuntimeDetails(message, type = 'info', ttlMs = 45000) {
    const effectiveTtl = Number.isFinite(ttlMs) ? Math.max(1000, ttlMs) : 45000;
    pinnedRuntimeDetails = {
        message,
        type,
        expiresAt: Date.now() + effectiveTtl,
    };
    updateRuntimeDetails(message, type);
}

function getPinnedRuntimeDetails() {
    if (!pinnedRuntimeDetails) return null;
    if (Date.now() > pinnedRuntimeDetails.expiresAt) {
        pinnedRuntimeDetails = null;
        return null;
    }
    return pinnedRuntimeDetails;
}

function isCompleteEvent(event) {
    return hasText(getAIPrompt(event)) && hasText(getImagePrompt(event)) && hasText(getImageUrl(event));
}

function isNewEvent(event) {
    return !hasText(getAIPrompt(event)) && !hasText(getImagePrompt(event)) && !hasText(getImageUrl(event));
}

function getFilterCounts() {
    return {
        new: uniqueEventEntries.filter((entry) => isNewEvent(entry.event)).length,
        all: uniqueEventEntries.length,
        missing: uniqueEventEntries.filter((entry) => {
            const missingCount = getMissingMetadataFields(entry.event).length;
            return missingCount > 0 && missingCount < 3;
        }).length,
        hidden: uniqueEventEntries.filter((entry) => entry.allHidden).length,
        complete: uniqueEventEntries.filter((entry) => isCompleteEvent(entry.event)).length,
        approval: uniqueEventEntries.filter((entry) => getMissingMetadataFields(entry.event).length > 0 && hasText(entry.event?.hex)).length,
    };
}

function updateSidebarUi() {
    const counts = getFilterCounts();
    const filters = ['new', 'all', 'missing', 'hidden', 'complete', 'approval'];
    filters.forEach((filter) => {
        const btn = document.getElementById(`filter-btn-${filter}`);
        if (!btn) return;
        const countEl = btn.querySelector('.filter-count');
        if (countEl) countEl.textContent = counts[filter];
        btn.classList.toggle('active', filter === activeFilter);
    });
}

function setFilter(filter) {
    activeFilter = filter;
    updateSidebarUi();
    renderEvents();
}

function renderAgendaViewerContent() {
    const agendaContentEl = document.getElementById('agenda-json-content');
    if (!agendaContentEl) return;
    if (!agendaPayload) {
        agendaContentEl.textContent = 'Agenda not loaded yet.';
        return;
    }
    agendaContentEl.textContent = JSON.stringify(agendaPayload, null, 2);
}

function toggleAgendaViewer() {
    const viewer = document.getElementById('agenda-viewer');
    const navButton = document.querySelector('.admin-top-nav .nav-btn');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    viewer.style.display = shouldShow ? 'block' : 'none';

    if (navButton) {
        navButton.textContent = shouldShow ? 'Hide Actual Agenda' : 'Show Actual Agenda';
    }

    if (shouldShow) {
        renderAgendaViewerContent();
    }
}

function renderEventsJsonViewerContent() {
    const eventsJsonContentEl = document.getElementById('events-json-content');
    if (!eventsJsonContentEl) return;

    if (!uniqueEventEntries.length) {
        eventsJsonContentEl.textContent = 'No event JSON entries loaded yet.';
        return;
    }

    const lines = [];
    lines.push(`Generated from agenda.json on ${new Date().toISOString()}`);
    lines.push(`Unique Event Groups: ${uniqueEventEntries.length}`);
    lines.push('');

    uniqueEventEntries.forEach((entry, index) => {
        const event = entry.event || {};
        const title = event.summary || event.title || `Event ${index + 1}`;
        const hex = hasText(event.hex) ? event.hex.trim() : '';
        const eventPath = hex ? `events/${hex}.json` : 'events/<missing-hex>.json';
        const sourceSummary = (entry.sourceDetails || [])
            .map((source) => `Event Index: ${source.index} | UID: ${source.uid}`)
            .join(' ; ');

        lines.push(`${index + 1}. ${eventPath}`);
        lines.push(`   Title: ${title}`);
        lines.push(`   HEX: ${hex || 'MISSING'}`);
        lines.push(`   Occurrences: ${entry.duplicateCount}`);
        if (sourceSummary) {
            lines.push(`   Sources: ${sourceSummary}`);
        }
        lines.push('');
    });

    eventsJsonContentEl.textContent = lines.join('\n');
}

function toggleEventsJsonViewer() {
    const viewer = document.getElementById('events-json-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    viewer.style.display = shouldShow ? 'block' : 'none';

    if (shouldShow) {
        renderEventsJsonViewerContent();
    }
}

function updateApiAuthStatus(message, type = 'info') {
    const statusElement = document.getElementById('api-ready-indicator');
    if (!statusElement) return;
    let label = 'API Not Ready';
    let className = 'api-ready-pill api-error';
    if (type === 'success') {
        label = 'API Ready';
        className = 'api-ready-pill api-success';
    } else if (type === 'loading' || type === 'info') {
        label = 'API Checking';
        className = 'api-ready-pill api-loading';
    }
    statusElement.textContent = label;
    statusElement.className = className;
    statusElement.title = message || label;
}

function updateRuntimeStatus(message, type = 'info') {
    const statusElement = document.getElementById('runtime-state-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
}

function formatRuntimeCommand(command) {
    if (!command || typeof command !== 'object') return 'No command context';
    const realm = command.realm ?? 'unknown';
    const subject = command.subject ?? 'unknown';
    const action = command.action ?? 'unknown';
    let suffix = '';
    if (Array.isArray(command.calendarTokens) && command.calendarTokens.length > 0) {
        suffix = ` | calendars=${command.calendarTokens.join(',')}`;
    }
    return `Command: realm=${realm} subject=${subject} action=${action}${suffix}`;
}

function formatRuntimeResult(result) {
    if (result == null) return 'No result captured yet.';
    if (typeof result === 'string') return `Result: ${result}`;
    if (typeof result !== 'object') return `Result: ${String(result)}`;

    const status = result.status ?? 'unknown';
    const message = result.message ?? '';
    const eventsCount = Number.isFinite(result.eventsCount) ? ` events=${result.eventsCount}` : '';
    const modifiedCount = Number.isFinite(result.modifiedEventsCount) ? ` modified=${result.modifiedEventsCount}` : '';
    const queueAccepted = result.queueAccepted === true ? ' queueAccepted=true' : '';
    const summary = `Result: status=${status}${eventsCount}${modifiedCount}${queueAccepted}`;
    return message ? `${summary} message="${message}"` : summary;
}

function updateModalStatus(message, type = 'info') {
    const statusElement = document.getElementById('modal-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = `status-text status-${type}`;
}

function updateGlobalRefreshStatus(message, type = 'info') {
    const statusElement = document.getElementById('global-refresh-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = `refresh-status ${type}`;
}

async function sendScoutsCommand(payload) {
    const response = await fetch(SCOUTS_REFRESH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain',
        },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw await buildHttpError(response);
    }

    try {
        const parsed = await response.json();
        if (parsed && typeof parsed === 'object') {
            parsed._httpStatus = response.status;
            return parsed;
        }
        return { value: parsed, _httpStatus: response.status };
    } catch {
        return { _httpStatus: response.status };
    }
}

function setApiActionState(enabled) {
    apiAuthReady = Boolean(enabled);
    refreshApiActionButtons();
}

function refreshApiActionButtons() {
    const enabled = apiAuthReady && !lambdaRuntimeRunning && !uiCommandInFlight;
    const actionButtons = document.querySelectorAll('.requires-api');
    actionButtons.forEach((button) => {
        button.disabled = !enabled;
        button.classList.toggle('btn-disabled', !enabled);
    });
}

async function pollLambdaRuntimeStatus(silent = false) {
    if (!apiAuthReady) {
        lambdaRuntimeRunning = false;
        refreshApiActionButtons();
        if (!silent) {
            updateRuntimeStatus('Runtime status unavailable (API auth not ready).', 'error');
            updateRuntimeDetails('Cloudflare auth is not ready.', 'error');
        }
        return;
    }

    try {
        const result = await sendScoutsCommand({
            realm: 'scouts',
            subject: 'status',
            action: 'runtime',
        });
        const runtime = result?.runtime || {};
        lambdaRuntimeRunning = runtime?.status === 'running';
        refreshApiActionButtons();

        if (lambdaRuntimeRunning) {
            pinnedRuntimeDetails = null;
            const startedAt = runtime?.startedAt ? new Date(runtime.startedAt).toLocaleString('en-GB') : 'unknown';
            const subject = runtime?.command?.subject || 'unknown';
            updateRuntimeStatus(`Running (${subject}) since ${startedAt}.`, 'loading');
            updateRuntimeDetails(formatRuntimeCommand(runtime?.command), 'loading');
        } else {
            const completedAt = runtime?.lastCompletedAt
                ? new Date(runtime.lastCompletedAt).toLocaleString('en-GB')
                : null;
            const outcome = runtime?.lastOutcome || 'idle';
            const suffix = completedAt ? ` Last ${outcome} at ${completedAt}.` : '';
            updateRuntimeStatus(`Idle.${suffix}`, 'success');
            const pinned = getPinnedRuntimeDetails();
            if (pinned) {
                updateRuntimeDetails(pinned.message, pinned.type);
                return;
            }
            const lastCommand = runtime?.lastCommand || null;
            const lastResult = runtime?.lastResult || null;
            if (lastCommand || lastResult) {
                const pieces = [];
                if (lastCommand) pieces.push(formatRuntimeCommand(lastCommand));
                if (lastResult) pieces.push(formatRuntimeResult(lastResult));
                updateRuntimeDetails(pieces.join(' | '), outcome === 'error' ? 'error' : 'success');
            } else {
                updateRuntimeDetails('No lambda commands recorded yet.', 'info');
            }
        }
    } catch (error) {
        lambdaRuntimeRunning = false;
        refreshApiActionButtons();
        if (!silent) {
            updateRuntimeStatus(`Runtime status check failed: ${error.message}`, 'error');
            updateRuntimeDetails('Unable to fetch runtime details.', 'error');
        }
    }
}

async function checkApiAuthStatus() {
    updateApiAuthStatus('Checking Cloudflare admin API...', 'loading');
    setApiActionState(false);

    try {
        const response = await fetch(AUTH_STATUS_URL, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });

        if (!response.ok) {
            throw await buildHttpError(response);
        }

        const payload = await response.json();
        if (!payload?.ok) {
            throw new Error(payload?.message || 'Auth status check failed.');
        }

        const keySuffix = typeof payload.apiKeyLast4 === 'string' && payload.apiKeyLast4
            ? ` (key ending ${payload.apiKeyLast4})`
            : '';
        updateApiAuthStatus(`Ready - Cloudflare API proxy authenticated${keySuffix}`, 'success');
        setApiActionState(true);
        await pollLambdaRuntimeStatus(true);
    } catch (error) {
        console.error('Error checking admin API auth status:', error);
        updateApiAuthStatus(
            'Admin API unavailable. Re-login via Cloudflare Access or verify Worker config/secrets.',
            'error',
        );
        setApiActionState(false);
        updateRuntimeStatus('Runtime status unavailable.', 'error');
        updateRuntimeDetails('Runtime details unavailable.', 'error');
    }
}

// Load events from agenda.json
async function loadEvents(options = {}) {
    const { silent = false } = options;
    if (agendaLoadInFlight) {
        return;
    }

    agendaLoadInFlight = true;
    try {
        // Try to load from parent directory (assuming admin is in website/admin/)
        const response = await fetch(`../../agenda.json?ts=${Date.now()}`, { cache: 'no-store' });
        
        if (!response.ok) {
            throw new Error('Failed to load events.json: ' + response.status);
        }

        const data = await response.json();
        agendaPayload = data;
        eventsData = data.events || [];
        uniqueEventEntries = buildUniqueEventEntries(eventsData);
        lastAgendaScanAtIso = new Date().toISOString();
        console.log('[Admin] agenda.json fetched', {
            totalEvents: data.events?.length ?? 0,
            uniqueEvents: uniqueEventEntries.length,
        });

        updateEventsCount(
            uniqueEventEntries.length,
            eventsData.length,
            uniqueEventEntries.filter((entry) => entry.allHidden).length,
            uniqueEventEntries.filter((entry) => isCompleteEvent(entry.event)).length,
        );
        updateSidebarUi();
        renderEvents();
        reconcileRequeueTrackerEntries();
        renderRequeueTracker();
        renderAgendaViewerContent();
        renderEventsJsonViewerContent();
    } catch (error) {
        console.error('Error loading events:', error);
        if (!silent) {
            showError('Failed to load events data. Please ensure agenda.json exists and is accessible.');
        }
    } finally {
        agendaLoadInFlight = false;
    }
}

function formatQueueSnapshotCount(snapshot) {
    if (!snapshot || !snapshot.counts || typeof snapshot.counts !== 'object') {
        return 'unknown';
    }
    const visible = Number.isFinite(snapshot.counts.visible) ? snapshot.counts.visible : '?';
    const inFlight = Number.isFinite(snapshot.counts.inFlight) ? snapshot.counts.inFlight : '?';
    const delayed = Number.isFinite(snapshot.counts.delayed) ? snapshot.counts.delayed : '?';
    return `visible=${visible}, in-flight=${inFlight}, delayed=${delayed}`;
}

function formatObservedIds(snapshot) {
    if (!snapshot || !snapshot.observed || typeof snapshot.observed !== 'object') {
        return 'n/a';
    }
    const requestIds = Array.isArray(snapshot.observed.requestIds) ? snapshot.observed.requestIds : [];
    const hexIds = Array.isArray(snapshot.observed.hexIds) ? snapshot.observed.hexIds : [];
    const requestSample = requestIds.slice(0, 3);
    const hexSample = hexIds.slice(0, 3);
    if (requestSample.length === 0 && hexSample.length === 0) return 'n/a';
    const parts = [];
    if (requestSample.length > 0) {
        parts.push(`requestIds=${requestSample.join(', ')}`);
    }
    if (hexSample.length > 0) {
        parts.push(`hex=${hexSample.join(', ')}`);
    }
    return parts.join(' | ');
}

function normaliseTrackerToken(value) {
    return hasText(value) ? String(value).trim().toLowerCase() : '';
}

function getSnapshotObservedTokens(snapshot) {
    if (!snapshot || !snapshot.observed || typeof snapshot.observed !== 'object') {
        return new Set();
    }
    const requestIds = Array.isArray(snapshot.observed.requestIds) ? snapshot.observed.requestIds : [];
    const hexIds = Array.isArray(snapshot.observed.hexIds) ? snapshot.observed.hexIds : [];
    const tokens = [...requestIds, ...hexIds]
        .map((token) => normaliseTrackerToken(token))
        .filter(Boolean);
    return new Set(tokens);
}

function collectTrackerTokens(tracked) {
    const tokens = [];
    const requestIds = Array.isArray(tracked?.requestIds) ? tracked.requestIds : [];
    tokens.push(...requestIds);
    tokens.push(tracked?.hex);
    tokens.push(tracked?.uid);
    return Array.from(new Set(tokens.map((value) => normaliseTrackerToken(value)).filter(Boolean)));
}

function hasTrackedTokenInSnapshot(tracked, snapshot) {
    const observedTokens = getSnapshotObservedTokens(snapshot);
    if (observedTokens.size === 0) return false;
    return collectTrackerTokens(tracked).some((token) => observedTokens.has(token));
}

function deriveQueueTrackerStatus(tracked) {
    if (hasTrackedTokenInSnapshot(tracked, latestProcessingSnapshot)) return 'processing';
    if (hasTrackedTokenInSnapshot(tracked, latestQueuedSnapshot)) return 'queued';
    return 'submitted';
}

function extractRequestIdsFromResult(result) {
    if (!result || typeof result !== 'object') return [];
    const candidates = [
        result.requestId,
        result.requestID,
        result.request_id,
        result.queuedRequestId,
        result.id,
        result?.request?.id,
    ];
    if (Array.isArray(result.requestIds)) candidates.push(...result.requestIds);
    if (Array.isArray(result.ids)) candidates.push(...result.ids);
    return Array.from(new Set(candidates.map((value) => normaliseTrackerToken(value)).filter(Boolean)));
}

async function fetchQueueSnapshot(url) {
    try {
        const response = await fetch(`${url}?ts=${Date.now()}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) return null;
        const payload = await response.json();
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

async function pollQueueDepthSnapshots() {
    const statusEl = document.getElementById('queue-depth-status');
    const queuedEl = document.getElementById('queue-depth-queued');
    const processingEl = document.getElementById('queue-depth-processing');
    const observedToggleEl = document.getElementById('queue-depth-observed-toggle');
    const observedDetailsEl = document.getElementById('queue-depth-observed-details');
    const updatedEl = document.getElementById('queue-depth-updated');
    if (!statusEl || !queuedEl || !processingEl || !updatedEl) {
        return;
    }

    const [queuedSnapshot, processingSnapshot] = await Promise.all([
        fetchQueueSnapshot(QUEUED_REQUESTS_RUNTIME_URL),
        fetchQueueSnapshot(PROCESSING_REQUESTS_RUNTIME_URL),
    ]);
    latestQueuedSnapshot = queuedSnapshot;
    latestProcessingSnapshot = processingSnapshot;

    const hasAnySnapshot = Boolean(queuedSnapshot || processingSnapshot);
    statusEl.textContent = hasAnySnapshot ? 'Queue snapshots loaded' : 'Queue snapshots unavailable';
    statusEl.className = `status-text ${hasAnySnapshot ? 'status-success' : 'status-error'}`;

    queuedEl.textContent = `scoutsRequests: ${formatQueueSnapshotCount(queuedSnapshot)}`;
    processingEl.textContent = `scoutsProcessing: ${formatQueueSnapshotCount(processingSnapshot)}`;

    const observedBits = [];
    const queuedObserved = formatObservedIds(queuedSnapshot);
    const processingObserved = formatObservedIds(processingSnapshot);
    if (queuedObserved !== 'n/a') observedBits.push(`queued(${queuedObserved})`);
    if (processingObserved !== 'n/a') observedBits.push(`processing(${processingObserved})`);
    if (observedToggleEl && observedDetailsEl) {
        const hasObservedIds = observedBits.length > 0;
        observedToggleEl.hidden = !hasObservedIds;
        if (!hasObservedIds && observedToggleEl.open) {
            observedToggleEl.open = false;
        }
        observedDetailsEl.textContent = hasObservedIds ? observedBits.join(' | ') : 'No observed IDs';
    }

    const timestamps = [queuedSnapshot?.updatedAt, processingSnapshot?.updatedAt]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .map((value) => new Date(value))
        .filter((date) => !Number.isNaN(date.getTime()));
    if (timestamps.length > 0) {
        const mostRecent = timestamps.sort((a, b) => b.getTime() - a.getTime())[0];
        updatedEl.textContent = `Last update: ${mostRecent.toLocaleString('en-GB')}`;
    } else {
        updatedEl.textContent = 'Last update: n/a';
    }

    reconcileRequeueTrackerEntries();
    renderRequeueTracker();
}

function showError(message) {
    const container = document.getElementById('events-container');
    container.innerHTML = `<div class="error">${message}</div>`;
}

// Generate a unique identifier for an event (UID or HEX)
function generateEventUID(event, index) {
    // If event has a uid, use it
    if (event.uid) return event.uid;
    
    // Generate a hex UID based on event data
    const uniqueString = `${event.summary || ''}_${event.dtstart || ''}_${index}`;
    let hash = 0;
    for (let i = 0; i < uniqueString.length; i++) {
        const char = uniqueString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to hex and pad to 8 characters
    return Math.abs(hash).toString(16).padStart(8, '0');
}

// Get image URL from event data
function normaliseImagePath(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    if (trimmed.startsWith('/')) {
        return trimmed;
    }
    return `/${trimmed.replace(/^(\.\/)+/, '')}`;
}

function getImageUrl(event) {
    let candidate = null;
    if (event.image) {
        if (typeof event.image === 'string') candidate = event.image;
        else if (event.image.url) candidate = event.image.url;
        else if (event.image.src) candidate = event.image.src;
    } else if (event.imageUrl) {
        candidate = event.imageUrl;
    }
    return normaliseImagePath(candidate);
}

// Get tagline from event data (prioritise `tagline`, fallback to legacy `AI`)
function getAIPrompt(event) {
    if (!event || typeof event !== 'object') return null;
    return event.tagline || event.AI || event.ai || event.aiPrompt || null;
}

function getImagePrompt(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.image && typeof event.image === 'object' && typeof event.image.prompt === 'string') {
        const trimmed = event.image.prompt.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function getMissingMetadataFields(event) {
    const missing = [];
    if (!hasText(getAIPrompt(event))) {
        missing.push('Tagline');
    }
    if (!hasText(getImagePrompt(event))) {
        missing.push('Image Prompt');
    }
    if (!hasText(getImageUrl(event))) {
        missing.push('Image URL');
    }
    return missing;
}

// Determine event section/type
function getEventSection(event) {
    const type = (event.icsType || event.section || '').toLowerCase();
    if (type.includes('beaver')) return 'beavers';
    if (type.includes('cub')) return 'cubs';
    if (type.includes('scout')) return 'scouts';
    return 'all';
}

function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isHiddenEvent(event) {
    const statusValue = typeof event?.status === 'string' ? event.status.trim().toLowerCase() : '';
    return statusValue === 'hidden' || Boolean(event?.hiddenAt);
}

function getEventMergeKey(event, index) {
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (hex) return `hex:${hex}`;

    const uid = hasText(event?.uid) ? event.uid.trim() : '';
    if (uid) return `uid:${uid}`;

    return `generated:${generateEventUID(event, index)}`;
}

function cloneEventRecord(event) {
    try {
        return JSON.parse(JSON.stringify(event || {}));
    } catch {
        return { ...(event || {}) };
    }
}

function mergeEventMetadata(targetEvent, sourceEvent) {
    if (!targetEvent || !sourceEvent) return;

    if (!hasText(targetEvent.hex) && hasText(sourceEvent.hex)) {
        targetEvent.hex = sourceEvent.hex.trim();
    }

    if (!hasText(targetEvent.uid) && hasText(sourceEvent.uid)) {
        targetEvent.uid = sourceEvent.uid.trim();
    }

    if (!hasText(targetEvent.summary) && hasText(sourceEvent.summary)) {
        targetEvent.summary = sourceEvent.summary;
    }

    if (!hasText(targetEvent.title) && hasText(sourceEvent.title)) {
        targetEvent.title = sourceEvent.title;
    }

    if (!hasText(targetEvent.location) && hasText(sourceEvent.location)) {
        targetEvent.location = sourceEvent.location;
    }

    if (!hasText(getAIPrompt(targetEvent)) && hasText(getAIPrompt(sourceEvent))) {
        targetEvent.tagline = getAIPrompt(sourceEvent);
    }

    if (!hasText(getImageUrl(targetEvent)) && hasText(getImageUrl(sourceEvent))) {
        if (!targetEvent.image || typeof targetEvent.image !== 'object') {
            targetEvent.image = {};
        }
        targetEvent.image.url = getImageUrl(sourceEvent);
    }

    if (!hasText(getImagePrompt(targetEvent)) && hasText(getImagePrompt(sourceEvent))) {
        if (!targetEvent.image || typeof targetEvent.image !== 'object') {
            targetEvent.image = {};
        }
        targetEvent.image.prompt = getImagePrompt(sourceEvent);
    }
}

function buildUniqueEventEntries(events) {
    const grouped = new Map();

    (events || []).forEach((event, index) => {
        const key = getEventMergeKey(event, index);
        const hidden = isHiddenEvent(event);
        const sourceUid = hasText(event?.uid) ? event.uid.trim() : generateEventUID(event, index);
        const existing = grouped.get(key);

        if (!existing) {
            grouped.set(key, {
                key,
                event: cloneEventRecord(event),
                firstIndex: index,
                duplicateCount: 1,
                hiddenCount: hidden ? 1 : 0,
                sourceDetails: [{ index, uid: sourceUid }],
            });
            return;
        }

        existing.duplicateCount += 1;
        if (hidden) {
            existing.hiddenCount += 1;
        }
        existing.sourceDetails.push({ index, uid: sourceUid });
        mergeEventMetadata(existing.event, event);
    });

    return Array.from(grouped.values()).map((entry) => ({
        ...entry,
        allHidden: entry.hiddenCount === entry.duplicateCount,
    }));
}

function getEntryIdentifier(entry) {
    const event = entry?.event || {};
    if (hasText(event.uid)) return event.uid.trim();
    if (hasText(event.hex)) return `hex:${event.hex.trim()}`;
    return generateEventUID(event, entry?.firstIndex ?? 0);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTrackerTimestamp(isoString) {
    if (!isoString) return 'n/a';
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) return isoString;
    return parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function normaliseMissingFields(fields) {
    if (!Array.isArray(fields)) return [];
    return Array.from(new Set(fields.map((field) => String(field || '').trim()).filter(Boolean)));
}

function isSameMissingSet(a, b) {
    const left = normaliseMissingFields(a).sort();
    const right = normaliseMissingFields(b).sort();
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function findMatchingEntryForTracker(tracked) {
    const trackedHex = hasText(tracked?.hex) ? tracked.hex.trim().toLowerCase() : '';
    if (trackedHex) {
        const byHex = uniqueEventEntries.find((entry) => {
            const entryHex = hasText(entry?.event?.hex) ? entry.event.hex.trim().toLowerCase() : '';
            return entryHex === trackedHex;
        });
        if (byHex) return byHex;
    }

    const trackedUid = hasText(tracked?.uid) ? tracked.uid.trim() : '';
    if (trackedUid) {
        const byUid = uniqueEventEntries.find((entry) => hasText(entry?.event?.uid) && entry.event.uid.trim() === trackedUid);
        if (byUid) return byUid;
    }

    if (hasText(tracked?.entryKey)) {
        return uniqueEventEntries.find((entry) => entry?.key === tracked.entryKey) || null;
    }

    return null;
}

function recordRequeueTrackerEntry(entry, requestedMissing, commandResult = null) {
    const event = entry?.event || {};
    const normalizedRequested = normaliseMissingFields(requestedMissing);
    const requestIds = extractRequestIdsFromResult(commandResult);
    const tracked = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        title: event.summary || event.title || 'Untitled Event',
        hex: hasText(event?.hex) ? event.hex.trim().toLowerCase() : '',
        uid: hasText(event?.uid) ? event.uid.trim() : '',
        requestIds,
        entryKey: hasText(entry?.key) ? entry.key : '',
        requestedAt: new Date().toISOString(),
        lastCheckedAt: null,
        requestedMissing: normalizedRequested,
        latestMissing: normalizedRequested,
        status: 'submitted',
    };

    requeueTrackerEntries = [tracked, ...requeueTrackerEntries].slice(0, MAX_TRACKED_REQUEUE_ENTRIES);
    renderRequeueTracker();
}

function reconcileRequeueTrackerEntries() {
    if (!Array.isArray(requeueTrackerEntries) || requeueTrackerEntries.length === 0) {
        return;
    }

    const checkedAtIso = new Date().toISOString();
    requeueTrackerEntries = requeueTrackerEntries.map((tracked) => {
        const match = findMatchingEntryForTracker(tracked);
        const next = { ...tracked, lastCheckedAt: checkedAtIso };
        const queueStatus = deriveQueueTrackerStatus(next);

        if (queueStatus === 'processing' || queueStatus === 'queued') {
            next.status = queueStatus;
            return next;
        }

        if (!match || !match.event) {
            if (next.status !== 'resolved') {
                next.status = 'not-found';
            }
            return next;
        }

        next.title = match.event.summary || match.event.title || next.title;
        const currentMissing = getMissingMetadataFields(match.event);
        next.latestMissing = currentMissing;

        if (currentMissing.length === 0) {
            next.status = 'resolved';
            return next;
        }

        next.status = 'submitted';
        return next;
    });
}

function statusLabelForTracker(status) {
    if (status === 'submitted') return 'Submitted';
    if (status === 'processing') return 'Processing';
    if (status === 'resolved') return 'Resolved';
    if (status === 'updated') return 'Updated';
    if (status === 'not-found') return 'Not Found';
    return 'Queued';
}

function renderRequeueTracker() {
    const tbody = document.getElementById('requeue-tracker-body');
    const summary = document.getElementById('requeue-tracker-summary');
    const lastScan = document.getElementById('requeue-tracker-last-scan');
    if (!tbody || !summary || !lastScan) return;

    const total = requeueTrackerEntries.length;
    const resolved = requeueTrackerEntries.filter((entry) => entry.status === 'resolved').length;
    const open = total - resolved;
    summary.textContent = total === 0
        ? 'No requeue requests submitted yet.'
        : `${open} open, ${resolved} resolved (${total} tracked).`;
    lastScan.textContent = lastAgendaScanAtIso
        ? `Last scan: ${new Date(lastAgendaScanAtIso).toLocaleTimeString('en-GB')}`
        : 'Last scan: not started.';

    if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="4">No requeue requests yet.</td></tr>';
        return;
    }

    tbody.innerHTML = requeueTrackerEntries.map((entry) => {
        const statusClass = `request-status-pill request-status-${entry.status}`;
        const missingText = entry.latestMissing.length > 0 ? entry.latestMissing.join(', ') : 'None';
        return `<tr>
            <td>${escapeHtml(entry.title)}</td>
            <td><span class="${statusClass}">${escapeHtml(statusLabelForTracker(entry.status))}</span></td>
            <td>${escapeHtml(missingText)}</td>
            <td>${escapeHtml(formatTrackerTimestamp(entry.requestedAt))}</td>
        </tr>`;
    }).join('');
}

// Render all events
function renderEvents() {
    const container = document.getElementById('events-container');
    
    if (uniqueEventEntries.length === 0) {
        console.warn('[Admin] No events found after loading');
        container.innerHTML = '<p class="loading">No events found.</p>';
        return;
    }

    visibleEventEntries = uniqueEventEntries.filter((entry) => {
        const event = entry.event;
        switch (activeFilter) {
            case 'new':
                return isNewEvent(event);
            case 'missing':
                return (() => {
                    const missingCount = getMissingMetadataFields(event).length;
                    return missingCount > 0 && missingCount < 3;
                })();
            case 'hidden':
                return entry.allHidden;
            case 'complete':
                return isCompleteEvent(event);
            case 'approval':
                return getMissingMetadataFields(event).length > 0 && hasText(event?.hex);
            case 'all':
            default:
                return true;
        }
    });

    if (visibleEventEntries.length === 0) {
        container.innerHTML = '<p class="loading">No events match the selected filter.</p>';
        return;
    }

    container.innerHTML = visibleEventEntries.map((entry, index) => {
        const event = entry.event;
        const imageUrl = getImageUrl(event);
        const tagline = getAIPrompt(event);
        const imagePrompt = getImagePrompt(event);
        const missingFields = getMissingMetadataFields(event);
        const requeueEligible = missingFields.length > 0;
        const section = getEventSection(event);
        const isHidden = entry.allHidden;
        const title = event.summary || event.title || 'Untitled Event';
        const eventUID = getEntryIdentifier(entry);
        const sourceDetailsMarkup = entry.sourceDetails?.length
            ? entry.sourceDetails
                .map((detail) => `<div class="event-identifiers-row"><span>Event Index:</span> <code>${detail.index}</code> <span>UID:</span> <code>${detail.uid}</code></div>`)
                .join('')
            : '<div class="event-identifiers-row">No source details</div>';
        if (!event.dtstart) {
            console.warn('[Admin] Event missing dtstart', { index, uid: eventUID, title });
        }
        
        return `
            <div class="event-card">
                <div class="event-image-container">
                    ${imageUrl 
                        ? `<img src="${imageUrl}" alt="${title}" class="event-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22%3E%3Crect fill=%22%23ddd%22 width=%22400%22 height=%22300%22/%3E%3Ctext fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22%3ENo Image%3C/text%3E%3C/svg%3E'">` 
                        : `<div class="event-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999;">No Image</div>`
                    }
                    <span class="event-badge ${section}">${section}</span>
                    ${isHidden ? `<span class="event-badge hidden">Hidden</span>` : ''}
                </div>
                <div class="event-details">
                    <h3 class="event-title">${title}</h3>
                    <details class="event-identifiers">
                        <summary>Identifiers</summary>
                        <div class="event-identifiers-body">
                            <div class="event-identifiers-row"><span>UID:</span> <code>${eventUID}</code></div>
                            <div class="event-identifiers-row"><span>HEX:</span> <code>${event.hex || 'Missing HEX'}</code></div>
                            <div class="event-identifiers-row"><span>Image URL:</span> <code>${imageUrl || 'Not set'}</code></div>
                            <div class="event-identifiers-row"><span>Occurrences:</span> <code>${entry.duplicateCount}</code></div>
                            ${sourceDetailsMarkup}
                        </div>
                    </details>

                    ${imagePrompt ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">Image Prompt</div>
                            <div class="ai-prompt-text">${imagePrompt}</div>
                        </div>
                    ` : ''}

                    ${tagline ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">Tagline</div>
                            <div class="ai-prompt-text">${tagline}</div>
                        </div>
                    ` : ''}

                    ${requeueEligible
                        ? `<p class="requeue-hint">Missing: ${missingFields.join(', ')}</p>`
                        : `<p class="requeue-hint requeue-ready">Metadata complete. No requeue needed.</p>`
                    }
                    <div class="event-actions">
                        <button 
                            class="btn btn-primary"
                            onclick="openUploadModal(${index})"
                        >
                            View Details
                        </button>
                        ${requeueEligible
                            ? `<button class="btn btn-secondary requires-api" onclick="requeueEvent(${index})">Requeue Missing Fields</button>`
                            : ''
                        }
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function normaliseEventDateString(value) {
    if (!value || typeof value !== 'string') return value;
    const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z?)$/i);
    if (!match) return value;
    const [, y, m, d, rawH, rawM, rawS, suffix] = match;
    const hh = rawH ?? '00';
    const mm = rawM ?? '00';
    const ss = rawS ?? '00';
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}${suffix || ''}`;
}

// Format date string
function formatDate(dateString) {
    try {
        const normalised = normaliseEventDateString(dateString);
        const date = new Date(normalised || dateString);
        if (Number.isNaN(date.getTime())) {
            return dateString;
        }
        return date.toLocaleString('en-GB', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        return dateString;
    }
}

// Open upload modal
function openUploadModal(index) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        return;
    }

    currentEventIndex = index;
    const entry = visibleEventEntries[index];
    if (!entry || !entry.event) {
        updateRuntimeDetails('Unable to open editor for selected event.', 'error');
        return;
    }
    const event = entry.event;
    const modal = document.getElementById('upload-modal');
    
    document.getElementById('modal-event-name').textContent = event.summary || event.title || 'Event ' + index;
    document.getElementById('modal-event-hex').textContent = event.hex || 'Missing HEX';
    
    const currentImage = getImageUrl(event);
    const imgElement = document.getElementById('modal-current-image');
    if (currentImage) {
        imgElement.src = currentImage;
        imgElement.style.display = 'block';
    } else {
        imgElement.style.display = 'none';
    }
    
    const imageUrlText = document.getElementById('modal-image-url');
    const imagePromptText = document.getElementById('modal-image-prompt');
    const taglineText = document.getElementById('modal-tagline');
    const requeueButton = document.getElementById('modal-requeue-button');
    const requeueHint = document.getElementById('modal-requeue-hint');
    if (imageUrlText) imageUrlText.textContent = currentImage || 'Not set';
    if (imagePromptText) imagePromptText.textContent = getImagePrompt(event) || 'Not set';
    if (taglineText) taglineText.textContent = getAIPrompt(event) || 'Not set';
    const missing = getMissingMetadataFields(event);
    if (requeueButton) {
        requeueButton.style.display = missing.length > 0 ? 'inline-block' : 'none';
    }
    if (requeueHint) {
        if (missing.length > 0) {
            requeueHint.textContent = `Eligible for requeue: missing ${missing.join(', ')}.`;
            requeueHint.className = 'refresh-status error';
        } else {
            requeueHint.textContent = 'Metadata complete. Requeue is not required.';
            requeueHint.className = 'refresh-status success';
        }
    }
    document.getElementById('modal-status').textContent = '';
    document.getElementById('modal-status').className = 'status-text';
    
    modal.style.display = 'flex';
}

// Close upload modal
function closeUploadModal() {
    const modal = document.getElementById('upload-modal');
    modal.style.display = 'none';
    currentEventIndex = null;
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('upload-modal');
    if (event.target === modal) {
        closeUploadModal();
    }
}

// Lambda refresh functionality
async function refreshLambda() {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        const statusElement = document.getElementById('refresh-status');
        statusElement.textContent = 'Admin API auth not ready';
        statusElement.className = 'refresh-status error';
        return;
    }

    const actionInput = document.getElementById('refresh-action');
    const statusElement = document.getElementById('refresh-status');
    const action = actionInput.value;
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        statusElement.textContent = 'Lambda currently running. Wait for completion.';
        statusElement.className = 'refresh-status error';
        return;
    }

    // Validate input
    if (!action || action.trim() === '') {
        statusElement.textContent = 'Please enter an action number';
        statusElement.className = 'refresh-status error';
        return;
    }

    // Show loading state
    statusElement.textContent = 'Sending request...';
    statusElement.className = 'refresh-status loading';

    const actionCount = parseInt(action, 10);
    const payload = {
        realm: 'scouts',
        subject: 'agenda',
        action: Number.isFinite(actionCount) ? actionCount : 0,
    };

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollLambdaRuntimeStatus(true);

        const resultText = result?.status || result?.message || 'ok';
        const modifiedEvents = Array.isArray(result?.modifiedEvents) ? result.modifiedEvents : [];
        const modifiedCount = Number.isFinite(result?.modifiedEventsCount)
            ? result.modifiedEventsCount
            : modifiedEvents.length;
        const modifiedSuffix = modifiedCount > 0 ? ` (${modifiedCount} events modified)` : ' (no event metadata changes)';
        statusElement.textContent = `Agenda events refresh completed: ${resultText}${modifiedSuffix}`;
        statusElement.className = 'refresh-status success';
        if (modifiedEvents.length > 0) {
            const preview = modifiedEvents
                .slice(0, 5)
                .map((entry) => entry?.title || entry?.hex || entry?.uid || entry?.key || 'unknown')
                .join(' | ');
            updateRuntimeDetails(`Modified events: ${preview}${modifiedEvents.length > 5 ? ' ...' : ''}`, 'success');
        }

        // Optionally reload events after a short delay
        setTimeout(() => {
            loadEvents();
            statusElement.textContent = 'Events reloaded';
        }, 2000);

    } catch (error) {
        console.error('Error triggering Lambda:', error);
        const errorMessage = error instanceof TypeError
            ? 'Network/CORS error calling refresh Lambda. Verify Lambda Function URL CORS settings and response headers.'
            : `Error: ${error.message}`;
        statusElement.textContent = errorMessage;
        statusElement.className = 'refresh-status error';
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

async function refreshSelectedCalendar(calendarToken = 'all', label = 'Selected Calendar') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateGlobalRefreshStatus('Admin API auth not ready', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        updateGlobalRefreshStatus('Lambda currently running. Wait for completion.', 'error');
        return;
    }

    const payload = {
        realm: 'scouts',
        subject: calendarToken && calendarToken !== 'all' ? String(calendarToken).trim().toLowerCase() : 'calendars',
        action: 'refresh',
    };

    updateGlobalRefreshStatus(`Refreshing ${label}...`, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollLambdaRuntimeStatus(true);
        const count = Number.isFinite(result?.eventsCount) ? result.eventsCount : null;
        const generatedAt = result?.generatedAt ? new Date(result.generatedAt).toLocaleString('en-GB') : null;
        const countSuffix = count !== null ? ` (${count} events in agenda)` : '';
        const timeSuffix = generatedAt ? ` at ${generatedAt}` : '';
        updateGlobalRefreshStatus(`Refresh complete for ${label}${countSuffix}${timeSuffix}`, 'success');

        setTimeout(() => {
            loadEvents();
        }, 1200);
    } catch (error) {
        console.error(`Error refreshing ${label}:`, error);
        updateGlobalRefreshStatus(`Failed to refresh ${label}: ${error.message}`, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

async function requeueEvent(eventIndex, fromModal = false) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        const message = 'Lambda currently running. Wait for completion before queueing.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const entry = visibleEventEntries[eventIndex];
    if (!entry || !entry.event) {
        if (fromModal) updateModalStatus('Unable to find selected event entry.', 'error');
        else updateRuntimeDetails('Unable to find selected event entry.', 'error');
        return;
    }

    const event = entry.event;
    const eventLabel = event.summary || event.title || `Event ${eventIndex + 1}`;
    const missing = getMissingMetadataFields(event);
    if (missing.length === 0) {
        const message = 'Event metadata is complete. Requeue not required.';
        if (fromModal) updateModalStatus(message, 'info');
        else updateRuntimeDetails(message, 'info');
        return;
    }

    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (!hex) {
        const message = 'Cannot requeue: event is missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    if (!subject.image || typeof subject.image !== 'object') {
        subject.image = {};
    }
    if (!hasText(subject.tagline) && hasText(subject.AI)) {
        subject.tagline = subject.AI;
    }
    if (!hasText(subject.tagline)) subject.tagline = null;
    if (!hasText(subject.image.prompt)) subject.image.prompt = null;
    if (!hasText(subject.image.url)) subject.image.url = null;

    const payload = {
        realm: 'scouts',
        subject: 'scoutsRequest',
        action: 'requeue',
        event: subject,
    };

    const loadingMessage = `Requeueing "${eventLabel}" (missing: ${missing.join(', ')})...`;
    if (fromModal) updateModalStatus(loadingMessage, 'loading');
    else pinRuntimeDetails(loadingMessage, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        const queueAcceptedSuffix = result?.queueAccepted === true ? ' Queue accepted.' : '';
        const statusCode = Number.isFinite(result?._httpStatus) ? result._httpStatus : 200;
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const successMessage = `Requeue request submitted for "${eventLabel}" [HTTP ${statusCode}].${queueAcceptedSuffix}${backendMessage}`;
        if (fromModal) updateModalStatus(successMessage, 'success');
        else pinRuntimeDetails(successMessage, 'success');
        recordRequeueTrackerEntry(entry, missing, result);
    } catch (error) {
        console.error('Error requeueing event:', error);
        const failureMessage = `Failed to requeue event: ${error.message}`;
        if (fromModal) updateModalStatus(failureMessage, 'error');
        else pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

function requeueCurrentEvent() {
    if (currentEventIndex === null) {
        updateModalStatus('Open an event first before requeueing.', 'error');
        return;
    }
    requeueEvent(currentEventIndex, true);
}


// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    setApiActionState(false);
    checkApiAuthStatus();
    loadEvents();
    renderRequeueTracker();
    pollQueueDepthSnapshots();
    setInterval(() => {
        pollLambdaRuntimeStatus(true);
    }, 5000);
    setInterval(() => {
        pollQueueDepthSnapshots();
    }, 10000);
    setInterval(() => {
        loadEvents({ silent: true });
    }, AGENDA_POLL_INTERVAL_MS);
});
