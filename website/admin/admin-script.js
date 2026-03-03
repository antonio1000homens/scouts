// Admin Script for Event Images Management

let eventsData = [];
let uniqueEventEntries = [];
let visibleEventEntries = [];
let hasS3Permission = false;
let currentEventIndex = null;
let apiAuthReady = false;
let showHiddenEvents = false;
let agendaPayload = null;
const ADMIN_API_BASE = window.ADMIN_API_BASE || '/admin-api';
const SCOUTS2SQS_URL = window.SCOUTS2SQS_URL || window.SCOUTS_QUEUE_URL || `${ADMIN_API_BASE}/scouts2sqs`;
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

// Check if AWS SDK is available and user has S3 permissions
function checkS3Permissions() {
    // Uploads are no longer needed; metadata is queued via scouts2sqs through Cloudflare.
    updateS3Status('Paste an image URL to queue metadata updates (no S3 upload needed)', 'info');
    hasS3Permission = true;
}

function updateS3Status(message, type) {
    const statusElement = document.getElementById('s3-status');
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
}

function updateEventsCount(uniqueCount, rawCount = uniqueCount, hiddenCount = 0) {
    const countElement = document.getElementById('events-count');
    const hiddenSuffix = hiddenCount > 0 ? `, ${hiddenCount} hidden` : '';
    countElement.textContent = `${uniqueCount} unique (${rawCount} raw${hiddenSuffix})`;
}

