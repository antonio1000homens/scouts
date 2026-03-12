# Approval Request Fix Summary

## Problem
Approval requests from the admin website were not being processed by the scouts.mjs lambda.

## Root Cause
**Line 3179** in `scouts.mjs` only checked for actions starting with `'persist'`:
```javascript
commandActionToken.startsWith('persist')
```

But the admin website sends:
```javascript
{
  realm: 'scouts',
  action: 'approve',  // ← Does NOT start with 'persist'
  subject: { hexId: '...', isApproved: true }
}
```

## Solution
Updated the condition to also accept `'approve'`:
```javascript
(commandActionToken.startsWith('persist') || commandActionToken === 'approve')
```

## Files Changed
- `/Users/antoniofreire/storage/github/lambdas/scouts/function/scouts.mjs` (line 3179)

## Next Steps
1. **Deploy** the updated lambda to AWS
2. **Test** by sending an approval request from the admin UI
3. **Verify** in CloudWatch logs:
   - Look for `[AdminPersist:isApproved]` log entries
   - Confirm SQS message is queued
4. **Check** that the event's approval status updates in `agenda.json`

## CloudWatch Log Commands
```bash
# Watch logs in real-time
aws logs tail /aws/lambda/scouts --follow --region eu-west-2

# Search for approval logs
aws logs filter-pattern /aws/lambda/scouts \
  --filter-pattern "AdminPersist" \
  --start-time $(date -u -d '10 minutes ago' +%s)000 \
  --region eu-west-2
```

## Expected Flow After Fix
1. Admin UI sends: `realm: 'scouts'`, `action: 'approve'`
2. Lambda detects: `isMetadataPersistCommand = true`
3. Lambda validates: `hexId` present, `isApproved: true`
4. Lambda queues to SQS: `realm: 'persist'`, `action: 'persist'`
5. SQS consumer processes and updates HEX file
6. Agenda.json gets updated with approval status
