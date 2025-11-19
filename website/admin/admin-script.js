// Admin Script for Event Images Management

let eventsData = [];
let hasS3Permission = false;
let currentEventIndex = null;

// Check if AWS SDK is available and user has S3 permissions
function checkS3Permissions() {
    // Check if AWS SDK is loaded
    if (typeof AWS === 'undefined') {
        updateS3Status('AWS SDK not loaded', 'warning');
        hasS3Permission = false;
        return;
    }

    // Try to check S3 access
    // In a real implementation, this would make a test call to S3
    // For now, we'll check if credentials are configured
    try {
        const credentials = AWS.config.credentials;
        if (credentials && credentials.accessKeyId) {
            updateS3Status('S3 upload enabled', 'success');
            hasS3Permission = true;
        } else {
            updateS3Status('S3 credentials not configured', 'warning');
            hasS3Permission = false;
        }
    } catch (error) {
        updateS3Status('S3 upload disabled', 'warning');
        hasS3Permission = false;
    }
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

// Get image URL from event data
function getImageUrl(event) {
    if (event.image) {
        if (typeof event.image === 'string') return event.image;
        if (event.image.url) return event.image.url;
        if (event.image.src) return event.image.src;
    }
    if (event.imageUrl) return event.imageUrl;
    return null;
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
        container.innerHTML = '<p class="loading">No events found.</p>';
        return;
    }

    container.innerHTML = eventsData.map((event, index) => {
        const imageUrl = getImageUrl(event);
        const aiPrompt = getAIPrompt(event);
        const section = getEventSection(event);
        const title = event.summary || event.title || 'Untitled Event';
        
        return `
            <div class="event-card">
                <div class="event-image-container">
                    ${imageUrl 
                        ? `<img src="${imageUrl}" alt="${title}" class="event-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22%3E%3Crect fill=%22%23ddd%22 width=%22400%22 height=%22300%22/%3E%3Ctext fill=%22%23999%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22%3ENo Image%3C/text%3E%3C/svg%3E'">` 
                        : `<div class="event-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999;">No Image</div>`
                    }
                    <span class="event-badge ${section}">${section}</span>
                </div>
                <div class="event-details">
                    <h3 class="event-title">${title}</h3>
                    <p class="event-index">Event Index: ${index}</p>
                    
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
                        class="btn ${hasS3Permission ? 'btn-primary' : 'btn-disabled'}" 
                        onclick="${hasS3Permission ? `openUploadModal(${index})` : 'alert(\'S3 upload not available. Please configure AWS credentials.\')'}"
                        ${!hasS3Permission ? 'disabled' : ''}
                    >
                        ${hasS3Permission ? 'Replace Image' : 'Upload Disabled'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Format date string
function formatDate(dateString) {
    try {
        const date = new Date(dateString);
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
    
    const currentImage = getImageUrl(event);
    const imgElement = document.getElementById('modal-current-image');
    if (currentImage) {
        imgElement.src = currentImage;
        imgElement.style.display = 'block';
    } else {
        imgElement.style.display = 'none';
    }
    
    // Clear previous inputs
    document.getElementById('image-upload').value = '';
    document.getElementById('image-url').value = '';
    
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

    const fileInput = document.getElementById('image-upload');
    const urlInput = document.getElementById('image-url');
    
    if (!fileInput.files.length && !urlInput.value.trim()) {
        alert('Please select a file or enter an image URL');
        return;
    }

    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Upload the file to S3 using AWS SDK
    // 2. Update the agenda.json with the new image URL
    // 3. Refresh the events display

    alert('Image upload functionality requires AWS SDK integration.\n\n' +
          'To implement:\n' +
          '1. Add AWS SDK to the page\n' +
          '2. Configure AWS credentials\n' +
          '3. Implement S3 upload with proper bucket permissions\n' +
          '4. Update agenda.json with new image URL');

    closeUploadModal();
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
    const payload = {
        realm: 'scouts',
        subject: 'events',
        action: parseInt(action, 10)
    };

    try {
        const response = await fetch(lambdaUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkS3Permissions();
    loadEvents();
});
