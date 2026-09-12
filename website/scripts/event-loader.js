const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
});

const AGENDA_URL = '/agenda.json';
const FALLBACK_AGENDA_URL = 'https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com/agenda.json';
const S3_OBJECT_BASE_URL = 'https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com';
const EVENT_LOADER_SCRIPT_URL = new URL(
    document.currentScript?.src || 'event-loader.js',
    window.location.href
);
const LOCAL_WEBSITE_BASE_URL = new URL('..', EVENT_LOADER_SCRIPT_URL);
const LOCAL_AGENDA_URL = new URL('../agenda.json', LOCAL_WEBSITE_BASE_URL).href;
const CONTACT_PAGE_URL = new URL('contact/index.html', LOCAL_WEBSITE_BASE_URL).href;

const CANONICAL_METADATA_KEYS = ['hex', 'tagline', 'image', 'status'];
const CANONICAL_IMAGE_KEYS = ['theme', 'url'];
const CANONICAL_STATUS_KEYS = ['isHidden', 'isApproved'];
const LEGACY_ENRICHMENT_TOP_LEVEL_KEYS = [
    'hex', 'hexId', 'tagline', 'AI', 'ai', 'image', 'imageTheme', 'imageUrl', 'sourceImg',
    'status', 'approved', 'isApproved', 'isHidden', 'hidden', 'hiddenAt'
];

async function fetchAgendaJson() {
    const requestUrls = [AGENDA_URL, LOCAL_AGENDA_URL, FALLBACK_AGENDA_URL].map((url) => `${url}?ts=${Date.now()}`);
    let lastError = null;

    for (const url of requestUrls) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error('Failed to load agenda.json');
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowedKeys, label) {
    const extras = Object.keys(value || {}).filter((key) => !allowedKeys.includes(key));
    if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.sort().join(', ')}`);
}

function canonicalText(value, label, { nullable = true } = {}) {
    if (value === null && nullable) return null;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string${nullable ? ' or null' : ''}`);
    return value.trim();
}

function assertCanonicalAgendaEvent(event) {
    if (!isObject(event)) throw new Error('agenda event must be an object');
    const legacyFields = LEGACY_ENRICHMENT_TOP_LEVEL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(event, key));
    if (legacyFields.length > 0) {
        throw new Error(`agenda event contains legacy enrichment fields: ${legacyFields.sort().join(', ')}`);
    }

    const metadata = event.metadata;
    if (!isObject(metadata)) throw new Error('agenda event metadata must be an object');
    assertExactKeys(metadata, CANONICAL_METADATA_KEYS, 'metadata');
    const hex = canonicalText(metadata.hex, 'metadata.hex', { nullable: false }).toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex)) throw new Error('metadata.hex must be lowercase hexadecimal');
    if (metadata.tagline !== null) canonicalText(metadata.tagline, 'metadata.tagline');

    if (!isObject(metadata.image)) throw new Error('metadata.image must be an object');
    assertExactKeys(metadata.image, CANONICAL_IMAGE_KEYS, 'metadata.image');
    if (metadata.image.theme !== null) canonicalText(metadata.image.theme, 'metadata.image.theme');
    if (metadata.image.url !== null) canonicalText(metadata.image.url, 'metadata.image.url');

    if (!isObject(metadata.status)) throw new Error('metadata.status must be an object');
    assertExactKeys(metadata.status, CANONICAL_STATUS_KEYS, 'metadata.status');
    if (typeof metadata.status.isHidden !== 'boolean') throw new Error('metadata.status.isHidden must be boolean');
    if (typeof metadata.status.isApproved !== 'boolean') throw new Error('metadata.status.isApproved must be boolean');
    return event;
}

function normaliseDateString(value) {
    if (!value) return null;
    if (typeof value !== 'string') return value;
    const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z?)$/i);
    if (compactMatch) {
        const [, y, m, d, rawH, rawM, rawS, suffix] = compactMatch;
        const hh = rawH ?? '00';
        const mm = rawM ?? '00';
        const ss = rawS ?? '00';
        return `${y}-${m}-${d}T${hh}:${mm}:${ss}${suffix || ''}`;
    }
    return value;
}

function getMetadataData(event) {
    return isObject(event?.metadata) ? event.metadata : null;
}

