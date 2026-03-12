# Hidden Events Cleanup & Validation Feature

## Overview

When the calendar cache expires and scouts.mjs fetches new calendars, it now:

1. **Cleans up hidden past events** - Removes all hidden events that are in the past from `agenda.json`
2. **Validates hidden future events** - Ensures hidden events marked in the future are consistent between `agenda.json` and their HEX files

## Features

### 1. Hidden Past Events Cleanup

**Function**: `cleanupHiddenPastEvents(events)`

- Scans all events in the enriched agenda
- Identifies events marked as hidden with a start time in the past
- Removes them from the agenda before saving to S3
- Returns list of removed events for reporting

**Criteria for removal**:
- Event is marked hidden (`hidden: true`, `status: "hidden"`, or `hiddenAt` is set)
- Event start time is in the past (current time >= event start time)

**What happens**:
- Event is completely removed from `agenda.json`
- Event details are logged for debugging
- Removed events are reported in the Lambda response

**Example**:
```javascript
Before:
{
  "events": [
    { "uid": "past-hidden", "title": "Old Hidden Event", "hidden": true, "start": "2025-01-01" },
    { "uid": "future-hidden", "title": "Upcoming Hidden Event", "hidden": true, "start": "2025-12-01" },
    { "uid": "public", "title": "Public Event", "hidden": false, "start": "2025-12-01" }
  ]
}

After cleanup:
{
  "events": [
    { "uid": "future-hidden", "title": "Upcoming Hidden Event", "hidden": true, "start": "2025-12-01" },
    { "uid": "public", "title": "Public Event", "hidden": false, "start": "2025-12-01" }
  ]
}
// "past-hidden" is REMOVED
```

### 2. Hidden Future Events Validation

**Function**: `validateHiddenFutureEvents(events, bucket)`

- Scans all hidden future events in the agenda
- For each event, loads the corresponding HEX file from S3
- Checks if the hidden status matches between agenda and HEX file
- If inconsistent, updates the HEX file to match the agenda

**Consistency Check**:
```
If agenda says: hidden=true
And HEX file says: hidden=false (or no hidden field)
  → Update HEX file: hidden=true, status="hidden"
  → Log the inconsistency
  → Report in response
```

**What happens**:
- Both files are kept (no removal for future events)
- HEX file is updated to match agenda hidden status
- Agenda takes precedence for hidden status
- Inconsistencies are logged and reported

**Example**:
```javascript
Agenda event:
{
  "uid": "future-hidden",
  "title": "Upcoming Hidden Event",
  "hidden": true,
  "start": "2025-12-01T10:00:00Z"
}

HEX file (inconsistent):
{
  "title": "Upcoming Hidden Event",
  "hidden": false  // ← Conflict!
}

After validation:
{
  "title": "Upcoming Hidden Event",
  "hidden": true,     // ← FIXED
  "status": "hidden", // ← FIXED
  "hiddenAt": "2025-10-17T10:30:00Z" // ← Added
}
```

## Processing Flow

```
Fetch & Parse Calendars
  ↓
Merge with Existing Agenda
  ↓
Enrich with AI
  ↓
Verify & Repair Images
  ↓
[NEW] Clean up hidden past events ← Remove past hidden events from agenda
  ↓
[NEW] Validate hidden future events ← Fix HEX inconsistencies, keep in agenda
  ↓
Save agenda.json (without past hidden events)
  ↓
Cleanup orphaned HEX files
  ↓
Verify & Repair HEX file images
  ↓
Generate Response (with hidden events details)
```

## Response Structure

When hidden events are cleaned up or inconsistencies are found, the response includes:

