# Hidden Events Cleanup - Quick Reference

## What It Does

When scouts.mjs refreshes calendars:

1. **Removes past hidden events** from `agenda.json` automatically
2. **Fixes inconsistencies** in hidden future events between `agenda.json` and HEX files

## Why

- **Cleanup**: Keep agenda.json lean by removing old hidden events
- **Consistency**: Ensure hidden future events stay hidden everywhere
- **Audit**: Track what was hidden and when

## Key Functions

### `cleanupHiddenPastEvents(events)`
```javascript
Input: Array of agenda events
Output: { retainedEvents, removedEvents }

Does:
  - Finds all hidden events that are in the past
  - Removes them from agenda
  - Returns list of removed events
```

### `validateHiddenFutureEvents(events, bucket)`
```javascript
Input: Array of agenda events, S3 bucket
Output: Array of inconsistencies found & fixed

Does:
  - Finds all hidden events in the future
  - Checks their HEX files in S3
  - If HEX says not hidden, updates it to match agenda
  - Returns list of fixed inconsistencies
```

## Hidden Event Definition

An event is considered hidden if ANY of these are true:

```javascript
event.hidden === true
event.hidden === "true" || "1" || "yes"
event.hiddenAt !== undefined && event.hiddenAt !== null
event.status === "hidden"
event.status === true
```

## Response Example

```json
{
  "status": "ok",
  
  "hiddenEvents": {
    "cleanupCount": 3,
    "removedPastHiddenEvents": [
      {
        "uid": "event-1",
        "title": "Old Hidden Event",
        "eventTime": "2025-01-15T10:00:00.000Z"
      }
    ],
    "inconsistenciesFixed": 1,
    "inconsistencyDetails": [
      {
        "uid": "event-2",
        "title": "Future Hidden Event",
        "agendaHidden": true,
        "hexHidden": false,
        "action": "agenda_takes_precedence"
      }
    ]
  }
}
```

## Data Flow

```
Enriched Agenda
  ↓
Clean up hidden past events
  ├─ Past hidden → REMOVE
  ├─ Future hidden → KEEP
  └─ All others → KEEP
  ↓
Validate hidden future events
  ├─ Read HEX file
  ├─ If inconsistent → FIX HEX
  ├─ If consistent → OK
  └─ If no HEX → OK (nothing to validate)
  ↓
Save cleaned agenda.json
```

## What Gets Changed

### agenda.json
```
REMOVED: All hidden events with past start time
UNCHANGED: All future hidden events
UNCHANGED: All visible events (hidden=false)
```

### HEX Files (events/*.json)
```
UPDATED: If marked not hidden but agenda says hidden
UNCHANGED: If already marked hidden
UNCHANGED: If agenda says visible
```

## Logs You'll See

```
[Hidden Events] Starting hidden event cleanup and validation...
[Hidden Cleanup] Removing hidden past event: Event Title (uid123)
[Hidden Events] Removed 2 hidden past events from agenda
[Hidden Validation] Inconsistency found for Future Event: agenda hidden=true, hex hidden=false
[Hidden Validation] Updated HEX file to match agenda hidden status for Future Event
[Hidden Events] Found and fixed 1 inconsistencies in hidden future events
```

## Common Scenarios

### Scenario 1: Past hidden event exists
**What happens**:
- Event removed from agenda.json
- Response includes it in `removedPastHiddenEvents`
- HEX file deleted (if it's also orphaned)

### Scenario 2: Future hidden event is inconsistent
**What happens**:
- Event stays in agenda.json
- HEX file updated to match agenda's hidden status
- Response includes it in `inconsistencyDetails`

### Scenario 3: Hidden event becomes past
**What happens**:
- Next time Lambda runs, it's removed
- Not removed immediately (only on next refresh)
- May need manual trigger to remove sooner

### Scenario 4: Hidden event expires (moves to past)
**Status before**: Future hidden event in both agenda.json and HEX
**Status after**: Removed from agenda.json on next refresh
**Status of HEX**: May be deleted as orphaned

## Performance

- **Time**: <100ms added per run
- **Cost**: Minimal (only HEX reads/writes for hidden events)
- **Space**: Agenda.json gets smaller as past hidden events removed

## Configuration

**None required** - uses existing settings.

## Backwards Compatible

✅ **Yes** - fully backwards compatible
- Hidden events work as before
- Only cleanup/validation is added
- No breaking changes
- Response extended only (not modified)

## Troubleshooting

### Inconsistencies not being fixed
1. Check CloudWatch logs for `[Hidden Validation]` messages
2. Verify HEX file exists in S3 under `events/` prefix
3. Verify agenda event has correct hidden field
4. Check IAM permissions for S3 read/write

### Past hidden events not being removed
1. Check if event start time is really in the past
2. Verify hidden field is set correctly
3. Check CloudWatch logs for `[Hidden Cleanup]` messages
4. May need to trigger Lambda manually (not on schedule)

### Wrong events marked as hidden
1. Check the hidden field values
2. Verify function `isEventHidden()` logic
3. Check for typos in hidden field ("hidde" vs "hidden")

## Next Steps

1. Deploy updated scouts.mjs
2. Monitor first run in CloudWatch
3. Verify response includes hiddenEvents section
4. Check S3 agenda.json is smaller
5. Verify HEX files are updated where needed
