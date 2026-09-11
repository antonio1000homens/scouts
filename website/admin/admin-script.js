// Admin Script for Event Images Management

let eventsData = [];
let uniqueEventEntries = [];
let visibleEventEntries = [];
let currentEventIndex = null;
let apiAuthReady = false;
let uiCommandInFlight = false;
let activeFilter = '';
let agendaPayload = null;
let agendaLoadInFlight = false;
let latestQueuedSnapshot = null;
let latestProcessingSnapshot = null;
let latestCompletedSnapshot = null;
let activeRuntimeViewerKey = '';
let pinnedRuntimeDetails = null;
let lastLoadedEventsSummary = null;
let adminNotificationTimer = null;
let browserNotificationsEnabled = false;
let agendaNotificationBaseline = null;
let browserNotificationUnavailableShown = false;
const MIN_RUNTIME_DETAILS_VISIBLE_MS = 5000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS = 20000;
const HEX_NOT_FOUND_BACKOFF_MS = 30000;
const COMPLETED_REQUEST_HIDE_AFTER_MS = 10 * 60 * 1000;
const AUTO_LAMBDA_PREF_KEY = 'scouts_admin_auto_lambda_enabled';
const AUTO_LAMBDA_INTERVAL_PREF_KEY = 'scouts_admin_auto_lambda_interval_ms';
const AGENDA_URL = '/agenda.json';
const FALLBACK_AGENDA_URL = 'https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com/agenda.json';
const STATUS_POLL_PREF_KEY = 'scouts_admin_status_poll_enabled';
const STATUS_POLL_INTERVAL_PREF_KEY = 'scouts_admin_status_poll_interval_seconds';
const HEX_PREVIEW_AUTO_REFRESH_PREF_KEY = 'scouts_admin_hex_preview_auto_refresh';
const HEX_PREVIEW_INTERVAL_PREF_KEY = 'scouts_admin_hex_preview_interval_ms';
const BROWSER_NOTIFICATIONS_PREF_KEY = 'scouts_admin_browser_notifications_enabled';
let runtimeDetailsLastShownAt = 0;
let runtimeDetailsLastMessage = '';
let runtimeDetailsLastType = 'info';
let runtimeDetailsPending = null;
let runtimeDetailsFlushTimer = null;
let latestBackendRequestId = '';
let autoLambdaInvokeInFlight = false;
let autoLambdaInvokeEnabled = true;
let autoLambdaInvokeIntervalMs = DEFAULT_AUTO_LAMBDA_INVOKE_INTERVAL_MS;
let autoLambdaInvokeTimer = null;
let statusPollingEnabled = true;
let statusPollingIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS;
let statusPollingTimer = null;
let statusPollingInFlight = false;
let latestCompletedRequests = [];
let latestCompletedRequestsUpdatedAt = null;
let latestImageEnrichExecutions = [];
let latestImageEnrichUpdatedAt = null;
let showArchivedRequests = false;
let showStalledRequests = false;
let cachedScoutsConfig = null;
let cachedScoutsConfigLoadedAt = 0;
let scoutsConfigLoadPromise = null;
const missingHexRetryAtByHex = new Map();
const warnedMissingDtstartIds = new Set();
const localVisibilityOverrides = new Map();
const ADMIN_API_BASE = window.ADMIN_API_BASE || '/admin-api';
const configuredScoutsUrl = window.SCOUTS_URL || window.SCOUTS_REFRESH_URL || '';
// Never let a browser-side config point at the Lambda URL.  The API key is
// injected only by the same-origin Cloudflare Worker proxy.
const SCOUTS_URL = configuredScoutsUrl.startsWith('/')
    ? configuredScoutsUrl
    : `${ADMIN_API_BASE}/scouts`;
const AUTH_STATUS_URL = window.SCOUTS_AUTH_STATUS_URL || `${ADMIN_API_BASE}/auth-status`;
const QUEUED_REQUESTS_RUNTIME_URL = '../../runtime/scoutsQueued.json';
const PROCESSING_REQUESTS_RUNTIME_URL = '../../runtime/scoutsProcessing.json';
const COMPLETED_REQUESTS_RUNTIME_URL = '../../runtime/scoutsComplete.json';
const SCOUTS_CONFIG_URL = window.SCOUTS_CONFIG_URL || '../../scouts.conf';
const SCOUTS_CONFIG_CACHE_MS = 5 * 60 * 1000;
const HEX_PREVIEW_POLL_INTERVAL_MS = 5000;
const GENERATED_REQUEST_POLL_INTERVAL_MS = 3000;
const GENERATED_REQUEST_POLL_TIMEOUT_MS = 30000;
const QUEUED_STALLED_THRESHOLD_MS = 60 * 1000;
let activeHexPreviewCardIndex = null;
let activeHexPreviewHex = null;
let activeHexPreviewPollTimer = null;
let hexPreviewAutoRefreshEnabled = false;
let hexPreviewIntervalMs = HEX_PREVIEW_POLL_INTERVAL_MS;
let generatedRequestPollTimer = null;
let generatedRequestPollToken = 0;

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
    if (countElement) {
        countElement.textContent = `${uniqueCount} unique (${rawCount} raw${hiddenSuffix}${completeSuffix})`;
    }
    lastLoadedEventsSummary = {
        uniqueCount,
        rawCount,
        hiddenCount,
        completeCount,
        label: `${uniqueCount} unique (${rawCount} raw${hiddenSuffix}${completeSuffix})`,
    };
}

function showAdminNotification(message, tone = 'info', durationMs = 5000) {
    const notificationEl = document.getElementById('admin-notification');
    if (!notificationEl) return;

    notificationEl.textContent = message;
    notificationEl.dataset.tone = tone;
    notificationEl.hidden = false;

    if (adminNotificationTimer) {
        clearTimeout(adminNotificationTimer);
    }
    adminNotificationTimer = setTimeout(() => {
        notificationEl.hidden = true;
    }, Math.max(1000, durationMs));
}

function readBrowserNotificationsPreference() {
    try {
        return window.localStorage.getItem(BROWSER_NOTIFICATIONS_PREF_KEY) === '1';
    } catch {
        return false;
    }
}

function persistBrowserNotificationsPreference(enabled) {
    try {
        window.localStorage.setItem(BROWSER_NOTIFICATIONS_PREF_KEY, enabled ? '1' : '0');
    } catch {
        // Ignore storage errors; the preference remains valid for this page.
    }
}

function updateBrowserNotificationsUi() {
    const toggle = document.getElementById('browser-notifications-toggle');
    if (!toggle) return;
    toggle.checked = browserNotificationsEnabled;
    toggle.title = browserNotificationsEnabled
        ? 'Native browser notifications are enabled for agenda changes.'
        : 'Enable native browser notifications for agenda changes.';
}

async function setBrowserNotificationsEnabled(enabled) {
    if (!enabled) {
        browserNotificationsEnabled = false;
        persistBrowserNotificationsPreference(false);
        updateBrowserNotificationsUi();
        return false;
    }

    if (typeof Notification !== 'function') {
        browserNotificationsEnabled = false;
        persistBrowserNotificationsPreference(false);
        updateBrowserNotificationsUi();
        showAdminNotification('This browser does not support native notifications; in-page alerts remain available.', 'error', 7000);
        return false;
    }

    let permission = Notification.permission;
    if (permission === 'default') {
        try {
            permission = await Notification.requestPermission();
        } catch (error) {
            console.warn('[AdminNotifications] Permission request failed', error);
            permission = 'denied';
        }
    }

    browserNotificationsEnabled = permission === 'granted';
    persistBrowserNotificationsPreference(browserNotificationsEnabled);
    updateBrowserNotificationsUi();
    if (!browserNotificationsEnabled) {
        showAdminNotification(
            permission === 'denied'
                ? 'Browser notifications were denied; in-page alerts remain available.'
                : 'Browser notifications were not enabled; in-page alerts remain available.',
            'error',
            7000,
        );
    } else {
        showAdminNotification('Browser notifications enabled for agenda changes.', 'success', 4000);
    }
    return browserNotificationsEnabled;
}

function initializeBrowserNotificationsPreference() {
    browserNotificationsEnabled = readBrowserNotificationsPreference()
        && typeof Notification === 'function'
        && Notification.permission === 'granted';
    updateBrowserNotificationsUi();
}

function notificationEventIdentity(entry, index = 0) {
    const event = entry?.event || entry || {};
    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const hex = String(metadata.hex || metadata.hexId || event.hex || event.hexId || '').trim().toLowerCase();
    if (hex) return `hex:${hex}`;
    const uid = String(event.uid || event.source?.uid || '').trim();
    if (uid) return `uid:${uid}`;
    const title = String(event.summary || event.title || '').trim().toLowerCase();
    const date = String(event.dtstart || event.start || '').trim();
    const location = String(event.location || '').trim().toLowerCase();
    return `fallback:${title}|${date}|${location}|${index}`;
}

