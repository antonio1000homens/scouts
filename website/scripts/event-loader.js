// Copyright (c) 2025 Antonio Freire. All rights reserved.
//
// Loads and renders upcoming Scouts events from agenda.json.

const REGRESSION_UID_PREFIX = 'scouts-regression-';
const SECTION_BADGE_CONFIG = {
    beavers: { src: 'images/icons/beavers.svg', alt: 'Beavers' },
    cubs: { src: 'images/icons/cubs.svg', alt: 'Cubs' },
    scouts: { src: 'images/icons/scouts.svg', alt: 'Scouts' },
    explorers: { src: 'images/icons/explorers.svg', alt: 'Explorers' },
};

function getMetadataData(event) {
    return event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
}

function getStatusData(event) {
    const status = getMetadataData(event)?.status;
    return status && typeof status === 'object' ? status : {};
}

function isApprovedEventImage(event) {
    return getStatusData(event)?.isApproved === true;
}

function normaliseImagePath(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return trimmed.replace(/^\/+/, '');
}

function resolveImageUrl(event) {
    if (!isApprovedEventImage(event)) return null;
    const raw = getMetadataData(event)?.image?.url;
    const normalised = normaliseImagePath(raw);
    if (!normalised) return null;
    if (/^https?:\/\//i.test(normalised)) return normalised;
    const scriptSrc = document.currentScript?.src || window.location.href;
    return new URL(`../${normalised}`, scriptSrc).href;
}

function withImageWidthParam(url, width) {
    if (!url) return null;
    try {
        const parsed = new URL(url, window.location.href);
        parsed.searchParams.set('w', String(width));
        return parsed.href;
    } catch {
        return url;
    }
}

function createEventImageMarkup(event) {
    const imageUrl = resolveImageUrl(event);
    if (!imageUrl) return '';
    const title = event?.title || event?.summary || 'Scout event';
    const src = withImageWidthParam(imageUrl, 400);
    return `<img class="event-card-image" src="${src}" alt="Image for ${title}" loading="lazy" />`;
}

function normaliseDateCandidate(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{8}T\d{6}Z?$/.test(trimmed)) {
        const iso = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T${trimmed.slice(9, 11)}:${trimmed.slice(11, 13)}:${trimmed.slice(13, 15)}${trimmed.endsWith('Z') ? 'Z' : ''}`;
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
}

function getEventDate(event) {
    return normaliseDateCandidate(
        event?.start?.epochMillis
        ?? event?.start?.iso
        ?? event?.start?.raw
        ?? event?.dtstart
        ?? event?.date
        ?? null,
    );
}

function formatDisplayDate(value) {
    const date = normaliseDateCandidate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function normaliseSectionValue(value) {
    const section = String(value || '').trim().toLowerCase();
    return SECTION_BADGE_CONFIG[section] ? section : 'cubs';
}

function resolveEventSection(event) {
    return normaliseSectionValue(event?.source?.section ?? event?.source?.icsType ?? event?.icsType ?? event?.section ?? null);
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

function isRegressionEvent(event) {
    const candidates = [event?.uid, event?.source?.uid];
    return candidates.some((uid) => (
        typeof uid === 'string'
        && uid.trim().toLowerCase().startsWith(REGRESSION_UID_PREFIX)
    ));
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
    const imageMarkup = createEventImageMarkup(event);
    container.innerHTML = `
        <article class="event-card">
            ${imageMarkup}
            <div class="event-card-copy">
                ${createEventHeading('h3', event)}
                ${tagline ? `<p class="event-card-tagline">${tagline}</p>` : ''}
                ${dateLabel ? `<p class="event-card-date">${dateLabel}</p>` : ''}
                ${locationLabel ? `<p class="event-card-location">${locationLabel}</p>` : ''}
            </div>
        </article>
    `;
}

function renderUpcomingEvents(events, container) {
    if (!container) return;
    if (!events.length) {
        container.innerHTML = '<p>No upcoming events scheduled.</p>';
        return;
    }
    container.innerHTML = events.map((event) => {
        const dateLabel = formatDisplayDate(event.__eventDate || event.dtstart || event.start?.iso || event.start?.raw);
        const tagline = getTagline(event);
        return `
            <article class="event-card event-card--compact">
                ${createEventImageMarkup(event)}
                <div class="event-card-copy">
                    ${createEventHeading('h3', event)}
                    ${tagline ? `<p class="event-card-tagline">${tagline}</p>` : ''}
                    ${dateLabel ? `<p class="event-card-date">${dateLabel}</p>` : ''}
                </div>
            </article>
        `;
    }).join('');
}

function assertCanonicalAgendaEvent(event) {
    if (!event || typeof event !== 'object') throw new Error('Agenda event must be an object');
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== 'object') throw new Error('Agenda event is missing canonical metadata');
    if (!metadata.status || typeof metadata.status !== 'object') throw new Error('Agenda event is missing metadata.status');
    if (!metadata.image || typeof metadata.image !== 'object') throw new Error('Agenda event is missing metadata.image');
}

async function loadAgendaEvents() {
    const response = await fetch('agenda.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load agenda.json: HTTP ${response.status}`);
    const agenda = await response.json();
    const now = Date.now();
    const events = [];
    for (const rawEvent of Array.isArray(agenda?.events) ? agenda.events : []) {
        let event;
        try {
            event = normaliseEventRecord(rawEvent);
        } catch (error) {
            console.warn('Skipping non-canonical agenda event', error);
            continue;
        }
        if (isRegressionEvent(event)) {
            console.log('Filtering out regression event', event.uid || event.source?.uid || event.title);
            continue;
        }
        if (isHiddenEvent(event)) {
            console.log('Filtering out hidden event', event.uid || event.title);
            continue;
        }
        const eventDate = getEventDate(event);
        if (!eventDate || eventDate.getTime() < now) continue;
        events.push({ ...event, __eventDate: eventDate });
    }
    events.sort((a, b) => a.__eventDate.getTime() - b.__eventDate.getTime());
    return events;
}

async function initialiseEventSections() {
    try {
        const events = await loadAgendaEvents();
        renderNextEventCard(events[0] || null, document.getElementById('next-event'));
        renderUpcomingEvents(events.slice(1, 4), document.getElementById('upcoming-events'));
    } catch (error) {
        console.error('Unable to render Scouts events', error);
    }
}

document.addEventListener('DOMContentLoaded', initialiseEventSections);
