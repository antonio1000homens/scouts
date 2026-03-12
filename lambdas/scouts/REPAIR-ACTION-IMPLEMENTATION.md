# Repair Action Implementation Summary

## Overview
Implemented "repair" action functionality for handling broken images in the event enrichment pipeline. The repair action works identically to new/retry actions but is specifically triggered when image verification detects broken image URLs.

## Changes Made

### 1. scouts2sqs.mjs - Accept Repair Action
**File**: `/home/windsor/github/lambdas/scouts/sqs/scouts2sqs/function/scouts2sqs.mjs`

**Line 1475**: Updated condition to accept 'repair' action
```javascript
// Before
if (rawRealm === 'scoutsRequest' && (rawAction === 'retry' || rawAction === 'new')) {

// After
if (rawRealm === 'scoutsRequest' && (rawAction === 'retry' || rawAction === 'new' || rawAction === 'repair')) {
```

**Behavior**: 
- scouts2sqs now accepts messages with action 'repair'
- The existing logic (lines 1487-1502) already ignores the action and focuses only on missing fields:
  - `!rawSubject.AI` → routes to 'AI' realm
  - `!rawSubject.image?.prompt` → routes to 'imagePrompt' realm
  - `!rawSubject.image?.url` → routes to 'pixabay' realm
- This means repair messages are processed the same way as new/retry, determining the target realm based on what's missing

### 2. scouts.mjs - Send Repair Notifications
**File**: `/home/windsor/github/lambdas/scouts/function/scouts.mjs`

#### 2a. Updated notifyImageRepair Function (Lines 1443-1453)
```javascript
// Before
async function notifyImageRepair(event, brokenImageUrl) {
  const payload = {
    realm: 'scouts',
    subject: 'image',
    action: 'repair',
    details: {
      uid: event.uid,
      title: event.title,
      brokenImageUrl,
      removedAt: new Date().toISOString(),
    },
  };
  await postToScoutsRequestsQueue(payload, 'Image Repair');
}

// After
async function notifyImageRepair(hexData) {
  const payload = {
    realm: 'scoutsRequest',
    subject: hexData,
    action: 'repair',
  };
  await postToScoutsRequestsQueue(payload, 'Image Repair');
}
```

**Changes**:
- Changed realm from 'scouts' to 'scoutsRequest' (matches new/retry pattern)
- Changed subject from 'image' to hex data (matches new/retry pattern)
- Removed details object (not needed, hex data contains all required info)
- Simplified function signature to accept only hex data

#### 2b. Updated Agenda Image Repair Call (Lines 2345-2361)
```javascript
// Before
for (const brokenImage of brokenImages) {
  try {
    await notifyImageRepair(brokenImage, brokenImage.imageUrl);
    repairNotificationsSent += 1;
  } catch (notifyError) {
    console.warn(`[Image Repair] Failed to notify about broken image for ${brokenImage.title}:`, notifyError.message);
  }
}

// After
for (const brokenImage of brokenImages) {
  try {
    // Load hex file data for the broken image event
    const hexKey = buildHexStorageKey(brokenImage.title);
    const hexData = await getJsonFromS3(bucket, hexKey, `hex:${brokenImage.title}`);
    
    if (hexData) {
      await notifyImageRepair(hexData);
      repairNotificationsSent += 1;
    } else {
      console.warn(`[Image Repair] Could not load hex data for ${brokenImage.title}`);
    }
  } catch (notifyError) {
    console.warn(`[Image Repair] Failed to notify about broken image for ${brokenImage.title}:`, notifyError.message);
  }
}
```

**Changes**:
- Added hex file loading before calling notifyImageRepair
- Pass complete hex data instead of broken image metadata
- Added error handling for missing hex files

#### 2c. Updated HEX File Image Repair Call (Lines 2449-2461)
```javascript
// Before
// Send repair notification
await notifyImageRepair(
  { uid: key, title: hexData.title, section: 'unknown' },
  hexData.image.url
);

// After
// Send repair notification with repaired hex data
await notifyImageRepair(repairedHex);
```

**Changes**:
- Pass `repairedHex` (hex data with broken image URL removed) instead of event metadata
- This ensures the repair notification contains the current state of the hex file

## Message Flow

### Repair Action Workflow
1. **Image Verification** (scouts.mjs)
   - `verifyAndRepairEventImages()` checks agenda event images
   - `verifyAndRepairHexFile()` checks HEX file images
   - Detects broken image URLs (images that don't exist in S3)

2. **Repair Notification** (scouts.mjs)
   - Loads complete hex data for broken image events
   - Sends message to scoutsRequests queue:
     ```javascript
     {
       realm: 'scoutsRequest',
       subject: hexData,  // Complete hex file data
       action: 'repair'
     }
     ```

3. **Routing** (scouts2sqs.mjs)
   - Receives repair message from scoutsRequests queue
   - Ignores action type, focuses on missing fields in hex data
   - Determines target realm based on what's missing:
     - No AI → realm: 'AI'
     - No image.prompt → realm: 'imagePrompt'  
     - No image.url → realm: 'pixabay'
   - Sends to scoutsProcessing queue with appropriate realm

4. **Processing** (sqs2scouts.mjs)
   - Processes the AI/imagePrompt/pixabay request
   - Generates missing content
   - Persists updated hex file
   - Sends notification back to scoutsDecision queue

## Key Principles

1. **Action Independence**: scouts2sqs ignores whether the action is 'new', 'retry', or 'repair' - it only looks at what fields are missing in the hex data

2. **Consistency**: Repair messages follow the exact same structure as new/retry messages:
   - Same realm: 'scoutsRequest'
   - Same subject format: hex data object
   - Only difference: action label ('repair' vs 'new'/'retry')

3. **Smart Routing**: The system automatically determines what needs to be generated (AI, prompt, or image) based on the current state of the hex data

## Testing Scenarios

### Scenario 1: Broken Image with Complete AI/Prompt
- Hex data has AI and image.prompt but image.url is null
- scouts2sqs routes to 'pixabay' realm
- sqs2scouts generates new image URL from existing prompt

### Scenario 2: Broken Image with Missing Prompt
- Hex data has AI but image.prompt and image.url are null
- scouts2sqs routes to 'imagePrompt' realm
- sqs2scouts generates new prompt, then continues to pixabay

### Scenario 3: Broken Image with Missing AI
- Hex data has no AI, image.prompt, or image.url
- scouts2sqs routes to 'AI' realm
- sqs2scouts generates AI content, then continues through imagePrompt → pixabay

## Files Modified
1. `/home/windsor/github/lambdas/scouts/sqs/scouts2sqs/function/scouts2sqs.mjs`
   - Line 1475: Added 'repair' to action condition

2. `/home/windsor/github/lambdas/scouts/function/scouts.mjs`
   - Lines 1443-1453: Rewrote notifyImageRepair function
   - Lines 2345-2361: Updated agenda image repair loop
   - Lines 2449-2461: Updated HEX file repair notification

## Impact
- No breaking changes to existing functionality
- New 'repair' action seamlessly integrates with existing new/retry logic
- Provides dedicated workflow for handling broken images while reusing existing enrichment pipeline
- Clear distinction between new events ('new'), failed enrichments ('retry'), and broken images ('repair')
