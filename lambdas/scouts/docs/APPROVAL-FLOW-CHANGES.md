# Approval Flow Changes

## Problem
Previously, when scouts2sqs processed AI/imagePrompt/imageUrl requests, it stored approval metadata in an `approvals/` directory. This created unnecessary storage overhead and complexity.

## Solution
Modified the approval flow to be more efficient:

### 1. AI/imagePrompt/imageUrl Requests (scouts2sqs)
- **Before**: Stored approval metadata in `approvals/` directory
- **After**: 
  - Extracts HEX identifier from subject
  - Loads existing data from S3 (`events/{HEX}.json`)
  - Sends notification using the loaded data with new field populated
  - **No approval metadata storage**

### 2. Approval Actions (sqs2scouts)
- **Before**: Updated approval metadata
- **After**: 
  - Directly replaces the existing `events/{HEX}.json` file in S3
  - Merges approved changes with existing data
  - Sends confirmation notification

## Code Changes

### scouts2sqs.mjs
1. **Simplified AI/imagePrompt/imageUrl requests**:
   ```javascript
   } else if (
       normalizedAction === 'request'
       && ['AI', 'imagePrompt', 'imageUrl'].includes(normalizedRealm)
   ) {
       // Just send to SQS - no approval folder lookups
       await sendToSQS(payload);
   ```

2. **Added processing modal replacement**:
   - When Slack buttons are clicked for AI/imagePrompt/imageUrl realms
   - Immediately replaces the message with "Processing..." status
   - No longer looks up approval metadata

3. **Fixed Slack interaction response**:
   - All Slack button clicks now return HTTP 200 immediately
   - Async operations (SQS, Slack updates) run in background
   - No more hanging Slack modals

4. **Removed approval folder dependencies**:
   - No calls to `loadApprovalMessageMetadata()` for AI realms
   - Simplified REJECT handling for AI realms
   - REJECT actions for AI realms show "Ignored" status and don't send to SQS

### sqs2scouts.mjs
1. **Added approval action handling**:
   ```javascript
   } else if ((realm === 'AI' || realm === 'imagePrompt' || realm === 'imageUrl') && action === 'approval') {
       // Replace existing HEX.json file
       const hexValue = event.hex;
       const existingHex = await loadHexEventFromS3(hexValue);
       const mergedEvent = { ...existingHex, ...event };
       await saveHexEventToS3(hexValue, mergedEvent);
   ```

2. **Removed approval metadata storage for requests**:
   - No longer calls `storeApprovalMessageReference()` for AI/imagePrompt/imageUrl requests

## Benefits
1. **Simplified storage**: No more approval metadata directory
2. **Direct updates**: Approval actions directly update the source HEX files
3. **Reduced complexity**: Fewer storage operations and lookups
4. **Better data consistency**: Single source of truth in HEX files
5. **Immediate feedback**: Users see "Processing..." status immediately
6. **No approval folder dependencies**: scouts2sqs no longer needs approval folder access
7. **Fixed Slack interactions**: Button clicks respond immediately, no more hanging modals

## Flow Diagram

### Before
```
AI/imagePrompt/imageUrl request → Store approval metadata → Send notification
Slack button click → Look up approval metadata → Send to SQS
Approval action → Update approval metadata → Update HEX file
```

### After
```
AI/imagePrompt/imageUrl request → Send to SQS only
Slack button click → Return 200 immediately → (async) Show "Processing..." → Send to SQS
Approval action → Update HEX file directly → Send confirmation
```

## Testing
Use the provided `test-approval-flow.js` script to verify the changes work correctly:

```bash
REQUIRED_API_KEY=your_api_key node test-approval-flow.js
```

---

## Update: Realm Consolidation (Latest)

### Changes
1. **Removed `imagePrompt` realm**: 
   - The `imagePrompt` realm has been consolidated into the `AI` realm
   - AI mode now generates both tagline and image prompt in a single API call
   - Events needing either tagline or image prompt now use `realm: 'AI'`

2. **Consolidated approval realms**:
   - `scoutRequest` and `scoutsRequest` have been merged into a single `scouts` realm
   - All approval flows now use `realm: 'scouts'`

### Current Realms
- `AI` - Request AI-generated tagline and/or image prompt (HEX string subject)
- `imageUrl` - Request Pixabay image URL lookup (HEX string subject)
- `scouts` - Approval/rejection of enriched content (JSON payload subject)

See `MESSAGE-FLOW.md` for current message flow documentation.