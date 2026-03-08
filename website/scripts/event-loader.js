const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
});

const AGENDA_URL = 'http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/agenda.json';
const S3_SITE_ORIGIN = 'http://2ndtolworth.s3-website.eu-west-2.amazonaws.com';

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

function getSourceData(event) {
    return event?.source && typeof event.source === 'object' ? event.source : null;
}

function getMetadataData(event) {
    return event?.metadata && typeof event.metadata === 'object' ? event.metadata : null;
}

function getStatusData(event) {
    return event?.status && typeof event.status === 'object' ? event.status : null;
}

function getEventDate(event) {
    if (!event) return null;
    const source = getSourceData(event);
    const candidate = source?.dtstart || event.dtstart || event.start?.iso || event.start?.raw || event.start;
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

function resolveImageUrl(event) {
    if (!event) return null;
    const metadata = getMetadataData(event);
    const image = metadata?.image ?? event.image;
    const imageUrl = event.imageUrl;
    if (typeof image === 'string') return normaliseImagePath(image);
    if (typeof imageUrl === 'string') return normaliseImagePath(imageUrl);
    if (image && typeof image === 'object') {
        if (typeof image.url === 'string') return normaliseImagePath(image.url);
        if (typeof image.src === 'string') return normaliseImagePath(image.src);
        if (typeof image.href === 'string') return normaliseImagePath(image.href);
    }
    return null;
}

function normaliseImagePath(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    if (trimmed.startsWith('/website/eventImages/')) {
        return `${S3_SITE_ORIGIN}${trimmed}`;
    }
    if (trimmed.startsWith('website/eventImages/')) {
        return `${S3_SITE_ORIGIN}/${trimmed}`;
    }
    if (trimmed.startsWith('/')) {
        return trimmed;
    }
    return `/${trimmed.replace(/^(\.\/)+/, '')}`;
}

function withImageWidthParam(imageUrl, width = 400) {
    if (!imageUrl || typeof imageUrl !== 'string') return null;
    const trimmed = imageUrl.trim();
    if (!trimmed) return null;
    if (/[?&]w=\d+/i.test(trimmed)) {
        return trimmed;
    }
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
    if (value === undefined || value === null) {
        return 'cubs';
    }
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return 'cubs';
    if (normalized === 'all' || normalized === 'group' || normalized === 'scouts' || normalized === 'all scouts') {
        return 'all';
    }
    if (normalized.startsWith('beaver')) {
        return 'beavers';
    }
    if (normalized.startsWith('cub')) {
        return 'cubs';
    }
    return 'cubs';
}

function resolveEventSection(event) {
    if (!event) return 'cubs';
    const source = getSourceData(event);
    return normaliseSectionValue(
        source?.icsType ?? source?.section ?? event.icsType ?? event.section ?? event.audience ?? event.group ?? null,
    );
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
    if (!event || typeof event !== 'object') return null;
    const metadata = getMetadataData(event);
    return metadata?.tagline || event.tagline || event.AI || event.ai || event.aiPrompt || null;
}

function isHiddenEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const status = getStatusData(event);
    if (status?.isHidden === true) return true;
    if (typeof event.isHidden === 'boolean') return event.isHidden;
    if (typeof event.isHidden === 'string') {
        const normalized = event.isHidden.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    return event.status === 'hidden' || event.hidden === true;
}

function normaliseEventRecord(event) {
    if (!event || typeof event !== 'object') return null;
    const source = getSourceData(event);
    const metadata = getMetadataData(event);
    const status = getStatusData(event);
    const normalised = {
        ...event,
        uid: source?.uid ?? event.uid,
        title: source?.title ?? event.title ?? source?.summary ?? event.summary,
        summary: source?.summary ?? event.summary ?? source?.title ?? event.title,
        location: source?.location ?? event.location,
        dtstart: source?.dtstart ?? event.dtstart,
        section: source?.section ?? event.section,
        icsType: source?.icsType ?? event.icsType,
        tagline: metadata?.tagline ?? event.tagline,
        image: metadata?.image ?? event.image,
        hexId: metadata?.hexId ?? event.hexId ?? event.hex ?? null,
        hex: metadata?.hexId ?? event.hexId ?? event.hex ?? null,
        approved: status?.isApproved === true || event.approved === true,
        status: status?.isHidden === true ? 'hidden' : event.status,
    };

    if (!normalised.title) {
        normalised.title = normalised.summary || normalised.name || 'Scout event';
    }

    if (normalised.tagline === undefined) {
        normalised.tagline = getTagline(normalised);
    }

    if (!normalised.location && normalised.place) {
        normalised.location = normalised.place;
    }

    const imageUrl = resolveImageUrl(normalised);
    if (imageUrl) {
        normalised.imageUrl = imageUrl;
    }

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
    const sectionKey = resolveEventSection(event);
    const headingMarkup = createEventHeading('h3', event);
    const frontMarkup = image
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
        <div class="event-card flip-card" tabindex="0" data-section="${sectionKey}">
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

    container.innerHTML = events.map(event => {
        const image = createEventImageMarkup(event);
        const sectionKey = resolveEventSection(event);
        const headingMarkup = createEventHeading('h4', event);
        return `
            <div class="event-card" data-section="${sectionKey}">
                ${image}
                ${headingMarkup}
                ${getTagline(event) ? `<p class="ai-text">${getTagline(event)}</p>` : ''}
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
    }).join('');

    container.innerHTML = `
        <div class="event-carousel">
            <button class="carousel-control prev" type="button" aria-label="Previous events"><span aria-hidden="true">‹</span></button>
            <div class="carousel-viewport">
                <div class="carousel-track">
                    ${cards}
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
        const atStart = currentIndex <= 0;
        const atEnd = currentIndex >= maxIndex;
        prevButton.disabled = atStart;
        nextButton.disabled = atEnd;
        const hideControls = maxIndex === 0;
        [prevButton, nextButton].forEach(btn => btn.classList.toggle('is-hidden', hideControls));
    };

    const updatePosition = () => {
        const offset = getItemOffset() * currentIndex;
        track.style.transform = `translateX(-${offset}px)`;
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
    fetch(`${AGENDA_URL}?ts=${Date.now()}`, {
        cache: 'no-store',
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const events = (data.events || [])
                .filter(event => {
                    // Filter out hidden events
                    if (isHiddenEvent(event)) {
                        console.log('Filtering out hidden event:', event.uid ?? event.title);
                        return false;
                    }
                    return true;
                })
                .map(normaliseEventRecord)
                .filter(Boolean);
            console.log('[EventsLoader] S3 agenda.json fetched', {
                totalEvents: data.events?.length ?? 0,
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
            console.log('[EventsLoader] Future events count:', futureEvents.length);

            const pastEvents = parsedEvents
                .filter(event => event.__eventDate <= now)
                .sort((a, b) => b.__eventDate - a.__eventDate);
                    console.log('[EventsLoader] Past events count:', pastEvents.length);
                    const nextEvent = futureEvents.length ? futureEvents[0] : null;
                    const upcomingEvents = futureEvents.slice(1, 4);

                    renderNextEventCard(nextEvent, document.getElementById('next-event'));
                    renderFutureEvents(upcomingEvents, document.getElementById('future-events'));
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

function isHiddenEvent(event) {
    const status = getStatusData(event);
    if (status?.isHidden === true) return true;
    return event?.status === 'hidden' || event?.hidden === true;
}