function updateHideStatus(message, type = 'info') {
    const statusElement = document.getElementById('hide-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
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
    const statusElement = document.getElementById('api-auth-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
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
        return await response.json();
    } catch {
        return null;
    }
}

async function sendQueuePayload(payload) {
    const response = await fetch(SCOUTS2SQS_URL, {
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

    return response;
}

function setApiActionState(enabled) {
    apiAuthReady = Boolean(enabled);
    const actionButtons = document.querySelectorAll('.requires-api');
    actionButtons.forEach((button) => {
        button.disabled = !apiAuthReady;
        button.classList.toggle('btn-disabled', !apiAuthReady);
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
    } catch (error) {
        console.error('Error checking admin API auth status:', error);
        updateApiAuthStatus(
            'Admin API unavailable. Re-login via Cloudflare Access or verify Worker config/secrets.',
            'error',
        );
        setApiActionState(false);
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
        );
        updateHiddenEventsUi();
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

    visibleEventEntries = showHiddenEvents
        ? [...uniqueEventEntries]
        : uniqueEventEntries.filter((entry) => !entry.allHidden);

    if (visibleEventEntries.length === 0) {
        container.innerHTML = '<p class="loading">All events are hidden. Use "Show Hidden" to view them.</p>';
        return;
    }

    container.innerHTML = visibleEventEntries.map((entry, index) => {
        const event = entry.event;
        const imageUrl = getImageUrl(event);
        const tagline = getAIPrompt(event);
        const imagePrompt = getImagePrompt(event);
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
                    <button class="btn-hide${isHidden ? ' disabled' : ''}" onclick="hideEvent(${index})" title="Hide this event" ${isHidden ? 'disabled' : ''}>
                        ${isHidden ? 'Already Hidden' : 'Hide'}
                    </button>
                </div>
                <div class="event-details">
                    <h3 class="event-title">${title}</h3>
                    <p class="event-index">UID: ${eventUID} | Occurrences: ${entry.duplicateCount}</p>
                    ${event.hex ? `<p class="event-index">HEX: ${event.hex}</p>` : ''}
                    ${entry.sourceDetails?.length
                        ? `<div class="image-info"><strong>Grouped Source Events:</strong>${entry.sourceDetails.map((detail) => `<div class="image-url">Event Index: ${detail.index} | UID: ${detail.uid}</div>`).join('')}</div>`
                        : ''
                    }
                    
                    <div class="event-meta">
                        ${event.dtstart ? `<p><strong>Date:</strong> ${formatDate(event.dtstart)}</p>` : ''}
                        ${event.location ? `<p><strong>Location:</strong> ${event.location}</p>` : ''}
                    </div>

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

                    <button 
                        class="btn btn-primary"
                        onclick="openUploadModal(${index})"
                    >
                        Edit URL, Prompt & Tagline
                    </button>
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
        updateHideStatus('Unable to open editor for selected event.', 'error');
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
    
    // Clear previous inputs
    const urlField = document.getElementById('image-url');
    const imagePromptField = document.getElementById('image-prompt-input');
    const taglineField = document.getElementById('tagline-input');
    urlField.value = currentImage || '';
    imagePromptField.value = getImagePrompt(event) || '';
    taglineField.value = getAIPrompt(event) || '';
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

async function queueWorkflowAction(realm) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        return;
    }

    if (currentEventIndex === null) {
        updateModalStatus('Open an event first before queueing workflow actions.', 'error');
        return;
    }

    const entry = visibleEventEntries[currentEventIndex];
    if (!entry || !entry.event) {
        updateModalStatus('Unable to find selected event entry.', 'error');
        return;
    }

    const event = entry.event;
    const hex = event.hex || null;
    if (!hex) {
        updateModalStatus('This event is missing a HEX identifier.', 'error');
        return;
    }

    const actionMap = {
        AI: 'request',
        imagePrompt: 'request',
        pixabay: 'bypass',
    };

    if (!actionMap[realm]) {
        updateModalStatus(`Unsupported workflow realm: ${realm}`, 'error');
        return;
    }

    let payload;
    if (realm === 'pixabay') {
        const subject = JSON.parse(JSON.stringify(event || {}));
        subject.hex = hex;
        subject.image = subject.image && typeof subject.image === 'object' ? subject.image : {};
        const modalPrompt = (document.getElementById('image-prompt-input')?.value || '').trim();
        if (modalPrompt) {
            subject.image.prompt = modalPrompt;
        }
        payload = { realm, action: actionMap[realm], subject };
    } else {
        payload = { realm, action: actionMap[realm], subject: hex };
    }

    const label = realm === 'AI'
        ? 'AI review'
        : realm === 'imagePrompt'
            ? 'image prompt review'
            : 'image URL review';

    updateModalStatus(`Queueing ${label}...`, 'loading');

    try {
        await sendQueuePayload(payload);
        updateModalStatus(`Queued ${label} successfully.`, 'success');
    } catch (error) {
        console.error(`Error queueing ${label}:`, error);
        updateModalStatus(`Failed to queue ${label}: ${error.message}`, 'error');
    }
}

// Upload image (placeholder - requires AWS SDK integration)
async function uploadImage() {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        return;
    }

    if (currentEventIndex === null) {
        alert('No event selected');
        return;
    }

    const urlInput = document.getElementById('image-url');
    const imagePromptInput = document.getElementById('image-prompt-input');
    const taglineInput = document.getElementById('tagline-input');
    const rawUrl = urlInput.value.trim();
    const rawImagePrompt = imagePromptInput.value.trim();
    const rawTagline = taglineInput.value.trim();
    const entry = visibleEventEntries[currentEventIndex];
    if (!entry || !entry.event) {
        updateModalStatus('Unable to find selected event entry.', 'error');
        return;
    }
    const event = entry.event;
    const hex = event.hex || null;

    if (!hex) {
        updateModalStatus('This event is missing a HEX identifier and cannot be persisted.', 'error');
        return;
    }

    if (!rawUrl && !rawImagePrompt && !rawTagline) {
        updateModalStatus('Provide at least one metadata change to persist.', 'error');
        return;
    }

    let parsedUrl = null;
    if (rawUrl) {
        try {
            parsedUrl = new URL(rawUrl);
            if (!/^https?:$/i.test(parsedUrl.protocol)) {
                throw new Error('Only http/https URLs are supported.');
            }
        } catch (error) {
            updateModalStatus(error.message || 'Invalid image URL.', 'error');
            return;
        }
    }

    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    const existingImage = subject.image;
    if (!existingImage || typeof existingImage !== 'object') {
        subject.image = {};
        if (typeof existingImage === 'string' && existingImage.trim()) {
            subject.image.url = existingImage.trim();
        }
    }

    if (parsedUrl) {
        subject.image.url = parsedUrl.toString();
    }

    if (rawImagePrompt) {
        subject.image.prompt = rawImagePrompt;
    }

    if (rawTagline) {
        subject.AI = rawTagline;
    }

    updateModalStatus('Saving metadata...', 'loading');

    try {
        const persistPayload = {
            realm: 'persist',
            action: 'persist',
            subject,
        };
        await sendQueuePayload(persistPayload);

        updateModalStatus('Metadata persisted successfully.', 'success');
        setTimeout(() => {
            closeUploadModal();
            loadEvents();
        }, 800);
    } catch (error) {
        console.error('Error sending persist request:', error);
        updateModalStatus(error.message || 'Failed to send persist request.', 'error');
    }
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
        subject: 'events',
        action: Number.isFinite(actionCount) ? actionCount : 0,
    };

    try {
        await sendScoutsCommand(payload);

        statusElement.textContent = 'Lambda triggered successfully!';
        statusElement.className = 'refresh-status success';

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

    const payload = {
        realm: 'scouts',
        subject: 'calendar',
        action: 'refresh',
    };

    if (calendarToken && calendarToken !== 'all') {
        payload.calendar = calendarToken;
    }

    updateGlobalRefreshStatus(`Refreshing ${label}...`, 'loading');

    try {
        const result = await sendScoutsCommand(payload);
        const count = Number.isFinite(result?.eventsCount) ? result.eventsCount : null;
        const countSuffix = count !== null ? ` (${count} events in agenda)` : '';
        updateGlobalRefreshStatus(`Refresh complete for ${label}${countSuffix}`, 'success');

        setTimeout(() => {
            loadEvents();
        }, 1200);
    } catch (error) {
        console.error(`Error refreshing ${label}:`, error);
        updateGlobalRefreshStatus(`Failed to refresh ${label}: ${error.message}`, 'error');
    }
}

// Hide event functionality
async function hideEvent(eventIndex) {
    if (!apiAuthReady) {
        updateApiAuthStatus(
            'Cannot send requests: Cloudflare API auth is not ready. Re-login or debug Worker settings.',
            'error',
        );
        return;
    }

    const entry = visibleEventEntries[eventIndex];
    if (!entry || !entry.event) {
        updateHideStatus('Unable to find selected event entry.', 'error');
        return;
    }

    const match = entry.event;
    const eventUID = getEntryIdentifier(entry);

    if (!confirm(`Are you sure you want to hide the event with UID: ${eventUID}?`)) {
        return;
    }

    updateHideStatus(`Hiding event ${eventUID}...`, 'loading');

    const hexValue = match.hex;
    if (!hexValue) {
        updateHideStatus(`Event ${eventUID} is missing a HEX identifier`, 'error');
        return;
    }

    const subject = JSON.parse(JSON.stringify(match));
    subject.hex = hexValue;
    subject.uid = match.uid || eventUID;
    subject.status = 'hidden';

    const payload = {
        realm: 'persist',
        action: 'hidden',
        subject,
    };

    try {
        const response = await fetch(SCOUTS2SQS_URL, {
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

        let message = `Event ${eventUID} hidden successfully`;
        try {
            const parsed = await response.json();
            if (parsed?.message) {
                message = parsed.message;
            }
        } catch {
            // Response was not JSON; keep default message
        }
        updateHideStatus(message, 'success');
        
        // Reload events to reflect the change
        setTimeout(() => {
            loadEvents();
            updateHideStatus('Events refreshed after hide action', 'success');
        }, 1000);

    } catch (error) {
        console.error('Error hiding event:', error);
        updateHideStatus(`Error hiding event: ${error.message}`, 'error');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkS3Permissions();
    setApiActionState(false);
    checkApiAuthStatus();
    loadEvents();
});