```json
{
  "status": "ok",
  "eventsCount": 42,
  
  "hiddenEvents": {
    "cleanupCount": 3,
    "removedPastHiddenEvents": [
      {
        "uid": "event-123",
        "title": "Old Hidden Event",
        "eventTime": "2025-01-15T10:00:00.000Z"
      },
      {
        "uid": "event-456",
        "title": "Cancelled Hidden Event",
        "eventTime": "2025-02-01T14:30:00.000Z"
      }
    ],
    "inconsistenciesFixed": 2,
    "inconsistencyDetails": [
      {
        "uid": "event-789",
        "title": "Future Hidden Event",
        "agendaHidden": true,
        "hexHidden": false,
        "action": "agenda_takes_precedence"
      },
      {
        "uid": "event-999",
        "title": "Another Future Hidden Event",
        "agendaHidden": true,
        "hexHidden": false,
        "action": "agenda_takes_precedence"
      }
    ]
  }
}
```

## Log Messages

You'll see these log messages during processing:

```
[Hidden Events] Starting hidden event cleanup and validation...
[Hidden Cleanup] Removing hidden past event: Old Event (uid123)
[Hidden Cleanup] Removing hidden past event: Another Event (uid456)
[Hidden Events] Removed 2 hidden past events from agenda
[Hidden Validation] Inconsistency found for Future Event: agenda hidden=true, hex hidden=false
[Hidden Validation] Updated HEX file to match agenda hidden status for Future Event
[Hidden Events] Found and fixed 1 inconsistencies in hidden future events
```

## How Hidden Status is Determined

The `isEventHidden()` function checks for these fields:

```javascript
// Event is considered hidden if any of these are true:

1. hidden: true                    // Boolean field
2. hidden: "true"|"1"|"yes"        // String field
3. hiddenAt: <any value>           // Timestamp when hidden
4. status: "hidden"                // Status field
5. status: true                    // Boolean status

// If none are set, event is NOT hidden
```

## S3 Updates

### agenda.json
- **Before**: Contains all events (past, hidden, future)
- **After**: Removed all past hidden events
- **Effect**: Smaller agenda.json file over time
- **Preserves**: All hidden future events (for reference)

### events/*.json (HEX files)
- **Before**: May have hidden=false while agenda has hidden=true
- **After**: Hidden status synchronized with agenda
- **Effect**: Future hidden events are marked in both places
- **Preserves**: Other event data (AI, images, etc.)

## Use Cases

### Use Case 1: Automatic Cleanup
**Scenario**: Old hidden events accumulate in agenda.json over time

**Solution**: 
- Past hidden events automatically removed on next calendar refresh
- agenda.json stays lean and performant
- No manual cleanup needed

### Use Case 2: Prevent Reappearance
**Scenario**: A hidden future event becomes visible in HEX file

**Solution**:
- Validation detects the inconsistency
- HEX file is updated to match agenda's hidden status
- Event stays hidden as intended

### Use Case 3: Audit Trail
**Scenario**: Need to know what events were hidden and removed

**Solution**:
- Response includes all removed past hidden events
- Response includes all fixed inconsistencies
- CloudWatch logs record exact timestamps
- Full audit trail available

## Technical Details

### Hidden Past Event Removal
```javascript
cleanupHiddenPastEvents(events)
  │
  ├─ FOR EACH event:
  │  ├─ isHidden = isEventHidden(event)
  │  ├─ eventTime = event.start.epochMillis
  │  ├─ isPastEvent = eventTime <= now
  │  │
  │  ├─ IF isHidden AND isPastEvent:
  │  │  ├─ ADD to removedEvents list
  │  │  ├─ LOG removal
  │  │  └─ DON'T include in retainedEvents
  │  │
  │  └─ ELSE:
  │     └─ ADD to retainedEvents
  │
  └─ RETURN { retainedEvents, removedEvents }
```