function getStatusData(event) {
    const metadata = getMetadataData(event);
    return isObject(metadata?.status) ? metadata.status : null;
}

function getEventDate(event) {
    if (!event) return null;
    const candidate = event.dtstart || event.start?.iso || event.start?.raw || event.start;
    const normalised = normaliseDateString(candidate);
    if (!normalised) return null;
    const parsed = new Date(normalised);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDisplayDate(dateOrString) {
    if (!dateOrString) return '';
    const date = dateOrString instanceof Date ? dateOrString : new Date(normaliseDateString(dateOrString));
    if (Number.isNaN(date.getTime())) return '';
    return dateFormatter.format(date);
}

function isApprovedEventImage(event) {
    return getStatusData(event)?.isApproved === true;
}

function resolveImageUrl(event) {
    if (!isApprovedEventImage(event)) return null;
    const imageUrl = getMetadataData(event)?.image?.url;
    return typeof imageUrl === 'string' ? normaliseImagePath(imageUrl) : null;
}

function normaliseImagePath(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/website/eventImages/')) return `${S3_OBJECT_BASE_URL}${trimmed}`;
    if (trimmed.startsWith('website/eventImages/')) return `${S3_OBJECT_BASE_URL}/${trimmed}`;
    throw new Error(`Unsupported canonical event image path: ${trimmed}`);
}

function withImageWidthParam(imageUrl, width = 400) {
    if (!imageUrl || typeof imageUrl !== 'string') return null;
    const trimmed = imageUrl.trim();
    if (!trimmed) return null;
    if (/[?&]w=\d+/i.test(trimmed)) return trimmed;
    const separator = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${separator}w=${width}`;
}

function createEventImageMarkup(event, width = 400) {
    const rawUrl = resolveImageUrl(event);
    if (!rawUrl) return '';
    const sizedUrl = withImageWidthParam(rawUrl, width) || rawUrl;
    const altText = event?.title || event?.summary || 'Scout event image';
    return `<img src="${sizedUrl}" alt="${altText}" loading="lazy" />`;
}

const SECTION_BADGE_CONFIG = {
    beavers: {
        src: 'website/images/beavers-logo-white-png.png',
        alt: 'Beavers event',
    },
    cubs: {
        src: 'website/images/cubs-logo-white-png.png',
        alt: 'Cubs event',
    },
    all: {
        src: 'website/images/scouts-logo-white-png.png',
        alt: 'All scouts event',
    },
};

function normaliseSectionValue(value) {
    if (value === undefined || value === null) return 'cubs';
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return 'cubs';
    if (normalized === 'all' || normalized === 'group' || normalized === 'scouts' || normalized === 'all scouts') return 'all';
    if (normalized.startsWith('beaver')) return 'beavers';
    if (normalized.startsWith('cub')) return 'cubs';
    return 'cubs';
}

function resolveEventSection(event) {
    return normaliseSectionValue(event?.icsType ?? event?.section ?? null);
}

function createEventBadgeMarkup(event) {
    const sectionKey = resolveEventSection(event);
    const config = SECTION_BADGE_CONFIG[sectionKey] ?? SECTION_BADGE_CONFIG.cubs;
    return `<span class="event-section-badge event-section-badge--${sectionKey}"><img src="${config.src}" alt="${config.alt}" loading="lazy" /></span>`;
}

function createEventHeading(tagName, event) {
    const badge = createEventBadgeMarkup(event);
    const title = event?.title || event?.summary || 'Scout event';
    return `<${tagName} class="event-card-title">${badge}<span class="event-card-title-text">${title}</span></${tagName}>`;
}

function getTagline(event) {
    return getMetadataData(event)?.tagline ?? null;
}

function isHiddenEvent(event) {
    return getStatusData(event)?.isHidden === true;
}

function normaliseEventRecord(event) {
    assertCanonicalAgendaEvent(event);
    const normalised = { ...event };
    if (!normalised.title) normalised.title = normalised.summary || normalised.name || 'Scout event';
    normalised.section = resolveEventSection(normalised);
    return normalised;
}

function renderNextEventCard(event, container) {
    if (!container) return;
    if (!event) {
        container.innerHTML = '<p>No upcoming events scheduled.</p>';
        return;
    }

    const dateLabel = formatDisplayDate(event.__eventDate || event.dtstart || event.start?.iso || event.start?.raw);
    const locationLabel = event.location || '';
    const tagline = getTagline(event);
    const aiCopy = tagline ? `<p class="ai-text">${tagline}</p>` : '';
    const metaBlock = [
        dateLabel ? `<p><span class="label">Date:</span> ${dateLabel}</p>` : '',
        locationLabel ? `<p><span class="label">Location:</span> ${locationLabel}</p>` : ''
    ].filter(Boolean).join('');
    const image = createEventImageMarkup(event);
    const hasImage = Boolean(image);
    const sectionKey = resolveEventSection(event);
    const headingMarkup = createEventHeading('h3', event);
    const frontMarkup = hasImage
        ? `
            <div class="next-event-hero next-event-hero--with-image">
                <div class="next-event-hero-media">${image}</div>
                <div class="next-event-hero-copy">
                    ${headingMarkup}
                    ${aiCopy}
                </div>
            </div>
        `
        : `
            <div class="next-event-hero next-event-hero--text-only">
                ${headingMarkup}
                ${aiCopy}
            </div>
        `;

    container.innerHTML = `
        <div class="event-card flip-card${hasImage ? ' flip-card--with-image' : ''}" tabindex="0" data-section="${sectionKey}">
            <div class="flip-card-inner">
                <div class="flip-card-face flip-card-front">
                    ${frontMarkup}
                </div>
                <div class="flip-card-face flip-card-back">
                    ${headingMarkup}
                    ${aiCopy}
                    ${metaBlock ? `<div class="event-meta">${metaBlock}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function renderFutureEvents(events, container) {
    if (!container) return;
    if (!events.length) {
        container.innerHTML = '<p>No upcoming events to show.</p>';
        return;
    }

    container.innerHTML = events.map((event, index) => {
        const image = createEventImageMarkup(event);
        const sectionKey = resolveEventSection(event);
        const headingMarkup = createEventHeading('h4', event);
        const nextLabel = index === 0 ? '<p class="event-card-kicker">Coming next</p>' : '';
        const tagline = getTagline(event);
        return `
            <div class="event-card${index === 0 ? ' event-card--next' : ''}" data-section="${sectionKey}">
                ${nextLabel}
                ${image}
                ${headingMarkup}
                ${tagline ? `<p class="ai-text">${tagline}</p>` : ''}
            </div>
        `;
    }).join('');
}

function renderPastEventsCarousel(events, container) {
    if (!container) return;
    if (!events.length) {
        container.innerHTML = '<p>No recent events to show.</p>';
        return;
    }

    const cards = events.map(event => {
        const dateLabel = formatDisplayDate(event.__eventDate || event.dtstart || event.start?.iso || event.start?.raw);
        const locationLabel = event.location ? `<p class="location">${event.location}</p>` : '';
        const tagline = getTagline(event);
        const aiCopy = tagline ? `<p class="ai-text">${tagline}</p>` : '';
        const image = createEventImageMarkup(event);
        const sectionKey = resolveEventSection(event);
        const headingMarkup = createEventHeading('h4', event);
        return `
            <div class="event-card carousel-item" data-section="${sectionKey}">
                ${image}
                ${headingMarkup}
                ${dateLabel ? `<p class="date">${dateLabel}</p>` : ''}
                ${locationLabel}
                ${aiCopy}
            </div>
        `;
    });

    cards.push(`
        <div class="event-card carousel-item event-card--cta" data-section="all">
            <p class="event-card-kicker">Still<br>curious?</p>
            <p class="ai-text">Send us a message and we can help you find the right section, answer questions, or explain how to get involved.</p>
            <a class="event-card-cta-link" href="${CONTACT_PAGE_URL}">Go to the contact form</a>
        </div>
    `);

    container.innerHTML = `
        <div class="event-carousel">
            <button class="carousel-control prev" type="button" aria-label="Previous events"><span aria-hidden="true">‹</span></button>
            <div class="carousel-viewport">
                <div class="carousel-track">
                    ${cards.join('')}
                </div>
            </div>
            <button class="carousel-control next" type="button" aria-label="Next events"><span aria-hidden="true">›</span></button>
        </div>
    `;

    const carousel = container.querySelector('.event-carousel');
    const track = carousel.querySelector('.carousel-track');
    const items = Array.from(track.children);
    const prevButton = carousel.querySelector('.prev');
    const nextButton = carousel.querySelector('.next');
    let currentIndex = 0;

    const getColumns = () => {
        const value = window.getComputedStyle(carousel).getPropertyValue('--carousel-columns');
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? 3 : parsed;
    };

    const getItemOffset = () => {
        if (!items.length) return 0;
        const itemWidth = items[0].getBoundingClientRect().width;
        const trackStyles = window.getComputedStyle(track);
        const gap = parseFloat(trackStyles.columnGap || trackStyles.gap || 0);
        return itemWidth + gap;
    };

    const clampIndex = (index) => {
        const columns = getColumns();
        const maxIndex = Math.max(0, items.length - columns);
        return Math.min(Math.max(index, 0), maxIndex);
    };

    const updateButtons = () => {
        const columns = getColumns();
        const maxIndex = Math.max(0, items.length - columns);
        prevButton.disabled = currentIndex <= 0;
        nextButton.disabled = currentIndex >= maxIndex;
        const hideControls = maxIndex === 0;
        [prevButton, nextButton].forEach(btn => btn.classList.toggle('is-hidden', hideControls));
    };

    const updatePosition = () => {
        track.style.transform = `translateX(-${getItemOffset() * currentIndex}px)`;
    };

    const goTo = (index) => {
        currentIndex = clampIndex(index);
        updatePosition();
        updateButtons();
    };

    prevButton.addEventListener('click', () => goTo(currentIndex - 1));
    nextButton.addEventListener('click', () => goTo(currentIndex + 1));

    window.addEventListener('resize', () => {
        currentIndex = clampIndex(currentIndex);
        window.requestAnimationFrame(() => {
            updatePosition();
            updateButtons();
        });
    });

    goTo(0);
}

document.addEventListener('DOMContentLoaded', () => {
    fetchAgendaJson()
        .then(data => {
            const rawEvents = Array.isArray(data.events) ? data.events : [];
            const canonicalEvents = rawEvents
                .map((event) => {
                    try {
                        return normaliseEventRecord(event);
                    } catch (error) {
                        console.error('[EventsLoader] Rejecting non-canonical agenda event', {
                            title: event?.title ?? event?.summary ?? null,
                            error: error?.message || String(error),
                        });
                        return null;
                    }
                })
                .filter(Boolean);
            const events = canonicalEvents.filter(event => {
                if (isHiddenEvent(event)) {
                    console.log('Filtering out hidden event:', event.uid ?? event.title);
                    return false;
                }
                return true;
            });

            console.log('[EventsLoader] agenda.json fetched', {
                totalEvents: rawEvents.length,
                canonicalEvents: canonicalEvents.length,
                visibleEvents: events.length,
            });

            const now = new Date();
            const parsedEvents = events
                .map(event => {
                    const eventDate = getEventDate(event);
                    if (!eventDate) {
                        console.warn('[EventsLoader] Skipping event with invalid date', {
                            uid: event.uid,
                            summary: event.summary,
                            dtstart: event.dtstart,
                        });
                        return null;
                    }
                    return { ...event, __eventDate: eventDate };
                })
                .filter(Boolean);

            const futureEvents = parsedEvents
                .filter(event => event.__eventDate > now)
                .sort((a, b) => a.__eventDate - b.__eventDate);
            const pastEvents = parsedEvents
                .filter(event => event.__eventDate <= now)
                .sort((a, b) => b.__eventDate - a.__eventDate);

            console.log('[EventsLoader] Future events count:', futureEvents.length);
            console.log('[EventsLoader] Past events count:', pastEvents.length);

            renderFutureEvents(futureEvents.slice(0, 3), document.getElementById('future-events'));
            renderPastEventsCarousel(pastEvents, document.getElementById('past-events'));
        })
        .catch(error => {
            console.error('Error loading events:', error);
            const eventsSection = document.getElementById('events-section');
            if (eventsSection) {
                eventsSection.innerHTML = '<div class="container"><p>Could not load events. Please check the console for more details.</p></div>';
            }
        });
});
