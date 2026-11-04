import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  claimApprovalAction,
  resetApprovalIdempotencyClientsForTests,
  setApprovalIdempotencyClientsForTests,
} from './approval-coordinator.mjs';

function conditionalFailure() {
  return Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
}

function memoryClient(seed = null) {
  let item = seed;
  return {
    get item() { return item; },
    async send(command) {
      if (command instanceof PutItemCommand) {
        if (item) throw conditionalFailure();
        item = command.input.Item;
        return {};
      }
      if (command instanceof GetItemCommand) return { Item: item };
      if (command instanceof UpdateItemCommand) {
        const values = command.input.ExpressionAttributeValues;
        if (item?.state?.S !== values[':observedState']?.S
          || item?.updatedAt?.S !== values[':observedUpdatedAt']?.S) throw conditionalFailure();
        item = {
          ...item,
          state: values[':claimed'],
          idempotencyKey: values[':idempotencyKey'],
          rootRequestId: values[':rootRequestId'],
          revision: values[':revision'],
          hex: values[':hex'],
          requiresGeneratedImage: values[':requiresGeneratedImage'],
          claimedAt: values[':claimedAt'],
          updatedAt: values[':updatedAt'],
          takeoverOf: values[':takeoverOf'],
          claimToken: values[':claimToken'],
        };
        return {};
      }
      assert.fail(`Unexpected DynamoDB command ${command.constructor.name}`);
    },
  };
}

const identity = {
  idempotencyKey: 'approval-1',
  rootRequestId: 'root-1',
  revision: 'rev-1',
  hex: 'aabbcc',
  requiresGeneratedImage: false,
};

test('DynamoDB approval claims are conditional and do not expire', async () => {
  const dynamodb = memoryClient();
  setApprovalIdempotencyClientsForTests({ dynamoClient: dynamodb, backend: 'dynamodb', tableName: 'activity' });
  try {
    const claim = await claimApprovalAction(identity);
    assert.equal(claim.owned, true);
    assert.equal(claim.backend, 'dynamodb');
    assert.equal(dynamodb.item.requestId.S, 'approval-idempotency#approval-1');
    assert.equal(dynamodb.item.feed.S, 'approval-idempotency');
    assert.equal(dynamodb.item.state.S, 'claimed');
    assert.equal('expiresAt' in dynamodb.item, false);
  } finally {
    resetApprovalIdempotencyClientsForTests();
  }
});

test('DynamoDB approval duplicate reuses a live claim without taking ownership', async () => {
  const dynamodb = memoryClient();
  setApprovalIdempotencyClientsForTests({ dynamoClient: dynamodb, backend: 'dynamodb', tableName: 'activity' });
  try {
    const first = await claimApprovalAction(identity);
    const duplicate = await claimApprovalAction(identity);
    assert.equal(first.owned, true);
    assert.equal(duplicate.owned, false);
    assert.equal(duplicate.pending, true);
  } finally {
    resetApprovalIdempotencyClientsForTests();
  }
});

test('DynamoDB approval claim can conditionally take over an expired claim', async () => {
  const oldTime = new Date(Date.now() - 60_000).toISOString();
  const dynamodb = memoryClient({
    requestId: { S: 'approval-idempotency#approval-1' },
    state: { S: 'claimed' },
    updatedAt: { S: oldTime },
    claimedAt: { S: oldTime },
    claimToken: { S: 'old-token' },
  });
  setApprovalIdempotencyClientsForTests({ dynamoClient: dynamodb, backend: 'dynamodb', tableName: 'activity' });
  try {
    const claim = await claimApprovalAction(identity);
    assert.equal(claim.owned, true);
    assert.notEqual(claim.claimToken, 'old-token');
    assert.equal(dynamodb.item.takeoverOf.S, oldTime);
    assert.equal(dynamodb.item.claimToken.S, claim.claimToken);
  } finally {
    resetApprovalIdempotencyClientsForTests();
  }
});