function notificationEventSnapshot(entry) {
    const event = entry?.event || entry || {};
    const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const image = metadata.image && typeof metadata.image === 'object' ? metadata.image : (event.image || {});
    const status = metadata.status && typeof metadata.status === 'object' ? metadata.status : (event.status || {});
    return {
        title: String(event.summary || event.title || '').trim(),
        date: String(event.dtstart || event.start || '').trim(),
        location: String(event.location || '').trim(),
        hidden: status.isHidden === true || event.isHidden === true || event.status === 'hidden',
        approved: status.isApproved === true || event.approved === true || event.isApproved === true,
        tagline: String(metadata.tagline || event.tagline || event.AI || event.ai || '').trim(),
        imageTheme: String(image.theme || '').trim(),
        imageUrl: String(image.url || image.src || event.imageUrl || '').trim(),
    };
}

function buildAgendaChangeSet(previousEntries = [], currentEntries = []) {
    const previous = new Map(previousEntries.map((entry, index) => [notificationEventIdentity(entry, index), notificationEventSnapshot(entry)]));
    const current = new Map(currentEntries.map((entry, index) => [notificationEventIdentity(entry, index), notificationEventSnapshot(entry)]));
    const added = [];
    const removed = [];
    const changed = [];
    const fields = [
        ['title', 'title'],
        ['date', 'date'],
        ['location', 'location'],
        ['hidden', 'visibility'],
        ['approved', 'approval'],
        ['tagline', 'tagline'],
        ['imageTheme', 'image theme'],
        ['imageUrl', 'image'],
    ];

    for (const [identity, snapshot] of current) {
        if (!previous.has(identity)) {
            added.push({ identity, snapshot });
            continue;
        }
        const before = previous.get(identity);
        const changes = fields
            .filter(([field]) => before[field] !== snapshot[field])
            .map(([, label]) => label);
        if (changes.length > 0) changed.push({ identity, snapshot, changes });
    }
    for (const [identity, snapshot] of previous) {
        if (!current.has(identity)) removed.push({ identity, snapshot });
    }

    return { added, removed, changed, hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0 };
}

function notificationEventLabel(change) {
    return change?.snapshot?.title || change?.identity?.replace(/^(hex|uid|fallback):/, '') || 'unnamed event';
}

