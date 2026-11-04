# Issue 174 approval idempotency migration

Approval actions currently use conditional S3 objects under
`runtime/approval-idempotency/`. This migration moves those claims into the
existing `scouts-request-activity` DynamoDB table while retaining the S3
objects as rollback copies. DynamoDB rows use `requestId=approval-idempotency#<key>`
and `feed=approval-idempotency`; they intentionally omit `expiresAt`, so the
table TTL cannot remove replay-protection records.

## Rollout

1. Deploy with `SCOUTS_APPROVAL_IDEMPOTENCY_BACKEND=dual`. S3 remains the claim
   authority while each newly owned claim is also conditionally written to
   DynamoDB. Both the Scouts and Slack-handler Lambdas must use this mode.
2. Run a dry-run, then import the existing S3 claims:

   ```sh
   AWS_PROFILE=scouts node scripts/migrate-approval-idempotency-s3-to-dynamodb.mjs
   AWS_PROFILE=scouts node scripts/migrate-approval-idempotency-s3-to-dynamodb.mjs \
     --apply --confirm-account 553490163883
   ```

   The script verifies the AWS account, rejects identity conflicts, and
   reports counts without printing idempotency keys. Do not continue if it
   exits with conflicts.
3. Verify every legacy claim has a matching DynamoDB row and no row has
   `expiresAt`. Keep all S3 claim objects intact.
4. Set the backend to `dynamodb` and redeploy both Lambdas. Wait longer than
   the 30-second claim lease before treating the cutover as complete. Verify
   the deployed Lambda environment and role permissions, and inspect the
   activity table for the imported claim count.
5. Roll back by setting the backend to `s3` and redeploying. The S3 objects are
   retained for this purpose.

The dual mode fails closed if it cannot persist a claim in both stores. Queue
publication remains authoritative; completion-marker writes stay best-effort
to preserve the existing retry and replay behavior.

## Capacity boundary

This migration does not change the activity table's billing mode. The deferred
refresh outbox remains `PAY_PER_REQUEST`; changing it to provisioned capacity
requires representative capacity evidence and is outside this migration until
the bounded synthetic benchmark is authorized.
