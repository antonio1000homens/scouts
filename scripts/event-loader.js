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

            const futureEvents = events.filter(event => new Date(event.start.iso) > now).sort((a, b) => new Date(a.start.iso) - new Date(b.start.iso));
            const pastEvents = events.filter(event => new Date(event.start.iso) <= now).sort((a, b) => new Date(b.start.iso) - new Date(a.start.iso));

            const nextEvent = futureEvents.length > 0 ? futureEvents[0] : null;
            const upcomingEvents = futureEvents.slice(0, 3);
            const recentEvents = pastEvents.slice(0, 3);

            const nextEventContainer = document.getElementById('next-event');
            if (nextEvent) {
                nextEventContainer.innerHTML = `
                    <div class="event-card prominent">
                        <h3>${nextEvent.title}</h3>
                        <p class="subtitle">${nextEvent.AI || ''}</p>
                        <p class="date">${new Date(nextEvent.start.iso).toLocaleString()}</p>
                        <p class="location">${nextEvent.location || ''}</p>
                    </div>
                `;
            } else {
                nextEventContainer.innerHTML = '<p>No upcoming events scheduled.</p>';
            }

            const futureEventsContainer = document.getElementById('future-events');
            if (upcomingEvents.length > 0) {
                futureEventsContainer.innerHTML = upcomingEvents.map(event => `
                    <div class="event-card">
                        <h4>${event.title}</h4>
                        <p class="date">${new Date(event.start.iso).toLocaleString()}</p>
                    </div>
                `).join('');
            } else {
                futureEventsContainer.innerHTML = '<p>No upcoming events to show.</p>';
            }

            const pastEventsContainer = document.getElementById('past-events');
            if (recentEvents.length > 0) {
                pastEventsContainer.innerHTML = recentEvents.map(event => `
                    <div class="event-card">
                        <h4>${event.title}</h4>
                        <p class="date">${new Date(event.start.iso).toLocaleString()}</p>
                    </div>
                `).join('');
            } else {
                pastEventsContainer.innerHTML = '<p>No recent events to show.</p>';
            }
        })
        .catch(error => {
            console.error('Error loading events:', error);
            const eventsSection = document.getElementById('events-section');
            if(eventsSection) {
                eventsSection.innerHTML = '<div class="container"><p>Could not load events. Please check the console for more details.</p></div>';
            }
        });
});
