# Hidden Events Cleanup - Code Examples

## Example 1: Cleanup in Action

### Input Agenda
```json
{
  "events": [
    {
      "uid": "past-hidden-1",
      "title": "Old Hidden Event",
      "hidden": true,
      "dtstart": "20250115T100000",
      "start": {
        "raw": "20250115T100000",
        "epochMillis": 1705329600000
      }
    },
    {
      "uid": "future-hidden-1",
      "title": "Upcoming Hidden Event",
      "hidden": true,
      "dtstart": "20251220T100000",
      "start": {
        "raw": "20251220T100000",
        "epochMillis": 1766265600000
      }
    },
    {
      "uid": "public-1",
      "title": "Public Event",
      "hidden": false,
      "dtstart": "20251201T100000",
      "start": {
        "raw": "20251201T100000",
        "epochMillis": 1764710400000
      }
    }
  ]
}
```

### After Cleanup
```json
{
  "events": [
    {
      "uid": "future-hidden-1",
      "title": "Upcoming Hidden Event",
      "hidden": true,
      "dtstart": "20251220T100000"
    },
    {
      "uid": "public-1",
      "title": "Public Event",
      "hidden": false,
      "dtstart": "20251201T100000"
    }
  ]
}
```

**Result**: Past hidden event removed, future hidden and public events kept.

## Example 2: Inconsistency Detection & Fix

### Before Validation

**agenda.json event**:
```json
{
  "uid": "future-hidden-2",
  "title": "Future Hidden Event",
  "hidden": true,
  "dtstart": "20251215T140000",
  "start": {
    "epochMillis": 1766861400000
  }
}
```

**HEX file (events/hex_for_title.json)**:
```json
{
  "title": "Future Hidden Event",
  "hex": "66757475726520...",
  "hidden": false,
  "image": {
    "url": "http://...",
    "prompt": "..."
  },
  "AI": "..."
}
```

**Inconsistency**: Agenda says `hidden=true` but HEX says `hidden=false`

### After Validation

**HEX file is updated to**:
```json
{
  "title": "Future Hidden Event",
  "hex": "66757475726520...",
  "hidden": true,
  "status": "hidden",
  "hiddenAt": "2025-10-17T10:30:00.000Z",
  "image": {
    "url": "http://...",
    "prompt": "..."
  },
  "AI": "..."
}
```

**Result**: HEX file now matches agenda's hidden status.

## Example 3: Function Implementation

### cleanupHiddenPastEvents Implementation

```javascript
async function cleanupHiddenPastEvents(events) {
  const now = Date.now();
  const removedEvents = [];
  const retainedEvents = [];

  for (const event of events ?? []) {
    if (!event) continue;

    const isHidden = isEventHidden(event);
    const eventTime = event.start?.epochMillis;
    const isPastEvent = typeof eventTime === 'number' 
      && !Number.isNaN(eventTime) 
      && eventTime <= now;

    if (isHidden && isPastEvent) {
      // Remove hidden past events
      console.log(`[Hidden Cleanup] Removing hidden past event: ${event.title} (${event.uid})`);
      removedEvents.push({
        uid: event.uid,
        title: event.title,
        eventTime: new Date(eventTime).toISOString(),
      });
    } else {
      // Retain all other events
      retainedEvents.push(event);
    }
  }

  return { retainedEvents, removedEvents };
}
```

### validateHiddenFutureEvents Implementation

