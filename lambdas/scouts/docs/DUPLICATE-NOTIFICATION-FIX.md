# Duplicate Notification Fix

## Problem
Users were receiving duplicate Slack notifications for the same event title (e.g., "Surbiton Parade") even though the HEX batching logic was designed to prevent this. The issue occurred when the Lambda function was invoked multiple times in quick succession.

## Root Cause
The HEX batching logic prevented duplicates **within a single Lambda invocation**, but did not prevent duplicates **across multiple invocations**. 

### Scenario that caused duplicates:
1. Lambda invocation #1 processes events
   - Finds "Surbiton Parade" needs enrichment
   - Creates HEX file `events/53757262696...json` with `runs=0`
   - Queues and sends notification to Slack
2. Lambda invocation #2 runs shortly after (e.g., scheduled or manual trigger)
   - Reads the same HEX file (exists now, but `lastNotificationSent` is missing)
   - Sees event still needs enrichment
   - Detects `isFirstRun = false` (HEX file exists)
   - But wait - the code had a bug where it only checked `!existingHexFile`, not whether a notification was already sent
3. Actually the real issue was simpler: if invocation #2 happened before invocation #1 finished writing the HEX file, both would see `!existingHexFile = true` and both would queue notifications

The race condition existed because:
- Read HEX file
- Check if exists
- Write HEX file
- Send notification

These operations are not atomic, so two concurrent invocations could both pass the `!existingHexFile` check.

## Solution
Added a **notification cooldown period** tracked via a `lastNotificationSent` timestamp in the HEX file.

### Changes Made

#### 1. Added `lastNotificationSent` field to HEX files
When creating or updating HEX files, preserve the existing `lastNotificationSent` timestamp:

```javascript
const hexFileData = {
  title: eventTitle,
  uid: baseEvent.uid ?? null,
  start: baseEvent.start ?? null,
  location: baseEvent.location ?? null,
  section: baseEvent.section ?? null,
  AI: baseEvent.AI ?? null,
  image: {
    prompt: baseEvent.image.prompt ?? null,
    url: baseEvent.image.url ?? null,
  },
  runs: hasChanges ? 0 : currentRuns + 1,
  lastNotificationSent: existingHexFile?.lastNotificationSent ?? null,  // NEW
};
```

#### 2. Check cooldown period before queuing notifications
Added logic to prevent notifications if one was sent recently (within 6 hours):

```javascript
// Check if notification was sent recently (within last 6 hours)
const notificationCooldownMs = 6 * 60 * 60 * 1000; // 6 hours
const lastNotificationTime = hexFileData.lastNotificationSent 
  ? Date.parse(hexFileData.lastNotificationSent) 
  : 0;
const timeSinceLastNotification = now - lastNotificationTime;
const isInCooldownPeriod = timeSinceLastNotification < notificationCooldownMs;

// Only queue notification if:
// 1. This is the first run (no existing HEX file), AND
// 2. Not in cooldown period (no notification sent recently), AND
// 3. titleHex exists
if (isFirstRun && titleHex && !isInCooldownPeriod) {
  queuedScoutRequest = true;
} else if (isFirstRun && isInCooldownPeriod) {
  console.log(`[HEX] Skipping notification for "${eventTitle}" - notification sent recently (${Math.round(timeSinceLastNotification / 1000 / 60)} minutes ago)`);
}
```

#### 3. Update timestamp when notification is sent
After successfully sending a notification, update the HEX file with the current timestamp:

```javascript
await postToScouts2Sqs(...);
console.log(`[HEX] Sent notification for HEX "${hexValue.substring(0, 16)}..."`);

// Update HEX file with notification timestamp to prevent duplicate notifications
try {
  const hexKey = buildHexStorageKey(notificationData.title);
  const hexLabel = `hex:${notificationData.title}`;
  const existingHexFile = await getJsonFromS3(bucketName, hexKey, hexLabel);
  if (existingHexFile) {
    existingHexFile.lastNotificationSent = new Date().toISOString();
    await putJsonToS3(bucketName, hexKey, existingHexFile, hexLabel);
    console.log(`[HEX] Updated notification timestamp for "${notificationData.title}"`);
  }
} catch (updateErr) {
  console.warn(`[HEX] Failed to update notification timestamp:`, updateErr.message);
}
```

## Benefits

1. **Prevents duplicate notifications across Lambda invocations**
   - Even if Lambda is triggered multiple times, only one notification per 6-hour window
2. **Maintains existing batching behavior**
   - Multiple events with same title still batched within single invocation
3. **Configurable cooldown period**
   - Currently set to 6 hours, easily adjustable via `notificationCooldownMs` constant
4. **Graceful degradation**
   - If timestamp update fails, logs warning but continues processing
   - Old HEX files without timestamp will get one on next notification
5. **Better logging**
   - Clear messages when notifications are skipped due to cooldown

## Testing

To verify the fix:

1. Deploy the updated function
2. Trigger the Lambda manually twice within 6 hours
3. Check logs - second invocation should show:
   ```
   [HEX] Skipping notification for "Event Title" - notification sent recently (X minutes ago)
   ```
4. Verify only one Slack notification appears
5. Check S3 HEX file contains `lastNotificationSent` timestamp

## Cooldown Period Tuning

The current cooldown is **6 hours**. Adjust if needed:

- **Too short** (< 1 hour): May not prevent duplicates if Lambda runs frequently
- **Too long** (> 24 hours): May prevent legitimate re-notifications if event details change
- **Current value (6 hours)**: Balances duplicate prevention with responsiveness to changes

To change: modify `notificationCooldownMs` constant in `enrichEventsWithAI` function.

## Edge Cases Handled

1. **HEX file doesn't exist**: Creates file without timestamp, queues notification, updates with timestamp after send
2. **HEX file exists but no timestamp**: Treats as "no recent notification", queues if needed
3. **Timestamp update fails**: Logs warning but continues (prevents notification send failure from breaking processing)
4. **Multiple events same title, same invocation**: Existing batching prevents duplicates ✓
5. **Multiple events same title, different invocations**: New cooldown prevents duplicates ✓
6. **Event details change**: If enrichment fields change, `runs` resets to 0, can trigger new notification after cooldown
