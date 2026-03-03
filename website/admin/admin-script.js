// Admin Script for Event Images Management

let eventsData = [];
let uniqueEventEntries = [];
let visibleEventEntries = [];
let currentEventIndex = null;
let apiAuthReady = false;
let lambdaRuntimeRunning = false;
let uiCommandInFlight = false;
let showHiddenEvents = false;
let showCompleteEvents = false;
let agendaPayload = null;
let pinnedRuntimeDetails = null;
const MIN_RUNTIME_DETAILS_VISIBLE_MS = 5000;
let runtimeDetailsLastShownAt = 0;
let runtimeDetailsLastMessage = '';
let runtimeDetailsLastType = 'info';
let runtimeDetailsPending = null;
let runtimeDetailsFlushTimer = null;
const ADMIN_API_BASE = window.ADMIN_API_BASE || '/admin-api';
const SCOUTS_REFRESH_URL = window.SCOUTS_REFRESH_URL || `${ADMIN_API_BASE}/scouts`;
const AUTH_STATUS_URL = window.SCOUTS_AUTH_STATUS_URL || `${ADMIN_API_BASE}/auth-status`;

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

function updateHiddenEventsUi() {
    const toggleButton = document.getElementById('toggle-hidden-events');
    const hiddenSummary = document.getElementById('hidden-summary');
    const hiddenCount = uniqueEventEntries.filter((entry) => entry.allHidden).length;

    if (toggleButton) {
        toggleButton.textContent = showHiddenEvents ? 'Hide Hidden' : 'Show Hidden';
    }

    if (hiddenSummary) {
        if (hiddenCount === 0) {
            hiddenSummary.textContent = 'No hidden events in agenda.';
        } else if (showHiddenEvents) {
            hiddenSummary.textContent = `Showing ${hiddenCount} hidden event group${hiddenCount !== 1 ? 's' : ''}.`;
        } else {
            hiddenSummary.textContent = `${hiddenCount} hidden event group${hiddenCount !== 1 ? 's' : ''} collapsed.`;
        }
    }
}

function toggleHiddenEvents() {
    showHiddenEvents = !showHiddenEvents;
    updateHiddenEventsUi();
    renderEvents();
}

function isCompleteEvent(event) {
    return hasText(getAIPrompt(event)) && hasText(getImagePrompt(event)) && hasText(getImageUrl(event));
}

function updateCompleteEventsUi() {
    const toggleButton = document.getElementById('toggle-complete-events');
    const summary = document.getElementById('complete-summary');
    const completeCount = uniqueEventEntries.filter((entry) => isCompleteEvent(entry.event)).length;

    if (toggleButton) {
        toggleButton.textContent = showCompleteEvents ? 'Hide Complete' : 'Show Complete';
    }

    if (summary) {
        if (completeCount === 0) {
            summary.textContent = 'No complete events in agenda.';
        } else if (showCompleteEvents) {
            summary.textContent = `Showing ${completeCount} complete event group${completeCount !== 1 ? 's' : ''}.`;
        } else {
            summary.textContent = `${completeCount} complete event group${completeCount !== 1 ? 's' : ''} collapsed.`;
        }
    }
}

function toggleCompleteEvents() {
    showCompleteEvents = !showCompleteEvents;
    updateCompleteEventsUi();
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
async function loadEvents() {
    try {
        // Try to load from parent directory (assuming admin is in website/admin/)
        const response = await fetch('../../agenda.json');
        
        if (!response.ok) {
            throw new Error('Failed to load events.json: ' + response.status);
        }

        const data = await response.json();
        agendaPayload = data;
        eventsData = data.events || [];
        uniqueEventEntries = buildUniqueEventEntries(eventsData);
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
        updateHiddenEventsUi();
        updateCompleteEventsUi();
        renderEvents();
        renderAgendaViewerContent();
        renderEventsJsonViewerContent();
    } catch (error) {
        console.error('Error loading events:', error);
        showError('Failed to load events data. Please ensure agenda.json exists and is accessible.');
    }
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

// Get AI prompt from event data
function getAIPrompt(event) {
    return event.AI || event.ai || event.aiPrompt || null;
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
        missing.push('AI Tagline');
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
        targetEvent.AI = getAIPrompt(sourceEvent);
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

// Render all events
function renderEvents() {
    const container = document.getElementById('events-container');
    
    if (uniqueEventEntries.length === 0) {
        console.warn('[Admin] No events found after loading');
        container.innerHTML = '<p class="loading">No events found.</p>';
        return;
    }

    visibleEventEntries = uniqueEventEntries.filter((entry) => {
        const hiddenAllowed = showHiddenEvents || !entry.allHidden;
        const completeAllowed = showCompleteEvents || !isCompleteEvent(entry.event);
        return hiddenAllowed && completeAllowed;
    });

    if (visibleEventEntries.length === 0) {
        container.innerHTML = '<p class="loading">No events match current filters. Use "Show Hidden" or "Show Complete".</p>';
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
                    <p class="event-index">UID: ${eventUID} | Occurrences: ${entry.duplicateCount}</p>
                    ${event.hex ? `<p class="event-index">HEX: ${event.hex}</p>` : ''}
                    ${entry.sourceDetails?.length
                        ? `<div class="image-info"><strong>Grouped Source Events:</strong>${entry.sourceDetails.map((detail) => `<div class="image-url">Event Index: ${detail.index} | UID: ${detail.uid}</div>`).join('')}</div>`
                        : ''
                    }
                    
                    ${imageUrl ? `
                        <div class="image-info">
                            <strong>Image URL:</strong>
                            <div class="image-url">${imageUrl}</div>
                        </div>
                    ` : '<p class="no-ai-prompt">No image configured</p>'}

                    ${imagePrompt ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">Image Prompt</div>
                            <div class="ai-prompt-text">${imagePrompt}</div>
                        </div>
                    ` : '<p class="no-ai-prompt">No image prompt</p>'}

                    ${tagline ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">Tagline</div>
                            <div class="ai-prompt-text">${tagline}</div>
                        </div>
                    ` : '<p class="no-ai-prompt">No tagline</p>'}

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
    if (!hasText(subject.AI)) subject.AI = null;
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
    setInterval(() => {
        pollLambdaRuntimeStatus(true);
    }, 5000);
});