```javascript
async function validateHiddenFutureEvents(events, bucket) {
  const now = Date.now();
  const inconsistencies = [];

  for (const event of events ?? []) {
    if (!event) continue;

    const isHidden = isEventHidden(event);
    const eventTime = event.start?.epochMillis;
    const isFutureEvent = typeof eventTime === 'number' 
      && !Number.isNaN(eventTime) 
      && eventTime > now;

    // Only validate hidden future events
    if (!isHidden || !isFutureEvent) continue;

    const eventTitle = event.title ?? event.summary ?? null;
    if (!eventTitle) continue;

    try {
      const titleHex = titleToHex(eventTitle);
      const hexKey = buildHexStorageKey(eventTitle);
      const hexData = await getJsonFromS3(bucket, hexKey, `hex:${eventTitle}`);

      if (hexData) {
        // HEX file exists, check if hidden status matches
        const hexIsHidden = isEventHidden(hexData);
        if (!hexIsHidden) {
          // Inconsistency found
          console.log(
            `[Hidden Validation] Inconsistency found for ${eventTitle}: ` +
            `agenda hidden=true, hex hidden=false`
          );
          
          inconsistencies.push({
            uid: event.uid,
            title: eventTitle,
            agendaHidden: true,
            hexHidden: false,
            action: 'agenda_takes_precedence',
          });
          
          // Update HEX to match agenda
          hexData.status = 'hidden';
          hexData.hiddenAt = new Date().toISOString();
          await putJsonToS3(bucket, hexKey, hexData, `hex:${eventTitle}`, true);
          
          console.log(
            `[Hidden Validation] Updated HEX file to match agenda ` +
            `hidden status for ${eventTitle}`
          );
        }
      }
    } catch (error) {
      console.warn(`[Hidden Validation] Error validating hidden event ${eventTitle}:`, 
                   error.message);
    }
  }

  return inconsistencies;
}
```

## Example 4: Integration in Handler

```javascript
// After image verification and repair

logImageDiagnostics('Final agenda before storage', enrichedAgenda);

// Verify and repair images
const { repairedEvents: verifiedAgenda, brokenImages } = 
  await verifyAndRepairEventImages(enrichedAgenda, bucket);

// [NEW] Clean up hidden past events
console.log('[Hidden Events] Starting hidden event cleanup and validation...');
const { retainedEvents: cleanedAgenda, removedEvents: hiddenPastEvents } = 
  await cleanupHiddenPastEvents(verifiedAgenda);

if (hiddenPastEvents.length > 0) {
  console.log(`[Hidden Events] Removed ${hiddenPastEvents.length} hidden past events`);
}

// [NEW] Validate hidden future events
const hiddenInconsistencies = await validateHiddenFutureEvents(cleanedAgenda, bucket);

if (hiddenInconsistencies.length > 0) {
  console.log(
    `[Hidden Events] Found and fixed ${hiddenInconsistencies.length} inconsistencies`
  );
}

// Save cleaned agenda (without past hidden events)
const trimmedAgenda = cleanedAgenda.map(prepareEventForStorage);
await putJsonToS3(bucket, agendaKey, agendaPayload, 'agenda');
```

## Example 5: Response Structure

### Response with Both Cleanup and Validation

```json
{
  "status": "ok",
  "eventsCount": 39,
  "generatedAt": "2025-10-17T10:30:00.000Z",
  
  "hiddenEvents": {
    "cleanupCount": 3,
    "removedPastHiddenEvents": [
      {
        "uid": "past-hidden-1",
        "title": "Old Hidden Event",
        "eventTime": "2025-01-15T10:00:00.000Z"
      },
      {
        "uid": "past-hidden-2",
        "title": "Another Old Hidden Event",
        "eventTime": "2025-02-01T14:30:00.000Z"
      },
      {
        "uid": "past-hidden-3",
        "title": "Yet Another Hidden Event",
        "eventTime": "2025-03-10T09:15:00.000Z"
      }
    ],
    "inconsistenciesFixed": 2,
    "inconsistencyDetails": [
      {
        "uid": "future-hidden-1",
        "title": "Upcoming Hidden Event",
        "agendaHidden": true,
        "hexHidden": false,
        "action": "agenda_takes_precedence"
      },
      {
        "uid": "future-hidden-2",
        "title": "Another Future Hidden Event",
        "agendaHidden": true,
        "hexHidden": false,
        "action": "agenda_takes_precedence"
      }
    ]
  },
  
  "imageRepair": { ... },
  "processedEvents": [ ... ]
}
```

### Response with No Changes

```json
{
  "status": "ok",
  "eventsCount": 42,
  "generatedAt": "2025-10-17T10:30:00.000Z"
  
  // hiddenEvents not present (no cleanup or fixes needed)
}
```

## Example 6: Error Handling

### If Cleanup Fails

