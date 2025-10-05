# Events System Guide

## Overview
The 2nd Tolworth Scout Group website now features a dynamic events system that loads events from JSON files. Events are automatically displayed on the home page with the next upcoming event featured prominently.

## JSON Event Files

The events are stored in two JSON files located in the root directory:

- `cubs-events.json` - Contains Cubs section events
- `scouts-events.json` - Contains Scouts section events

## Event Structure

Each event in the JSON files should follow this structure:

```json
{
  "title": "Event Name",
  "date": "YYYY-MM-DD",
  "time": "HH:MM AM/PM - HH:MM AM/PM",
  "location": "Location Name",
  "description": "Brief description of the event",
  "section": "cubs" or "scouts"
}
```

### Example Event

```json
{
  "title": "Cubs Badge Workshop",
  "date": "2025-10-15",
  "time": "6:30 PM - 8:00 PM",
  "location": "2nd Tolworth Scout HQ",
  "description": "Work towards your activity badges with hands-on challenges and games.",
  "section": "cubs"
}
```

## How to Update Events

### Adding a New Event

1. Open the appropriate JSON file (`cubs-events.json` or `scouts-events.json`)
2. Add a new event object to the array following the structure above
3. Make sure the date format is `YYYY-MM-DD` (e.g., `2025-12-25`)
4. Save the file
5. The website will automatically load and display the new event

### Removing Past Events

Events with dates in the past are automatically hidden from the website. However, you may want to periodically clean up the JSON files:

1. Open the JSON file
2. Remove event objects with past dates
3. Save the file

### Editing an Event

1. Open the appropriate JSON file
2. Find the event you want to edit
3. Update any of the fields (title, date, time, location, description)
4. Save the file

## Website Display

### Next Event Section
- Located just below the hero section on the home page
- Shows the soonest upcoming event from both Cubs and Scouts
- Features a prominent purple gradient background
- Displays all event details (date, time, location, description)
- Includes a "View All Events" button

### Upcoming Events Section
- Located after the News section
- Displays all upcoming events sorted by date
- Events are color-coded:
  - **Green** badge for Cubs events
  - **Dark teal** badge for Scouts events
- Responsive grid layout (3 columns on desktop, 1 column on mobile)

## Technical Details

### Files Involved
- `cubs-events.json` - Cubs events data
- `scouts-events.json` - Scouts events data
- `scripts/events-loader.js` - JavaScript that loads and displays events
- `index.html` - Contains the event sections
- `styles.css` - Event styling

### How It Works
1. When the page loads, `events-loader.js` fetches both JSON files
2. Events are filtered to show only future dates
3. Events are sorted by date (earliest first)
4. The next event is displayed in the prominent section
5. All upcoming events are displayed in the events grid

## Tips

- Keep event descriptions concise (1-2 sentences)
- Use consistent date formatting (`YYYY-MM-DD`)
- Update the JSON files regularly to remove past events
- Add events well in advance so they appear on the website
- Test the website after adding events to ensure they display correctly

## Troubleshooting

**Events not showing up:**
- Check that the date is in the future
- Verify the JSON syntax is correct (use a JSON validator)
- Make sure the `section` field is exactly "cubs" or "scouts"

**Wrong date format:**
- Dates must be in `YYYY-MM-DD` format
- Example: `2025-12-31` not `31/12/2025`

**Events showing "No upcoming events":**
- All event dates are in the past
- Add new events with future dates