### Hidden Future Event Validation
```javascript
validateHiddenFutureEvents(events, bucket)
  │
  ├─ FOR EACH event:
  │  ├─ isHidden = isEventHidden(event)
  │  ├─ eventTime = event.start.epochMillis
  │  ├─ isFutureEvent = eventTime > now
  │  │
  │  ├─ IF isHidden AND isFutureEvent:
  │  │  ├─ titleHex = titleToHex(event.title)
  │  │  ├─ hexKey = buildHexStorageKey(event.title)
  │  │  ├─ hexData = getJsonFromS3(hexKey)
  │  │  │
  │  │  ├─ IF hexData exists:
  │  │  │  ├─ hexIsHidden = isEventHidden(hexData)
  │  │  │  │
  │  │  │  ├─ IF NOT hexIsHidden (inconsistency):
  │  │  │  │  ├─ hexData.status = "hidden"
  │  │  │  │  ├─ hexData.hiddenAt = now
  │  │  │  │  ├─ putJsonToS3(hexData)
  │  │  │  │  ├─ ADD to inconsistencies
  │  │  │  │  └─ LOG the fix
  │  │  │  │
  │  │  │  └─ ELSE: No problem, continue
  │  │  │
  │  │  └─ ELSE: No HEX file, nothing to validate
  │  │
  │  └─ ELSE: Skip (not hidden OR in past)
  │
  └─ RETURN inconsistencies
```

## Error Handling

### What if cleanup fails?
- Error is logged with warning level
- Processing continues (non-blocking)
- Past hidden events may remain in agenda
- No data loss occurs

### What if validation fails?
- Error is logged with warning level  
- Specific event validation skipped
- Other events continue processing
- Inconsistency not fixed for that event

### What if HEX update fails?
- Error is logged with warning level
- Event remains in response inconsistencies list
- Other HEX updates continue
- Agenda keeps hidden status (authoritative)

## Performance

- **Cleanup overhead**: O(n) where n = number of events
  - One pass through all events
  - No S3 calls for cleanup
  - Happens during normal processing

- **Validation overhead**: O(m) where m = number of hidden future events
  - One S3 read per hidden future event
  - One S3 write only if inconsistency found
  - Most events skip validation (not hidden or past)

- **Expected**: <100ms for typical agenda with ~50 events

## Backwards Compatibility

✅ **Fully backward compatible**
- Existing events unaffected if not hidden or past
- Hidden past events are just removed (cleanup)
- Hidden future events preserved and validated
- Response is extended (not modified)
- No breaking changes

## Configuration

No additional configuration required.

The feature uses existing:
- `isEventHidden()` function for hidden status
- `titleToHex()` for HEX file lookup
- `buildHexStorageKey()` for S3 key generation
- Event `start.epochMillis` for time comparison

## Testing

### Test 1: Past Hidden Event Removal
1. Create hidden event with past date
2. Save to agenda.json
3. Run Lambda
4. Verify event removed from agenda.json
5. Check response includes it in removedPastHiddenEvents

### Test 2: Future Hidden Event Preservation
1. Create hidden event with future date
2. Save to agenda.json
3. Run Lambda
4. Verify event still in agenda.json
5. Check response doesn't include it in removed list

### Test 3: Inconsistency Detection & Fix
1. Create hidden future event in agenda
2. Create HEX file with hidden=false
3. Run Lambda
4. Verify HEX file updated to hidden=true
5. Check response includes it in inconsistencyDetails

### Test 4: No Action Needed
1. Create hidden future event in agenda
2. Create matching HEX file with hidden=true
3. Run Lambda
4. Verify no changes
5. Check response has empty inconsistencyDetails

## Monitoring

Monitor these metrics in CloudWatch:

- `hiddenEvents.cleanupCount` - Number of past hidden events removed per run
- `hiddenEvents.inconsistenciesFixed` - Number of HEX file fixes per run
- Log entries for `[Hidden Cleanup]` and `[Hidden Validation]`

Expect to see:
- Small cleanup numbers (only when past hidden events exist)
- Larger inconsistency numbers (if HEX files get out of sync)

## Future Enhancements

Possible future improvements:
- Archive removed past hidden events to separate location
- Configurable hidden event retention period
- Automatic HEX file cleanup for deleted hidden events
- Hidden event expiration notification via SQS
