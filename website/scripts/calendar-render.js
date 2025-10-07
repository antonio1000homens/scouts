// Simple client-side .ics fetch + parse (minimal parser)
// Attempts to fetch the ICS URL and extract VEVENT blocks, then render upcoming events.
// Graceful fallback: if fetch fails (CORS or server returns an .ics download), we keep the Open/Download links.

(async function () {
  'use strict';

  function parseICSEvents(icsText) {
    const events = [];
    const vevents = icsText.split(/BEGIN:VEVENT/g).slice(1);
    vevents.forEach(block => {
      const end = block.split(/END:VEVENT/)[0];
      const lines = end.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const event = {};
      lines.forEach(line => {
        if (line.startsWith('DTSTART')) event.dtstart = line.split(':').slice(1).join(':');
        if (line.startsWith('DTEND')) event.dtend = line.split(':').slice(1).join(':');
        if (line.startsWith('SUMMARY')) event.summary = line.split(':').slice(1).join(':');
        if (line.startsWith('LOCATION')) event.location = line.split(':').slice(1).join(':');
        if (line.startsWith('DESCRIPTION')) event.description = line.split(':').slice(1).join(':');
      });

      // Convert DTSTART to JS Date where possible (handles basic UTC and local formats)
      if (event.dtstart) {
        // Remove timezone suffix Z for Date parsing
        const raw = event.dtstart.replace(/Z$/, '');
        // If format is YYYYMMDDThhmmss or YYYYMMDD, convert to ISO-like
        if (/^\d{8}T\d{6}$/.test(raw)) {
          const iso = raw.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
          event.start = new Date(iso);
        } else if (/^\d{8}$/.test(raw)) {
          const iso = raw.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
          event.start = new Date(iso);
        } else {
          const tryIso = raw.replace(/\s+/, 'T');
          event.start = new Date(tryIso);
        }
      }

      if (event.dtend) {
        const raw = event.dtend.replace(/Z$/, '');
        if (/^\d{8}T\d{6}$/.test(raw)) {
          const iso = raw.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
          event.end = new Date(iso);
        } else if (/^\d{8}$/.test(raw)) {
          const iso = raw.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
          event.end = new Date(iso);
        } else {
          const tryIso = raw.replace(/\s+/, 'T');
          event.end = new Date(tryIso);
        }
      }

      events.push(event);
    });
    return events.filter(e => e.start && e.summary).sort((a,b)=>a.start - b.start);
  }

  async function fetchICS(url) {
    try {
      const res = await fetch(url, {mode: 'cors'});
      if (!res.ok) throw new Error('Network response was not ok');
      const text = await res.text();
      // If the server returned a file download wrapper (like HTML), detect automatically by simple heuristics
      if (text.trim().startsWith('<') && text.includes('DOCTYPE')) {
        throw new Error('Server returned HTML instead of ICS');
      }
      return text;
    } catch (err) {
      console.warn('Failed to fetch ICS:', err.message);
      throw err;
    }
  }

  function formatDate(d) {
    if (!d || !(d instanceof Date) || isNaN(d)) return '';
    return d.toLocaleString(undefined, {weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  }

  async function renderCalendars() {
    const items = document.querySelectorAll('.calendar-item[data-ics]');
    for (const item of items) {
      const url = item.getAttribute('data-ics');
      const eventsContainer = item.querySelector('.calendar-events');
      try {
        const ics = await fetchICS(url);
        const events = parseICSEvents(ics);
        if (!events.length) {
          eventsContainer.innerHTML = '<p class="muted">No upcoming events found.</p>';
          continue;
        }
        // Render next 6 events
        const list = document.createElement('ul');
        list.className = 'calendar-event-list';
        events.slice(0,6).forEach(ev => {
          const li = document.createElement('li');
          li.className = 'calendar-event';
          li.innerHTML = `<div class="ce-head"><strong>${ev.summary}</strong> <span class="ce-date">${formatDate(ev.start)}</span></div>${ev.location?`<div class="ce-location">${ev.location}</div>`:''}${ev.description?`<div class="ce-desc">${ev.description}</div>`:''}`;
          list.appendChild(li);
        });
        eventsContainer.innerHTML = '';
        eventsContainer.appendChild(list);
      } catch (err) {
        // Show fallback message but keep the Open/Download links
        eventsContainer.innerHTML = '<p class="muted">Could not load events here — click Open calendar to view or download the file.</p>';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderCalendars);
  } else {
    renderCalendars();
  }

})();
