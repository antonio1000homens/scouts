# Scouts2SQS Lambda Function

Simple Lambda function that accepts POST requests and publishes messages to the scoutsProcessing SQS queue.

## Structure
```
scouts2sqs/
├── function/
│   ├── lambda-layer/
│   │   ├── nodejs/
│   │   └── config.json
│   └── scouts2sqs.mjs
├── deploy.sh
├── test-local.js
└── README.md
```

## Testing Locally

1. **Deploy the function first:**
   ```bash
   ./deploy.sh
   ```

2. **Get the Function URL from the deployment output**

3. **Update the test script:**
   - Edit `test-local.js`
   - Replace `FUNCTION_URL` with your actual Lambda function URL

4. **Run the test:**
   ```bash
   node test-local.js
   ```

## Expected Behavior

- Accepts POST requests with `realm`, `subject`, `action` parameters
- Consumes `scoutsRequests` SQS messages and republishes normalized internal jobs to `scoutsProcessing`
- Translates field-level requests like `realm=scoutsRequest`, `subject=tagline|imageTheme`, `action=request|persist` into the existing internal queue payloads
- Publishes to SQS queue: `https://sqs.eu-west-2.amazonaws.com/243857182133/scoutsProcessing`
- Sends notification to Slack channel: `#scouts`
- Returns 200 on success, 400/500 on errors

## Test Cases

The test script includes:
- ✅ Valid scouts message
- ✅ Another scouts message  
- ❌ Missing subject (should fail with 400)