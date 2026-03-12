# Debugging Approval Requests in scouts.mjs Lambda

## Issue
Approval requests are being sent from the admin website but there's no evidence the lambda is processing them.

## Key Areas to Check

### 1. Request Schema Validation
The lambda expects approval requests with this structure:
```javascript
{
  realm: 'persist',
  subject: {
    hexId: '<hex-value>',
    isApproved: true
  },
  action: 'persist'
}
```

**Check:** Verify admin website sends `realm: 'persist'` (not 'scouts' or other values)

### 2. Lambda Entry Point
The lambda processes approval via the `isMetadataPersistCommand` path (line ~2850):
```javascript
const isMetadataPersistCommand = Boolean(
  structuredCommand
  && structuredCommand.realm === 'scouts'  // ⚠️ MISMATCH!
  && commandActionToken?.startsWith('persist')
  ...
)
```

**Problem Found:** The lambda checks for `realm === 'scouts'` but approval requests use `realm === 'persist'`

### 3. CloudWatch Logs to Check

Run these AWS CLI commands:

```bash
# Get recent lambda invocations
aws logs tail /aws/lambda/scouts --follow --region eu-west-2

# Search for approval-related logs
aws logs filter-pattern /aws/lambda/scouts \
  --filter-pattern "approval" \
  --start-time $(date -u -d '1 hour ago' +%s)000 \
  --region eu-west-2

# Search for persist realm
aws logs filter-pattern /aws/lambda/scouts \
  --filter-pattern "persist" \
  --start-time $(date -u -d '1 hour ago' +%s)000 \
  --region eu-west-2

# Check for 403 errors (API key issues)
aws logs filter-pattern /aws/lambda/scouts \
  --filter-pattern "403" \
  --start-time $(date -u -d '1 hour ago' +%s)000 \
  --region eu-west-2
```

### 4. Admin Website Request Format

Check `admin-script.js` around line 1000+ for the approval request code.
Look for functions that send approval requests to verify they match expected schema.

### 5. Quick Fixes

**Option A: Fix Lambda to Accept Both Realms**
```javascript
const isMetadataPersistCommand = Boolean(
  structuredCommand
  && (structuredCommand.realm === 'scouts' || structuredCommand.realm === 'persist')  // Accept both
  && commandActionToken?.startsWith('persist')
  ...
)
```

**Option B: Fix Admin Website**
Change admin website to send `realm: 'scouts'` instead of `realm: 'persist'`

## Testing Steps

1. **Enable verbose logging** in lambda (add console.log at entry):
```javascript
export async function lambdaHandler(event = {}) {
  console.log('[DEBUG] Full event:', JSON.stringify(event, null, 2));
  console.log('[DEBUG] Structured command:', structuredCommand);
  // ... rest of code
}
```

2. **Test with curl**:
```bash
curl -X POST https://YOUR_LAMBDA_URL \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "realm": "persist",
    "subject": {
      "hexId": "TEST_HEX_VALUE",
      "isApproved": true
    },
    "action": "persist"
  }'
```

3. **Check SQS queue** for queued messages:
```bash
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/243857182133/scoutsRequests \
  --attribute-names ApproximateNumberOfMessages \
  --region eu-west-2
```

## Root Cause Found

The lambda checks for `commandActionToken.startsWith('persist')` on line 3179, but the admin website sends `action: 'approve'`.

The string `'approve'` does NOT start with `'persist'`, so the condition fails and the approval request is never processed.

## Fix Applied

Updated line 3179 in scouts.mjs:

```javascript
// BEFORE:
commandActionToken.startsWith('persist')

// AFTER:
(commandActionToken.startsWith('persist') || commandActionToken === 'approve')
```

This allows the lambda to process both:
- `action: 'persist'` (generic persist operations)
- `action: 'approve'` (approval requests from admin UI)

## Testing

1. Deploy the updated lambda
2. Send an approval request from the admin UI
3. Check CloudWatch logs for:
   ```
   [AdminPersist:isApproved] ...
   ```
4. Verify the request is queued to SQS
5. Confirm the event's approval status updates in agenda.json
