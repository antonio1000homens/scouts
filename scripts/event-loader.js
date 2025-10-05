const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
});

function normaliseDateString(value) {
    if (!value) return null;
    if (typeof value !== 'string') return value;
    const timestampMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (timestampMatch) {
        const [, y, m, d, hh, mm, ss, suffix] = timestampMatch;
        return `${y}-${m}-${d}T${hh}:${mm}:${ss}${suffix || ''}`;
    }
    const dateMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateMatch) {
        const [, y, m, d] = dateMatch;
        return `${y}-${m}-${d}T00:00:00`;
    }
    return value;
}

function getEventDate(event) {
    if (!event) return null;
    const candidate = event.start?.iso || event.start?.raw || event.start;
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

function renderNextEventCard(event, container) {
    if (!container) return;
    if (!event) {
        container.innerHTML = '<p>No upcoming events scheduled.</p>';
        return;
    }

    const dateLabel = formatDisplayDate(event.__eventDate || event.start?.iso || event.start?.raw);
    const locationLabel = event.location || '';
    const aiCopy = event.AI ? `<p class="ai-text">${event.AI}</p>` : '';
    const metaBlock = [
        dateLabel ? `<p><span class="label">Date:</span> ${dateLabel}</p>` : '',
        locationLabel ? `<p><span class="label">Location:</span> ${locationLabel}</p>` : ''
    ].filter(Boolean).join('');

    container.innerHTML = `
        <div class="event-card flip-card" tabindex="0">
            <div class="flip-card-inner">
                <div class="flip-card-face flip-card-front">
                    <h3>${event.title}</h3>
                    ${aiCopy}
                </div>
                <div class="flip-card-face flip-card-back">
                    <h3>${event.title}</h3>
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

    container.innerHTML = events.map(event => `
        <div class="event-card">
            <h4>${event.title}</h4>
            ${event.AI ? `<p class="ai-text">${event.AI}</p>` : ''}
        </div>
    `).join('');
}

function renderPastEventsCarousel(events, container) {
    if (!container) return;
    if (!events.length) {
        container.innerHTML = '<p>No recent events to show.</p>';
        return;
    }

    const cards = events.map(event => {
        const dateLabel = formatDisplayDate(event.__eventDate || event.start?.iso || event.start?.raw);
        const locationLabel = event.location ? `<p class="location">${event.location}</p>` : '';
        const aiCopy = event.AI ? `<p class="ai-text">${event.AI}</p>` : '';
        return `
            <div class="event-card carousel-item">
                <h4>${event.title}</h4>
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
    fetch('events.json')
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const events = data.events || [];
            const now = new Date();

            const parsedEvents = events
                .map(event => {
                    const eventDate = getEventDate(event);
                    if (!eventDate) return null;
                    return { ...event, __eventDate: eventDate };
                })
                .filter(Boolean);

            const futureEvents = parsedEvents
                .filter(event => event.__eventDate > now)
                .sort((a, b) => a.__eventDate - b.__eventDate);

            const pastEvents = parsedEvents
                .filter(event => event.__eventDate <= now)
                .sort((a, b) => b.__eventDate - a.__eventDate);

            const nextEvent = futureEvents.length ? futureEvents[0] : null;
            const upcomingEvents = futureEvents.slice(0, 3);

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
