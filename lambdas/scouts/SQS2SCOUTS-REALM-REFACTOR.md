# Realm Refactoring: sqs2scouts to scouts Communication

## Overview
Refactored the communication between `sqs2scouts` and `scouts` Lambda functions via the `scoutsDecision` SQS queue. Changed the realm from `scouts`/`scoutsDecision` to `sqs2scouts` and updated action handling.

## Changes Summary

### 1. sqs2scouts.mjs Changes

#### Persist Notification (Line ~2465)
**Before:**
```javascript
const decisionPayload = {
    realm: 'scouts',
    action: 'persisted',
    subject: { hex: hexValue, title: eventTitle },
    source: 'sqs2scouts',
};
```

**After:**
```javascript
const decisionPayload = {
    realm: 'sqs2scouts',
    action: 'persisted',
    subject: { hex: hexValue, title: eventTitle },
    source: 'sqs2scouts',
};
```

#### Hidden Notification (Line ~2640) - NEW
**Added:**
```javascript
// Notify scoutsDecision queue that an event has been hidden
try {
    const decisionPayload = {
        realm: 'sqs2scouts',
        action: 'hidden',
        subject: {
            hex: event.hex,
            title: event.title,
            uid: event.uid,
        },
        source: 'sqs2scouts',
    };
    console.log('[Hide] Sending notification to scoutsDecision queue:', JSON.stringify(decisionPayload));
    await sendToScoutsDecisionQueue(decisionPayload);
} catch (queueErr) {
    console.warn('[Hide] Failed to notify scoutsDecision queue:', queueErr?.message || queueErr);
}
```

### 2. scouts.mjs Changes

#### A. Removed Approval Realm Logic (Lines ~1987-2075)
**Removed entire block:**
- Handled `realm: 'approval'` requests
- Merged approved changes into HEX files
- Forwarded confirmations to scoutsRequests queue

**Reason:** Approval logic no longer needed in scouts.mjs

#### B. Replaced scoutsDecision Realm with sqs2scouts (Lines ~2082-2170)

**Before:**
```javascript
if (structuredCommand && structuredCommand.realm === 'scoutsDecision') {
    // Single handler for checking completeness and updating agenda
}
```

**After:**
```javascript
if (structuredCommand && structuredCommand.realm === 'sqs2scouts') {
    const action = structuredCommand.action;
    
    if (action === 'persisted') {
        // Check completeness and update agenda
    } else if (action === 'hidden') {
        // Mark event as hidden in agenda
    } else {
        // Unsupported action
    }
}
```

## New Behavior

### When sqs2scouts sends "persisted" notification:
1. scouts.mjs receives message with `realm: 'sqs2scouts'` and `action: 'persisted'`
2. Loads HEX file from S3
3. Checks if event is complete (has AI, image.url, image.prompt)
4. If incomplete → sends to scoutsRequests queue for enrichment
5. If complete → updates agenda.json with AI and image data

### When sqs2scouts sends "hidden" notification:
1. scouts.mjs receives message with `realm: 'sqs2scouts'` and `action: 'hidden'`
2. Loads agenda.json
3. Finds matching event by hex or uid
4. Marks event as hidden with timestamp
5. Saves updated agenda.json

## Message Flow Diagram

### Persisted Flow:
```
sqs2scouts (persist realm) 
    → Saves HEX file to S3
    → Sends to scoutsDecision queue: { realm: 'sqs2scouts', action: 'persisted' }
    → scouts.mjs receives notification
    → Checks completeness
    → Updates agenda.json (if complete) OR sends to scoutsRequests (if incomplete)
```

### Hidden Flow:
```
sqs2scouts (persist realm, action 'hidden')
    → Saves HEX file with status=hidden (no extra hide realm)
    → Updates Slack message / confirmation
    → Sends to scoutsDecision queue: { realm: 'sqs2scouts', action: 'hidden' }
    → scouts.mjs receives notification
    → Marks event as hidden in agenda.json
```

## Benefits

1. **Clearer Ownership**: `sqs2scouts` realm clearly indicates the source
2. **Action-based Routing**: Different actions (`persisted`, `hidden`) handled separately
3. **Simplified Logic**: Removed unused approval realm from scouts.mjs
4. **Consistent Naming**: Realm name matches the Lambda function name

## Testing Recommendations

### Test Case 1: Persisted Event (Complete)
1. Send persist message to sqs2scouts with complete event data
2. Verify HEX file is saved to S3
3. Verify `sqs2scouts/persisted` notification sent to scoutsDecision queue
4. Verify scouts.mjs updates agenda.json with AI and image data

### Test Case 2: Persisted Event (Incomplete)
1. Send persist message to sqs2scouts with incomplete event data
2. Verify HEX file is saved to S3
3. Verify `sqs2scouts/persisted` notification sent to scoutsDecision queue
4. Verify scouts.mjs sends event to scoutsRequests queue for enrichment

### Test Case 3: Hidden Event
1. Send hidden message to sqs2scouts
2. Verify Slack message is updated
3. Verify `sqs2scouts/hidden` notification sent to scoutsDecision queue
4. Verify scouts.mjs marks event as hidden in agenda.json

## Deployment Notes

1. Deploy both functions together to avoid message processing errors
2. Update any documentation referencing `scoutsDecision` realm
3. Monitor CloudWatch logs for `[sqs2scouts]` prefix messages
4. Verify scoutsDecision queue metrics after deployment

## Date
October 17, 2025