```javascript
try {
  const { retainedEvents, removedEvents } = await cleanupHiddenPastEvents(agenda);
  console.log(`Cleaned up ${removedEvents.length} past hidden events`);
} catch (error) {
  // Log warning but don't fail
  console.warn('[Hidden Events] Cleanup failed:', error.message);
  // Continue with unfiltered agenda
}
```

### If Validation Fails for One Event

```javascript
for (const event of hiddenFutureEvents) {
  try {
    const hexData = await getJsonFromS3(bucket, hexKey, label);
    // ... validation logic
  } catch (error) {
    // Log warning for this specific event but continue with others
    console.warn(`[Hidden Validation] Error for ${event.title}:`, error.message);
    // Other events continue processing
  }
}
```

## Example 7: Hidden Event Detection

### Various Ways to Mark as Hidden

```javascript
// Method 1: Boolean field
{ "hidden": true }

// Method 2: String representation
{ "hidden": "true" }
{ "hidden": "1" }
{ "hidden": "yes" }

// Method 3: Timestamp field
{ "hiddenAt": "2025-10-17T10:30:00Z" }

// Method 4: Status field
{ "status": "hidden" }

// Method 5: Boolean status
{ "status": true }
```

All are detected by `isEventHidden()`:

```javascript
function isEventHidden(candidate) {
  if (typeof candidate.hidden === 'boolean' && candidate.hidden) return true;
  if (typeof candidate.hidden === 'string') {
    const text = candidate.hidden.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return true;
  }
  if (candidate.hiddenAt) return true;
  if (typeof candidate.status === 'string' 
      && candidate.status.trim().toLowerCase() === 'hidden') return true;
  if (candidate.status === true) return true;
  return false;
}
```

## Example 8: Time-Based Filtering

### How Past vs Future Determination Works

```javascript
const now = Date.now(); // Current time in milliseconds

for (const event of events) {
  const eventTime = event.start?.epochMillis;
  
  if (!eventTime || Number.isNaN(eventTime)) {
    // No valid time - skip this event
    continue;
  }
  
  if (eventTime <= now) {
    // Event time is now or before = PAST
    console.log('This is a PAST event');
  } else if (eventTime > now) {
    // Event time is after now = FUTURE
    console.log('This is a FUTURE event');
  }
}

// Example:
// now = 1729169400000 (2025-10-17T10:30:00Z)
// 
// Event 1: epochMillis = 1705329600000 (2025-01-15T10:00:00Z)
//   → 1705329600000 < 1729169400000 → PAST
// 
// Event 2: epochMillis = 1766265600000 (2025-12-20T10:00:00Z)
//   → 1766265600000 > 1729169400000 → FUTURE
```

## Example 9: S3 Key Lookup

### How HEX Files Are Located

```javascript
// Given event title: "Camp Fire and Sparklers"

// Step 1: Create hex from title
titleHex = titleToHex("Camp Fire and Sparklers");
// Result: "63616d7020666972652..."

// Step 2: Build S3 key
hexKey = buildHexStorageKey("Camp Fire and Sparklers");
// Result: "events/63616d7020666972652e6a736f6e"

// Step 3: Read from S3
hexData = await getJsonFromS3(bucket, hexKey, label);
// Reads s3://bucket/events/63616d7020666972652e6a736f6e.json

// Step 4: Update if needed
await putJsonToS3(bucket, hexKey, hexData, label);
// Writes back to s3://bucket/events/63616d7020666972652e6a736f6e.json
```

## Example 10: Logging Timeline

```
10:30:00.000 [Hidden Events] Starting hidden event cleanup and validation...
10:30:00.100 [Hidden Cleanup] Removing hidden past event: Old Event 1 (uid1)
10:30:00.150 [Hidden Cleanup] Removing hidden past event: Old Event 2 (uid2)
10:30:00.200 [Hidden Events] Removed 2 hidden past events from agenda
10:30:00.300 [Hidden Validation] Inconsistency found for Future Event A: agenda hidden=true, hex hidden=false
10:30:00.350 [Hidden Validation] Updated HEX file to match agenda hidden status for Future Event A
10:30:00.450 [Hidden Events] Found and fixed 1 inconsistencies in hidden future events
10:30:00.500 Agenda saved successfully
```
