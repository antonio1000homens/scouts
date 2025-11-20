// Admin Script for Event Images Management

let eventsData = [];
let hasS3Permission = false;
let currentEventIndex = null;
const SCOUTS2SQS_URL = window.SCOUTS2SQS_URL || 'https://hnpooqvuwzt2rvpqtxfngfvhrq0nxngr.lambda-url.eu-west-2.on.aws/';
const SCOUTS2SQS_API_KEY = window.SCOUTS2SQS_API_KEY || '';
let apiKey = SCOUTS2SQS_API_KEY;

// Check if AWS SDK is available and user has S3 permissions
function checkS3Permissions() {
    // Uploads are no longer needed; the image URL is sent to scouts2sqs for persistence
    updateS3Status('Paste an image URL to persist via scouts2sqs (no S3 upload needed)', 'info');
    hasS3Permission = true;
}

function updateS3Status(message, type) {
    const statusElement = document.getElementById('s3-status');
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
}

function updateEventsCount(count) {
    const countElement = document.getElementById('events-count');
    countElement.textContent = count + ' event' + (count !== 1 ? 's' : '');
}

function updateApiKeyStatus(message, type = 'info') {
    const statusElement = document.getElementById('api-key-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
}

function updateHideStatus(message, type = 'info') {
    const statusElement = document.getElementById('hide-status');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = 'status-text status-' + type;
}

function setApiKeyFromInput() {
    const input = document.getElementById('api-key-input');
    if (!input) return;
    const trimmed = (input.value || '').trim();
    apiKey = trimmed;
    if (trimmed) {
        updateApiKeyStatus('API key set for this session (not stored).', 'success');
    } else {
        updateApiKeyStatus('API key cleared. Requests will be rejected until a key is set.', 'warning');
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
        eventsData = data.events || [];
        console.log('[Admin] agenda.json fetched', {
            totalEvents: data.events?.length ?? 0,
            visibleEvents: eventsData.length,
        });
        
        updateEventsCount(eventsData.length);
        renderEvents();
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

// Determine event section/type
function getEventSection(event) {
    const type = (event.icsType || event.section || '').toLowerCase();
    if (type.includes('beaver')) return 'beavers';
    if (type.includes('cub')) return 'cubs';
    if (type.includes('scout')) return 'scouts';
    return 'all';
}

// Render all events
function renderEvents() {
    const container = document.getElementById('events-container');
    
    if (eventsData.length === 0) {
        console.warn('[Admin] No events found after loading');
        container.innerHTML = '<p class="loading">No events found.</p>';
        return;
    }

    container.innerHTML = eventsData.map((event, index) => {
        const imageUrl = getImageUrl(event);
        const aiPrompt = getAIPrompt(event);
        const section = getEventSection(event);
        const title = event.summary || event.title || 'Untitled Event';
        const eventUID = generateEventUID(event, index);
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
                    ${imageUrl ? `
                        <button class="btn-hide" onclick="hideEvent('${eventUID}')" title="Hide this event">
                            Hide
                        </button>
                    ` : ''}
                </div>
                <div class="event-details">
                    <h3 class="event-title">${title}</h3>
                    <p class="event-index">Event Index: ${index} | UID: ${eventUID}</p>
                    ${event.hex ? `<p class="event-index">HEX: ${event.hex}</p>` : ''}
                    
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

                    ${aiPrompt ? `
                        <div class="ai-prompt">
                            <div class="ai-prompt-label">AI Prompt</div>
                            <div class="ai-prompt-text">${aiPrompt}</div>
                        </div>
                    ` : '<p class="no-ai-prompt">No AI prompt</p>'}

                    <button 
                        class="btn btn-primary"
                        onclick="openUploadModal(${index})"
                    >
                        Set Image URL
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
    currentEventIndex = index;
    const event = eventsData[index];
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
    urlField.value = currentImage || '';
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

// Upload image (placeholder - requires AWS SDK integration)
async function uploadImage() {
    if (currentEventIndex === null) {
        alert('No event selected');
        return;
    }

    const urlInput = document.getElementById('image-url');
    const statusEl = document.getElementById('modal-status');
    const rawUrl = urlInput.value.trim();
    const event = eventsData[currentEventIndex];
    const hex = event.hex || null;

    const showStatus = (text, type = 'info') => {
        statusEl.textContent = text;
        statusEl.className = `status-text status-${type}`;
    };

    if (!hex) {
        showStatus('This event is missing a HEX identifier and cannot be persisted.', 'error');
        return;
    }

    if (!rawUrl) {
        showStatus('Please paste a public image URL (http/https).', 'error');
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl);
        if (!/^https?:$/i.test(parsedUrl.protocol)) {
            throw new Error('Only http/https URLs are supported.');
        }
    } catch (error) {
        showStatus(error.message || 'Invalid image URL.', 'error');
        return;
    }

    const subject = JSON.parse(JSON.stringify(event || {}));
    subject.hex = hex;
    subject.image = subject.image || {};
    subject.image.url = parsedUrl.toString();

    const payload = {
        realm: 'persist',
        action: 'persist',
        subject,
    };

    showStatus('Sending image URL for download and persistence...', 'loading');

    try {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (apiKey) {
            headers['x-api-key'] = apiKey;
        }

        const response = await fetch(SCOUTS2SQS_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to queue persist request: ${response.status} ${errorText}`);
        }

        showStatus('Sent! The pipeline will download, persist, and confirm via Slack.', 'success');
        setTimeout(() => {
            closeUploadModal();
            loadEvents();
        }, 800);
    } catch (error) {
        console.error('Error sending persist request:', error);
        showStatus(error.message || 'Failed to send persist request.', 'error');
    }
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('upload-modal');
    if (event.target === modal) {
        closeUploadModal();
    }
}

// Initialise API key status on load
window.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('api-key-input');
    if (input && apiKey) {
        input.value = apiKey;
        updateApiKeyStatus('API key preloaded from window.SCOUTS2SQS_API_KEY', 'info');
    } else {
        updateApiKeyStatus('Paste an API key to enable requests.', 'warning');
    }
});

// Lambda refresh functionality
async function refreshLambda() {
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

    const lambdaUrl = 'https://ykjzunulxefwp2ere4aotapnwu0whhsk.lambda-url.eu-west-2.on.aws/';
    const actionCount = parseInt(action, 10);
    const payload = {
        realm: 'scoutsRequest',
        subject: {
            type: 'events',
            count: Number.isFinite(actionCount) ? actionCount : 0,
        },
        action: 'new',
    };

    try {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (apiKey) {
            headers['x-api-key'] = apiKey;
        }

        const response = await fetch(lambdaUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        statusElement.textContent = 'Lambda triggered successfully!';
        statusElement.className = 'refresh-status success';

        // Optionally reload events after a short delay
        setTimeout(() => {
            loadEvents();
            statusElement.textContent = 'Events reloaded';
        }, 2000);

    } catch (error) {
        console.error('Error triggering Lambda:', error);
        statusElement.textContent = `Error: ${error.message}`;
        statusElement.className = 'refresh-status error';
    }
}

// Hide event functionality
async function hideEvent(eventUID) {
    if (!confirm(`Are you sure you want to hide the event with UID: ${eventUID}?`)) {
        return;
    }

    updateHideStatus(`Hiding event ${eventUID}...`, 'loading');

    const match = eventsData.find((event, index) => generateEventUID(event, index) === eventUID);
    if (!match) {
        updateHideStatus(`Unable to find event with UID ${eventUID}`, 'error');
        return;
    }

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
        const headers = {
            'Content-Type': 'application/json',
        };
        if (apiKey) {
            headers['x-api-key'] = apiKey;
        }

        const response = await fetch(SCOUTS2SQS_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
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
    loadEvents();
});
