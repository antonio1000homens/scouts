import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import worker, { classifySlackInteraction, verifySlackRequest } from './worker.js';

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

const signingSecret = 'unit-test-signing-secret';

function buildBody(actionId = 'scouts_request_approve') {
  const payload = {
    type: 'block_actions',
    actions: [{ action_id: actionId, value: '{}' }],
    trigger_id: 'trigger-test',
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function buildViewSubmissionBody() {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: 'view_submission',
      view: { callback_id: 'scouts_edit_modal' },
    }),
  }).toString();
}

function sign(body, timestamp) {
  return `v0=${crypto.createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
}

function signedRequest(body, timestamp) {
  return new Request('https://slack.2ndtolworth.org.uk/interactive', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': sign(body, timestamp),
    },
    body,
  });
}

test('classifies modal-open, response-coupled, and background interactions separately', () => {
  assert.equal(classifySlackInteraction({ actions: [{ action_id: 'scouts_request_edit' }] }), 'modal');
  assert.equal(classifySlackInteraction({
    type: 'view_submission',
    view: { callback_id: 'scouts_edit_modal' },
  }), 'response-coupled');
  assert.equal(classifySlackInteraction({ actions: [{ action_id: 'scouts_request_approve' }] }), 'background');
  assert.equal(classifySlackInteraction({ actions: [{ action_id: 'scouts_request_hide' }] }), 'background');
  assert.equal(classifySlackInteraction({ actions: [{ action_id: 'scouts_request_skip' }] }), 'background');
});

test('accepts a current valid Slack signature', async () => {
  const now = 1_800_000_000;
  const body = buildBody();
  const request = signedRequest(body, now);
  assert.equal(await verifySlackRequest(request, body, signingSecret, now), true);
});

test('rejects stale and future-skewed Slack timestamps', async () => {
  const now = 1_800_000_000;
  const body = buildBody();

  const stale = signedRequest(body, now - 301);
  const future = signedRequest(body, now + 301);

  assert.equal(await verifySlackRequest(stale, body, signingSecret, now), false);
  assert.equal(await verifySlackRequest(future, body, signingSecret, now), false);
});

test('rejects missing or invalid Slack signatures', async () => {
  const now = 1_800_000_000;
  const body = buildBody();

  const missing = new Request('https://slack.2ndtolworth.org.uk/interactive', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(now),
    },
    body,
  });
  assert.equal(await verifySlackRequest(missing, body, signingSecret, now), false);

  const invalid = signedRequest(body, now);
  invalid.headers.set('x-slack-signature', 'v0=deadbeef');
  assert.equal(await verifySlackRequest(invalid, body, signingSecret, now), false);
});

test('acknowledges valid background interactions at the edge and forwards worker proof', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = buildBody('scouts_request_approve');
  const request = signedRequest(body, timestamp);
  const originalFetch = globalThis.fetch;
  const captured = [];
  const waits = [];

  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return new Response('', { status: 200 });
  };

  try {
    const response = await worker.fetch(request, {
      SCOUTS_SLACK_HANDLER_URL: 'https://example.lambda-url.eu-west-2.on.aws/',
      SLACK_SIGNING_SECRET: signingSecret,
    }, {
      waitUntil(promise) {
        waits.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-scouts-slack-ack'), 'edge');
    assert.equal(response.headers.get('x-scouts-interaction-class'), 'background');
    assert.equal(waits.length, 1);
    await Promise.all(waits);

    assert.equal(captured.length, 1);
    const headers = new Headers(captured[0].init.headers);
    assert.ok(headers.get('x-scouts-worker-timestamp'));
    assert.match(headers.get('x-scouts-worker-signature') || '', /^v1=[0-9a-f]{64}$/);
    assert.equal(headers.get('x-scouts-interaction-class'), 'background');
    assert.equal(captured[0].init.body, body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses the modal fast path while still acknowledging Slack at the edge', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = buildBody('scouts_request_edit');
  const request = signedRequest(body, timestamp);
  const originalFetch = globalThis.fetch;
  const waits = [];
  let started = false;

  globalThis.fetch = async () => {
    started = true;
    return new Response('', { status: 200 });
  };

  try {
    const response = await worker.fetch(request, {
      SCOUTS_SLACK_HANDLER_URL: 'https://example.lambda-url.eu-west-2.on.aws/',
      SLACK_SIGNING_SECRET: signingSecret,
    }, {
      waitUntil(promise) {
        waits.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-scouts-interaction-class'), 'modal');
    assert.equal(waits.length, 1);
    await Promise.all(waits);
    assert.equal(started, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves Lambda response for edit modal view submissions', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = buildViewSubmissionBody();
  const request = signedRequest(body, timestamp);
  const originalFetch = globalThis.fetch;
  const waits = [];

  globalThis.fetch = async () => new Response(JSON.stringify({ response_action: 'clear' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const response = await worker.fetch(request, {
      SCOUTS_SLACK_HANDLER_URL: 'https://example.lambda-url.eu-west-2.on.aws/',
      SLACK_SIGNING_SECRET: signingSecret,
    }, {
      waitUntil(promise) {
        waits.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { response_action: 'clear' });
    assert.equal(waits.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
