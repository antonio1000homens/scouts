import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalActivity } from '../lambdas/shared-layer/nodejs/runtime-activity-model.mjs';

const NOW = new Date('2026-09-07T23:30:00Z');

function snapshot(status, requests, updatedAt = '2026-09-07T23:20:00Z') {
  return { status, updatedAt, requests };
}

function request(overrides = {}) {
  return {
    requestId: 'req-1',
    messageId: 'msg-1',
    hex: '73756d6d657220627265616b',
    title: 'SUMMER BREAK',
    realm: 'persist',
    action: 'persist',
    requestTime: '2026-09-07T23:09:11Z',
    ...overrides,
  };
}

test('later completed state supersedes stale queued state for the same request ID', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request()]),
    completedSnapshot: snapshot('completed', [request({ completedAt: '2026-09-07T23:09:13Z' })]),
    now: NOW,
  });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].requestId, 'req-1');
  assert.equal(activity[0].state, 'completed');
  assert.deepEqual(activity[0].timeline.map((entry) => entry.state), ['queued', 'completed']);
});

test('failed worker completion remains a terminal failure in authoritative activity', () => {
  const activity = buildCanonicalActivity({
    processingSnapshot: snapshot('processing', [request()]),
    completedSnapshot: snapshot('completed', [request({
      status: 'failed',
      failure: { type: 'QUOTA_REJECTED', message: 'Gemini daily limit reached' },
    })]),
    now: NOW,
  });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].state, 'failed');
  assert.equal(activity[0].failure.type, 'QUOTA_REJECTED');
  assert.equal(activity[0].failure.message, 'Gemini daily limit reached');
});

test('agenda publication failure is needs-attention rather than completed', () => {
  const activity = buildCanonicalActivity({
    completedSnapshot: snapshot('completed', [request({
      status: 'failed',
      failure: { type: 'AGENDA_EVENT_NOT_FOUND', message: 'No agenda event matches HEX' },
    })]),
    now: NOW,
  });
  assert.equal(activity[0].state, 'failed');
  assert.equal(activity[0].health, 'needs_attention');
  assert.equal(activity[0].failure.type, 'AGENDA_EVENT_NOT_FOUND');
});

test('age alone never creates queued-stalled or needs-attention lifecycle state', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ requestTime: '2026-09-07T18:00:00Z' })]),
    now: NOW,
  });
  assert.equal(activity[0].state, 'queued');
  assert.equal(activity[0].health, 'unknown');
  assert.ok(activity[0].ageSeconds > 60);
  assert.notEqual(activity[0].state, 'queued-stalled');
  assert.notEqual(activity[0].health, 'needs_attention');
});

test('durable event request history completes a request after transient completion snapshot has rotated away', () => {
  const hex = request().hex;
  const histories = new Map([[hex, [{
    requestId: 'req-1',
    timestamp: '2026-09-07T23:09:13Z',
    realm: 'persist',
    action: 'persist',
    status: 'applied',
  }]]]);
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request()]),
    completedSnapshot: snapshot('completed', [{
      requestId: 'some-newer-batch',
      hex: 'abcd',
      completedAt: '2026-09-07T23:20:00Z',
    }]),
    durableHistories: histories,
    now: NOW,
  });
  const item = activity.find((entry) => entry.requestId === 'req-1');
  assert.equal(item.state, 'completed');
  assert.equal(item.stage, 'applied');
  assert.ok(item.timeline.some((entry) => entry.source === 'event-history'));
});

test('running full-enrich execution attaches ARN and actual stage to the original request ID', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ realm: 'scoutsRequest', action: 'imageEnrich' })]),
    executions: [{
      requestId: 'req-1',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      currentStage: 'image',
      stateName: 'GenerateImageCloudflare',
      status: 'RUNNING',
      executionArn: 'arn:aws:states:eu-west-2:123:execution:full:one',
      startDate: '2026-09-07T23:09:12Z',
      updatedAt: '2026-09-07T23:10:12Z',
    }],
    now: NOW,
  });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].requestId, 'req-1');
  assert.equal(activity[0].state, 'waiting_for_image');
  assert.equal(activity[0].stage, 'image');
  assert.equal(activity[0].executionStateName, 'GenerateImageCloudflare');
  assert.equal(activity[0].executionArn, 'arn:aws:states:eu-west-2:123:execution:full:one');
});

test('live Step Functions stage overrides transient worker completed snapshot', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ realm: 'scoutsRequest', action: 'imageEnrich' })]),
    completedSnapshot: snapshot('completed', [request({
      realm: 'scoutsRequest',
      orchestrationType: 'fullEnrich',
      orchestrationStep: 'imageTheme',
      completedAt: '2026-09-07T23:10:00Z',
    })]),
    executions: [{
      requestId: 'req-1',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      currentStage: 'image',
      stateName: 'GenerateImageGemini',
      status: 'RUNNING',
      executionArn: 'arn:running',
      startDate: '2026-09-07T23:09:12Z',
      updatedAt: '2026-09-07T23:10:01Z',
    }],
    now: NOW,
  });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].state, 'waiting_for_image');
  assert.equal(activity[0].stage, 'image');
  assert.ok(activity[0].timeline.some((entry) => entry.state === 'completed'));
  assert.ok(activity[0].timeline.some((entry) => entry.source === 'step-functions'));
});

