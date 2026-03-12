# HEX Notification Batching

## Problem
Previously, when multiple events shared the same title (and thus the same HEX identifier), each event would trigger a separate notification. This led to multiple approval requests that would ultimately target the same `hex.json` file in S3.

For example, if you had:
- Event 1: "Swimming" (uid: swimming-2025-01-01)
- Event 2: "Swimming" (uid: swimming-2025-01-08)  
- Event 3: "Swimming" (uid: swimming-2025-01-15)

All three events would generate separate notifications even though they all update the same `events/537769696d6d696e67.json` file (HEX encoding of "Swimming").

## Solution
The notification logic has been updated to batch notifications per unique HEX identifier instead of per event.

### Changes in `scouts/function/scouts.mjs`

1. **Added HEX notification collection** (line 1161):
   ```javascript
   const hexNotifications = new Map(); // Map<hexValue, { realm, title, uid }>
   ```

2. **Replaced immediate notification sending with collection** (lines 1301-1314):
   - Instead of calling `postToScouts2Sqs` immediately when an event needs enrichment
   - The HEX and realm are stored in the `hexNotifications` Map
   - Duplicate HEXes are automatically prevented by the Map structure

3. **Added batch notification sending** (lines 1411-1429):
   - After all events are processed
   - One notification is sent per unique HEX identifier
   - Similar to the existing bump notification batching

## Benefits

1. **Fewer notifications**: Multiple events with the same title generate only one notification
2. **Less redundancy**: Approval actions don't need to be performed multiple times for the same content
3. **Simpler workflow**: Users see one approval request per unique event title instead of multiple
4. **Maintains compatibility**: The notification payload structure remains unchanged
5. **Better logging**: Clear messages indicate when duplicates are skipped

## Example

### Before
```
[HEX] Sent scouts2sqs notification for "Swimming" (realm: AI)
[HEX] Sent scouts2sqs notification for "Swimming" (realm: AI)
[HEX] Sent scouts2sqs notification for "Swimming" (realm: AI)
```
Result: 3 separate Slack notifications for approval

### After
```
[HEX] Queued notification for HEX "537769696d6d696e67..." (realm: AI, title: "Swimming")
[HEX] Notification already queued for HEX "537769696d6d696e67..." (title: "Swimming"), skipping duplicate
[HEX] Notification already queued for HEX "537769696d6d696e67..." (title: "Swimming"), skipping duplicate
[HEX] Sending 1 batched notification(s) for unique HEX identifiers
[HEX] Sent notification for HEX "537769696d6d696e67..." (realm: AI, title: "Swimming")
```
Result: 1 Slack notification for approval, updating the shared hex.json file

## Testing

A new test file `test-hex-batching.mjs` validates the batching logic:
- Multiple events with the same title batch to a single notification
- Events with different titles create separate notifications
- Notification payload structure remains correct

Run tests with:
```bash
npm test
```
