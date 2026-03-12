# Queue Rename Summary: scouts → scoutsProcessing

## Overview
Renamed the SQS queue from "scouts" to "scoutsProcessing" to avoid confusion with the lambda function named "scouts".

## Files Updated

### Lambda Functions
- `sqs/scouts2sqs/function/scouts2sqs.mjs` - Updated SQS_QUEUE_URL constant
- `sqs/sqs2scouts/function/sqs2scouts.mjs` - No direct changes needed (reads from environment)

### Deployment Scripts
- `sqs/scouts2sqs/deploy.sh` - Updated IAM policy resource ARN
- `sqs/sqs2scouts/deploy.sh` - Updated SQS_QUEUE_ARN and IAM policy resource ARN

### Documentation
- `sqs/scouts2sqs/README.md` - Updated queue URL references
- `sqs/sqs2scouts/README.md` - Updated queue ARN references
- `MESSAGE-FLOW.md` - Updated queue reference
- `PERSIST-FLOW-IMPLEMENTATION.md` - Updated all queue references

### Test Files
- `sqs/scouts2sqs/test-local.js` - Updated comment about SQS queue
- `test-persist-flow.js` - Updated queue references in comments

### Scripts
- `local-scouts-sqs.sh` - Updated QUEUE_URL default value
- `manage-triggers.sh` - Updated FUNCTION_QUEUES array

### New Files Created
- `create-scouts-processing-queue.sh` - Script to create the new queue and configure permissions

## Queue URL Changes
- **Old**: `https://sqs.eu-west-2.amazonaws.com/243857182133/scouts`
- **New**: `https://sqs.eu-west-2.amazonaws.com/243857182133/scoutsProcessing`

## Queue ARN Changes
- **Old**: `arn:aws:sqs:eu-west-2:243857182133:scouts`
- **New**: `arn:aws:sqs:eu-west-2:243857182133:scoutsProcessing`

## Deployment Steps

1. **Create the new queue**:
   ```bash
   ./create-scouts-processing-queue.sh
   ```

2. **Deploy updated lambda functions**:
   ```bash
   cd sqs/scouts2sqs && ./deploy.sh
   cd ../sqs2scouts && ./deploy.sh
   ```

3. **Test the new setup**:
   ```bash
   ./local-scouts-sqs.sh -p  # Test with polling
   ```

4. **Verify triggers are working**:
   ```bash
   ./manage-triggers.sh  # Check status
   ```

5. **Clean up old queue** (after confirming everything works):
   - Delete the old "scouts" queue from AWS Console or CLI
   - Remove any old event source mappings if they exist

## Impact
- No functional changes to the lambda logic
- Queue name is now more descriptive and avoids naming conflicts
- All existing functionality preserved
- Better separation of concerns between lambda function names and queue names