test('successful Deferred state remains waiting for retry rather than completed', () => {
  const activity = buildCanonicalActivity({
    completedSnapshot: snapshot('completed', [request({
      realm: 'scoutsRequest',
      orchestrationType: 'fullEnrich',
      completedAt: '2026-09-07T23:10:00Z',
    })]),
    executions: [{
      requestId: 'req-1',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      currentStage: 'waiting_for_retry',
      stateName: 'Deferred',
      status: 'SUCCEEDED',
      executionArn: 'arn:deferred',
      startDate: '2026-09-07T23:09:12Z',
      stopDate: '2026-09-07T23:10:02Z',
      updatedAt: '2026-09-07T23:10:02Z',
    }],
    now: NOW,
  });
  assert.equal(activity[0].state, 'waiting_for_retry');
  assert.equal(activity[0].stage, 'waiting_for_retry');
  assert.equal(activity[0].health, 'unknown');
});

test('successful ManualReview state remains needs-attention lifecycle evidence', () => {
  const activity = buildCanonicalActivity({
    completedSnapshot: snapshot('completed', [request({
      realm: 'scoutsRequest',
      orchestrationType: 'fullEnrich',
      completedAt: '2026-09-07T23:10:00Z',
    })]),
    executions: [{
      requestId: 'req-1',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      currentStage: 'manual_review',
      stateName: 'ManualReview',
      status: 'SUCCEEDED',
      executionArn: 'arn:manual',
      startDate: '2026-09-07T23:09:12Z',
      stopDate: '2026-09-07T23:10:02Z',
      updatedAt: '2026-09-07T23:10:02Z',
    }],
    now: NOW,
  });
  assert.equal(activity[0].state, 'manual_review');
  assert.equal(activity[0].health, 'needs_attention');
});

test('legacy execution ID can still correlate by HEX without replacing the admin request ID', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ realm: 'scoutsRequest', action: 'imageEnrich' })]),
    executions: [{
      requestId: 'full-old-execution-name',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      status: 'RUNNING',
      executionArn: 'arn:legacy',
      startDate: '2026-09-07T23:09:12Z',
    }],
    now: NOW,
  });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].requestId, 'req-1');
  assert.equal(activity[0].executionArn, 'arn:legacy');
});

test('old execution for the same HEX does not hijack a newer request ID', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({
      requestId: 'req-new',
      messageId: 'msg-new',
      realm: 'scoutsRequest',
      requestTime: '2026-09-07T23:09:11Z',
    })]),
    executions: [{
      requestId: 'legacy-old-execution',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      status: 'FAILED',
      executionArn: 'arn:old',
      startDate: '2026-09-06T10:00:00Z',
      stopDate: '2026-09-06T10:05:00Z',
      updatedAt: '2026-09-06T10:05:00Z',
    }],
    now: NOW,
  });
  const current = activity.find((entry) => entry.requestId === 'req-new');
  const old = activity.find((entry) => entry.requestId === 'legacy-old-execution');
  assert.equal(current.state, 'queued');
  assert.equal(old.state, 'needs_attention');
});

test('explicit failed workflow is needs-attention instead of an age-derived stall', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ realm: 'scoutsRequest' })]),
    executions: [{
      requestId: 'req-1',
      hex: request().hex,
      orchestrationType: 'fullEnrich',
      status: 'FAILED',
      executionArn: 'arn:failed',
      error: 'States.TaskFailed',
      cause: 'callback failed',
      startDate: '2026-09-07T23:09:12Z',
      updatedAt: '2026-09-07T23:09:13Z',
    }],
    now: NOW,
  });
  assert.equal(activity[0].state, 'needs_attention');
  assert.equal(activity[0].health, 'needs_attention');
  assert.equal(activity[0].failure.type, 'States.TaskFailed');
  assert.equal(activity[0].failure.message, 'callback failed');
});

test('old queued snapshot becomes explicit orphan only when live queue health proves no message remains', () => {
  const activity = buildCanonicalActivity({
    queuedSnapshot: snapshot('queued', [request({ requestTime: '2026-09-07T22:00:00Z' })]),
    queueHealth: {
      scoutsRequests: { ok: true, visible: 0, inFlight: 0, delayed: 0 },
    },
    now: NOW,
  });
  assert.equal(activity[0].state, 'needs_attention');
  assert.equal(activity[0].stage, 'tracking_orphaned');
  assert.equal(activity[0].failure.type, 'ORPHANED_TRACKING');
  assert.ok(activity[0].timeline.some((entry) => entry.source === 'queue-health'));
});
