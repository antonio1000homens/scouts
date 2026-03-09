// Admin Script for Event Images Management

let eventsData = [];
let uniqueEventEntries = [];
let visibleEventEntries = [];
let currentEventIndex = null;
let apiAuthReady = false;
let lambdaRuntimeRunning = false;
let uiCommandInFlight = false;
let activeFilter = 'all';
let agendaPayload = null;
let agendaLoadInFlight = false;
let latestQueuedSnapshot = null;
let latestProcessingSnapshot = null;
let latestCompletedSnapshot = null;
let pinnedRuntimeDetails = null;
const MIN_RUNTIME_DETAILS_VISIBLE_MS = 5000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS = 20000;
const HEX_NOT_FOUND_BACKOFF_MS = 30000;
const COMPLETED_REQUEST_HIDE_AFTER_MS = 10 * 60 * 1000;
const AUTO_LAMBDA_PREF_KEY = 'scouts_admin_auto_lambda_enabled';
const AUTO_LAMBDA_INTERVAL_PREF_KEY = 'scouts_admin_auto_lambda_interval_ms';
const AGENDA_AUTO_REFRESH_PREF_KEY = 'scouts_admin_agenda_auto_refresh_enabled';
const AGENDA_URL = '/agenda.json';
const FALLBACK_AGENDA_URL = 'https://2ndtolworth.s3.eu-west-2.amazonaws.com/agenda.json';
const STATUS_POLL_PREF_KEY = 'scouts_admin_status_poll_enabled';
const STATUS_POLL_INTERVAL_PREF_KEY = 'scouts_admin_status_poll_interval_seconds';
const HEX_PREVIEW_AUTO_REFRESH_PREF_KEY = 'scouts_admin_hex_preview_auto_refresh';
const HEX_PREVIEW_INTERVAL_PREF_KEY = 'scouts_admin_hex_preview_interval_ms';
let runtimeDetailsLastShownAt = 0;
let runtimeDetailsLastMessage = '';
let runtimeDetailsLastType = 'info';
let runtimeDetailsPending = null;
let runtimeDetailsFlushTimer = null;
let autoLambdaInvokeInFlight = false;
let autoLambdaInvokeEnabled = true;
let autoLambdaInvokeIntervalMs = DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS;
let autoLambdaInvokeTimer = null;
let agendaAutoRefreshEnabled = true;
let statusPollingEnabled = true;
let statusPollingIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS;
let statusPollingTimer = null;
let statusPollingInFlight = false;
let lastObservedRuntimeCompletedAt = '';
let latestCompletedRequests = [];
let latestCompletedRequestsUpdatedAt = null;
let cachedAiConfig = null;
let cachedAiConfigLoadedAt = 0;
let aiConfigLoadPromise = null;
const missingHexRetryAtByHex = new Map();
const warnedMissingDtstartIds = new Set();
const localVisibilityOverrides = new Map();
const ADMIN_API_BASE = window.ADMIN_API_BASE || '/admin-api';
const SCOUTS_REFRESH_URL = window.SCOUTS_REFRESH_URL || `${ADMIN_API_BASE}/scouts`;
const AUTH_STATUS_URL = window.SCOUTS_AUTH_STATUS_URL || `${ADMIN_API_BASE}/auth-status`;
const QUEUED_REQUESTS_RUNTIME_URL = '../../runtime/scoutsqueued.json';
const PROCESSING_REQUESTS_RUNTIME_URL = '../../runtime/scoutsprocessing.json';
const COMPLETED_REQUESTS_RUNTIME_URL = '../../runtime/scoutscompleted.json';
const AI_CONFIG_URL = '../../AI.conf';
const AI_CONFIG_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_IMAGE_GENERATION_PROMPT_TEMPLATE = 'cartoonish image of scouts in {{IMAGE_THEME}}, {{IMAGE_PROMPT_SPECIFICATIONS}}';
const DEFAULT_IMAGE_GENERATION_PROMPT_SPECIFICATIONS = [
    'landscape 4:3 composition suitable for website event cards',
    'approximately 1600x1200',
    'main subjects centered',
    'safe margins for crop',
];
const HEX_PREVIEW_POLL_INTERVAL_MS = 5000;
let activeHexPreviewCardIndex = null;
let activeHexPreviewHex = null;
let activeHexPreviewPollTimer = null;
let hexPreviewAutoRefreshEnabled = false;
let hexPreviewIntervalMs = HEX_PREVIEW_POLL_INTERVAL_MS;

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
    return hasText(getAIPrompt(event)) && hasText(getImageGenerationPrompt(event)) && hasText(getImageUrl(event));
}

function isNewEvent(event) {
    return !hasText(getAIPrompt(event)) && !hasText(getImageGenerationPrompt(event)) && !hasText(getImageUrl(event));
}

function isEntryMissingMetadata(entry) {
    if (isEntryHidden(entry)) return false;
    const missingCount = getMissingMetadataFields(entry?.event).length;
    return missingCount > 0 && missingCount < 3;
}

function isEntryComplete(entry) {
    if (isEntryHidden(entry)) return false;
    return isCompleteEvent(entry?.event);
}

function isEntryPendingApproval(entry) {
    if (isEntryHidden(entry)) return false;
    return getMissingMetadataFields(entry?.event).length > 0 && hasText(entry?.event?.hex);
}

