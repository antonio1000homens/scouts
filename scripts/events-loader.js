// Events loader - Loads events from JSON files and displays them on the page
(async function () {
  'use strict';

  // Function to fetch and parse JSON events
  async function fetchEvents(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch events');
      return await response.json();
    } catch (error) {
      console.error('Error loading events:', error);
      return [];
    }
  }

  // Function to parse date string to Date object
  function parseEventDate(dateStr) {
    return new Date(dateStr);
  }

  // Function to format date for display
  function formatDate(dateStr) {
    const date = parseEventDate(dateStr);
    const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
    return date.toLocaleDateString(undefined, options);
  }

  // Function to find the next upcoming event from all events
  function findNextEvent(allEvents) {
    const now = new Date();
    const upcomingEvents = allEvents.filter(event => parseEventDate(event.date) >= now);
    if (upcomingEvents.length === 0) return null;
    
    upcomingEvents.sort((a, b) => parseEventDate(a.date) - parseEventDate(b.date));
    return upcomingEvents[0];
  }

  // Function to render the next event section
  function renderNextEvent(event) {
    const nextEventSection = document.getElementById('next-event');
    if (!nextEventSection || !event) return;

    const eventDate = formatDate(event.date);
    const sectionBadge = event.section.charAt(0).toUpperCase() + event.section.slice(1);

    nextEventSection.innerHTML = `
      <div class="container">
        <div class="next-event-content">
          <div class="next-event-badge">${sectionBadge}</div>
          <h2>Next Event</h2>
          <h3>${event.title}</h3>
          <div class="next-event-details">
            <div class="event-detail">
              <span class="event-icon">📅</span>
              <span>${eventDate}</span>
            </div>
            <div class="event-detail">
              <span class="event-icon">🕐</span>
              <span>${event.time}</span>
            </div>
            <div class="event-detail">
              <span class="event-icon">📍</span>
              <span>${event.location}</span>
            </div>
          </div>
          <p class="next-event-description">${event.description}</p>
          <a href="#events" class="cta-button primary">View All Events</a>
        </div>
      </div>
    `;
  }

  // Function to render all events in the events section
  function renderAllEvents(cubsEvents, scoutsEvents) {
    const eventsGrid = document.getElementById('events-grid');
    if (!eventsGrid) return;

    const now = new Date();
    const allEvents = [...cubsEvents, ...scoutsEvents];
    const upcomingEvents = allEvents
      .filter(event => parseEventDate(event.date) >= now)
      .sort((a, b) => parseEventDate(a.date) - parseEventDate(b.date));

    if (upcomingEvents.length === 0) {
      eventsGrid.innerHTML = '<p class="no-events">No upcoming events at the moment. Check back soon!</p>';
      return;
    }

    eventsGrid.innerHTML = upcomingEvents.map(event => {
      const eventDate = formatDate(event.date);
      const sectionClass = event.section.toLowerCase();
      const sectionBadge = event.section.charAt(0).toUpperCase() + event.section.slice(1);
      
      return `
        <article class="event-card ${sectionClass}">
          <div class="event-section-badge">${sectionBadge}</div>
          <h3>${event.title}</h3>
          <div class="event-info">
            <div class="event-detail">
              <span class="event-icon">📅</span>
              <span>${eventDate}</span>
            </div>
            <div class="event-detail">
              <span class="event-icon">🕐</span>
              <span>${event.time}</span>
            </div>
            <div class="event-detail">
              <span class="event-icon">📍</span>
              <span>${event.location}</span>
            </div>
          </div>
          <p>${event.description}</p>
        </article>
      `;
    }).join('');
  }

  // Main initialization function
  async function init() {
    // Fetch events from both JSON files
    const [cubsEvents, scoutsEvents] = await Promise.all([
      fetchEvents('cubs-events.json'),
      fetchEvents('scouts-events.json')
    ]);

    // Combine all events and find the next one
    const allEvents = [...cubsEvents, ...scoutsEvents];
    const nextEvent = findNextEvent(allEvents);

    // Render the next event section
    renderNextEvent(nextEvent);

    // Render all events
    renderAllEvents(cubsEvents, scoutsEvents);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
