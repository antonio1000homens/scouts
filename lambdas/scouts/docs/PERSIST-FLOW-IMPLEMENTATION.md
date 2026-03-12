# Persist Flow Implementation

## Overview
This document describes the implementation of the persist flow for handling approval messages and hex file persistence.

## Changes Made

### 1. scouts2sqs Lambda Updates

**File**: `/lambdas/scouts/sqs/scouts2sqs/function/scouts2sqs.mjs`

- **Added approval realm handling**: When scouts2sqs receives a message with `realm: "approval"` and `action: "approve"`, it now:
  - Changes the realm to `"persist"`
  - Changes the action to `"persist"`
  - Forwards the message to the scoutsProcessing SQS queue

```javascript
} else if (rawRealm === 'approval' && rawAction === 'approve') {
    // Handle approval with approve action - change realm to persist and forward to scoutsProcessing queue
    console.log(`[approval] Processing approve action for:`, rawSubject.title || rawSubject.hex || 'unknown');
    
    const persistPayload = {
        realm: 'persist',
        subject: rawSubject,
        action: 'persist'
    };
    
    console.log(`[approval] Sending persist message to scoutsProcessing queue:`, JSON.stringify(persistPayload));
    await sendToSQS(persistPayload);
    console.log(`[approval] Approval processed - sent persist request`);
}
```

### 2. sqs2scouts Lambda Updates

**File**: `/lambdas/scouts/sqs/sqs2scouts/function/sqs2scouts.mjs`

#### Added S3 Write Capability
- **Import**: Added `PutObjectCommand` to S3 imports
- **Function**: Updated `saveHexEventToS3()` to actually save files to S3 instead of being a no-op

```javascript
async function saveHexEventToS3(hexValue, payload) {
    const trimmed = typeof hexValue === 'string' ? hexValue.trim() : '';
    if (!trimmed) {
        throw new Error('Cannot store HEX payload without identifier');
    }

    const key = `events/${trimmed}.json`;
    const bucket = TARGET_BUCKET;
    
    try {
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(payload, null, 2),
            ContentType: 'application/json',
        });
        
        await s3Client.send(command);
        console.log(`[Hex] Successfully saved HEX file to s3://${bucket}/${key}`);
    } catch (error) {
        console.error(`[Hex] Failed to save HEX file to s3://${bucket}/${key}:`, error.message);
        throw error;
    }
}
```

#### Added Persist Realm Support
- **Allowed realms**: Added `"persist"` to the allowed realms set
- **Persist handler**: Added logic to handle persist realm messages:
  - Extracts hex value from subject
  - Replaces hex file content with subject content
  - Sends Slack notification without UIDs

```javascript
// Handle persist realm - replace hex file content with subject
if (realm === 'persist') {
    console.log(`[persist] Processing persist action for subject:`, JSON.stringify(rawSubject));
    
    const event = ensureObjectSubject(rawSubject);
    const hexValue = event.hex;
    
    if (!hexValue) {
        throw new Error('Persist request missing hex identifier');
    }
    
    // Replace the hex file content with the subject content
    await saveHexEventToS3(hexValue, event);
    
    // Send Slack notification without UIDs
    const eventTitle = event.title || event.summary || event.name || 'Unknown Event';
    const notificationText = `Hex persisted for title "${eventTitle}"`;
    
    await postSlackMessage({
        text: notificationText,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `✅ ${notificationText}`
                }
            }
        ]
    });
    
    return {
        statusCode: 200,
        body: JSON.stringify({ message: `Hex file persisted for ${eventTitle}` })
    };
}
```

#### Removed UIDs from Slack Notifications
- **buildEventDetailsSection**: Always excludes `uid` and `originalUid` fields from Slack notifications
- **buildDecisionSummaryBlocks**: Added comment noting UIDs are intentionally excluded
- **buildSimpleMessage**: Explicitly excludes UID fields

```javascript
// Always exclude UID fields from Slack notifications
exclusionSet.add('uid');
exclusionSet.add('originalUid');
```

## Message Flow

### Before
```
scoutsRequest queue → scouts2sqs → (approval/approve) → scoutsProcessing queue → sqs2scouts → (not supported)
```

### After
```
scoutsRequest queue → scouts2sqs → (approval/approve) → (persist/persist) → scoutsProcessing queue → sqs2scouts → hex file replacement + Slack notification
```

## Testing

A test script was created (`test-persist-flow.js`) that verifies:
- ✅ scouts2sqs correctly transforms approval/approve to persist/persist
- ✅ sqs2scouts supports the persist realm
- ✅ Hex file replacement functionality works
- ✅ Slack notifications exclude UIDs
- ✅ All realms are properly allowed/blocked

## Usage

1. **Send approval message** to scoutsRequest queue:
   ```json
   {
     "realm": "approval",
     "action": "approve", 
     "subject": {
       "hex": "abc123",
       "title": "My Event",
       "AI": "Great event!",
       "image": {
         "prompt": "exciting scene",
         "url": "https://example.com/image.jpg"
       }
     }
   }
   ```

2. **scouts2sqs processes** and forwards to scoutsProcessing queue as:
   ```json
   {
     "realm": "persist",
     "action": "persist",
     "subject": { /* same subject content */ }
   }
   ```

3. **sqs2scouts receives** persist message and:
   - Saves subject content to `s3://bucket/events/abc123.json`
   - Sends Slack notification: "Hex persisted for title 'My Event'"
   - UIDs are excluded from the notification

## Security Notes

- UIDs are intentionally excluded from all Slack notifications to prevent exposure of internal identifiers
- The persist flow only works for messages with the exact realm/action combination
- All other realms continue to work as before