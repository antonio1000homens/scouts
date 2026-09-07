import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME = 'scouts-enrichment-state-test';
process.env.GEMINI_MAX_ATTEMPTS_PER_STAGE = '3';
process.env.GEMINI_RETRY_DELAY_ATTEMPT_2_SECONDS = '3600';
process.env.GEMINI_RETRY_DELAY_ATTEMPT_3_SECONDS = '21600';
process.env.GEMINI_IN_PROGRESS_LEASE_SECONDS = '60';

const stateModule = await import(`./enrichment-state.mjs?integration=${Date.now()}`);
const {
  reserveEnrichmentAttempt,
  markGeminiSucceeded,
  markEnrichmentSucceeded,
  markEnrichmentFailure,
  loadReusableGeneration,
  claimEnrichmentEscalation,
  resetEnrichmentState,
  getEnrichmentState,
  setEnrichmentStateClientForTests,
  resetEnrichmentStateClientForTests,
} = stateModule;

function conditionalFailure() {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function fromAttr(value) {
  if (value?.S !== undefined) return value.S;
  if (value?.N !== undefined) return Number(value.N);
  if (value?.BOOL !== undefined) return value.BOOL;
  if (value?.NULL) return null;
  return undefined;
}

function toAttr(value) {
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (value === null) return { NULL: true };
  return { S: String(value) };
}

function marshall(item) {
  if (!item) return undefined;
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, toAttr(value)]));
}

class InMemoryEnrichmentDynamo {
  constructor() {
    this.items = new Map();
    this.commands = [];
  }

  key(input) {
    return `${input.Key.hex.S}#${input.Key.stage.S}`;
  }

  async send(command) {
    this.commands.push(command);
    const input = command.input;
    const name = command.constructor.name;
    const key = this.key(input);

    if (name === 'GetItemCommand') {
      return { Item: marshall(this.items.get(key)) };
    }
    if (name !== 'UpdateItemCommand') throw new Error(`Unsupported command ${name}`);

    const values = Object.fromEntries(
      Object.entries(input.ExpressionAttributeValues || {}).map(([token, value]) => [token, fromAttr(value)])
    );
    const expression = input.UpdateExpression || '';
    let item = { ...(this.items.get(key) || {}), hex: input.Key.hex.S, stage: input.Key.stage.S };

    if (values[':previousGenerationId'] !== undefined) {
      if (item.state !== 'succeeded' || item.generationId !== values[':previousGenerationId']) throw conditionalFailure();
      item.state = 'pending';
      item.attemptCount = 0;
      item.generationId = values[':generationId'];
      item.updatedAt = values[':now'];
      delete item.geminiSucceeded;
      delete item.generatedValue;
      delete item.nextRetryAt;
      delete item.inProgressExpiresAt;
      this.items.set(key, item);
      return {};
    }

    if (values[':lease'] !== undefined && values[':max'] !== undefined) {
      const nowMs = values[':nowMs'];
      const max = values[':max'];
      if (item.state === 'in_progress' && Number(item.inProgressExpiresAt || 0) > nowMs) throw conditionalFailure();
      if (item.state === 'manual_review') throw conditionalFailure();
      if (Number(item.attemptCount || 0) >= max) throw conditionalFailure();
      if (item.nextRetryAt && item.nextRetryAt > values[':now']) throw conditionalFailure();

      item.state = 'in_progress';
      item.attemptCount = Number(item.attemptCount || 0) + 1;
      item.firstAttemptAt ||= values[':now'];
      item.lastAttemptAt = values[':now'];
      item.inProgressExpiresAt = values[':lease'];
      item.generationId = values[':generationId'];
      item.lastRequestId = values[':requestId'];
      item.updatedAt = values[':now'];
      item.expiresAt = values[':expiresAt'];
      delete item.nextRetryAt;
      this.items.set(key, item);
      return { Attributes: marshall(item) };
    }

    if (expression.includes('#escalatedAt')) {
      if (item.escalatedAt) throw conditionalFailure();
      item.escalatedAt = values[':escalatedAt'];
      item.updatedAt = values[':updatedAt'];
      item.expiresAt = values[':expiresAt'];
      this.items.set(key, item);
      return {};
    }

    if (expression.includes('#attemptCount = :zero')) {
      item.state = values[':state'];
      item.attemptCount = values[':zero'];
      item.updatedAt = values[':updatedAt'];
      item.expiresAt = values[':expiresAt'];
      delete item.nextRetryAt;
      delete item.inProgressExpiresAt;
      delete item.geminiSucceeded;
      delete item.generatedValue;
      delete item.generationId;
      this.items.set(key, item);
      return { Attributes: marshall(item) };
    }

    item.state = values[':state'];
    item.updatedAt = values[':updatedAt'];
    item.expiresAt = values[':expiresAt'];
    if (values[':generationId'] !== undefined) item.generationId = values[':generationId'];
    if (values[':true'] !== undefined) item.geminiSucceeded = values[':true'];
    if (values[':generatedValue'] !== undefined) item.generatedValue = values[':generatedValue'];
    if (values[':errorType'] !== undefined) item.lastErrorType = values[':errorType'];
    if (values[':errorMessage'] !== undefined) item.lastErrorMessage = values[':errorMessage'];
    if (values[':nextRetryAt'] !== undefined) item.nextRetryAt = values[':nextRetryAt'];
    else if (expression.includes('REMOVE') && expression.includes('#nextRetryAt')) delete item.nextRetryAt;
    if (expression.includes('REMOVE') && expression.includes('#inProgressExpiresAt')) delete item.inProgressExpiresAt;
    if (expression.includes('#geminiSucceeded') && values[':true'] === undefined) delete item.geminiSucceeded;
    this.items.set(key, item);
    return { Attributes: marshall(item) };
  }
}