function getFilterCounts() {
    return {
        new: uniqueEventEntries.filter((entry) => !isEntryHidden(entry) && isNewEvent(entry.event)).length,
        all: uniqueEventEntries.length,
        missing: uniqueEventEntries.filter((entry) => isEntryMissingMetadata(entry)).length,
        hidden: uniqueEventEntries.filter((entry) => isEntryHidden(entry)).length,
        complete: uniqueEventEntries.filter((entry) => isEntryComplete(entry)).length,
        approval: uniqueEventEntries.filter((entry) => isEntryPendingApproval(entry)).length,
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

function setViewerOpen(viewerId, shouldShow) {
    const viewer = document.getElementById(viewerId);
    if (!viewer) return null;
    viewer.style.display = shouldShow ? 'flex' : 'none';
    return viewer;
}

function closeAllViewers(exceptViewerId = '') {
    ['agenda-viewer', 'events-json-viewer', 'ai-config-viewer'].forEach((viewerId) => {
        if (viewerId === exceptViewerId) return;
        setViewerOpen(viewerId, false);
    });
}

function handleViewerBackdropClick(event) {
    if (event.target !== event.currentTarget) return;
    event.currentTarget.style.display = 'none';
}

function showAgendaViewer() {
    closeAllViewers('agenda-viewer');
    const viewer = setViewerOpen('agenda-viewer', true);
    if (!viewer) return;
    renderAgendaViewerContent();
}

function toggleAgendaViewer() {
    const viewer = document.getElementById('agenda-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        setViewerOpen('agenda-viewer', false);
        return;
    }
    showAgendaViewer();
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

function showEventsJsonViewer() {
    closeAllViewers('events-json-viewer');
    const viewer = setViewerOpen('events-json-viewer', true);
    if (!viewer) return;
    renderEventsJsonViewerContent();
}

function toggleEventsJsonViewer() {
    const viewer = document.getElementById('events-json-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        setViewerOpen('events-json-viewer', false);
        return;
    }
    showEventsJsonViewer();
}

async function renderAiConfigViewerContent(force = false) {
    const content = document.getElementById('ai-config-content');
    if (!content) return;
    content.textContent = 'Loading AI.conf...';
    try {
        const config = await loadAiConfig(force);
        content.textContent = JSON.stringify(config ?? {}, null, 2);
    } catch (error) {
        content.textContent = `Failed to load AI.conf: ${error.message}`;
    }
}

function showAiConfigViewer() {
    closeAllViewers('ai-config-viewer');
    const viewer = setViewerOpen('ai-config-viewer', true);
    if (!viewer) return;
    renderAiConfigViewerContent(true);
}

function toggleAiConfigViewer() {
    const viewer = document.getElementById('ai-config-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        setViewerOpen('ai-config-viewer', false);
        return;
    }
    showAiConfigViewer();
}

function closeViewerMenu() {
    const menu = document.getElementById('viewer-menu');
    const button = document.getElementById('viewer-menu-button');
    if (menu) {
        menu.classList.remove('is-open');
    }
    if (button) {
        button.setAttribute('aria-expanded', 'false');
    }
}

function toggleViewerMenu(event) {
    if (event) {
        event.stopPropagation();
    }
    const menu = document.getElementById('viewer-menu');
    const button = document.getElementById('viewer-menu-button');
    if (!menu || !button) return;
    const shouldShow = !menu.classList.contains('is-open');
    if (!shouldShow) {
        closeViewerMenu();
        return;
    }
    menu.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
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

function formatCompletedRequestOperation(value) {
    if (!hasText(value)) return 'unknown';
    const normalized = String(value).trim();
    if (normalized === 'processing-complete') return 'Processing Complete';
    if (normalized === 'imagePrompt') return 'Image Theme';
    if (normalized === 'imageUrl') return 'Image URL';
    if (normalized === 'tagline') return 'Tagline';
    if (normalized === 'hidden') return 'Hidden';
    if (normalized === 'persist') return 'Persist';
    if (normalized === 'completed') return 'Completed';
    return normalized;
}

function formatRequestStageLabel(value, fallback = 'Unknown') {
    if (!hasText(value)) return fallback;
    return formatCompletedRequestOperation(value);
}

function formatRequestBadgeClass(value) {
    if (!hasText(value)) return 'badge-unknown';
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'queued') return 'badge-queued';
    if (normalized === 'processing') return 'badge-processing';
    if (normalized === 'processing-complete') return 'badge-processing-complete';
    if (normalized === 'completed') return 'badge-completed';
    if (normalized === 'persist') return 'badge-persist';
    if (normalized === 'hidden') return 'badge-hidden';
    if (normalized === 'imageurl') return 'badge-image-url';
    if (normalized === 'imageprompt') return 'badge-image-prompt';
    if (normalized === 'tagline') return 'badge-tagline';
    if (normalized === 'updated') return 'badge-updated';
    return `badge-${normalized.replace(/[^a-z0-9]+/g, '-')}`;
}

function formatRequestBadgeLabel(value, fallback = 'Unknown') {
    if (!hasText(value)) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'queued') return 'Q Queued';
    if (normalized === 'processing') return 'P Processing';
    if (normalized === 'processing-complete') return 'DONE Processing';
    if (normalized === 'completed') return 'OK Completed';
    if (normalized === 'persist') return 'SAVE Persist';
    if (normalized === 'hidden') return 'OFF Hidden';
    if (normalized === 'imageurl') return 'IMG Image URL';
    if (normalized === 'imageprompt') return 'ART Image Theme';
    if (normalized === 'tagline') return 'TXT Tagline';
    if (normalized === 'updated') return 'UP Updated';
    return formatRequestStageLabel(value, fallback);
}

function normaliseRequestCardEntry(entry, options = {}) {
    if (!entry || typeof entry !== 'object') return null;

    const title = hasText(entry?.title)
        ? entry.title.trim()
        : (hasText(entry?.summary)
            ? entry.summary.trim()
            : (hasText(entry?.hex)
                ? entry.hex.trim()
                : (hasText(entry?.hexId)
                    ? entry.hexId.trim()
                    : (hasText(entry?.requestId) ? entry.requestId.trim() : 'Unknown'))));
    const hex = hasText(entry?.hex)
        ? entry.hex.trim()
        : (hasText(entry?.hexId) ? entry.hexId.trim() : '');
    const requestId = hasText(entry?.requestId)
        ? entry.requestId.trim()
        : (hasText(entry?.messageId) ? entry.messageId.trim() : '');
    const messageId = hasText(entry?.messageId) ? entry.messageId.trim() : '';
    const rawAction = entry?.operation ?? entry?.status ?? options.defaultAction ?? '';
    const action = formatRequestStageLabel(rawAction, formatRequestStageLabel(options.defaultAction, 'Unknown'));
    const timestamp = hasText(entry?.processedAt)
        ? entry.processedAt
        : (hasText(entry?.requestTime)
            ? entry.requestTime
            : (hasText(entry?.completedAt)
                ? entry.completedAt
                : (hasText(entry?.updatedAt) ? entry.updatedAt : '')));
    const subtitleParts = [];
    if (hex) subtitleParts.push(`HEX ${hex}`);
    if (hasText(options.sourceLabel)) subtitleParts.push(options.sourceLabel);

    return {
        title,
        hex,
        requestId,
        messageId,
        operation: action,
        badgeLabel: formatRequestBadgeLabel(rawAction || options.defaultAction || '', action),
        processedAt: timestamp,
        badgeClass: formatRequestBadgeClass(rawAction || options.defaultAction || ''),
        subtitle: subtitleParts.join(' • '),
    };
}

function renderRequestCards(listEl, entries, emptyMessage, options = {}) {
    if (!listEl) return;
    if (!Array.isArray(entries) || entries.length === 0) {
        listEl.innerHTML = `<p class="refresh-status">${escapeHtml(emptyMessage)}</p>`;
        return;
    }

    listEl.innerHTML = entries.map((entry) => {
        const normalized = normaliseRequestCardEntry(entry, options);
        if (!normalized) return '';
        const metadata = [
            ['Request ID', normalized.requestId],
            ['Message ID', normalized.messageId],
            ['HEX', normalized.hex],
            ['Action', normalized.operation],
            ['Timestamp', normalized.processedAt],
        ].filter(([, value]) => hasText(value));
        const metadataRows = metadata.map(([label, value]) => `
            <div class="request-card-meta-row">
                <div class="request-card-meta-label">${escapeHtml(label)}</div>
                <div class="request-card-meta-value">${escapeHtml(String(value).trim())}</div>
            </div>
        `).join('');
        return `
            <article class="request-card">
                <div class="request-card-header">
                    <div class="request-card-lead">
                        <div class="request-card-time"${hasText(normalized.processedAt) ? ` title="${escapeHtml(normalized.processedAt)}"` : ''}>${escapeHtml(formatTrackerTimestamp(normalized.processedAt))}</div>
                        <div class="request-card-title">${escapeHtml(normalized.title)}</div>
                        ${normalized.subtitle ? `<div class="request-card-subtitle">${escapeHtml(normalized.subtitle)}</div>` : ''}
                    </div>
                    <span class="request-card-badge ${escapeHtml(normalized.badgeClass)}">${escapeHtml(normalized.badgeLabel)}</span>
                </div>
                <details class="request-card-meta-toggle">
                    <summary>Request metadata</summary>
                    <div class="request-card-meta-grid">${metadataRows}</div>
                </details>
            </article>
        `;
    }).filter(Boolean).join('');
}

function normaliseCompletedRequestEntry(entry) {
    return normaliseRequestCardEntry(entry, {
        defaultAction: entry?.operation ?? entry?.status ?? 'completed',
        sourceLabel: 'Completed',
    });
}

function deduplicateRequestsByRequestId(normalizedEntries) {
    const byRequestId = new Map();
    const noRequestId = [];
    normalizedEntries.forEach((entry) => {
        const requestId = hasText(entry?.requestId) ? entry.requestId.trim() : '';
        if (!requestId) {
            noRequestId.push(entry);
            return;
        }
        const existing = byRequestId.get(requestId);
        if (!existing) {
            byRequestId.set(requestId, entry);
            return;
        }
        const existingTime = existing.processedAt ? new Date(existing.processedAt).getTime() : -1;
        const entryTime = entry.processedAt ? new Date(entry.processedAt).getTime() : -1;
        if (entryTime >= existingTime) {
            byRequestId.set(requestId, entry);
        }
    });
    return [...byRequestId.values(), ...noRequestId];
}

function setRequests(entries, updatedAt = null) {
    const normalized = Array.isArray(entries)
        ? entries
            .map((entry) => normaliseRequestCardEntry(entry, {
                defaultAction: entry?.status ?? entry?.operation ?? '',
            }))
            .filter(Boolean)
        : [];
    latestCompletedRequests = deduplicateRequestsByRequestId(normalized);
    latestCompletedRequestsUpdatedAt = hasText(updatedAt) ? updatedAt : null;
    renderCompletedRequests();
}

function setCompletedRequests(entries, updatedAt = null) {
    const normalized = Array.isArray(entries)
        ? entries
            .map((entry) => normaliseCompletedRequestEntry(entry))
            .filter(Boolean)
            .filter((entry) => !shouldHideCompletedRequestEntry(entry))
        : [];
    latestCompletedRequests = deduplicateRequestsByRequestId(normalized);
    latestCompletedRequestsUpdatedAt = hasText(updatedAt) ? updatedAt : null;
    renderCompletedRequests();
}

function shouldHideCompletedRequestEntry(entry) {
    const requestId = hasText(entry?.requestId) ? entry.requestId.trim() : '';
    if (!requestId) return false;

    const queuedRequestIds = new Set(
        getSnapshotRequests(latestQueuedSnapshot)
            .map((request) => getSnapshotRequestId(request))
            .filter(Boolean),
    );
    if (queuedRequestIds.has(requestId)) {
        return false;
    }

    const processedAt = hasText(entry?.processedAt) ? entry.processedAt : '';
    if (!processedAt) return false;
    const parsed = new Date(processedAt);
    if (Number.isNaN(parsed.getTime())) return false;

    return (Date.now() - parsed.getTime()) > COMPLETED_REQUEST_HIDE_AFTER_MS;
}

function renderCompletedRequests() {
    const summaryEl = document.getElementById('completed-requests-summary');
    const updatedEl = document.getElementById('completed-requests-updated');
    const listEl = document.getElementById('completed-requests-list');
    if (!summaryEl || !updatedEl || !listEl) return;

    const total = Array.isArray(latestCompletedRequests) ? latestCompletedRequests.length : 0;
    summaryEl.textContent = total > 0 ? `${total} requests` : 'No active requests';
    summaryEl.className = `status-text ${total > 0 ? 'status-success' : 'status-info'}`;

    if (latestCompletedRequestsUpdatedAt) {
        const parsed = new Date(latestCompletedRequestsUpdatedAt);
        updatedEl.textContent = `Last refresh: ${Number.isNaN(parsed.getTime()) ? latestCompletedRequestsUpdatedAt : parsed.toLocaleString('en-GB')}`;
    } else {
        updatedEl.textContent = 'Last refresh: n/a';
    }

    if (total === 0) {
        listEl.innerHTML = '<p class="refresh-status">No requests in the latest refresh.</p>';
        return;
    }

    renderRequestCards(
        listEl,
        latestCompletedRequests,
        'No requests in the latest refresh.',
        {},
    );
}

function updateCompletedRequestsFromResult(result) {
    const completedRequests = Array.isArray(result?.completedRequests) ? result.completedRequests : null;
    if (completedRequests) {
        const updatedAt = hasText(result?.runtimeRequestFiles?.completed?.updatedAt)
            ? result.runtimeRequestFiles.completed.updatedAt
            : new Date().toISOString();
        setCompletedRequests(completedRequests, updatedAt);
    }
}

function readCookie(name) {
    try {
        const cookieParts = document.cookie ? document.cookie.split('; ') : [];
        for (const part of cookieParts) {
            const separatorIndex = part.indexOf('=');
            const cookieName = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
            if (cookieName !== name) continue;
            const cookieValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : '';
            return decodeURIComponent(cookieValue);
        }
    } catch {
        // Ignore cookie parsing issues
    }
    return null;
}

function writeCookie(name, value, maxAgeDays = 365) {
    try {
        const maxAgeSeconds = Math.max(1, Math.round(maxAgeDays * 24 * 60 * 60));
        document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
    } catch {
        // Ignore cookie write errors
    }
}

function readAutoLambdaInvocationPreference() {
    const cookieValue = readCookie(AUTO_LAMBDA_PREF_KEY);
    if (cookieValue !== null) {
        return cookieValue === '1' || cookieValue.toLowerCase() === 'true';
    }
    try {
        const stored = window.localStorage.getItem(AUTO_LAMBDA_PREF_KEY);
        if (stored === null) return true;
        return stored === '1' || stored.toLowerCase() === 'true';
    } catch {
        return true;
    }
}

function readAutoLambdaIntervalPreference() {
    const cookieValue = readCookie(AUTO_LAMBDA_INTERVAL_PREF_KEY);
    const cookieSeconds = Number(cookieValue);
    if (Number.isFinite(cookieSeconds)) {
        return Math.max(5, Math.round(cookieSeconds)) * 1000;
    }
    try {
        const stored = window.localStorage.getItem(AUTO_LAMBDA_INTERVAL_PREF_KEY);
        const parsedSeconds = Number(stored);
        if (!Number.isFinite(parsedSeconds)) return DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS;
        return Math.max(5, Math.round(parsedSeconds)) * 1000;
    } catch {
        return DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS;
    }
}

function readAgendaAutoRefreshPreference() {
    const stored = readCookie(AGENDA_AUTO_REFRESH_PREF_KEY);
    if (stored === null) return true;
    return stored === '1' || stored.toLowerCase() === 'true';
}

function readStatusPollingPreference() {
    const stored = readCookie(STATUS_POLL_PREF_KEY);
    if (stored === null) return true;
    return stored === '1' || stored.toLowerCase() === 'true';
}

function readStatusPollingIntervalPreference() {
    const stored = readCookie(STATUS_POLL_INTERVAL_PREF_KEY);
    const parsedSeconds = Number(stored);
    if (!Number.isFinite(parsedSeconds)) return DEFAULT_STATUS_POLL_INTERVAL_MS;
    return Math.max(5, Math.round(parsedSeconds)) * 1000;
}

function readHexPreviewAutoRefreshPreference() {
    try {
        const stored = window.localStorage.getItem(HEX_PREVIEW_AUTO_REFRESH_PREF_KEY);
        if (stored === null) return false;
        return stored === '1' || stored.toLowerCase() === 'true';
    } catch {
        return false;
    }
}

function readHexPreviewIntervalPreference() {
    try {
        const stored = window.localStorage.getItem(HEX_PREVIEW_INTERVAL_PREF_KEY);
        const parsedSeconds = Number(stored);
        if (!Number.isFinite(parsedSeconds)) return HEX_PREVIEW_POLL_INTERVAL_MS;
        return Math.max(5, Math.round(parsedSeconds)) * 1000;
    } catch {
        return HEX_PREVIEW_POLL_INTERVAL_MS;
    }
}

function persistAutoLambdaInvocationPreference(enabled) {
    writeCookie(AUTO_LAMBDA_PREF_KEY, enabled ? '1' : '0');
}

function persistAutoLambdaIntervalPreference(intervalMs) {
    writeCookie(
        AUTO_LAMBDA_INTERVAL_PREF_KEY,
        String(Math.max(5, Math.round(intervalMs / 1000))),
    );
}

function persistAgendaAutoRefreshPreference(enabled) {
    writeCookie(AGENDA_AUTO_REFRESH_PREF_KEY, enabled ? '1' : '0');
}

function persistStatusPollingPreference(enabled) {
    writeCookie(STATUS_POLL_PREF_KEY, enabled ? '1' : '0');
}

function persistStatusPollingIntervalPreference(intervalMs) {
    writeCookie(
        STATUS_POLL_INTERVAL_PREF_KEY,
        String(Math.max(5, Math.round(intervalMs / 1000))),
    );
}

function persistHexPreviewAutoRefreshPreference(enabled) {
    try {
        window.localStorage.setItem(HEX_PREVIEW_AUTO_REFRESH_PREF_KEY, enabled ? '1' : '0');
    } catch {
        // Ignore storage errors
    }
}

function persistHexPreviewIntervalPreference(intervalMs) {
    try {
        window.localStorage.setItem(HEX_PREVIEW_INTERVAL_PREF_KEY, String(Math.max(5, Math.round(intervalMs / 1000))));
    } catch {
        // Ignore storage errors
    }
}

function restartAutoLambdaInvokeTimer() {
    if (autoLambdaInvokeTimer) {
        clearInterval(autoLambdaInvokeTimer);
        autoLambdaInvokeTimer = null;
    }
    if (!autoLambdaInvokeEnabled) {
        return;
    }
    autoLambdaInvokeTimer = setInterval(() => {
        invokeLambdaHeartbeat();
    }, autoLambdaInvokeIntervalMs);
}

function runStatusPollingJob() {
    if (statusPollingInFlight) return;
    statusPollingInFlight = true;
    Promise.all([
        pollLambdaRuntimeStatus(true),
        pollQueueDepthSnapshots(),
    ]).finally(() => {
        statusPollingInFlight = false;
    });
}

function restartStatusPollingTimer() {
    if (statusPollingTimer) {
        clearInterval(statusPollingTimer);
        statusPollingTimer = null;
    }
    if (!statusPollingEnabled) {
        return;
    }
    statusPollingTimer = setInterval(() => {
        runStatusPollingJob();
    }, statusPollingIntervalMs);
}

function updateAutoLambdaInvocationUi() {
    const toggle = document.getElementById('auto-lambda-toggle');
    const intervalInput = document.getElementById('auto-lambda-interval-seconds');
    const statusElement = document.getElementById('auto-lambda-status');
    if (toggle) {
        toggle.checked = autoLambdaInvokeEnabled;
    }
    if (intervalInput) {
        intervalInput.value = String(Math.max(5, Math.round(autoLambdaInvokeIntervalMs / 1000)));
    }
    if (statusElement) {
        const seconds = Math.max(5, Math.round(autoLambdaInvokeIntervalMs / 1000));
        statusElement.textContent = `Auto invocation: ${autoLambdaInvokeEnabled ? `enabled every ${seconds}s` : 'disabled'}`;
    }
}

function updateAgendaAutoRefreshUi() {
    const toggle = document.getElementById('agenda-auto-refresh-toggle');
    const statusElement = document.getElementById('agenda-auto-refresh-status');
    if (toggle) {
        toggle.checked = agendaAutoRefreshEnabled;
    }
    if (statusElement) {
        statusElement.textContent = `Agenda refresh: ${agendaAutoRefreshEnabled ? 'after lambda completion' : 'disabled'}`;
    }
}

function updateStatusPollingUi() {
    const toggle = document.getElementById('status-polling-toggle');
    const intervalInput = document.getElementById('status-polling-interval-seconds');
    const statusElement = document.getElementById('status-polling-status');
    if (toggle) {
        toggle.checked = statusPollingEnabled;
    }
    if (intervalInput) {
        intervalInput.value = String(Math.max(5, Math.round(statusPollingIntervalMs / 1000)));
    }
    if (statusElement) {
        const seconds = Math.max(5, Math.round(statusPollingIntervalMs / 1000));
        statusElement.textContent = `Polling: ${statusPollingEnabled ? `enabled every ${seconds}s` : 'disabled'}`;
    }
}

function setAutoLambdaInvocationEnabled(enabled, persist = true) {
    autoLambdaInvokeEnabled = Boolean(enabled);
    if (persist) {
        persistAutoLambdaInvocationPreference(autoLambdaInvokeEnabled);
    }
    restartAutoLambdaInvokeTimer();
    updateAutoLambdaInvocationUi();
}

function setAgendaAutoRefreshEnabled(enabled, persist = true) {
    agendaAutoRefreshEnabled = Boolean(enabled);
    if (persist) {
        persistAgendaAutoRefreshPreference(agendaAutoRefreshEnabled);
    }
    updateAgendaAutoRefreshUi();
}

function toggleAutoLambdaInvocation(enabled) {
    setAutoLambdaInvocationEnabled(enabled, true);
}

function toggleAgendaAutoRefresh(enabled) {
    setAgendaAutoRefreshEnabled(enabled, true);
}

function setStatusPollingEnabled(enabled, persist = true) {
    statusPollingEnabled = Boolean(enabled);
    if (persist) {
        persistStatusPollingPreference(statusPollingEnabled);
    }
    restartStatusPollingTimer();
    if (statusPollingEnabled) {
        runStatusPollingJob();
    }
    updateStatusPollingUi();
}

function toggleStatusPolling(enabled) {
    setStatusPollingEnabled(enabled, true);
}

function updateAutoLambdaInvocationInterval(value, persist = true) {
    const parsedSeconds = Number(value);
    const safeSeconds = Number.isFinite(parsedSeconds) ? Math.max(5, Math.round(parsedSeconds)) : 20;
    autoLambdaInvokeIntervalMs = safeSeconds * 1000;
    if (persist) {
        persistAutoLambdaIntervalPreference(autoLambdaInvokeIntervalMs);
    }
    restartAutoLambdaInvokeTimer();
    updateAutoLambdaInvocationUi();
}

function updateStatusPollingInterval(value, persist = true) {
    const parsedSeconds = Number(value);
    const safeSeconds = Number.isFinite(parsedSeconds)
        ? Math.max(5, Math.round(parsedSeconds))
        : Math.round(DEFAULT_STATUS_POLL_INTERVAL_MS / 1000);
    statusPollingIntervalMs = safeSeconds * 1000;
    if (persist) {
        persistStatusPollingIntervalPreference(statusPollingIntervalMs);
    }
    restartStatusPollingTimer();
    updateStatusPollingUi();
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

function maybeRefreshAgendaAfterRuntimeCompletion(runtime, wasRunning = false) {
    const completedAt = hasText(runtime?.lastCompletedAt) ? runtime.lastCompletedAt.trim() : '';
    if (!completedAt) return;

    const isNewCompletion = completedAt !== lastObservedRuntimeCompletedAt;
    lastObservedRuntimeCompletedAt = completedAt;

    if (!agendaAutoRefreshEnabled) return;
    if (runtime?.status === 'running') return;
    if (!isNewCompletion && !wasRunning) return;

    loadEvents({ silent: true });
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
        const wasRunning = lambdaRuntimeRunning;
        const result = await sendScoutsCommand({
            realm: 'scouts',
            subject: 'status',
            action: 'runtime',
        });
        const runtime = result?.runtime || {};
        lambdaRuntimeRunning = runtime?.status === 'running';
        refreshApiActionButtons();
        maybeRefreshAgendaAfterRuntimeCompletion(runtime, wasRunning);

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

async function fetchAgendaJson() {
    const requestUrls = [AGENDA_URL, FALLBACK_AGENDA_URL].map((url) => `${url}?ts=${Date.now()}`);
    let lastError = null;

    for (const url of requestUrls) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error('Failed to load agenda.json: ' + response.status);
            }
            return await response.json();
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error('Failed to load agenda.json.');
}

// Load events from the current site's agenda feed
async function loadEvents(options = {}) {
    const { silent = false } = options;
    if (agendaLoadInFlight) {
        return;
    }

    agendaLoadInFlight = true;
    try {
        const data = await fetchAgendaJson();
        const rawEvents = Array.isArray(data.events) ? data.events : [];
        eventsData = rawEvents.map((event) => normaliseEventTaglineFields(cloneEventRecord(event)));
        agendaPayload = data;
        uniqueEventEntries = buildUniqueEventEntries(eventsData);
        applyVisibilityOverrides(uniqueEventEntries);
        console.log('[Admin] agenda.json fetched', {
            totalEvents: rawEvents.length,
            uniqueEvents: uniqueEventEntries.length,
        });

        updateEventsCount(
            uniqueEventEntries.length,
            eventsData.length,
            uniqueEventEntries.filter((entry) => isEntryHidden(entry)).length,
            uniqueEventEntries.filter((entry) => isEntryComplete(entry)).length,
        );
        updateSidebarUi();
        renderEvents();
        renderAgendaViewerContent();
        renderEventsJsonViewerContent();
    } catch (error) {
        console.error('Error loading events:', error);
        if (!silent) {
            showError('Failed to load events data from agenda.json.');
        }
    } finally {
        agendaLoadInFlight = false;
    }
}

function formatQueueSnapshotCount(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.requests)) {
        return 'unknown';
    }
    return `requests=${snapshot.requests.length}`;
}

function getSnapshotRequests(snapshot) {
    return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function getSnapshotRequestHex(request) {
    if (hasText(request?.hexId)) return String(request.hexId).trim().toLowerCase();
    if (hasText(request?.hex)) return String(request.hex).trim().toLowerCase();
    return '';
}

function getSnapshotRequestId(request) {
    if (hasText(request?.requestId)) return String(request.requestId).trim();
    if (hasText(request?.messageId)) return String(request.messageId).trim();
    return '';
}

function getSnapshotRequestKey(request) {
    const requestId = getSnapshotRequestId(request);
    if (requestId) return requestId;
    const hex = getSnapshotRequestHex(request);
    const title = hasText(request?.title) ? request.title.trim() : '';
    return [hex, title].filter(Boolean).join('|');
}

function mergeRuntimeRequestEntries(primary, secondary) {
    return {
        ...(secondary && typeof secondary === 'object' ? secondary : {}),
        ...(primary && typeof primary === 'object' ? primary : {}),
        title: hasText(primary?.title) ? primary.title : secondary?.title,
        summary: hasText(primary?.summary) ? primary.summary : secondary?.summary,
        hex: hasText(primary?.hex) ? primary.hex : (hasText(primary?.hexId) ? primary.hexId : (secondary?.hex ?? secondary?.hexId)),
        hexId: hasText(primary?.hexId) ? primary.hexId : (hasText(primary?.hex) ? primary.hex : (secondary?.hexId ?? secondary?.hex)),
        requestId: hasText(primary?.requestId) ? primary.requestId : (secondary?.requestId ?? ''),
        messageId: hasText(primary?.messageId) ? primary.messageId : (secondary?.messageId ?? ''),
        requestTime: hasText(primary?.requestTime) ? primary.requestTime : (secondary?.requestTime ?? secondary?.processedAt ?? ''),
        processedAt: hasText(primary?.processedAt) ? primary.processedAt : (secondary?.processedAt ?? ''),
    };
}

function getAggregateRuntimeRequests(queuedSnapshot, processingSnapshot, completedSnapshot) {
    const queuedMap = new Map(
        getSnapshotRequests(queuedSnapshot)
            .map((request) => [getSnapshotRequestKey(request), request])
            .filter(([key]) => hasText(key)),
    );
    const processingMap = new Map(
        getSnapshotRequests(processingSnapshot)
            .map((request) => [getSnapshotRequestKey(request), request])
            .filter(([key]) => hasText(key)),
    );
    const completedMap = new Map(
        getSnapshotRequests(completedSnapshot)
            .map((request) => [getSnapshotRequestKey(request), request])
            .filter(([key]) => hasText(key)),
    );

    const merged = [];
    const allKeys = new Set([
        ...queuedMap.keys(),
        ...processingMap.keys(),
        ...completedMap.keys(),
    ]);

    allKeys.forEach((key) => {
        const queued = queuedMap.get(key) || null;
        const processing = processingMap.get(key) || null;
        const completed = completedMap.get(key) || null;

        if (processing && completed) {
            return;
        }

        if (queued && completed && !processing) {
            const entry = mergeRuntimeRequestEntries(completed, queued);
            entry.status = 'processing-complete';
            merged.push(entry);
            return;
        }

        if (processing) {
            const entry = mergeRuntimeRequestEntries(processing, queued);
            entry.status = 'processing';
            merged.push(entry);
            return;
        }

        if (queued) {
            const entry = mergeRuntimeRequestEntries(queued, completed);
            entry.status = 'queued';
            merged.push(entry);
        }
    });

    return merged.sort((left, right) => {
        const leftTime = new Date(left?.processedAt ?? left?.requestTime ?? 0).getTime();
        const rightTime = new Date(right?.processedAt ?? right?.requestTime ?? 0).getTime();
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

function formatRuntimeBadgeRequestId(requestId) {
    if (!hasText(requestId)) return '';
    const normalized = String(requestId).trim();
    return normalized.length > 10 ? normalized.slice(0, 8) : normalized;
}

function deriveEventRuntimeBadges(event) {
    const hex = hasText(event?.hex) ? String(event.hex).trim().toLowerCase() : '';
    if (!hex) return [];
    const appliedRequestIds = getAppliedRequestIdSet(event);

    const queuedRequests = getSnapshotRequests(latestQueuedSnapshot)
        .filter((request) => getSnapshotRequestHex(request) === hex);
    const processingRequests = getSnapshotRequests(latestProcessingSnapshot)
        .filter((request) => getSnapshotRequestHex(request) === hex);
    const completedPairs = new Set(
        getSnapshotRequests(latestCompletedSnapshot)
            .map((request) => {
                const requestHex = getSnapshotRequestHex(request);
                const requestId = getSnapshotRequestId(request);
                return requestHex && requestId ? `${requestHex}|${requestId}` : '';
            })
            .filter(Boolean),
    );

    const badges = [];
    const seen = new Set();
    const pushBadge = (kind, label, requestId = '') => {
        const key = `${kind}|${requestId}`;
        if (seen.has(key)) return;
        seen.add(key);
        const shortId = formatRuntimeBadgeRequestId(requestId);
        badges.push({
            kind,
            label: shortId ? `${label} ${shortId}` : label,
            requestId: hasText(requestId) ? requestId : '',
        });
    };

    queuedRequests.forEach((request) => {
        const requestId = getSnapshotRequestId(request);
        if (requestId && appliedRequestIds.has(requestId)) {
            return;
        }
        if (requestId && completedPairs.has(`${hex}|${requestId}`)) {
            pushBadge('updated', 'Updated', requestId);
            return;
        }
        pushBadge('queued', 'Queued', requestId);
    });

    processingRequests.forEach((request) => {
        const requestId = getSnapshotRequestId(request);
        if (requestId && appliedRequestIds.has(requestId)) {
            return;
        }
        pushBadge('processing', 'Processing', requestId);
    });

    return badges;
}

function renderEventRuntimeBadgesMarkup(event) {
    return deriveEventRuntimeBadges(event)
        .map((badge) => `<span class="event-badge runtime-${badge.kind}"${badge.requestId ? ` title="Request ID: ${escapeHtml(badge.requestId)}"` : ''}>${escapeHtml(badge.label)}</span>`)
        .join('');
}

function refreshVisibleEventRuntimeBadges() {
    if (!Array.isArray(visibleEventEntries) || visibleEventEntries.length === 0) {
        return;
    }
    visibleEventEntries.forEach((entry, index) => {
        const card = document.querySelector(`[data-event-card-index="${index}"]`);
        if (!card) return;
        const runtimeBadgeContainer = card.querySelector('.event-runtime-badges');
        if (!runtimeBadgeContainer) return;
        runtimeBadgeContainer.innerHTML = renderEventRuntimeBadgesMarkup(entry?.event || {});
    });
}

function formatObservedIds(snapshot) {
    const requests = getSnapshotRequests(snapshot);
    if (requests.length === 0) {
        return 'n/a';
    }
    const requestIds = [];
    const messageIds = [];
    const hexIds = [];
    requests.forEach((request) => {
        if (hasText(request?.requestId)) requestIds.push(request.requestId.trim());
        if (hasText(request?.messageId)) messageIds.push(request.messageId.trim());
        if (hasText(request?.hexId)) hexIds.push(request.hexId.trim());
    });
    const parts = [];
    if (requestIds.length > 0) {
        parts.push(`requestIds=${Array.from(new Set(requestIds)).slice(0, 3).join(', ')}`);
    }
    if (messageIds.length > 0) {
        parts.push(`messageIds=${Array.from(new Set(messageIds)).slice(0, 3).join(', ')}`);
    }
    if (hexIds.length > 0) {
        parts.push(`hex=${Array.from(new Set(hexIds)).slice(0, 3).join(', ')}`);
    }
    return parts.length > 0 ? parts.join(' | ') : 'n/a';
}

function decodeHexToText(hexValue) {
    const hex = hasText(hexValue) ? String(hexValue).trim().toLowerCase() : '';
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
    try {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }
        const decoded = new TextDecoder().decode(new Uint8Array(bytes)).trim();
        return decoded || null;
    } catch {
        return null;
    }
}

function resolveEventTitleByHex(hexValue) {
    const hex = hasText(hexValue) ? String(hexValue).trim().toLowerCase() : '';
    if (!hex) return null;
    const entry = uniqueEventEntries.find((candidate) => {
        const candidateHex = hasText(candidate?.event?.hex) ? String(candidate.event.hex).trim().toLowerCase() : '';
        return candidateHex === hex;
    });
    if (!entry?.event) return null;
    const title = entry.event.summary || entry.event.title || null;
    return hasText(title) ? title.trim() : null;
}

function formatObservedTitles(snapshot) {
    const requests = getSnapshotRequests(snapshot);
    if (requests.length === 0) {
        return 'n/a';
    }

    const titles = new Set();
    requests.forEach((request) => {
        const directTitle = request?.title ?? null;
        if (hasText(directTitle)) {
            const statusSuffix = hasText(request?.status) ? ` [${String(request.status).trim()}]` : '';
            titles.add(`${String(directTitle).trim()}${statusSuffix}`);
            return;
        }
        const byHex = resolveEventTitleByHex(request?.hexId);
        if (hasText(byHex)) {
            const statusSuffix = hasText(request?.status) ? ` [${String(request.status).trim()}]` : '';
            titles.add(`${byHex}${statusSuffix}`);
        }
    });

    requests.forEach((request) => {
        const hex = request?.hexId;
        const byHex = resolveEventTitleByHex(hex);
        if (hasText(byHex)) {
            const statusSuffix = hasText(request?.status) ? ` [${String(request.status).trim()}]` : '';
            titles.add(`${byHex}${statusSuffix}`);
            return;
        }
        const decoded = decodeHexToText(hex);
        if (hasText(decoded)) {
            const statusSuffix = hasText(request?.status) ? ` [${String(request.status).trim()}]` : '';
            titles.add(`${decoded}${statusSuffix}`);
        }
    });

    if (titles.size === 0) return 'n/a';
    return Array.from(titles).slice(0, 6).join(' | ');
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

async function fetchHexEventByHex(hexValue) {
    const hex = hasText(hexValue) ? String(hexValue).trim().toLowerCase() : '';
    if (!hex) return null;
    const now = Date.now();
    const nextRetryAt = missingHexRetryAtByHex.get(hex) || 0;
    if (nextRetryAt > now) return null;
    try {
        const response = await fetch(`../../events/${hex}.json?ts=${Date.now()}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) {
            if (response.status === 404 || response.status === 410) {
                missingHexRetryAtByHex.set(hex, now + HEX_NOT_FOUND_BACKOFF_MS);
            }
            return null;
        }
        const payload = await response.json();
        missingHexRetryAtByHex.delete(hex);
        return payload && typeof payload === 'object' ? normaliseEventRecordForUi(payload) : null;
    } catch {
        return null;
    }
}

async function fetchRawHexEventByHex(hexValue) {
    const hex = hasText(hexValue) ? String(hexValue).trim().toLowerCase() : '';
    if (!hex) return null;
    const now = Date.now();
    const nextRetryAt = missingHexRetryAtByHex.get(hex) || 0;
    if (nextRetryAt > now) return null;
    try {
        const response = await fetch(`../../events/${hex}.json?ts=${Date.now()}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) {
            if (response.status === 404 || response.status === 410) {
                missingHexRetryAtByHex.set(hex, now + HEX_NOT_FOUND_BACKOFF_MS);
            }
            return null;
        }
        const payload = await response.json();
        missingHexRetryAtByHex.delete(hex);
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

function getHexPreviewBody(cardIndex) {
    return document.querySelector(`[data-event-card-index="${cardIndex}"] .event-hex-preview-body`);
}

function getHexPreviewContainer(cardIndex) {
    return document.querySelector(`[data-event-card-index="${cardIndex}"] .event-hex-preview`);
}

function syncHexPreviewControls(cardIndex = activeHexPreviewCardIndex) {
    if (cardIndex === null || cardIndex === undefined) return;
    const card = document.querySelector(`[data-event-card-index="${cardIndex}"]`);
    if (!card) return;
    const autoToggle = card.querySelector('.event-hex-preview-auto-toggle');
    const intervalInput = card.querySelector('.event-hex-preview-interval-input');
    if (autoToggle) {
        autoToggle.checked = hexPreviewAutoRefreshEnabled;
    }
    if (intervalInput) {
        intervalInput.value = String(Math.max(5, Math.round(hexPreviewIntervalMs / 1000)));
        intervalInput.disabled = !hexPreviewAutoRefreshEnabled;
    }
}

function setHexPreviewState(cardIndex, message, state = 'info') {
    const body = getHexPreviewBody(cardIndex);
    if (!body) return;
    body.textContent = message;
    body.dataset.state = state;
}

async function refreshActiveHexPreview(cardIndex, hexValue) {
    if (activeHexPreviewCardIndex !== cardIndex || activeHexPreviewHex !== hexValue) return;
    setHexPreviewState(cardIndex, 'Loading HEX JSON...', 'loading');
    const payload = await fetchRawHexEventByHex(hexValue);
    if (activeHexPreviewCardIndex !== cardIndex || activeHexPreviewHex !== hexValue) return;
    if (!payload) {
        setHexPreviewState(cardIndex, 'HEX JSON not available.', 'empty');
        return;
    }
    const body = getHexPreviewBody(cardIndex);
    if (!body) return;
    body.textContent = JSON.stringify(payload, null, 2);
    body.dataset.state = 'loaded';
}

function scheduleActiveHexPreviewPoll(cardIndex, hexValue) {
    if (activeHexPreviewPollTimer) {
        clearTimeout(activeHexPreviewPollTimer);
        activeHexPreviewPollTimer = null;
    }
    if (!hexPreviewAutoRefreshEnabled) return;
    if (activeHexPreviewCardIndex !== cardIndex || activeHexPreviewHex !== hexValue) return;
    activeHexPreviewPollTimer = setTimeout(async () => {
        await refreshActiveHexPreview(cardIndex, hexValue);
        scheduleActiveHexPreviewPoll(cardIndex, hexValue);
    }, hexPreviewIntervalMs);
}

function openHexPreview(cardIndex) {
    const entry = visibleEventEntries[cardIndex];
    const hex = hasText(entry?.event?.hex) ? String(entry.event.hex).trim().toLowerCase() : '';
    closeHexPreview();
    activeHexPreviewCardIndex = cardIndex;
    activeHexPreviewHex = hex || null;
    const previewContainer = getHexPreviewContainer(cardIndex);
    if (previewContainer) {
        previewContainer.style.display = 'block';
    }
    syncHexPreviewControls(cardIndex);
    if (!hex) {
        setHexPreviewState(cardIndex, 'No HEX available for this event.', 'empty');
        return;
    }
    refreshActiveHexPreview(cardIndex, hex).catch(() => {
        if (activeHexPreviewCardIndex === cardIndex && activeHexPreviewHex === hex) {
            setHexPreviewState(cardIndex, 'Failed to load HEX JSON.', 'error');
        }
    });
    scheduleActiveHexPreviewPoll(cardIndex, hex);
}

function closeHexPreview(cardIndex = null) {
    if (activeHexPreviewPollTimer) {
        clearTimeout(activeHexPreviewPollTimer);
        activeHexPreviewPollTimer = null;
    }
    const indexToReset = cardIndex ?? activeHexPreviewCardIndex;
    if (indexToReset !== null && indexToReset !== undefined) {
        const previewContainer = getHexPreviewContainer(indexToReset);
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
        setHexPreviewState(indexToReset, 'Click "View HEX" to load HEX JSON.', 'idle');
    }
    activeHexPreviewCardIndex = null;
    activeHexPreviewHex = null;
}

function toggleHexPreview(cardIndex) {
    if (activeHexPreviewCardIndex === cardIndex) {
        closeHexPreview(cardIndex);
        return;
    }
    openHexPreview(cardIndex);
}

function refreshHexPreviewNow(cardIndex) {
    if (activeHexPreviewCardIndex !== cardIndex) {
        openHexPreview(cardIndex);
        return;
    }
    if (!activeHexPreviewHex) {
        setHexPreviewState(cardIndex, 'No HEX available for this event.', 'empty');
        return;
    }
    refreshActiveHexPreview(cardIndex, activeHexPreviewHex).catch(() => {
        setHexPreviewState(cardIndex, 'Failed to load HEX JSON.', 'error');
    });
    scheduleActiveHexPreviewPoll(cardIndex, activeHexPreviewHex);
}

function setHexPreviewAutoRefresh(cardIndex, enabled) {
    hexPreviewAutoRefreshEnabled = Boolean(enabled);
    persistHexPreviewAutoRefreshPreference(hexPreviewAutoRefreshEnabled);
    syncHexPreviewControls(cardIndex);
    if (activeHexPreviewCardIndex === cardIndex && activeHexPreviewHex) {
        scheduleActiveHexPreviewPoll(cardIndex, activeHexPreviewHex);
    }
}

function updateHexPreviewInterval(value, cardIndex) {
    const parsedSeconds = Number(value);
    const safeSeconds = Number.isFinite(parsedSeconds) ? Math.max(5, Math.round(parsedSeconds)) : 5;
    hexPreviewIntervalMs = safeSeconds * 1000;
    persistHexPreviewIntervalPreference(hexPreviewIntervalMs);
    syncHexPreviewControls(cardIndex);
    if (activeHexPreviewCardIndex === cardIndex && activeHexPreviewHex) {
        scheduleActiveHexPreviewPoll(cardIndex, activeHexPreviewHex);
    }
}

function applyHexEventMetadata(targetEvent, hexEvent) {
    if (!targetEvent || !hexEvent) return false;
    let changed = false;

    const nextTagline = getAIPrompt(hexEvent);
    if (hasText(nextTagline) && targetEvent.tagline !== nextTagline) {
        targetEvent.tagline = nextTagline;
        changed = true;
    }

    const nextTheme = getImageTheme(hexEvent);
    const nextUrl = getImageUrl(hexEvent);
    if (hasText(nextTheme) || hasText(nextUrl)) {
        if (!targetEvent.image || typeof targetEvent.image !== 'object') {
            targetEvent.image = {};
            changed = true;
        }
        if (hasText(nextTheme) && targetEvent.image.theme !== nextTheme) {
            targetEvent.image.theme = nextTheme;
            changed = true;
        }
        if (hasText(nextUrl) && targetEvent.image.url !== nextUrl) {
            targetEvent.image.url = nextUrl;
            changed = true;
        }
    }

    const nextHidden = isHiddenEvent(hexEvent);
    if (targetEvent.isHidden !== nextHidden) {
        targetEvent.isHidden = nextHidden;
        changed = true;
    }
    if (hexEvent.hiddenAt && targetEvent.hiddenAt !== hexEvent.hiddenAt) {
        targetEvent.hiddenAt = hexEvent.hiddenAt;
        changed = true;
    }
    if (hexEvent.approved === true && targetEvent.approved !== true) {
        targetEvent.approved = true;
        changed = true;
    }

    return changed;
}


async function pollQueueDepthSnapshots() {
    const updatedEl = document.getElementById('queue-depth-updated');
    const checkedEl = document.getElementById('queue-depth-checked');
    if (!updatedEl || !checkedEl) {
        return;
    }

    checkedEl.textContent = `Last checked: ${new Date().toLocaleString('en-GB')}`;

    const [queuedSnapshot, processingSnapshot, completedSnapshot] = await Promise.all([
        fetchQueueSnapshot(QUEUED_REQUESTS_RUNTIME_URL),
        fetchQueueSnapshot(PROCESSING_REQUESTS_RUNTIME_URL),
        fetchQueueSnapshot(COMPLETED_REQUESTS_RUNTIME_URL),
    ]);
    latestQueuedSnapshot = queuedSnapshot;
    latestProcessingSnapshot = processingSnapshot;
    latestCompletedSnapshot = completedSnapshot;

    const aggregateRequests = getAggregateRuntimeRequests(queuedSnapshot, processingSnapshot, completedSnapshot);
    const timestamps = [queuedSnapshot?.updatedAt, processingSnapshot?.updatedAt, completedSnapshot?.updatedAt]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .map((value) => new Date(value))
        .filter((date) => !Number.isNaN(date.getTime()));
    const mostRecentTimestamp = timestamps.length > 0
        ? timestamps.sort((a, b) => b.getTime() - a.getTime())[0].toISOString()
        : (completedSnapshot?.updatedAt ?? null);
    setRequests(aggregateRequests, mostRecentTimestamp);

    if (timestamps.length > 0) {
        updatedEl.textContent = `Last update: ${new Date(mostRecentTimestamp).toLocaleString('en-GB')}`;
    } else {
        updatedEl.textContent = 'Last update: n/a';
    }

    if (uniqueEventEntries.length > 0) {
        refreshVisibleEventRuntimeBadges();
    }
}

function showError(message) {
    const container = document.getElementById('events-container');
    container.innerHTML = `<div class="error">${message}</div>`;
}

async function loadAiConfig(force = false) {
    const now = Date.now();
    if (!force && cachedAiConfig && (now - cachedAiConfigLoadedAt) < AI_CONFIG_CACHE_MS) {
        return cachedAiConfig;
    }
    if (!force && aiConfigLoadPromise) {
        return aiConfigLoadPromise;
    }

    aiConfigLoadPromise = fetch(`${AI_CONFIG_URL}?ts=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        })
        .then((config) => {
            cachedAiConfig = config && typeof config === 'object' ? config : {};
            cachedAiConfigLoadedAt = Date.now();
            renderAiConfigViewerContent(false).catch(() => {});
            return cachedAiConfig;
        })
        .finally(() => {
            aiConfigLoadPromise = null;
        });

    return aiConfigLoadPromise;
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

function getSourceData(event) {
    return event?.source && typeof event.source === 'object' ? event.source : null;
}

function getMetadataData(event) {
    return event?.metadata && typeof event.metadata === 'object' ? event.metadata : null;
}

function getStatusData(event) {
    const metadata = getMetadataData(event);
    if (metadata?.status && typeof metadata.status === 'object') {
        return metadata.status;
    }
    return event?.status && typeof event.status === 'object' ? event.status : null;
}

function normaliseAppliedRequestRecord(record) {
    if (typeof record === 'string') {
        const requestId = hasText(record) ? record.trim() : '';
        return requestId ? { requestId, timestamp: '' } : null;
    }
    if (!record || typeof record !== 'object') return null;
    const requestId = hasText(record?.requestId) ? record.requestId.trim() : '';
    const timestamp = hasText(record?.timestamp)
        ? record.timestamp.trim()
        : (hasText(record?.appliedAt) ? record.appliedAt.trim() : '');
    const realm = hasText(record?.realm) ? record.realm.trim() : '';
    const subject = hasText(record?.subject) ? record.subject.trim() : '';
    const action = hasText(record?.action) ? record.action.trim() : '';
    const status = hasText(record?.status) ? record.status.trim() : '';
    if (!requestId) return null;
    return { requestId, timestamp, realm, subject, action, status };
}

function normaliseAppliedRequestHistory(value) {
    if (!Array.isArray(value)) return [];
    const deduped = new Map();
    value.forEach((entry) => {
        const normalized = normaliseAppliedRequestRecord(entry);
        if (!normalized) return;
        deduped.set(normalized.requestId, {
            ...(deduped.get(normalized.requestId) || {}),
            ...normalized,
        });
    });
    return Array.from(deduped.values());
}

function getAppliedRequestHistory(event) {
    if (!event || typeof event !== 'object') return [];
    const metadata = getMetadataData(event);
    return normaliseAppliedRequestHistory(metadata?.requests ?? metadata?.requestIds ?? event.requests ?? event.requestIds ?? []);
}

function getAppliedRequestIdSet(event) {
    return new Set(getAppliedRequestHistory(event).map((entry) => entry.requestId));
}

function normaliseEventRecordForUi(event) {
    if (!event || typeof event !== 'object') return event;
    const source = getSourceData(event);
    const metadata = getMetadataData(event);
    const status = getStatusData(event);
    const image = metadata?.image ?? event.image ?? null;
    const lastModified = event?.lastModified && typeof event.lastModified === 'object'
        ? {
            ...(event.lastModified.raw ? { raw: event.lastModified.raw } : {}),
            ...(event.lastModified.ISO ? { ISO: event.lastModified.ISO } : {}),
        }
        : event?.lastModified ?? null;

    return {
        ...event,
        uid: source?.uid ?? event.uid ?? null,
        title: source?.title ?? event.title ?? source?.summary ?? event.summary ?? null,
        summary: source?.summary ?? event.summary ?? source?.title ?? event.title ?? null,
        location: source?.location ?? event.location ?? null,
        dtstart: source?.dtstart ?? event.dtstart ?? null,
        section: source?.section ?? event.section ?? null,
        icsType: source?.icsType ?? event.icsType ?? null,
        image,
        tagline: metadata?.tagline ?? event.tagline ?? null,
        hexId: metadata?.hex ?? metadata?.hexId ?? event.hexId ?? event.hex ?? null,
        hex: metadata?.hex ?? metadata?.hexId ?? event.hexId ?? event.hex ?? null,
        requestIds: getAppliedRequestHistory(event),
        approved: status?.isApproved === true || event.approved === true,
        status: status?.isHidden === true ? 'hidden' : event.status ?? null,
        hiddenAt: event.hiddenAt ?? null,
        lastModified,
    };
}

function getImageUrl(event) {
    const metadata = getMetadataData(event);
    let candidate = null;
    const image = metadata?.image ?? event?.image;
    if (image) {
        if (typeof image === 'string') candidate = image;
        else if (image.url) candidate = image.url;
        else if (image.src) candidate = image.src;
    } else if (event.imageUrl) {
        candidate = event.imageUrl;
    }
    return normaliseImagePath(candidate);
}

// Get tagline from event data (prioritise `tagline`, fallback to legacy `AI`)
function getAIPrompt(event) {
    if (!event || typeof event !== 'object') return null;
    const metadata = getMetadataData(event);
    return metadata?.tagline || event.tagline || event.AI || event.ai || event.aiPrompt || null;
}

function getImageTheme(event) {
    if (!event || typeof event !== 'object') return null;
    const image = getMetadataData(event)?.image ?? event.image;
    if (image && typeof image === 'object' && typeof image.theme === 'string') {
        const trimmed = image.theme.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function buildImagePromptSpecificationsText(specifications) {
    if (!Array.isArray(specifications) || specifications.length === 0) {
        return DEFAULT_IMAGE_GENERATION_PROMPT_SPECIFICATIONS.join(', ');
    }
    const cleaned = specifications
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(', ') : DEFAULT_IMAGE_GENERATION_PROMPT_SPECIFICATIONS.join(', ');
}

function buildImageGenerationPromptFromTheme(theme, config = cachedAiConfig) {
    if (!hasText(theme)) return null;
    const normalizedTheme = String(theme).trim();
    const lower = normalizedTheme.toLowerCase();
    if (lower.startsWith('create a cartoonish image of ') || lower.startsWith('cartoonish image of scouts')) {
        return normalizedTheme;
    }
    const template = hasText(config?.imageGenerationPromptTemplate)
        ? String(config.imageGenerationPromptTemplate)
        : hasText(config?.imagePromptTemplate)
            ? String(config.imagePromptTemplate)
            : DEFAULT_IMAGE_GENERATION_PROMPT_TEMPLATE;
    const specifications = buildImagePromptSpecificationsText(config?.imageGenerationPromptSpecifications ?? config?.imagePromptSpecifications);
    return template
        .replace(/{{IMAGE_THEME}}/g, normalizedTheme)
        .replace(/{{IMAGE_PROMPT_SPECIFICATIONS}}/g, specifications)
        .replace(/\s+/g, ' ')
        .trim();
}

function getImageGenerationPrompt(event) {
    if (!event || typeof event !== 'object') return null;
    const derivedFromTheme = buildImageGenerationPromptFromTheme(getImageTheme(event));
    if (hasText(derivedFromTheme)) {
        return derivedFromTheme;
    }
    const image = getMetadataData(event)?.image ?? event.image;
    if (image && typeof image === 'object' && typeof image.prompt === 'string') {
        const trimmed = image.prompt.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function getMissingMetadataFields(event) {
    const missing = [];
    if (!hasText(getAIPrompt(event))) {
        missing.push('Tagline');
    }
    if (!hasText(getImageTheme(event))) {
        missing.push('Image Theme');
    }
    if (!hasText(getImageUrl(event))) {
        missing.push('Image URL');
    }
    return missing;
}

// Determine event section/type
function getEventSection(event) {
    const source = getSourceData(event);
    const type = (source?.icsType || source?.section || event.icsType || event.section || '').toLowerCase();
    if (type.includes('beaver')) return 'beavers';
    if (type.includes('cub')) return 'cubs';
    if (type.includes('scout')) return 'scouts';
    return 'all';
}

function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function normaliseEventTaglineFields(event) {
    if (!event || typeof event !== 'object') return event;
    const normalised = normaliseEventRecordForUi(event);
    const derivedTagline = getAIPrompt(normalised);
    if (hasText(derivedTagline) && !hasText(event.tagline)) {
        normalised.tagline = derivedTagline.trim();
    }
    return normalised;
}

function isHiddenEvent(event) {
    const structuredStatus = getStatusData(event);
    if (structuredStatus?.isHidden === true) return true;
    if (typeof event?.isHidden === 'boolean') return event.isHidden;
    if (typeof event?.isHidden === 'string') {
        const normalized = event.isHidden.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    const statusValue = typeof event?.status === 'string' ? event.status.trim().toLowerCase() : '';
    return statusValue === 'hidden' || Boolean(event?.hiddenAt);
}

function isEntryHidden(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.allHidden === true) return true;
    return isHiddenEvent(entry.event);
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

    if (!hasText(getImageTheme(targetEvent)) && hasText(getImageTheme(sourceEvent))) {
        if (!targetEvent.image || typeof targetEvent.image !== 'object') {
            targetEvent.image = {};
        }
        targetEvent.image.theme = getImageTheme(sourceEvent);
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

function getEventDisplayTitle(event, entry, index) {
    if (hasText(event?.summary)) return event.summary.trim();
    if (hasText(event?.title)) return event.title.trim();
    const identifier = getEntryIdentifier(entry);
    if (hasText(identifier)) return identifier;
    return `Event ${index + 1}`;
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

// Render all events
function renderEvents() {
    const container = document.getElementById('events-container');
    closeHexPreview();
    
    if (uniqueEventEntries.length === 0) {
        console.warn('[Admin] No events found after loading');
        container.innerHTML = '<p class="loading">No events found.</p>';
        return;
    }

    visibleEventEntries = uniqueEventEntries.filter((entry) => {
        const event = entry.event;
        switch (activeFilter) {
            case 'new':
                return !isEntryHidden(entry) && isNewEvent(event);
            case 'missing':
                return isEntryMissingMetadata(entry);
            case 'hidden':
                return isEntryHidden(entry);
            case 'complete':
                return isEntryComplete(entry);
            case 'approval':
                return isEntryPendingApproval(entry);
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
        const imageTheme = getImageTheme(event);
        const missingFields = getMissingMetadataFields(event);
        const requeueEligible = missingFields.length > 0;
        const section = getEventSection(event);
        const isHidden = isEntryHidden(entry);
        const title = getEventDisplayTitle(event, entry, index);
        const eventUID = getEntryIdentifier(entry);
        const sourceDetailsMarkup = entry.sourceDetails?.length
            ? entry.sourceDetails
                .map((detail) => `<div class="event-identifiers-row"><span>Event Index:</span> <code>${detail.index}</code> <span>UID:</span> <code>${detail.uid}</code></div>`)
                .join('')
            : '<div class="event-identifiers-row">No source details</div>';
        if (!event.dtstart) {
            const warnKey = `${eventUID}|${title}`;
            if (!warnedMissingDtstartIds.has(warnKey)) {
                warnedMissingDtstartIds.add(warnKey);
                console.warn('[Admin] Event missing dtstart', { index, uid: eventUID, title });
            }
        }
        
        return `
            <div
                class="event-card"
                data-event-card-index="${index}"
            >
                <div class="event-image-container">
                    ${imageUrl 
                        ? `<img src="${imageUrl}" alt="${title}" class="event-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22%3E%3Crect fill=%22%23ddd%22 width=%22400%22 height=%22300%22/%3E%3Ctext fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22%3ENo Image%3C/text%3E%3C/svg%3E'">` 
                        : `<div class="event-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999;">No Image</div>`
                    }
                    <div class="event-badge-stack">
                        <span class="event-badge ${section}">${section}</span>
                        ${isHidden ? `<span class="event-badge hidden">Hidden</span>` : ''}
                        <div class="event-runtime-badges">${renderEventRuntimeBadgesMarkup(event)}</div>
                    </div>
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

                    ${imageTheme ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">Image Theme</div>
                            <div class="ai-prompt-text">${imageTheme}</div>
                        </div>
                        <div class="ai-prompt-actions">
                            <button class="btn btn-secondary" onclick="copyImagePromptForEvent(${index})">Copy Image Prompt</button>
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
                        : ''
                    }
                    <div class="event-actions">
                        <button 
                            class="btn btn-primary"
                            onclick="openUploadModal(${index})"
                        >
                            View Details
                        </button>
                        ${isHidden
                            ? `<button class="btn btn-secondary requires-api" onclick="unhideEvent(${index})">Unhide Event</button>`
                            : `<button class="btn btn-secondary requires-api" onclick="hideEvent(${index})">Hide Event</button>`
                        }
                        ${requeueEligible
                            ? `<button class="btn btn-secondary requires-api" onclick="requeueEvent(${index})">Requeue Missing Fields</button>`
                            : ''
                        }
                        <button class="btn btn-secondary" onclick="toggleHexPreview(${index})">HEX</button>
                    </div>
                    <div class="event-hex-preview" style="display:none;">
                        <div class="event-hex-preview-header">
                            <div class="event-hex-preview-label">HEX JSON</div>
                            <div class="event-hex-preview-controls">
                                <button class="btn btn-secondary" onclick="refreshHexPreviewNow(${index})">Refresh</button>
                                <label class="event-hex-preview-auto">
                                    <input
                                        type="checkbox"
                                        class="event-hex-preview-auto-toggle"
                                        onchange="setHexPreviewAutoRefresh(${index}, this.checked)"
                                    >
                                    Auto
                                </label>
                                <input
                                    type="number"
                                    class="event-hex-preview-interval-input"
                                    min="5"
                                    step="1"
                                    value="${Math.max(5, Math.round(hexPreviewIntervalMs / 1000))}"
                                    onchange="updateHexPreviewInterval(this.value, ${index})"
                                >
                            </div>
                        </div>
                        <pre class="event-hex-preview-body" data-state="idle">Click "View HEX" to load HEX JSON.</pre>
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
    const currentImageTheme = getImageTheme(event);
    const imgElement = document.getElementById('modal-current-image');
    if (currentImage) {
        imgElement.src = currentImage;
        imgElement.style.display = 'block';
    } else {
        imgElement.style.display = 'none';
    }
    
    const imageUrlText = document.getElementById('modal-image-url');
    const imageThemeText = document.getElementById('modal-image-theme');
    const taglineText = document.getElementById('modal-tagline');
    const imagePromptInput = document.getElementById('modal-image-prompt-input');
    const taglineInput = document.getElementById('modal-tagline-input');
    const imageUrlInput = document.getElementById('modal-image-url-input');
    const hideToggleButton = document.getElementById('modal-hide-toggle-button');
    const requeueButton = document.getElementById('modal-requeue-button');
    if (imageUrlText) imageUrlText.textContent = currentImage || 'Not set';
    if (imagePromptInput) imagePromptInput.value = currentImageTheme || '';
    if (taglineInput) taglineInput.value = getAIPrompt(event) || '';
    if (imageUrlInput) imageUrlInput.value = currentImage || '';
    if (imageThemeText) imageThemeText.textContent = currentImageTheme || 'Not set';
    if (taglineText) taglineText.textContent = getAIPrompt(event) || 'Not set';
    if (hideToggleButton) {
        const hidden = isEntryHidden(entry);
        hideToggleButton.textContent = hidden ? 'Unhide Event' : 'Hide Event';
    }
    if (requeueButton) {
        requeueButton.style.display = 'inline-block';
    }
    document.getElementById('modal-status').textContent = '';
    document.getElementById('modal-status').className = 'status-text';
    
    modal.style.display = 'flex';
}

function updateModalContent(index) {
    const modal = document.getElementById('upload-modal');
    if (!modal || modal.style.display !== 'flex') return;
    openUploadModal(index);
}

// Close upload modal
function closeUploadModal() {
    const modal = document.getElementById('upload-modal');
    modal.style.display = 'none';
    const taglineInput = document.getElementById('modal-tagline-input');
    const imagePromptInput = document.getElementById('modal-image-prompt-input');
    const imageUrlInput = document.getElementById('modal-image-url-input');
    if (taglineInput) taglineInput.value = '';
    if (imagePromptInput) imagePromptInput.value = '';
    if (imageUrlInput) imageUrlInput.value = '';
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

    // Show loading state
    statusElement.textContent = 'Sending request...';
    statusElement.className = 'refresh-status loading';

    const actionCount = Number.isFinite(parseInt(action, 10)) ? parseInt(action, 10) : 0;
    const payload = {
        realm: 'scouts',
        subject: 'agenda',
        action: actionCount,
    };

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollLambdaRuntimeStatus(true);
        await pollQueueDepthSnapshots();
        updateCompletedRequestsFromResult(result);

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
        await pollQueueDepthSnapshots();
        updateCompletedRequestsFromResult(result);
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

async function invokeLambdaHeartbeat() {
    if (!apiAuthReady) return;
    if (!autoLambdaInvokeEnabled) return;
    if (autoLambdaInvokeInFlight) return;
    if (uiCommandInFlight || lambdaRuntimeRunning) return;

    autoLambdaInvokeInFlight = true;
    try {
        const payload = {
            realm: 'scouts',
            subject: 'agenda',
            action: 0,
        };
        const result = await sendScoutsCommand(payload);
        await pollLambdaRuntimeStatus(true);
        await pollQueueDepthSnapshots();
        updateCompletedRequestsFromResult(result);
    } catch (error) {
        console.warn('[Admin] Auto lambda heartbeat failed:', error?.message || error);
    } finally {
        autoLambdaInvokeInFlight = false;
    }
}

function isAcceptedAdminImageUrl(value) {
    if (!hasText(value)) return false;
    const trimmed = String(value).trim();
    return /^https?:\/\//i.test(trimmed)
        || trimmed.startsWith('/')
        || trimmed.startsWith('website/');
}

function getSelectedModalEntry() {
    if (currentEventIndex === null) {
        updateModalStatus('Open an event first.', 'error');
        return null;
    }

    const entry = visibleEventEntries[currentEventIndex];
    if (!entry || !entry.event) {
        updateModalStatus('Unable to find selected event entry.', 'error');
        return null;
    }

    return entry;
}

function getFieldOperationConfig(field) {
    if (field === 'tagline') {
        return {
            subject: 'tagline',
            payloadKey: 'tagline',
            label: 'Tagline',
            queueLabel: 'AI tagline',
        };
    }
    if (field === 'imagePrompt') {
        return {
            subject: 'imagePrompt',
            requestSubject: 'imagePrompt',
            payloadKey: 'imagePrompt',
            label: 'Image Theme',
            queueLabel: 'AI image theme',
        };
    }
    return {
        subject: 'imageUrl',
        requestSubject: 'eventImage',
        payloadKey: 'imageUrl',
        label: 'Image URL',
        queueLabel: 'AI image',
    };
}

function getModalFieldValue(field) {
    if (field === 'tagline') {
        const input = document.getElementById('modal-tagline-input');
        return hasText(input?.value) ? input.value.trim() : '';
    }
    if (field === 'imagePrompt') {
        const input = document.getElementById('modal-image-prompt-input');
        return hasText(input?.value) ? input.value.trim() : '';
    }
    const input = document.getElementById('modal-image-url-input');
    return hasText(input?.value) ? input.value.trim() : '';
}

function refreshModalCurrentMetadata(event) {
    const imageUrlText = document.getElementById('modal-image-url');
    const imageThemeText = document.getElementById('modal-image-theme');
    const taglineText = document.getElementById('modal-tagline');
    const currentImage = getImageUrl(event);
    const currentImageTheme = getImageTheme(event);
    if (imageUrlText) imageUrlText.textContent = currentImage || 'Not set';
    if (imageThemeText) imageThemeText.textContent = currentImageTheme || 'Not set';
    if (taglineText) taglineText.textContent = getAIPrompt(event) || 'Not set';

    const imgElement = document.getElementById('modal-current-image');
    if (imgElement) {
        if (currentImage) {
            imgElement.src = currentImage;
            imgElement.style.display = 'block';
        } else {
            imgElement.style.display = 'none';
        }
    }
}

async function copyImagePromptForEvent(eventIndex) {
    const entry = visibleEventEntries[eventIndex];
    if (!entry) return;

    const imagePrompt = getImageGenerationPrompt(entry.event);
    if (!hasText(imagePrompt)) {
        pinRuntimeDetails('No image prompt available to copy.', 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(imagePrompt);
        pinRuntimeDetails('Image generation prompt copied to clipboard.', 'success');
    } catch (error) {
        console.error('Failed to copy image generation prompt:', error);
        pinRuntimeDetails(`Failed to copy image prompt: ${error.message}`, 'error');
    }
}

function applyLocalPersistedField(entry, field, value) {
    if (!entry || !entry.event) return;
    const event = entry.event;
    if (field === 'tagline') {
        event.tagline = value;
        if (Object.prototype.hasOwnProperty.call(event, 'AI')) delete event.AI;
        if (Object.prototype.hasOwnProperty.call(event, 'ai')) delete event.ai;
        return;
    }
    if (!event.image || typeof event.image !== 'object') {
        event.image = {};
    }
    if (field === 'imagePrompt') {
        event.image.theme = value;
        if (Object.prototype.hasOwnProperty.call(event.image, 'prompt')) delete event.image.prompt;
        return;
    }
    event.image.url = value;
}

function applyLocalHiddenState(entry, hiddenAtIso, hidden = true) {
    if (!entry || !entry.event) return;
    const event = entry.event;
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (hidden) {
        event.isHidden = true;
        event.hiddenAt = hasText(hiddenAtIso) ? hiddenAtIso : new Date().toISOString();
        entry.allHidden = true;
        if (hex) {
            localVisibilityOverrides.set(hex, {
                hidden: true,
                hiddenAt: event.hiddenAt,
            });
        }
    } else {
        event.isHidden = false;
        event.hiddenAt = null;
        entry.allHidden = false;
        if (hex) {
            localVisibilityOverrides.set(hex, {
                hidden: false,
                hiddenAt: null,
            });
        }
    }
}

function applyVisibilityOverrides(entries, options = {}) {
    if (!Array.isArray(entries) || localVisibilityOverrides.size === 0) return false;
    const allowConfirm = options.allowConfirm !== false;
    let changed = false;

    entries.forEach((entry) => {
        const event = entry?.event;
        const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
        if (!hex) return;

        const override = localVisibilityOverrides.get(hex);
        if (!override) return;

        const backendStateMatches = isHiddenEvent(event) === Boolean(override.hidden);
        if (allowConfirm && backendStateMatches) {
            localVisibilityOverrides.delete(hex);
            return;
        }

        if (override.hidden) {
            const nextHiddenAt = hasText(override.hiddenAt) ? override.hiddenAt : (event.hiddenAt || new Date().toISOString());
            if (event.isHidden !== true || event.hiddenAt !== nextHiddenAt || entry.allHidden !== true) {
                event.isHidden = true;
                event.hiddenAt = nextHiddenAt;
                entry.allHidden = true;
                changed = true;
            }
            return;
        }

        if (event.isHidden !== false || event.hiddenAt !== null || entry.allHidden !== false) {
            event.isHidden = false;
            event.hiddenAt = null;
            entry.allHidden = false;
            changed = true;
        }
    });

    return changed;
}

async function persistCurrentField(field) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateModalStatus('Admin API auth not ready.', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        updateModalStatus('Lambda currently running. Wait for completion before persisting.', 'error');
        return;
    }

    const entry = getSelectedModalEntry();
    if (!entry) return;

    const config = getFieldOperationConfig(field);
    const nextValue = getModalFieldValue(field);
    if (!nextValue) {
        updateModalStatus(`Enter a ${config.label.toLowerCase()} value to persist.`, 'error');
        return;
    }
    if (field === 'imageUrl' && !isAcceptedAdminImageUrl(nextValue)) {
        updateModalStatus('Image URL must be http(s), /path, or website/...', 'error');
        return;
    }

    const event = entry.event;
    const eventLabel = event.summary || event.title || `Event ${currentEventIndex + 1}`;
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (!hex) {
        updateModalStatus(`Cannot persist ${config.label.toLowerCase()}: event is missing HEX.`, 'error');
        return;
    }

    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    if (!subject.image || typeof subject.image !== 'object') {
        subject.image = {};
    }
    if (field === 'tagline') {
        subject.tagline = nextValue;
    } else if (field === 'imagePrompt') {
        subject.image.theme = nextValue;
        if (Object.prototype.hasOwnProperty.call(subject.image, 'prompt')) delete subject.image.prompt;
    } else {
        subject.image.url = nextValue;
    }

    if (!hasText(subject.tagline) && hasText(subject.AI)) {
        subject.tagline = subject.AI;
    }
    if (Object.prototype.hasOwnProperty.call(subject, 'AI')) delete subject.AI;
    if (Object.prototype.hasOwnProperty.call(subject, 'ai')) delete subject.ai;

    const payload = {
        realm: 'scouts',
        subject: config.subject,
        action: 'persist',
        hex,
        event: subject,
    };
    payload[config.payloadKey] = nextValue;

    updateModalStatus(`Persisting ${config.label.toLowerCase()} for "${eventLabel}"...`, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        const statusCode = Number.isFinite(result?._httpStatus) ? result._httpStatus : 200;
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const queueAcceptedSuffix = result?.queueAccepted === true ? ' Queue accepted.' : '';
        const successMessage = `${config.label} persist queued for "${eventLabel}" [HTTP ${statusCode}].${queueAcceptedSuffix}${backendMessage}`;
        updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');

        applyLocalPersistedField(entry, field, nextValue);
        refreshModalCurrentMetadata(entry.event);

        await pollQueueDepthSnapshots();
        setTimeout(() => {
            loadEvents({ silent: true });
        }, 1500);
    } catch (error) {
        console.error(`Error persisting ${config.label}:`, error);
        const failureMessage = `Failed to persist ${config.label.toLowerCase()}: ${error.message}`;
        updateModalStatus(failureMessage, 'error');
        pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

async function requestGeneratedField(field) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateModalStatus('Admin API auth not ready.', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        updateModalStatus('Lambda currently running. Wait for completion before queueing generation.', 'error');
        return;
    }

    const entry = getSelectedModalEntry();
    if (!entry) return;

    const config = getFieldOperationConfig(field);
    const event = entry.event;
    const eventLabel = event.summary || event.title || `Event ${currentEventIndex + 1}`;
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (!hex) {
        updateModalStatus(`Cannot queue ${config.queueLabel}: event is missing HEX.`, 'error');
        return;
    }

    const payload = {
        realm: 'scouts',
        subject: config.requestSubject || config.subject,
        action: 'generate',
        hex,
        event: JSON.parse(JSON.stringify(event || {})),
    };

    updateModalStatus(`Queueing ${config.queueLabel} for "${eventLabel}"...`, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        const statusCode = Number.isFinite(result?._httpStatus) ? result._httpStatus : 200;
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const queueAcceptedSuffix = result?.queueAccepted === true ? ' Queue accepted.' : '';
        const successMessage = `${config.queueLabel} request queued for "${eventLabel}" [HTTP ${statusCode}].${queueAcceptedSuffix}${backendMessage}`;
        updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');
        await pollQueueDepthSnapshots();
        setTimeout(() => {
            loadEvents({ silent: true });
        }, 2000);
    } catch (error) {
        console.error(`Error queueing ${config.queueLabel}:`, error);
        const failureMessage = `Failed to queue ${config.queueLabel}: ${error.message}`;
        updateModalStatus(failureMessage, 'error');
        pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

async function hideEvent(eventIndex, fromModal = false) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        else updateRuntimeDetails('Admin API auth not ready.', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        const message = 'Lambda currently running. Wait for completion before hiding.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const entry = visibleEventEntries[eventIndex];
    if (!entry || !entry.event) {
        const message = 'Unable to find selected event entry.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const event = entry.event;
    if (isHiddenEvent(event)) {
        const message = 'Event is already hidden.';
        if (fromModal) updateModalStatus(message, 'info');
        else updateRuntimeDetails(message, 'info');
        return;
    }

    const eventLabel = event.summary || event.title || `Event ${eventIndex + 1}`;
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (!hex) {
        const message = 'Cannot hide event: missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const hiddenAtIso = new Date().toISOString();
    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    subject.isHidden = true;
    subject.hiddenAt = hiddenAtIso;
    if (!subject.image || typeof subject.image !== 'object') {
        subject.image = {};
    }
    if (!hasText(subject.tagline) && hasText(subject.AI)) {
        subject.tagline = subject.AI;
    }
    if (Object.prototype.hasOwnProperty.call(subject, 'AI')) delete subject.AI;
    if (Object.prototype.hasOwnProperty.call(subject, 'ai')) delete subject.ai;

    const payload = {
        realm: 'scouts',
        subject: 'metadata',
        action: 'hide',
        hex,
        event: subject,
        hiddenAt: hiddenAtIso,
    };

    const loadingMessage = `Hiding "${eventLabel}"...`;
    if (fromModal) updateModalStatus(loadingMessage, 'loading');
    else pinRuntimeDetails(loadingMessage, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollQueueDepthSnapshots();
        applyLocalHiddenState(entry, hiddenAtIso);
        updateEventsCount(
            uniqueEventEntries.length,
            eventsData.length,
            uniqueEventEntries.filter((candidate) => isEntryHidden(candidate)).length,
            uniqueEventEntries.filter((candidate) => isEntryComplete(candidate)).length,
        );
        updateSidebarUi();
        renderEvents();
        if (fromModal) {
            updateModalContent(currentEventIndex);
        }
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const successMessage = `Hide request queued for "${eventLabel}".${backendMessage}`;
        if (fromModal) updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');
    } catch (error) {
        console.error('Error hiding event:', error);
        const failureMessage = `Failed to hide event: ${error.message}`;
        if (fromModal) updateModalStatus(failureMessage, 'error');
        else pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

async function unhideEvent(eventIndex, fromModal = false) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        else updateRuntimeDetails('Admin API auth not ready.', 'error');
        return;
    }
    if (lambdaRuntimeRunning || uiCommandInFlight) {
        const message = 'Lambda currently running. Wait for completion before unhiding.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const entry = visibleEventEntries[eventIndex];
    if (!entry || !entry.event) {
        const message = 'Unable to find selected event entry.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const event = entry.event;
    if (!isHiddenEvent(event)) {
        const message = 'Event is already visible.';
        if (fromModal) updateModalStatus(message, 'info');
        else updateRuntimeDetails(message, 'info');
        return;
    }

    const eventLabel = event.summary || event.title || `Event ${eventIndex + 1}`;
    const hex = hasText(event?.hex) ? event.hex.trim().toLowerCase() : '';
    if (!hex) {
        const message = 'Cannot unhide event: missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    subject.isHidden = false;
    subject.hiddenAt = null;
    if (!subject.image || typeof subject.image !== 'object') {
        subject.image = {};
    }
    if (!hasText(subject.tagline) && hasText(subject.AI)) {
        subject.tagline = subject.AI;
    }
    if (Object.prototype.hasOwnProperty.call(subject, 'AI')) delete subject.AI;
    if (Object.prototype.hasOwnProperty.call(subject, 'ai')) delete subject.ai;

    const payload = {
        realm: 'scouts',
        subject: 'metadata',
        action: 'unhide',
        hex,
        event: subject,
    };

    const loadingMessage = `Unhiding "${eventLabel}"...`;
    if (fromModal) updateModalStatus(loadingMessage, 'loading');
    else pinRuntimeDetails(loadingMessage, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollQueueDepthSnapshots();
        applyLocalHiddenState(entry, null, false);
        updateEventsCount(
            uniqueEventEntries.length,
            eventsData.length,
            uniqueEventEntries.filter((candidate) => isEntryHidden(candidate)).length,
            uniqueEventEntries.filter((candidate) => isEntryComplete(candidate)).length,
        );
        updateSidebarUi();
        renderEvents();
        if (fromModal) {
            updateModalContent(currentEventIndex);
        }
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const successMessage = `Unhide request queued for "${eventLabel}".${backendMessage}`;
        if (fromModal) updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');
    } catch (error) {
        console.error('Error unhiding event:', error);
        const failureMessage = `Failed to unhide event: ${error.message}`;
        if (fromModal) updateModalStatus(failureMessage, 'error');
        else pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

function toggleCurrentEventHidden() {
    if (currentEventIndex === null) {
        updateModalStatus('Open an event first before toggling visibility.', 'error');
        return;
    }
    const entry = visibleEventEntries[currentEventIndex];
    if (!entry || !entry.event) {
        updateModalStatus('Unable to find selected event entry.', 'error');
        return;
    }
    if (isEntryHidden(entry)) {
        unhideEvent(currentEventIndex, true);
    } else {
        hideEvent(currentEventIndex, true);
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
    if (Object.prototype.hasOwnProperty.call(subject, 'AI')) delete subject.AI;
    if (Object.prototype.hasOwnProperty.call(subject, 'ai')) delete subject.ai;
    if (!hasText(subject.tagline)) subject.tagline = null;
    if (!hasText(subject.image.theme)) subject.image.theme = null;
    if (Object.prototype.hasOwnProperty.call(subject.image, 'prompt')) delete subject.image.prompt;
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
    autoLambdaInvokeIntervalMs = readAutoLambdaIntervalPreference();
    statusPollingIntervalMs = readStatusPollingIntervalPreference();
    hexPreviewAutoRefreshEnabled = readHexPreviewAutoRefreshPreference();
    hexPreviewIntervalMs = readHexPreviewIntervalPreference();
    setAutoLambdaInvocationEnabled(readAutoLambdaInvocationPreference(), false);
    setAgendaAutoRefreshEnabled(readAgendaAutoRefreshPreference(), false);
    setStatusPollingEnabled(readStatusPollingPreference(), false);
    persistAutoLambdaInvocationPreference(autoLambdaInvokeEnabled);
    persistAutoLambdaIntervalPreference(autoLambdaInvokeIntervalMs);
    persistStatusPollingPreference(statusPollingEnabled);
    persistStatusPollingIntervalPreference(statusPollingIntervalMs);
    setApiActionState(false);
    checkApiAuthStatus();
    loadEvents();
    renderCompletedRequests();
    document.addEventListener('click', (event) => {
        const menu = document.getElementById('viewer-menu');
        const button = document.getElementById('viewer-menu-button');
        if (!menu || !button) return;
        const target = event.target;
        if (menu.contains(target) || button.contains(target)) return;
        closeViewerMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        closeViewerMenu();
        closeAllViewers();
    });
});