function notifyAgendaChanges(changeSet) {
    if (!browserNotificationsEnabled || !changeSet?.hasChanges) return false;

    const parts = [];
    if (changeSet.added.length) parts.push(`${changeSet.added.length} new`);
    if (changeSet.removed.length) parts.push(`${changeSet.removed.length} removed`);
    if (changeSet.changed.length) parts.push(`${changeSet.changed.length} updated`);
    const examples = [
        ...changeSet.added.slice(0, 2).map((change) => `New: ${notificationEventLabel(change)}`),
        ...changeSet.removed.slice(0, 2).map((change) => `Removed: ${notificationEventLabel(change)}`),
        ...changeSet.changed.slice(0, 3).map((change) => `${notificationEventLabel(change)} (${change.changes.join(', ')})`),
    ];
    const body = `${parts.join(', ')} event change${parts.reduce((sum, part) => sum + Number.parseInt(part, 10), 0) === 1 ? '' : 's'}. ${examples.join(' · ')}`;
    const notificationOptions = {
        body,
        tag: 'scouts-admin-agenda-change',
        icon: '/website/images/scouts-logo-white-png.png',
    };

    try {
        if (typeof Notification !== 'function' || Notification.permission !== 'granted') {
            throw new Error('Native browser notifications are unavailable.');
        }
        const notification = new Notification('Scouts agenda changed', notificationOptions);
        notification.onclick = () => window.focus();
        browserNotificationUnavailableShown = false;
        return true;
    } catch (error) {
        browserNotificationsEnabled = false;
        persistBrowserNotificationsPreference(false);
        updateBrowserNotificationsUi();
        if (!browserNotificationUnavailableShown) {
            showAdminNotification(`Agenda changed: ${body}`, 'info', 7000);
            browserNotificationUnavailableShown = true;
        }
        return false;
    }
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

function updateRuntimeRequestId(requestId, label = 'Latest request ID') {
    const requestIdElement = document.getElementById('runtime-state-request-id');
    if (!requestIdElement) return;

    const normalizedRequestId = hasText(requestId) ? String(requestId).trim() : '';
    latestBackendRequestId = normalizedRequestId;
    requestIdElement.textContent = `${label}: ${normalizedRequestId || 'n/a'}`;
    requestIdElement.className = 'runtime-request-id';
}

function updateRuntimeRealmError(realmError, realmErrorDetail) {
    const requestIdElement = document.getElementById('runtime-state-request-id');
    if (!requestIdElement) return;

    const errorRealm = hasText(realmError) ? String(realmError).trim() : 'validation';
    const errorDetail = hasText(realmErrorDetail) ? String(realmErrorDetail).trim() : 'Request validation failed';
    requestIdElement.textContent = `${errorRealm} error: ${errorDetail}`;
    requestIdElement.className = 'runtime-request-id runtime-request-error';
}

function extractBackendRequestId(result) {
    if (result?.realmError) {
        return null;
    }
    const candidates = [
        result?.queuedMessage?.messageId,
        result?.queuedMessage?.requestId,
        result?.requestId,
        result?.messageId,
    ];
    for (const candidate of candidates) {
        if (hasText(candidate)) return String(candidate).trim();
    }
    return '';
}

function extractBackendRealmError(result) {
    if (!result || typeof result !== 'object') return null;
    const realmError = hasText(result.realmError) ? String(result.realmError).trim() : null;
    const realmErrorDetail = hasText(result.realmErrorDetail) ? String(result.realmErrorDetail).trim() : null;
    return realmError ? { realmError, realmErrorDetail } : null;
}

function appendBackendRequestIdMessage(message, result, options = {}) {
    const realmError = extractBackendRealmError(result);
    if (realmError) {
        if (options.updateFooter !== false) {
            updateRuntimeRealmError(realmError.realmError, realmError.realmErrorDetail);
        }
        const baseMessage = typeof message === 'string' ? message.trim() : String(message ?? '').trim();
        return baseMessage || realmError.realmErrorDetail || 'Request validation failed';
    }

    const requestId = extractBackendRequestId(result);
    if (!requestId) {
        return typeof message === 'string' ? message : String(message ?? '');
    }

    if (options.updateFooter !== false) {
        updateRuntimeRequestId(requestId);
    }

    const baseMessage = typeof message === 'string' ? message.trim() : String(message ?? '').trim();
    if (options.includeInMessage === false) {
        return baseMessage;
    }
    if (!baseMessage) {
        return `Request ID: ${requestId}.`;
    }
    if (baseMessage.includes(`Request ID: ${requestId}`)) {
        return baseMessage;
    }
    return `${baseMessage} Request ID: ${requestId}.`;
}

function formatRuntimeSummary(command, result) {
    const realm = hasText(command?.realm) ? String(command.realm).trim().toLowerCase() : '';
    const subject = hasText(command?.subject) ? String(command.subject).trim().toLowerCase() : '';
    const status = hasText(result?.status) ? String(result.status).trim().toLowerCase() : '';

    if (realm === 'scouts' && subject === 'agenda' && status) {
        return `Refresh status ${status}`;
    }

    return '';
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
    return hasText(getAIPrompt(event))
        && hasText(getImageThemeOrLegacyPrompt(event))
        && hasRelativeImageUrl(event)
        && isEventApproved(event)
        && !isHiddenEvent(event);
}

function isNewEvent(event) {
    return !hasText(getAIPrompt(event))
        && !hasText(getImageThemeOrLegacyPrompt(event))
        && !hasRelativeImageUrl(event);
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

function isEventApproved(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.approved === true || event.isApproved === true) return true;
    const status = event.status;
    if (status && typeof status === 'object' && status.isApproved === true) return true;
    const metadataStatus = event.metadata?.status;
    return metadataStatus && typeof metadataStatus === 'object' && metadataStatus.isApproved === true;
}

function isEntryApproved(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return isEventApproved(entry.event);
}

function isEntryPendingApproval(entry) {
    if (isEntryHidden(entry)) return false;
    return hasText(entry?.event?.hex) && !isEntryApproved(entry);
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

function getDefaultFilterForCounts(counts) {
    const priority = ['new', 'approval', 'missing', 'complete', 'hidden', 'all'];
    for (const filter of priority) {
        if ((counts?.[filter] ?? 0) > 0) {
            return filter;
        }
    }
    return 'all';
}

function updateSidebarUi() {
    const counts = getFilterCounts();
    if (!hasText(activeFilter) || !(activeFilter in counts)) {
        activeFilter = getDefaultFilterForCounts(counts);
    }
    const filters = ['new', 'approval', 'missing', 'hidden', 'complete', 'all'];
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
    ['agenda-viewer', 'events-json-viewer', 'scouts-config-viewer', 'runtime-json-viewer', 'image-viewer', 'ai-config-viewer'].forEach((viewerId) => {
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
        const hex = getEventHex(event);
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

async function renderScoutsConfigViewerContent(force = false) {
    const content = document.getElementById('scouts-config-content');
    if (!content) return;
    content.textContent = 'Loading scouts.conf...';
    try {
        const config = await loadScoutsConfig(force);
        content.textContent = JSON.stringify(config ?? {}, null, 2);
    } catch (error) {
        content.textContent = `Failed to load scouts.conf: ${error.message}`;
    }
}

function showScoutsConfigViewer() {
    closeAllViewers('scouts-config-viewer');
    const viewer = setViewerOpen('scouts-config-viewer', true);
    if (!viewer) return;
    renderScoutsConfigViewerContent(true);
}

function toggleScoutsConfigViewer() {
    const viewer = document.getElementById('scouts-config-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        setViewerOpen('scouts-config-viewer', false);
        return;
    }
    showScoutsConfigViewer();
}

function getRuntimeSnapshotViewerConfig(snapshotKey) {
    if (snapshotKey === 'queued') {
        return {
            key: 'queued',
            title: 'Runtime Queued Snapshot',
            url: QUEUED_REQUESTS_RUNTIME_URL,
            getSnapshot: () => latestQueuedSnapshot,
            setSnapshot: (snapshot) => {
                latestQueuedSnapshot = snapshot;
            },
        };
    }
    if (snapshotKey === 'processing') {
        return {
            key: 'processing',
            title: 'Runtime Processing Snapshot',
            url: PROCESSING_REQUESTS_RUNTIME_URL,
            getSnapshot: () => latestProcessingSnapshot,
            setSnapshot: (snapshot) => {
                latestProcessingSnapshot = snapshot;
            },
        };
    }
    if (snapshotKey === 'completed') {
        return {
            key: 'completed',
            title: 'Runtime Completed Snapshot',
            url: COMPLETED_REQUESTS_RUNTIME_URL,
            getSnapshot: () => latestCompletedSnapshot,
            setSnapshot: (snapshot) => {
                latestCompletedSnapshot = snapshot;
            },
        };
    }
    return null;
}

async function renderRuntimeSnapshotViewerContent(snapshotKey, force = false) {
    const config = getRuntimeSnapshotViewerConfig(snapshotKey);
    const titleEl = document.getElementById('runtime-json-title');
    const contentEl = document.getElementById('runtime-json-content');
    if (!config || !titleEl || !contentEl) return;

    titleEl.textContent = config.title;
    contentEl.textContent = 'Loading runtime snapshot...';

    let snapshot = !force ? config.getSnapshot() : null;
    if (!snapshot) {
        snapshot = await fetchQueueSnapshot(config.url);
        config.setSnapshot(snapshot);
    }

    if (!snapshot) {
        contentEl.textContent = 'Runtime snapshot not available.';
        return;
    }

    contentEl.textContent = JSON.stringify(snapshot, null, 2);
}

function showRuntimeSnapshotViewer(snapshotKey = 'queued') {
    const config = getRuntimeSnapshotViewerConfig(snapshotKey);
    if (!config) return;

    activeRuntimeViewerKey = config.key;
    closeAllViewers('runtime-json-viewer');
    const viewer = setViewerOpen('runtime-json-viewer', true);
    if (!viewer) return;
    renderRuntimeSnapshotViewerContent(config.key, true).catch((error) => {
        const contentEl = document.getElementById('runtime-json-content');
        if (contentEl) {
            contentEl.textContent = `Failed to load runtime snapshot: ${error.message}`;
        }
    });
}

function toggleRuntimeSnapshotViewer(snapshotKey = activeRuntimeViewerKey || 'queued') {
    const viewer = document.getElementById('runtime-json-viewer');
    if (!viewer) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        setViewerOpen('runtime-json-viewer', false);
        return;
    }
    showRuntimeSnapshotViewer(snapshotKey);
}

function openImageViewer(imageUrl, title = 'Event Image') {
    if (!hasText(imageUrl)) return;
    const titleEl = document.getElementById('image-viewer-title');
    const imageEl = document.getElementById('image-viewer-image');
    if (!titleEl || !imageEl) return;

    titleEl.textContent = title;
    imageEl.src = imageUrl;
    imageEl.alt = title;
    closeAllViewers('image-viewer');
    setViewerOpen('image-viewer', true);
}

function toggleImageViewer() {
    const viewer = document.getElementById('image-viewer');
    const imageEl = document.getElementById('image-viewer-image');
    if (!viewer || !imageEl) return;

    const shouldShow = viewer.style.display === 'none' || viewer.style.display === '';
    if (!shouldShow) {
        imageEl.src = '';
        setViewerOpen('image-viewer', false);
        return;
    }
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

function formatRuntimeStatusCompletedAt(isoString) {
    if (!hasText(isoString)) return '';
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) return '';

    const now = new Date();
    const isToday = parsed.getFullYear() === now.getFullYear()
        && parsed.getMonth() === now.getMonth()
        && parsed.getDate() === now.getDate();

    return parsed.toLocaleString('en-GB', isToday
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    if (normalized === 'imageTheme') return 'Image Theme';
    if (normalized === 'imageUrl') return 'Image URL';
    if (normalized === 'tagline') return 'Tagline';
    if (normalized === 'hidden') return 'Hidden';
    if (normalized === 'persist') return 'Persist';
    if (normalized === 'completed') return 'Completed';
    return normalized;
}

function formatRequestStageLabel(value, fallback = 'Unknown') {
    if (!hasText(value)) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'processing-stall') return 'Processing Stall';
    if (normalized === 'completed-archive') return 'Completed Archive';
    return formatCompletedRequestOperation(value);
}

function formatRequestBadgeClass(value) {
    if (!hasText(value)) return 'badge-unknown';
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'queued') return 'badge-queued';
    if (normalized === 'queued-stalled') return 'badge-queued-stalled';
    if (normalized === 'processing') return 'badge-processing';
    if (normalized === 'processing-stall') return 'badge-processing-stall';
    if (normalized === 'processing-complete') return 'badge-processing-complete';
    if (normalized === 'completed') return 'badge-completed';
    if (normalized === 'completed-archive') return 'badge-completed-archive';
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
    if (normalized === 'queued-stalled') return 'STALL Queued';
    if (normalized === 'processing') return 'P Processing';
    if (normalized === 'processing-stall') return 'STALL Processing';
    if (normalized === 'processing-complete') return 'DONE Processing';
    if (normalized === 'completed') return 'OK Completed';
    if (normalized === 'completed-archive') return 'ARCH Completed';
    if (normalized === 'persist') return 'SAVE Persist';
    if (normalized === 'hidden') return 'OFF Hidden';
    if (normalized === 'imageurl') return 'IMG Image URL';
    if (normalized === 'imageprompt') return 'ART Image Theme';
    if (normalized === 'tagline') return 'TXT Tagline';
    if (normalized === 'updated') return 'UP Updated';
    return formatRequestStageLabel(value, fallback);
}

function extractRequestQueueAction(entry) {
    const candidates = [
        entry?.action,
        entry?.command?.action,
        entry?.message?.action,
        entry?.payload?.action,
        entry?.rawPayload?.action,
        entry?.body?.action,
        entry?.request?.action,
        entry?.operation,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function formatRequestQueueActionLabel(value) {
    if (!hasText(value)) return 'n/a';
    return String(value).trim();
}

function resolveRequestSubject(entry) {
    if (!entry || typeof entry !== 'object') return '';

    if (hasText(entry?.subject)) {
        return entry.subject.trim();
    }

    if (entry?.subject && typeof entry.subject === 'object') {
        const subjectTitle = entry.subject.title ?? entry.subject.summary ?? entry.subject.name ?? entry.subject.value ?? null;
        if (hasText(subjectTitle)) {
            return subjectTitle.trim();
        }
    }

    const directTitle = entry?.title ?? entry?.summary ?? entry?.name ?? null;
    if (hasText(directTitle)) {
        return directTitle.trim();
    }

    const hex = getSnapshotRequestHex(entry);
    const knownTitle = resolveEventTitleByHex(hex);
    if (hasText(knownTitle)) {
        return knownTitle.trim();
    }

    const decodedHex = decodeHexToText(hex);
    if (hasText(decodedHex)) {
        return decodedHex.trim();
    }

    return '';
}

function normaliseRequestCardEntry(entry, options = {}) {
    if (!entry || typeof entry !== 'object') return null;

    const subject = resolveRequestSubject(entry);
    const hex = getSnapshotRequestHex(entry);
    const title = hasText(subject)
        ? subject
        : (hex || (hasText(entry?.requestId) ? entry.requestId.trim() : 'Unknown'));
    const requestId = hasText(entry?.requestId)
        ? entry.requestId.trim()
        : (hasText(entry?.messageId) ? entry.messageId.trim() : '');
    const messageId = hasText(entry?.messageId) ? entry.messageId.trim() : '';
    const rawAction = entry?.operation ?? entry?.status ?? options.defaultAction ?? '';
    const stageKey = hasText(rawAction)
        ? String(rawAction).trim().toLowerCase()
        : (hasText(options.defaultAction) ? String(options.defaultAction).trim().toLowerCase() : '');
    const action = formatRequestStageLabel(stageKey, formatRequestStageLabel(options.defaultAction, 'Unknown'));
    const timestamp = hasText(entry?.processedAt)
        ? entry.processedAt
        : (hasText(entry?.requestTime)
            ? entry.requestTime
            : (hasText(entry?.completedAt)
                ? entry.completedAt
                : (hasText(entry?.updatedAt) ? entry.updatedAt : '')));
    const queueAction = extractRequestQueueAction(entry);
    const realm = hasText(entry?.realm) ? entry.realm.trim() : '';
    const subtitleParts = [];
    if (hasText(options.sourceLabel)) subtitleParts.push(options.sourceLabel);

    return {
        title,
        subject,
        hex,
        realm,
        requestId,
        messageId,
        stageKey,
        operation: action,
        queueAction,
        headerAction: formatRequestQueueActionLabel(queueAction),
        badgeLabel: formatRequestBadgeLabel(stageKey, action),
        processedAt: timestamp,
        badgeClass: formatRequestBadgeClass(stageKey),
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
            ['Realm', normalized.realm],
            ['Subject', normalized.subject],
            ['Action', formatRequestQueueActionLabel(normalized.queueAction)],
            ['Request ID', normalized.requestId],
            ['Message ID', normalized.messageId],
            ['HEX', normalized.hex],
            ['Stage', normalized.operation],
            ['Timestamp', normalized.processedAt],
        ].filter(([, value]) => value !== null && value !== undefined && String(value).trim().length > 0);
        const metadataRows = metadata.map(([label, value]) => {
            const rowClass = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            return `
            <div class="request-card-meta-row request-card-meta-row-${escapeHtml(rowClass)}">
                <div class="request-card-meta-label">${escapeHtml(label)}</div>
                <div class="request-card-meta-value">${escapeHtml(String(value).trim())}</div>
            </div>
        `;
        }).join('');
        return `
            <article class="request-card">
                <div class="request-card-header">
                    <div class="request-card-lead">
                        <div class="request-card-time"${hasText(normalized.processedAt) ? ` title="${escapeHtml(normalized.processedAt)}"` : ''}>${escapeHtml(formatTrackerTimestamp(normalized.processedAt))}</div>
                        <div class="request-card-title">
                            <span class="request-card-title-text">${escapeHtml(normalized.title)}</span>
                            ${hasText(normalized.queueAction) ? `<span class="request-card-title-action">${escapeHtml(normalized.headerAction)}</span>` : ''}
                        </div>
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
        const existingPriority = getRequestStagePriority(existing?.stageKey);
        const entryPriority = getRequestStagePriority(entry?.stageKey);
        if (entryPriority > existingPriority) {
            byRequestId.set(requestId, entry);
            return;
        }
        const existingTime = getRequestTimestampValue(existing);
        const entryTime = getRequestTimestampValue(entry);
        if (entryTime >= existingTime) {
            byRequestId.set(requestId, entry);
        }
    });
    return [...byRequestId.values(), ...noRequestId];
}

function getRequestStagePriority(stageKey) {
    const normalized = hasText(stageKey) ? String(stageKey).trim().toLowerCase() : '';
    if (normalized === 'completed') return 5;
    if (normalized === 'completed-archive') return 4;
    if (normalized === 'processing') return 3;
    if (normalized === 'processing-stall') return 2;
    if (normalized === 'queued') return 1;
    return 0;
}

function getRequestTimestampValue(entry) {
    const candidates = [
        entry?.processedAt,
        entry?.completedAt,
        entry?.requestTime,
        entry?.updatedAt,
        entry?.timestamp,
    ];

    for (const candidate of candidates) {
        if (!hasText(candidate)) continue;
        const parsed = new Date(candidate).getTime();
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}

function sortRequestEntriesByTimestamp(entries) {
    return [...entries].sort((left, right) => {
        return getRequestTimestampValue(right) - getRequestTimestampValue(left);
    });
}

function setRequests(entries, updatedAt = null) {
    const normalized = Array.isArray(entries)
        ? entries
            .map((entry) => normaliseRequestCardEntry(entry, {
                defaultAction: entry?.status ?? entry?.operation ?? '',
            }))
            .filter(Boolean)
        : [];
    latestCompletedRequests = sortRequestEntriesByTimestamp(deduplicateRequestsByRequestId(normalized));
    latestCompletedRequestsUpdatedAt = hasText(updatedAt) ? updatedAt : null;
    renderCompletedRequests();
}

function setCompletedRequests(entries, updatedAt = null) {
    const normalized = Array.isArray(entries)
        ? entries
            .map((entry) => normaliseCompletedRequestEntry(entry))
            .filter(Boolean)
        : [];
    latestCompletedRequests = sortRequestEntriesByTimestamp(deduplicateRequestsByRequestId(normalized));
    latestCompletedRequestsUpdatedAt = hasText(updatedAt) ? updatedAt : null;
    renderCompletedRequests();
}

function groupRuntimeRequestsBySection(entries) {
    const groups = {
        queued: [],
        processing: [],
        completed: [],
    };

    (entries || []).forEach((entry) => {
        const stageKey = hasText(entry?.stageKey) ? entry.stageKey.trim().toLowerCase() : '';
        if (stageKey === 'queued') {
            groups.queued.push(entry);
            return;
        }
        if (stageKey === 'processing' || stageKey === 'processing-stall') {
            groups.processing.push(entry);
            return;
        }
        if (stageKey === 'completed' || stageKey === 'completed-archive') {
            groups.completed.push(entry);
        }
    });

    return {
        queued: sortRequestEntriesByTimestamp(groups.queued),
        processing: sortRequestEntriesByTimestamp(groups.processing),
        completed: sortRequestEntriesByTimestamp(groups.completed),
    };
}

function formatRequestSectionCount(count) {
    return `${count} request${count === 1 ? '' : 's'}`;
}

function toggleArchivedRequests(enabled) {
    showArchivedRequests = Boolean(enabled);
    renderCompletedRequests();
}

function toggleStalledRequests(enabled) {
    showStalledRequests = Boolean(enabled);
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
    const updatedEl = document.getElementById('completed-requests-updated');
    const requestsListEl = document.getElementById('requests-list');
    const requestsCountEl = document.getElementById('requests-count');
    if (!updatedEl || !requestsListEl || !requestsCountEl) return;

    const totalEntries = Array.isArray(latestCompletedRequests) ? latestCompletedRequests : [];
    if (latestCompletedRequestsUpdatedAt) {
        const parsed = new Date(latestCompletedRequestsUpdatedAt);
        updatedEl.textContent = `Last refresh: ${Number.isNaN(parsed.getTime()) ? latestCompletedRequestsUpdatedAt : parsed.toLocaleString('en-GB')}`;
    } else {
        updatedEl.textContent = 'Last refresh: n/a';
    }

    const visibleEntries = totalEntries.filter((entry) => {
        const stageKey = String(entry?.stageKey || '').trim().toLowerCase();
        if (!showArchivedRequests && stageKey === 'completed-archive') {
            return false;
        }
        if (!showStalledRequests && (stageKey === 'queued-stalled' || stageKey === 'processing-stall')) {
            return false;
        }
        return true;
    });
    requestsCountEl.textContent = formatRequestSectionCount(visibleEntries.length);

    renderRequestCards(
        requestsListEl,
        visibleEntries,
        (showArchivedRequests || showStalledRequests)
            ? 'No requests found.'
            : 'No active requests. Enable archived jobs or stalled requests to show hidden history.',
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

function renderImageEnrichExecutions() {
    const updatedEl = document.getElementById('image-enrich-updated');
    const countEl = document.getElementById('image-enrich-count');
    const listEl = document.getElementById('image-enrich-list');
    if (!updatedEl || !countEl || !listEl) return;

    const entries = Array.isArray(latestImageEnrichExecutions) ? latestImageEnrichExecutions : [];
    countEl.textContent = `${entries.length} image workflow${entries.length === 1 ? '' : 's'}`;
    if (latestImageEnrichUpdatedAt) {
        const parsed = new Date(latestImageEnrichUpdatedAt);
        updatedEl.textContent = `Last refresh: ${Number.isNaN(parsed.getTime()) ? latestImageEnrichUpdatedAt : parsed.toLocaleString('en-GB')}`;
    } else {
        updatedEl.textContent = 'Last refresh: n/a';
    }

    if (entries.length === 0) {
        listEl.innerHTML = '<p class="refresh-status">No active image workflows.</p>';
        return;
    }

    listEl.innerHTML = entries.map((entry) => {
        const title = hasText(entry?.hex) ? entry.hex.trim() : (hasText(entry?.name) ? entry.name.trim() : 'Unknown workflow');
        const badge = hasText(entry?.status) ? entry.status.trim().toLowerCase() : 'running';
        const badgeClass = badge === 'running' ? 'badge-processing' : 'badge-completed';
        const startedAt = hasText(entry?.startDate) ? formatTrackerTimestamp(entry.startDate) : 'n/a';
        const currentStage = hasText(entry?.currentStage) ? entry.currentStage.trim() : 'waiting';
        const workerStatus = hasText(entry?.workerStatus) ? entry.workerStatus.trim() : 'running';
        const requestId = hasText(entry?.requestId) ? entry.requestId.trim() : 'n/a';
        const executionArn = hasText(entry?.executionArn) ? entry.executionArn.trim() : 'n/a';
        return `
            <article class="request-card">
                <div class="request-card-header">
                    <div class="request-card-lead">
                        <div class="request-card-time"${hasText(entry?.startDate) ? ` title="${escapeHtml(entry.startDate)}"` : ''}>${escapeHtml(startedAt)}</div>
                        <div class="request-card-title">
                            <span class="request-card-title-text">${escapeHtml(title)}</span>
                            <span class="request-card-title-action">${escapeHtml(currentStage)}</span>
                        </div>
                        <div class="request-card-subtitle">${escapeHtml(workerStatus)}</div>
                    </div>
                    <span class="request-card-badge ${badgeClass}">${escapeHtml(String(badge).toUpperCase())}</span>
                </div>
                <details class="request-card-meta-toggle">
                    <summary>Execution metadata</summary>
                    <div class="request-card-meta-grid">
                        <div class="request-card-meta-row"><div class="request-card-meta-label">Request ID</div><div class="request-card-meta-value">${escapeHtml(requestId)}</div></div>
                        <div class="request-card-meta-row"><div class="request-card-meta-label">Execution</div><div class="request-card-meta-value">${escapeHtml(executionArn)}</div></div>
                    </div>
                </details>
            </article>
        `;
    }).join('');
}

function setImageEnrichExecutions(entries, updatedAt = null) {
    latestImageEnrichExecutions = Array.isArray(entries) ? entries : [];
    latestImageEnrichUpdatedAt = hasText(updatedAt) ? updatedAt : null;
    renderImageEnrichExecutions();
}

function updateImageEnrichExecutionsFromResult(result) {
    const imageEnrich = result?.stepFunctions?.imageEnrich;
    if (!imageEnrich || typeof imageEnrich !== 'object') {
        return;
    }
    const executions = Array.isArray(imageEnrich.executions)
        ? imageEnrich.executions
        : (Array.isArray(imageEnrich.activeExecutions) ? imageEnrich.activeExecutions : []);
    setImageEnrichExecutions(
        executions,
        hasText(result?.generatedAt) ? result.generatedAt : new Date().toISOString(),
    );
}

function updateRuntimePanelsFromResult(result) {
    updateCompletedRequestsFromResult(result);
    updateImageEnrichExecutionsFromResult(result);
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
        pollQueueDepthSnapshots(),
        loadEvents({ silent: true, notifyOnAgendaChanges: true, onlyIfChanged: true, notificationSource: 'Agenda polling' }),
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
    if (toggle) {
        toggle.checked = autoLambdaInvokeEnabled;
    }
    if (intervalInput) {
        intervalInput.value = String(Math.max(5, Math.round(autoLambdaInvokeIntervalMs / 1000)));
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

function toggleAutoLambdaInvocation(enabled) {
    setAutoLambdaInvocationEnabled(enabled, true);
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
    const response = await fetch(SCOUTS_URL, {
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
            const requestId = extractBackendRequestId(parsed);
            if (requestId) {
                updateRuntimeRequestId(requestId);
            }
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
    const enabled = apiAuthReady && !uiCommandInFlight;
    const actionButtons = document.querySelectorAll('.requires-api');
    actionButtons.forEach((button) => {
        button.disabled = !enabled;
        button.classList.toggle('btn-disabled', !enabled);
    });
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
        await pollQueueDepthSnapshots();
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
    const {
        silent = false,
        notifyOnCountChange = false,
        notifyOnAgendaChanges = false,
        onlyIfChanged = false,
        notificationSource = 'Lambda refresh',
    } = options;
    if (agendaLoadInFlight) {
        return;
    }

    agendaLoadInFlight = true;
    try {
        const previousSummary = lastLoadedEventsSummary;
        const data = await fetchAgendaJson();
        const rawEvents = Array.isArray(data.events) ? data.events : [];
        eventsData = rawEvents.map((event) => normaliseEventTaglineFields(cloneEventRecord(event)));
        agendaPayload = data;
        uniqueEventEntries = buildUniqueEventEntries(eventsData);
        applyVisibilityOverrides(uniqueEventEntries);
        const previousAgendaEntries = agendaNotificationBaseline;
        const agendaChangeSet = previousAgendaEntries
            ? buildAgendaChangeSet(previousAgendaEntries, uniqueEventEntries)
            : { added: [], removed: [], changed: [], hasChanges: false };
        agendaNotificationBaseline = uniqueEventEntries.map((entry) => ({
            event: cloneEventRecord(entry.event),
        }));
        if (notifyOnAgendaChanges && previousAgendaEntries) {
            notifyAgendaChanges(agendaChangeSet);
        }
        if (onlyIfChanged && previousAgendaEntries && !agendaChangeSet.hasChanges) {
            return;
        }
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
        if (
            notifyOnCountChange
            && previousSummary
            && Number.isFinite(previousSummary.uniqueCount)
            && previousSummary.uniqueCount !== uniqueEventEntries.length
        ) {
            const delta = uniqueEventEntries.length - previousSummary.uniqueCount;
            const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`;
            showAdminNotification(
                `${notificationSource}: events loaded changed from ${previousSummary.uniqueCount} to ${uniqueEventEntries.length} (${deltaLabel})`,
                'success',
                5000,
            );
        }
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
    if (hasText(request?.hex)) return String(request.hex).trim().toLowerCase();
    if (hasText(request?.hexId)) return String(request.hexId).trim().toLowerCase();
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

function getSnapshotRequestTimestampMs(request) {
    const candidate = hasText(request?.requestTime)
        ? request.requestTime.trim()
        : (hasText(request?.processedAt)
            ? request.processedAt.trim()
            : (hasText(request?.completedAt)
                ? request.completedAt.trim()
                : ''));
    if (!candidate) return 0;
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isQueuedRequestStalled(request, nowMs = Date.now()) {
    const timestampMs = getSnapshotRequestTimestampMs(request);
    return timestampMs > 0 && (nowMs - timestampMs) > QUEUED_STALLED_THRESHOLD_MS;
}

function mergeRuntimeRequestEntries(primary, secondary) {
    return {
        ...(secondary && typeof secondary === 'object' ? secondary : {}),
        ...(primary && typeof primary === 'object' ? primary : {}),
        title: hasText(primary?.title) ? primary.title : secondary?.title,
        summary: hasText(primary?.summary) ? primary.summary : secondary?.summary,
        hex: getSnapshotRequestHex(primary) || getSnapshotRequestHex(secondary),
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

        const status = classifyAggregateRuntimeRequestStatus({
            hasQueued: Boolean(queued),
            hasProcessing: Boolean(processing),
            hasCompleted: Boolean(completed),
            queuedEntry: queued,
        });
        if (!status) return;

        let entry = {};
        [queued, processing, completed].forEach((source) => {
            if (!source) return;
            entry = mergeRuntimeRequestEntries(source, entry);
        });
        entry.status = status;
        merged.push(entry);
    });

    return merged.sort((left, right) => {
        const leftTime = new Date(left?.processedAt ?? left?.requestTime ?? 0).getTime();
        const rightTime = new Date(right?.processedAt ?? right?.requestTime ?? 0).getTime();
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

function classifyAggregateRuntimeRequestStatus({ hasQueued = false, hasProcessing = false, hasCompleted = false, queuedEntry = null } = {}) {
    if (hasCompleted && (hasQueued || hasProcessing)) return 'completed';
    if (hasProcessing && hasQueued) return 'processing';
    if (hasProcessing) return 'processing-stall';
    if (hasCompleted) return 'completed-archive';
    if (hasQueued && isQueuedRequestStalled(queuedEntry)) return 'queued-stalled';
    if (hasQueued) return 'queued';
    return '';
}

function mapAggregateStatusToEventBadge(status) {
    const normalized = hasText(status) ? String(status).trim().toLowerCase() : '';
    if (normalized === 'queued') return { kind: 'queued', label: 'Queued' };
    if (normalized === 'queued-stalled') return { kind: 'queued-stalled', label: 'Queued Stalled' };
    if (normalized === 'processing') return { kind: 'processing', label: 'Processing' };
    if (normalized === 'processing-stall') return { kind: 'processing-stall', label: 'Processing Stalled' };
    if (normalized === 'completed') return { kind: 'completed', label: 'Complete' };
    if (normalized === 'completed-archive') return { kind: 'completed-archive', label: 'Complete' };
    return null;
}

function formatRuntimeBadgeRequestId(requestId) {
    if (!hasText(requestId)) return '';
    const normalized = String(requestId).trim();
    return normalized.length > 10 ? normalized.slice(0, 8) : normalized;
}

function deriveEventRuntimeBadges(event) {
    const hex = getEventHex(event);
    if (!hex) return [];
    const appliedRequestIds = getAppliedRequestIdSet(event);
    const aggregateRequests = getAggregateRuntimeRequests(
        latestQueuedSnapshot,
        latestProcessingSnapshot,
        latestCompletedSnapshot,
    ).filter((request) => getSnapshotRequestHex(request) === hex);

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

    aggregateRequests.forEach((request) => {
        const requestId = getSnapshotRequestId(request);
        if (requestId && appliedRequestIds.has(requestId)) {
            return;
        }
        const badge = mapAggregateStatusToEventBadge(request?.status);
        if (!badge) return;
        pushBadge(badge.kind, badge.label, requestId);
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
    const hexes = [];
    requests.forEach((request) => {
        if (hasText(request?.requestId)) requestIds.push(request.requestId.trim());
        if (hasText(request?.messageId)) messageIds.push(request.messageId.trim());
        const hex = getSnapshotRequestHex(request);
        if (hasText(hex)) hexes.push(hex);
    });
    const parts = [];
    if (requestIds.length > 0) {
        parts.push(`requestIds=${Array.from(new Set(requestIds)).slice(0, 3).join(', ')}`);
    }
    if (messageIds.length > 0) {
        parts.push(`messageIds=${Array.from(new Set(messageIds)).slice(0, 3).join(', ')}`);
    }
    if (hexes.length > 0) {
        parts.push(`hex=${Array.from(new Set(hexes)).slice(0, 3).join(', ')}`);
    }
    return parts.length > 0 ? parts.join(' | ') : 'n/a';
}

function getEventHex(event) {
    const metadata = getMetadataData(event);
    const candidate = hasText(metadata?.hex)
        ? metadata.hex
        : (hasText(metadata?.hexId)
            ? metadata.hexId
            : (hasText(event?.hex)
                ? event.hex
                : event?.hexId));
    if (hasText(candidate)) return String(candidate).trim().toLowerCase();

    // Calendar refresh repairs the canonical S3 agenda, but derive the same
    // stable key locally while an older agenda is still cached or awaiting a
    // refresh. This keeps the admin actions usable during that transition.
    const title = event?.summary ?? event?.title;
    if (!hasText(title) || typeof TextEncoder !== 'function') return '';
    const bytes = new TextEncoder().encode(String(title).trim().toLowerCase());
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
        return getEventHex(candidate?.event) === hex;
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
        const byHex = resolveEventTitleByHex(getSnapshotRequestHex(request));
        if (hasText(byHex)) {
            const statusSuffix = hasText(request?.status) ? ` [${String(request.status).trim()}]` : '';
            titles.add(`${byHex}${statusSuffix}`);
        }
    });

    requests.forEach((request) => {
        const hex = getSnapshotRequestHex(request);
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
    const hex = getEventHex(entry?.event);
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

    checkedEl.title = 'Last checked is when this admin page last polled S3 for the runtime request snapshot files.';
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

    const queuedUpdatedAt = hasText(queuedSnapshot?.updatedAt) ? String(queuedSnapshot.updatedAt).trim() : '';
    const parsedQueuedUpdatedAt = queuedUpdatedAt ? new Date(queuedUpdatedAt) : null;
    if (parsedQueuedUpdatedAt && !Number.isNaN(parsedQueuedUpdatedAt.getTime())) {
        updatedEl.title = 'Last update is the updatedAt timestamp from runtime/scoutsQueued.json fetched from S3.';
        updatedEl.textContent = `Last update: ${parsedQueuedUpdatedAt.toLocaleString('en-GB')}`;
        updateRuntimeStatus('Runtime request snapshots ready.', 'success');
    } else {
        updatedEl.title = 'Last update is the updatedAt timestamp from runtime/scoutsQueued.json fetched from S3.';
        updatedEl.textContent = 'Last update: n/a';
        updateRuntimeStatus('Runtime request snapshots unavailable.', 'error');
    }

    if (!getPinnedRuntimeDetails()) {
        const queuedCount = Array.isArray(queuedSnapshot?.requests) ? queuedSnapshot.requests.length : 0;
        const processingCount = Array.isArray(processingSnapshot?.requests) ? processingSnapshot.requests.length : 0;
        const completedCount = Array.isArray(completedSnapshot?.requests) ? completedSnapshot.requests.length : 0;
        updateRuntimeDetails(`Queued ${queuedCount} | Processing ${processingCount} | Completed ${completedCount}`, 'info');
    }

    if (uniqueEventEntries.length > 0) {
        refreshVisibleEventRuntimeBadges();
    }
}

function showError(message) {
    const container = document.getElementById('events-container');
    container.innerHTML = `<div class="error">${message}</div>`;
}

async function loadScoutsConfig(force = false) {
    const now = Date.now();
    if (!force && cachedScoutsConfig && (now - cachedScoutsConfigLoadedAt) < SCOUTS_CONFIG_CACHE_MS) {
        return cachedScoutsConfig;
    }
    if (!force && scoutsConfigLoadPromise) {
        return scoutsConfigLoadPromise;
    }

    scoutsConfigLoadPromise = fetch(`${SCOUTS_CONFIG_URL}?ts=${Date.now()}`, {
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
            cachedScoutsConfig = config && typeof config === 'object' ? config : {};
            cachedScoutsConfigLoadedAt = Date.now();
            return cachedScoutsConfig;
        })
        .finally(() => {
            scoutsConfigLoadPromise = null;
        });

    return scoutsConfigLoadPromise;
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
    return normaliseAppliedRequestHistory(metadata?.requests ?? event.requests ?? []);
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
        hex: getEventHex(event) || null,
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

function hasRelativeImageUrl(event) {
    const url = getImageUrl(event);
    return hasText(url) && !/^https?:\/\//i.test(url);
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

function getImageThemeOrLegacyPrompt(event) {
    if (!event || typeof event !== 'object') return null;
    const image = getMetadataData(event)?.image ?? event.image;
    if (image && typeof image === 'object') {
        if (typeof image.theme === 'string' && image.theme.trim()) {
            return image.theme.trim();
        }
        if (typeof image.prompt === 'string' && image.prompt.trim()) {
            return image.prompt.trim();
        }
    }
    return null;
}

function buildImagePromptSpecificationsText(specifications) {
    if (!Array.isArray(specifications) || specifications.length === 0) return '';
    const cleaned = specifications
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(', ') : '';
}

function buildImageGenerationPromptFromTheme(theme, config = null) {
    if (!hasText(theme)) return null;
    const normalizedTheme = String(theme).trim();
    const resolvedConfig = config && typeof config === 'object'
        ? config
        : cachedScoutsConfig;
    const template = hasText(resolvedConfig?.imageGenerationPromptTemplate)
        ? String(resolvedConfig.imageGenerationPromptTemplate)
        : null;
    if (!template) return null;
    const specifications = buildImagePromptSpecificationsText(
        resolvedConfig?.imageGenerationPromptSpecifications,
    );
    return template
        .replace(/{{IMAGE_THEME}}/g, normalizedTheme)
        .replace(/{{IMAGE_PROMPT_SPECIFICATIONS}}/g, specifications)
        .replace(/\s+/g, ' ')
        .trim();
}

function getImageGenerationPrompt(event, config = null) {
    if (!event || typeof event !== 'object') return null;
    const derivedFromTheme = buildImageGenerationPromptFromTheme(getImageTheme(event), config);
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
    if (!hasText(getImageThemeOrLegacyPrompt(event))) {
        missing.push('Image Theme');
    }
    if (!hasRelativeImageUrl(event)) {
        missing.push('Image URL');
    }
    if (!isEventApproved(event)) {
        missing.push('Approval');
    }
    if (isHiddenEvent(event)) {
        missing.push('Visibility');
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
    const hex = getEventHex(event);
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
    {
        const hex = getEventHex(event);
        if (hex) return `hex:${hex}`;
    }
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

function escapeHtmlAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
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
        const hasMissingMetadata = missingFields.length > 0;
        const section = getEventSection(event);
        const isHidden = isEntryHidden(entry);
        const isApproved = isEntryApproved(entry);
        const showApprovalState = !isHidden && !isApproved;
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
                        ? `<img src="${imageUrl}" alt="${title}" class="event-image" onclick="openImageViewer('${escapeHtmlAttribute(imageUrl)}', '${escapeHtmlAttribute(title)}')" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22%3E%3Crect fill=%22%23ddd%22 width=%22400%22 height=%22300%22/%3E%3Ctext fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22%3ENo Image%3C/text%3E%3C/svg%3E'">` 
                        : `<div class="event-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999;">No Image</div>`
                    }
                    <div class="event-badge-stack">
                        <span class="event-badge ${section}">${section}</span>
                        ${isHidden ? `<span class="event-badge hidden">Hidden</span>` : ''}
                        ${showApprovalState ? `<span class="event-badge approval">Needs Approval</span>` : ''}
                        <div class="event-runtime-badges">${renderEventRuntimeBadgesMarkup(event)}</div>
                    </div>
                </div>
                <div class="event-details">
                    <h3 class="event-title">${title}</h3>
                    <details class="event-identifiers">
                        <summary>Identifiers</summary>
                        <div class="event-identifiers-body">
                            <div class="event-identifiers-row"><span>UID:</span> <code>${eventUID}</code></div>
                            <div class="event-identifiers-row"><span>HEX:</span> <code>${getEventHex(event) || 'Missing HEX'}</code></div>
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

                    ${hasMissingMetadata
                        ? `<p class="metadata-hint">Missing: ${missingFields.join(', ')}</p>`
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
                            ? `<button class="btn btn-secondary requires-api" value="unhide" onclick="unhideEvent(${index}, false, this.value)">Unhide Event</button>`
                            : `<button class="btn btn-secondary requires-api" value="hide" onclick="hideEvent(${index}, false, this.value)">Hide Event</button>`
                        }
                        ${showApprovalState
                            ? `<button class="btn btn-primary requires-api" value="approve" onclick="approveEvent(${index}, false, this.value)">Approve</button>`
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
    document.getElementById('modal-event-hex').textContent = getEventHex(event) || 'Missing HEX';
    
    const currentImage = getImageUrl(event);
    const currentImageTheme = getImageTheme(event);
    const imgElement = document.getElementById('modal-current-image');
    const imgFrame = document.getElementById('modal-image-frame');
    if (currentImage) {
        imgElement.src = currentImage;
        imgElement.style.display = 'block';
        if (imgFrame) imgFrame.style.display = 'flex';
    } else {
        imgElement.style.display = 'none';
        if (imgFrame) imgFrame.style.display = 'none';
    }
    
    const imageUrlText = document.getElementById('modal-image-url');
    const imageThemeText = document.getElementById('modal-image-theme');
    const taglineText = document.getElementById('modal-tagline');
    const imagePromptInput = document.getElementById('modal-image-prompt-input');
    const taglineInput = document.getElementById('modal-tagline-input');
    const imageUrlInput = document.getElementById('modal-image-url-input');
    const hideToggleButton = document.getElementById('modal-hide-toggle-button');
    const approveButton = document.getElementById('modal-approve-button');
    if (imageUrlText) imageUrlText.textContent = currentImage || 'Not set';
    if (imagePromptInput) imagePromptInput.value = currentImageTheme || '';
    if (taglineInput) taglineInput.value = getAIPrompt(event) || '';
    if (imageUrlInput) imageUrlInput.value = currentImage || '';
    if (imageThemeText) imageThemeText.textContent = currentImageTheme || 'Not set';
    if (taglineText) taglineText.textContent = getAIPrompt(event) || 'Not set';
    if (hideToggleButton) {
        const hidden = isEntryHidden(entry);
        hideToggleButton.textContent = hidden ? 'Unhide Event' : 'Hide Event';
        hideToggleButton.value = hidden ? 'unhide' : 'hide';
    }
    if (approveButton) {
        approveButton.style.display = isEntryHidden(entry) || isEntryApproved(entry) ? 'none' : 'inline-block';
    }
    document.getElementById('modal-status').textContent = '';
    document.getElementById('modal-status').className = 'status-text';
    
    modal.style.display = 'flex';
}

function openAdminEventByHex(hex) {
    const targetHex = String(hex || '').trim().toLowerCase();
    setFilter('all');
    const index = visibleEventEntries.findIndex((entry) => getEventHex(entry.event)?.toLowerCase() === targetHex);
    if (index < 0) {
        window.showAdminNotification?.('This event is no longer present in the agenda.', 'warning');
        return false;
    }
    openUploadModal(index);
    document.querySelector(`[data-event-card-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
}
window.openAdminEventByHex = openAdminEventByHex;

function updateModalContent(index) {
    const modal = document.getElementById('upload-modal');
    if (!modal || modal.style.display !== 'flex') return;
    openUploadModal(index);
}

function stopGeneratedRequestPolling() {
    generatedRequestPollToken += 1;
    if (generatedRequestPollTimer) {
        clearTimeout(generatedRequestPollTimer);
        generatedRequestPollTimer = null;
    }
}

function findAuthoritativeRequest(activity, requestId) {
    const normalizedRequestId = hasText(requestId) ? String(requestId).trim() : '';
    if (!normalizedRequestId || !activity || typeof activity !== 'object') return null;
    const requests = Array.isArray(activity.requests) ? activity.requests : [];
    return requests.find((request) => String(request?.requestId || '').trim() === normalizedRequestId) || null;
}

function isTerminalAuthoritativeRequest(request) {
    return ['completed', 'failed', 'manual_review', 'needs_attention'].includes(
        String(request?.state || '').trim().toLowerCase(),
    );
}

function describeAuthoritativeRequestOutcome(request) {
    const state = String(request?.state || '').trim().toLowerCase();
    if (state === 'completed') return 'completed';
    const failure = request?.failure && typeof request.failure === 'object' ? request.failure : {};
    const detail = hasText(failure.message) ? `: ${failure.message.trim()}` : '';
    return `${state || 'failed'}${detail}`;
}

async function refreshGeneratedEvent(hex) {
    await loadEvents({ silent: true });
    if (currentEventIndex === null) return;

    const normalizedHex = String(hex || '').trim().toLowerCase();
    const refreshedIndex = visibleEventEntries.findIndex(
        (entry) => getEventHex(entry?.event).toLowerCase() === normalizedHex,
    );
    if (refreshedIndex < 0) return;

    currentEventIndex = refreshedIndex;
    updateModalContent(refreshedIndex);
}

async function pollGeneratedRequestUntilSettled(requestId, options) {
    const { hex, config, eventLabel } = options || {};
    stopGeneratedRequestPolling();
    const pollToken = generatedRequestPollToken;
    const deadline = Date.now() + GENERATED_REQUEST_POLL_TIMEOUT_MS;

    const check = async () => {
        if (pollToken !== generatedRequestPollToken) return;

        let activity;
        try {
            activity = await pollQueueDepthSnapshots();
        } catch (error) {
            updateModalStatus(`Unable to check ${config?.queueLabel || 'AI generation'} progress: ${error.message}`, 'error');
            generatedRequestPollTimer = null;
            return;
        }

        if (pollToken !== generatedRequestPollToken) return;
        const request = findAuthoritativeRequest(activity, requestId);
        if (request && isTerminalAuthoritativeRequest(request)) {
            await refreshGeneratedEvent(hex);
            if (pollToken !== generatedRequestPollToken) return;
            const outcome = describeAuthoritativeRequestOutcome(request);
            const tone = request.state === 'completed' ? 'success' : 'error';
            updateModalStatus(`${config?.label || 'AI generation'} ${outcome} for "${eventLabel}".`, tone);
            generatedRequestPollTimer = null;
            return;
        }

        if (Date.now() >= deadline) {
            updateModalStatus(`No ${config?.queueLabel || 'AI generation'} update received for "${eventLabel}" within 30 seconds.`, 'error');
            generatedRequestPollTimer = null;
            return;
        }

        generatedRequestPollTimer = setTimeout(check, GENERATED_REQUEST_POLL_INTERVAL_MS);
    };

    await check();
}

// Close upload modal
function closeUploadModal() {
    stopGeneratedRequestPolling();
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
async function refreshLambda(action = 'refreshAgenda') {
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
    const requestedCount = actionInput.value;
    if (uiCommandInFlight) {
        statusElement.textContent = 'Another admin request is already in flight. Wait for completion.';
        statusElement.className = 'refresh-status error';
        return;
    }

    const actionCount = Number.isFinite(parseInt(requestedCount, 10)) ? parseInt(requestedCount, 10) : 0;

    // Show loading state
    statusElement.textContent = 'Sending request...';
    statusElement.className = 'refresh-status loading';

    const payload = {
        realm: 'scouts',
        subject: 'agenda',
        action: actionCount,
        maxEvents: actionCount,
    };

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollQueueDepthSnapshots();
        updateRuntimePanelsFromResult(result);

        const modifiedEvents = Array.isArray(result?.modifiedEvents) ? result.modifiedEvents : [];
        const modifiedCount = Number.isFinite(result?.modifiedEventsCount)
            ? result.modifiedEventsCount
            : modifiedEvents.length;
        const generatedAt = result?.generatedAt ? new Date(result.generatedAt).toLocaleString('en-GB') : null;
        const modifiedSuffix = modifiedCount > 0 ? ` (${modifiedCount} events modified)` : ' (no event metadata changes)';
        statusElement.textContent = generatedAt
            ? `Agenda-only enrichment completed: ${generatedAt}${modifiedSuffix}`
            : `Agenda-only enrichment completed${modifiedSuffix}`;
        statusElement.className = 'refresh-status success';
        if (modifiedEvents.length > 0) {
            const preview = modifiedEvents
                .slice(0, 5)
                .map((entry) => entry?.title || entry?.hex || entry?.uid || entry?.key || 'unknown')
                .join(' | ');
            updateRuntimeDetails(`Agenda-only modified events: ${preview}${modifiedEvents.length > 5 ? ' ...' : ''}`, 'success');
        }

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

async function refreshSelectedCalendar(calendarToken = 'all', label = 'Selected Calendar', action = 'refreshCalendars') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateGlobalRefreshStatus('Admin API auth not ready', 'error');
        return;
    }
    if (uiCommandInFlight) {
        updateGlobalRefreshStatus('Another admin request is already in flight. Wait for completion.', 'error');
        return;
    }

    const payload = {
        realm: 'scouts',
        subject: calendarToken && calendarToken !== 'all' ? String(calendarToken).trim().toLowerCase() : 'calendars',
        action,
    };

    updateGlobalRefreshStatus(`Refreshing ${label}...`, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        await pollQueueDepthSnapshots();
        updateRuntimePanelsFromResult(result);
        const count = Number.isFinite(result?.eventsCount) ? result.eventsCount : null;
        const generatedAt = result?.generatedAt ? new Date(result.generatedAt).toLocaleString('en-GB') : null;
        const countSuffix = count !== null ? ` (${count} events in agenda)` : '';
        updateGlobalRefreshStatus(
            generatedAt
                ? `Refresh complete for ${label}: ${generatedAt}${countSuffix}`
                : `Refresh complete for ${label}${countSuffix}`,
            'success',
        );
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
    if (uiCommandInFlight) return;

    autoLambdaInvokeInFlight = true;
    try {
        const payload = {
            realm: 'scouts',
            subject: 'agenda',
            action: 0,
        };
        const result = await sendScoutsCommand(payload);
        await pollQueueDepthSnapshots();
        updateRuntimePanelsFromResult(result);
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
    if (field === 'full') {
        return {
            subjectKey: 'full',
            payloadKey: 'full',
            label: 'Full Enrichment',
            queueLabel: 'full enrichment',
        };
    }
    if (field === 'tagline') {
        return {
            subjectKey: 'tagline',
            payloadKey: 'tagline',
            label: 'Tagline',
            queueLabel: 'AI tagline',
        };
    }
    if (field === 'imageTheme') {
        return {
            subjectKey: 'imageTheme',
            requestSubject: 'imageTheme',
            payloadKey: 'imageTheme',
            label: 'Image Theme',
            queueLabel: 'AI image theme',
        };
    }
    return {
        subjectKey: 'imageUrl',
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
    if (field === 'imageTheme') {
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
    const imgFrame = document.getElementById('modal-image-frame');
    if (imgElement) {
        if (currentImage) {
            imgElement.src = currentImage;
            imgElement.style.display = 'block';
            if (imgFrame) imgFrame.style.display = 'flex';
        } else {
            imgElement.style.display = 'none';
            if (imgFrame) imgFrame.style.display = 'none';
        }
    }
}

async function copyImagePromptForEvent(eventIndex) {
    const entry = visibleEventEntries[eventIndex];
    if (!entry) return;

    let scoutsConfig = cachedScoutsConfig;
    try {
        scoutsConfig = await loadScoutsConfig();
    } catch (error) {
        console.warn('Failed to load scouts.conf for image prompt copy:', error);
    }

    const imagePrompt = getImageGenerationPrompt(entry.event, scoutsConfig);
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
    if (field === 'imageTheme') {
        event.image.theme = value;
        if (Object.prototype.hasOwnProperty.call(event.image, 'prompt')) delete event.image.prompt;
        return;
    }
    event.image.url = value;
}

function applyLocalHiddenState(entry, hiddenAtIso, hidden = true) {
    if (!entry || !entry.event) return;
    const event = entry.event;
    const hex = getEventHex(event);
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
        const hex = getEventHex(event);
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

async function persistCurrentField(field, action = 'persist') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateModalStatus('Admin API auth not ready.', 'error');
        return;
    }
    if (uiCommandInFlight) {
        updateModalStatus('Another admin request is already in flight. Wait for completion before persisting.', 'error');
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
    const hex = getEventHex(event);
    if (!hex) {
        updateModalStatus(`Cannot persist ${config.label.toLowerCase()}: event is missing HEX.`, 'error');
        return;
    }

    const subject = {
        hex,
        [config.subjectKey]: nextValue,
    };

    const payload = {
        realm: 'scouts',
        subject,
        action,
    };

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
        const successMessage = appendBackendRequestIdMessage(
            `${config.label} ${action} queued for "${eventLabel}" [HTTP ${statusCode}].${queueAcceptedSuffix}${backendMessage}`,
            result,
        );
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

async function requestGeneratedField(field, action = 'generate') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        updateModalStatus('Admin API auth not ready.', 'error');
        return;
    }
    if (uiCommandInFlight) {
        updateModalStatus('Another admin request is already in flight. Wait for completion before queueing generation.', 'error');
        return;
    }

    const entry = getSelectedModalEntry();
    if (!entry) return;

    const config = getFieldOperationConfig(field);
    const event = entry.event;
    const eventLabel = event.summary || event.title || `Event ${currentEventIndex + 1}`;
    const hex = getEventHex(event);
    if (!hex) {
        updateModalStatus(`Cannot queue ${config.queueLabel}: event is missing HEX.`, 'error');
        return;
    }

    const payload = {
        realm: 'scouts',
        subject: {
            hex,
        },
        action,
    };

    const requestVerb = action === 'generateFull' ? 'requesting' : 'queueing';
    updateModalStatus(`${requestVerb.charAt(0).toUpperCase()}${requestVerb.slice(1)} ${config.queueLabel} for "${eventLabel}"...`, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        const statusCode = Number.isFinite(result?._httpStatus) ? result._httpStatus : 200;
        const backendMessage = typeof result?.message === 'string' && result.message.trim()
            ? ` ${result.message.trim()}`
            : '';
        const queueAcceptedSuffix = result?.queueAccepted === true ? ' Queue accepted.' : '';
        const actionLabel = action === 'generateFull' ? 'requested' : `${action} queued`;
        const successMessage = appendBackendRequestIdMessage(
            `${config.queueLabel} ${actionLabel} for "${eventLabel}" [HTTP ${statusCode}].${queueAcceptedSuffix}${backendMessage}`,
            result,
        );
        updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');
        await pollQueueDepthSnapshots();
        const requestId = extractBackendRequestId(result);
        if (requestId) {
            void pollGeneratedRequestUntilSettled(requestId, {
                hex,
                config,
                eventLabel,
            });
        }
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

async function hideEvent(eventIndex, fromModal = false, action = 'hide') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        else updateRuntimeDetails('Admin API auth not ready.', 'error');
        return;
    }
    if (uiCommandInFlight) {
        const message = 'Another admin request is already in flight. Wait for completion before hiding.';
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
    const hex = getEventHex(event);
    if (!hex) {
        const message = 'Cannot hide event: missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const hiddenAtIso = new Date().toISOString();
    const subject = {
        hex,
        isHidden: true,
    };

    const payload = {
        realm: 'scouts',
        subject,
        action,
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
        const successMessage = appendBackendRequestIdMessage(
            `Hide request queued for "${eventLabel}".${backendMessage}`,
            result,
        );
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

async function unhideEvent(eventIndex, fromModal = false, action = 'unhide') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        else updateRuntimeDetails('Admin API auth not ready.', 'error');
        return;
    }
    if (uiCommandInFlight) {
        const message = 'Another admin request is already in flight. Wait for completion before unhiding.';
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
    const hex = getEventHex(event);
    if (!hex) {
        const message = 'Cannot unhide event: missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const subject = {
        hex,
        isHidden: false,
    };

    const payload = {
        realm: 'scouts',
        subject,
        action,
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
        const successMessage = appendBackendRequestIdMessage(
            `Unhide request queued for "${eventLabel}".${backendMessage}`,
            result,
        );
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

function toggleCurrentEventHidden(action = null) {
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
        unhideEvent(currentEventIndex, true, action || 'unhide');
    } else {
        hideEvent(currentEventIndex, true, action || 'hide');
    }
}

function applyLocalApprovalState(entry, approved = true) {
    if (!entry || !entry.event) return;
    const event = entry.event;
    event.approved = approved;
    event.isApproved = approved;
    if (!event.status || typeof event.status !== 'object') {
        event.status = {};
    }
    event.status.isApproved = approved;
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = {};
    }
    if (!event.metadata.status || typeof event.metadata.status !== 'object') {
        event.metadata.status = {};
    }
    event.metadata.status.isApproved = approved;
}

async function approveEvent(eventIndex, fromModal = false, action = 'approve') {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        if (fromModal) updateModalStatus('Admin API auth not ready.', 'error');
        else updateRuntimeDetails('Admin API auth not ready.', 'error');
        return;
    }
    if (uiCommandInFlight) {
        const message = 'Another admin request is already in flight. Wait for completion before approving.';
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
    if (isEntryApproved(entry)) {
        const message = 'Event is already approved.';
        if (fromModal) updateModalStatus(message, 'info');
        else updateRuntimeDetails(message, 'info');
        return;
    }

    const eventLabel = event.summary || event.title || `Event ${eventIndex + 1}`;
    const hex = getEventHex(event);
    if (!hex) {
        const message = 'Cannot approve event: missing HEX.';
        if (fromModal) updateModalStatus(message, 'error');
        else updateRuntimeDetails(message, 'error');
        return;
    }

    const payload = {
        realm: 'scouts',
        subject: {
            hex,
            isApproved: true,
        },
        action,
    };

    const loadingMessage = `Approving "${eventLabel}"...`;
    if (fromModal) updateModalStatus(loadingMessage, 'loading');
    else pinRuntimeDetails(loadingMessage, 'loading');

    uiCommandInFlight = true;
    refreshApiActionButtons();
    try {
        const result = await sendScoutsCommand(payload);
        const requestId = extractBackendRequestId(result);
        await pollQueueDepthSnapshots();
        applyLocalApprovalState(entry, true);
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
        updateRuntimeRequestId(requestId || latestBackendRequestId);
        const successMessage = appendBackendRequestIdMessage(
            `Approve request queued for "${eventLabel}".${backendMessage}`,
            result,
            { updateFooter: false, includeInMessage: false },
        );
        if (fromModal) updateModalStatus(successMessage, 'success');
        pinRuntimeDetails(successMessage, 'success');
    } catch (error) {
        console.error('Error approving event:', error);
        const failureMessage = `Failed to approve event: ${error.message}`;
        if (fromModal) updateModalStatus(failureMessage, 'error');
        else pinRuntimeDetails(failureMessage, 'error');
    } finally {
        uiCommandInFlight = false;
        refreshApiActionButtons();
    }
}

function approveCurrentEvent(action = 'approve') {
    if (currentEventIndex === null) {
        updateModalStatus('Open an event first before approving.', 'error');
        return;
    }
    approveEvent(currentEventIndex, true, action);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    autoLambdaInvokeIntervalMs = readAutoLambdaIntervalPreference();
    statusPollingIntervalMs = readStatusPollingIntervalPreference();
    hexPreviewAutoRefreshEnabled = readHexPreviewAutoRefreshPreference();
    hexPreviewIntervalMs = readHexPreviewIntervalPreference();
    initializeBrowserNotificationsPreference();
    setAutoLambdaInvocationEnabled(readAutoLambdaInvocationPreference(), false);
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