let db;
beforeEach(() => {
  db = new InMemoryEnrichmentDynamo();
  setEnrichmentStateClientForTests(db);
});
after(() => resetEnrichmentStateClientForTests());

test('conditional reservation permits one owner and blocks a concurrent duplicate', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  const first = await reserveEnrichmentAttempt({ hex: 'ABCD', stage: 'tagline', generationId: 'g1', requestId: 'r1', now });
  assert.equal(first.reserved, true);
  assert.equal(first.state.attemptCount, 1);
  assert.equal(first.state.state, 'in_progress');

  const duplicate = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'tagline', generationId: 'g1', requestId: 'r2', now: new Date('2026-09-07T10:00:30Z') });
  assert.equal(duplicate.reserved, false);
  assert.equal(duplicate.reason, 'in_progress');
  assert.equal((await getEnrichmentState('abcd', 'tagline')).attemptCount, 1);
});

test('expired in-progress lease becomes retryable instead of staying locked forever', async () => {
  await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'tagline', generationId: 'g1', requestId: 'r1', now: new Date('2026-09-07T10:00:00Z') });
  const retry = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'tagline', generationId: 'g1', requestId: 'r2', now: new Date('2026-09-07T10:01:01Z') });
  assert.equal(retry.reserved, true);
  assert.equal(retry.state.attemptCount, 2);
  assert.equal(retry.state.lastRequestId, 'r2');
});

test('retryable failures enforce 1h then 6h cooldown and quarantine after attempt 3', async () => {
  const t0 = new Date('2026-09-07T10:00:00Z');
  const first = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'imageTheme', generationId: 'g1', requestId: 'r1', now: t0 });
  const failure1 = await markEnrichmentFailure({ hex: 'abcd', stage: 'imageTheme', error: { status: 429, message: 'rate limited' }, attemptCount: first.state.attemptCount, now: t0 });
  assert.equal(failure1.state, 'retry_wait');
  assert.equal(failure1.nextRetryAt, '2026-09-07T11:00:00.000Z');

  const early = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'imageTheme', generationId: 'g1', requestId: 'too-early', now: new Date('2026-09-07T10:59:59Z') });
  assert.equal(early.reserved, false);
  assert.equal(early.reason, 'cooldown_active');

  const second = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'imageTheme', generationId: 'g1', requestId: 'r2', now: new Date('2026-09-07T11:00:00Z') });
  assert.equal(second.state.attemptCount, 2);
  const failure2 = await markEnrichmentFailure({ hex: 'abcd', stage: 'imageTheme', error: { status: 503, message: 'unavailable' }, attemptCount: 2, now: new Date('2026-09-07T11:00:00Z') });
  assert.equal(failure2.nextRetryAt, '2026-09-07T17:00:00.000Z');

  const third = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'imageTheme', generationId: 'g1', requestId: 'r3', now: new Date('2026-09-07T17:00:00Z') });
  assert.equal(third.state.attemptCount, 3);
  const failure3 = await markEnrichmentFailure({ hex: 'abcd', stage: 'imageTheme', error: new Error('network timeout'), attemptCount: 3, now: new Date('2026-09-07T17:00:00Z') });
  assert.equal(failure3.state, 'manual_review');
  assert.equal(failure3.nextRetryAt, undefined);

  const quarantined = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'imageTheme', generationId: 'g1', requestId: 'r4', now: new Date('2026-09-08T17:00:00Z') });
  assert.equal(quarantined.reserved, false);
  assert.equal(quarantined.reason, 'manual_review');
});

