import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTerminalSlackPayload,
  canonicalSlackDecision,
  reconcileSlackDecision,
} from '../lambdas/sqs2scouts/function/slack-decision-sync.mjs';

function event(status = {}) {
  return {
    title: 'Synthetic Scout Event',
    metadata: {
      hex: 'abcd1234',
      image: { url: '/website/eventImages/synthetic.jpg' },
      status: {
        isApproved: status.isApproved === true,
        isHidden: status.isHidden === true,
      },
    },
  };
}

test('Admin -> Slack approval updates the stored review card and removes actions', async () => {
  const calls = [];
  const persisted = [];
  const result = await reconcileSlackDecision({
    event: event({ isApproved: true }),
    messageBody: { decisionSource: 'admin' },
    identifiers: ['abcd1234'],
    loadMetadata: async () => ({ realm: 'approval', channel: 'C123', ts: '100.200', identifiers: ['abcd1234'] }),
    persistMetadata: async (_metadata, overrides) => persisted.push(overrides),
    updateMessage: async (...args) => calls.push(args),
    postResponseUrl: async () => assert.fail('response_url should not be needed when channel+ts exist'),
    resolveImageUrl: (value) => `https://example.test/${String(value).replace(/^\//, '')}`,
  });
  assert.equal(result.decision.status, 'APPROVED');
  assert.equal(result.deliveredVia, 'chat.update');
  assert.equal(calls.length, 1);
  assert.equal(result.payload.blocks.some((block) => block.type === 'actions'), false);
  assert.equal(persisted[0].status, 'APPROVED');
  assert.equal(persisted[0].decisionSource, 'admin');
});

test('Admin -> Slack hide renders the canonical hidden state without action buttons', async () => {
  let updatedPayload;
  const result = await reconcileSlackDecision({
    event: event({ isApproved: true, isHidden: true }),
    identifiers: ['abcd1234'],
    loadMetadata: async () => ({ realm: 'approval', channel: 'C123', ts: '100.200', identifiers: ['abcd1234'] }),
    persistMetadata: async () => {},
    updateMessage: async (_channel, _ts, text, blocks) => { updatedPayload = { text, blocks }; },
  });
  assert.equal(result.decision.status, 'HIDDEN');
  assert.match(updatedPayload.text, /Hidden/i);
  assert.equal(updatedPayload.blocks.some((block) => block.type === 'actions'), false);
});

test('Unhide reconciles to a meaningful visible state when the event is not approved', () => {
  assert.equal(canonicalSlackDecision(event({ isApproved: false, isHidden: false })).status, 'VISIBLE');
  const { payload } = buildTerminalSlackPayload(event({ isApproved: false, isHidden: false }));
  assert.match(payload.text, /Visible/i);
  assert.equal(payload.blocks.some((block) => block.type === 'actions'), false);
});

test('Slack-originated decision can use direct channel+ts and terminal metadata is recorded', async () => {
  const persisted = [];
  const result = await reconcileSlackDecision({
    event: event({ isApproved: true }),
    messageBody: {
      decisionSource: 'slack',
      slackMetadata: { channel: 'C999', ts: '222.333', responseUrl: 'https://hooks.slack.test/response' },
    },
    identifiers: ['abcd1234'],
    loadMetadata: async () => null,
    persistMetadata: async (metadata, overrides) => persisted.push({ metadata, overrides }),
    updateMessage: async () => {},
    postResponseUrl: async () => assert.fail('chat.update succeeds first'),
  });
  assert.equal(result.deliveredVia, 'chat.update');
  assert.equal(persisted[0].metadata.channel, 'C999');
  assert.equal(persisted[0].overrides.status, 'APPROVED');
  assert.equal(persisted[0].overrides.decisionSource, 'slack');
});

test('Missing/deleted Slack message never fails canonical persistence reconciliation', async () => {
  let terminalMetadata = null;
  const result = await reconcileSlackDecision({
    event: event({ isHidden: true }),
    identifiers: ['abcd1234'],
    loadMetadata: async () => ({ realm: 'approval', channel: 'C404', ts: '404.404', identifiers: ['abcd1234'] }),
    persistMetadata: async (_metadata, overrides) => { terminalMetadata = overrides; },
    updateMessage: async () => { throw new Error('message_not_found'); },
    logger: { warn() {} },
  });
  assert.equal(result.deliveredVia, null);
  assert.equal(result.decision.status, 'HIDDEN');
  assert.equal(terminalMetadata.status, 'HIDDEN');
});

test('Retries are idempotent replacements and never create a new Slack message', async () => {
  const updates = [];
  const options = {
    event: event({ isApproved: true }),
    identifiers: ['abcd1234'],
    loadMetadata: async () => ({ realm: 'approval', channel: 'C123', ts: '1.2', identifiers: ['abcd1234'] }),
    persistMetadata: async () => {},
    updateMessage: async (...args) => updates.push(args),
  };
  const first = await reconcileSlackDecision(options);
  const second = await reconcileSlackDecision(options);
  assert.equal(first.payload.text, second.payload.text);
  assert.deepEqual(first.payload.blocks, second.payload.blocks);
  assert.equal(updates.length, 2);
});

test('Slack action snapshots strip stale status before they enter persistence', () => {
  const handler = readFileSync('lambdas/scouts-slack-handler/function/slack-handler.mjs', 'utf8');
  assert.match(handler, /function stripStaleDecisionStatus\(event\)/);
  assert.match(handler, /subject: stripStaleDecisionStatus\(eventData\)/);
  assert.match(handler, /subject: stripStaleDecisionStatus\(baseEvent\)/);
  assert.match(handler, /decisionSource: 'slack'/);
});

test('sqs2scouts deployment includes the Slack decision synchronizer module', () => {
  const deploy = readFileSync('lambdas/sqs2scouts/deploy.sh', 'utf8');
  assert.match(deploy, /slack-decision-sync\.mjs/);
});


test('revisioned Admin approval also reconciles the stored Slack review card', () => {
  const approvalAdapter = readFileSync('lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs', 'utf8');
  assert.match(approvalAdapter, /reconcileSlackDecision/);
  assert.match(approvalAdapter, /async function reconcileApprovalSlack/);
  assert.match(approvalAdapter, /loadApprovalMessageMetadata/);
  assert.match(approvalAdapter, /await reconcileApprovalSlack\(message, hex, accepted, approvalState\)/);
});

test('approval awaiting generated image replaces stale review actions with a pending state', () => {
  const { decision, payload } = buildTerminalSlackPayload(event({ isApproved: false }), {
    decisionOverride: {
      status: 'AWAITING_IMAGE',
      label: 'Approval accepted — generating image',
      emoji: '⏳',
    },
  });
  assert.equal(decision.status, 'AWAITING_IMAGE');
  assert.match(payload.text, /generating image/i);
  assert.equal(payload.blocks.some((block) => block.type === 'actions'), false);
});

test('Slack response URL callback bindings use the defined helper in both persistence paths', () => {
  const persistenceProcessor = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
  const approvalAdapter = readFileSync('lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs', 'utf8');
  for (const source of [persistenceProcessor, approvalAdapter]) {
    assert.match(source, /async function postToResponseUrl\(/);
    assert.match(source, /postResponseUrl: postToResponseUrl/);
    assert.doesNotMatch(source, /\n\s*postResponseUrl,\n/);
  }
});