test('deterministic configuration/auth errors quarantine immediately', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  const first = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'tagline', generationId: 'g1', requestId: 'r1', now });
  const state = await markEnrichmentFailure({ hex: 'abcd', stage: 'tagline', error: { status: 401, message: 'invalid API key' }, attemptCount: first.state.attemptCount, now });
  assert.equal(state.state, 'manual_review');
  assert.equal(state.attemptCount, 1);
  assert.equal(state.lastErrorType, 'AUTH_FAILURE');
});

test('provider success is cached before persistence completion and reused without another generation', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'image', generationId: 'image-g1', requestId: 'r1', now });
  const persisted = await markGeminiSucceeded({
    hex: 'abcd', stage: 'image', generationId: 'image-g1', generatedValue: { relativeUrl: 'website/eventImages/a.jpg' }, now,
  });
  assert.equal(persisted.state, 'persist_pending');
  assert.equal(persisted.geminiSucceeded, true);

  const reusable = await loadReusableGeneration({ hex: 'abcd', stage: 'image', generationId: 'image-g1' });
  assert.deepEqual(reusable.generatedValue, { relativeUrl: 'website/eventImages/a.jpg' });

  const complete = await markEnrichmentSucceeded({ hex: 'abcd', stage: 'image', generationId: 'image-g1', now });
  assert.equal(complete.state, 'succeeded');
  assert.equal(complete.attemptCount, 1);
});

test('a materially new generation resets prior success and starts again at attempt 1', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'image', generationId: 'old', requestId: 'r1', now });
  await markGeminiSucceeded({ hex: 'abcd', stage: 'image', generationId: 'old', generatedValue: { relativeUrl: 'old.jpg' }, now });
  await markEnrichmentSucceeded({ hex: 'abcd', stage: 'image', generationId: 'old', now });

  const next = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'image', generationId: 'new', requestId: 'r2', now: new Date('2026-09-07T11:00:00Z') });
  assert.equal(next.reserved, true);
  assert.equal(next.state.attemptCount, 1);
  assert.equal(next.state.generationId, 'new');
  assert.equal(next.state.geminiSucceeded, undefined);
  assert.equal(next.state.generatedValue, undefined);
});

test('quarantine escalation is idempotent and manual reset is deliberate', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  const first = await reserveEnrichmentAttempt({ hex: 'abcd', stage: 'tagline', generationId: 'g1', requestId: 'r1', now });
  await markEnrichmentFailure({ hex: 'abcd', stage: 'tagline', error: { status: 401, message: 'invalid API key' }, attemptCount: first.state.attemptCount, now });

  assert.equal(await claimEnrichmentEscalation({ hex: 'abcd', stage: 'tagline', now }), true);
  assert.equal(await claimEnrichmentEscalation({ hex: 'abcd', stage: 'tagline', now: new Date('2026-09-07T10:01:00Z') }), false);

  const reset = await resetEnrichmentState('abcd', 'tagline', new Date('2026-09-07T10:02:00Z'));
  assert.equal(reset.state, 'pending');
  assert.equal(reset.attemptCount, 0);
  assert.equal(reset.generationId, undefined);
  assert.equal(reset.geminiSucceeded, undefined);
});

test('invalid stage updates are rejected without writing a null sort key', async () => {
  const now = new Date('2026-09-07T10:00:00Z');
  assert.equal(await markEnrichmentSucceeded({ hex: 'abcd', stage: 'unsupported', generationId: 'g1', now }), null);
  assert.equal(await markGeminiSucceeded({ hex: 'abcd', stage: undefined, generationId: 'g1', generatedValue: { value: 'x' }, now }), null);
  assert.equal(await claimEnrichmentEscalation({ hex: 'abcd', stage: 'unsupported', now }), false);
  assert.equal(db.commands.length, 0);
  assert.equal(db.items.has('abcd#null'), false);
});
