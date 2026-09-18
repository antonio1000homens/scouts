import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = path.resolve(import.meta.dirname, '../request-router.mjs');
const HEX = '726577617264732074726970';

function command(name) {
  return class {
    constructor(input) { this.input = input; this.name = name; }
  };
}

async function loadRouter(eventOverride = null) {
  const executions = [];
  const activity = [];
  const sentMessages = [];
  const completeEvent = eventOverride ?? { title: 'Rewards Trip', metadata: { hex: HEX, tagline: 'Join us', image: { theme: 'trip', url: '/website/eventImages/rewards.jpg' }, status: { isHidden: false, isApproved: true } } };
  const S3Client = class { async send(request) { return { Body: { transformToString: async () => JSON.stringify(completeEvent) } }; } };
  const SQSClient = class { async send(request) { sentMessages.push(request.input); return { MessageId: 'downstream-message' }; } };
  const SFNClient = class {
    async send(request) {
      if (request.name === 'StartExecutionCommand') {
        executions.push(request.input);
        return { executionArn: 'arn:fixture' };
      }
      if (request.name === 'ListExecutionsCommand') {
        return { executions: [] };
      }
      throw new Error(`Unexpected SFN command ${request.name}`);
    }
  };
  const context = vm.createContext({ Buffer, URL, console, process, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(readFileSync(sourcePath, 'utf8'), { context, identifier: sourcePath });
  const modules = new Map();
  const synthetic = (specifier, exports) => {
    const result = new vm.SyntheticModule(Object.keys(exports), function initialize() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context, identifier: specifier });
    modules.set(specifier, result);
    return result;
  };
  const linker = async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier === '@aws-sdk/client-s3') return synthetic(specifier, { S3Client, GetObjectCommand: command('GetObjectCommand') });
    if (specifier === '@aws-sdk/client-sqs') return synthetic(specifier, { SQSClient, SendMessageCommand: command('SendMessageCommand') });
    if (specifier === '@aws-sdk/client-sfn') return synthetic(specifier, { SFNClient, ListExecutionsCommand: command('ListExecutionsCommand'), StartExecutionCommand: command('StartExecutionCommand') });
    if (specifier === 'crypto') return synthetic(specifier, { default: {
      randomBytes: () => Buffer.from('fixture'),
      timingSafeEqual: (left, right) => left.equals(right),
      createHash: () => ({ update() { return this; }, digest: () => 'a'.repeat(64) }),
    } });
    if (specifier === '/opt/nodejs/ssm-secrets.mjs') return synthetic(specifier, { getRequiredSecret: async () => 'fixture-secret' });
    if (specifier === '/opt/nodejs/request-activity.mjs') return synthetic(specifier, { recordRequestActivity: async (entry) => { activity.push(entry); return entry; } });
    if (specifier.endsWith('/request-processor.mjs')) return synthetic(specifier, { lambdaHandler: async () => ({ statusCode: 200, body: 'standard' }) });
    throw new Error(`Unhandled import ${specifier}`);
  };
  await module.link(linker);
  await module.evaluate();
  return { handler: module.namespace.lambdaHandler, executions, activity, sentMessages };
}

test('real request router preserves request/root identity and closes complete events without SFN', async () => {
  const previousArn = process.env.FULL_ENRICH_STATE_MACHINE_ARN;
  process.env.FULL_ENRICH_STATE_MACHINE_ARN = 'arn:aws:states:eu-west-2:553490163883:stateMachine:fixture';
  try {
    const router = await loadRouter();
    const response = await router.handler({ Records: [{ eventSource: 'aws:sqs', body: JSON.stringify({
      realm: 'scoutsRequest', action: 'new', requestId: 'request-router', rootRequestId: 'operation-router',
      subject: { hex: HEX },
    }) }] });
    assert.equal(response.statusCode, 200);
    assert.equal(router.executions.length, 0);
    assert.equal(router.activity.length, 1);
    assert.equal(router.activity[0].requestId, 'request-router');
    assert.equal(router.activity[0].rootRequestId, 'operation-router');
    assert.equal(router.activity[0].state, 'completed');
  } finally {
    if (previousArn === undefined) delete process.env.FULL_ENRICH_STATE_MACHINE_ARN;
    else process.env.FULL_ENRICH_STATE_MACHINE_ARN = previousArn;
  }
});

test('real request router forwards a persist mutation with occurrence and root identity intact', async () => {
  const router = await loadRouter();
  const response = await router.handler({ Records: [{ eventSource: 'aws:sqs', body: JSON.stringify({
    realm: 'persist', action: 'persist', requestId: 'request-persist', rootRequestId: 'operation-persist',
    occurrenceId: 'occ_0123456789abcdef01234567', visibilityIntent: 'hide', subject: { metadata: { hex: HEX, status: { isHidden: true } } },
  }) }] });
  assert.equal(response.statusCode, 200);
  assert.equal(router.sentMessages.length, 1);
  const forwarded = JSON.parse(router.sentMessages[0].MessageBody);
  assert.equal(forwarded.hex, HEX);
  assert.equal(forwarded.requestId, 'request-persist');
  assert.equal(forwarded.rootRequestId, 'operation-persist');
  assert.equal(forwarded.occurrenceId, 'occ_0123456789abcdef01234567');
  assert.equal(forwarded.visibilityIntent, 'hide');
  assert.deepEqual(JSON.parse(forwarded.action).metadata.status, { isHidden: true });
});


test('new event starts at one combined text stage before image generation', async () => {
  const previousArn = process.env.FULL_ENRICH_STATE_MACHINE_ARN;
  process.env.FULL_ENRICH_STATE_MACHINE_ARN = 'arn:aws:states:eu-west-2:553490163883:stateMachine:fixture';
  try {
    const router = await loadRouter({
      title: 'New Event',
      metadata: {
        hex: HEX,
        tagline: null,
        image: { theme: null, url: null },
        status: { isHidden: false, isApproved: false },
      },
    });
    const response = await router.handler({ Records: [{ eventSource: 'aws:sqs', body: JSON.stringify({
      realm: 'scoutsRequest',
      action: 'new',
      requestId: 'combined-request',
      subject: { hex: HEX },
    }) }] });

    assert.equal(response.statusCode, 200);
    assert.equal(router.executions.length, 1);
    const execution = JSON.parse(router.executions[0].input);
    assert.equal(execution.startStage, 'taglineTheme');
    assert.equal(execution.requestMode, 'auto');
    assert.equal(execution.continueAfterStage, true);
    assert.equal(execution.continueToImage, true);
  } finally {
    if (previousArn === undefined) delete process.env.FULL_ENRICH_STATE_MACHINE_ARN;
    else process.env.FULL_ENRICH_STATE_MACHINE_ARN = previousArn;
  }
});

test('Details tagline and image-theme requests start fresh manual field-only executions', async () => {
  const previousArn = process.env.FULL_ENRICH_STATE_MACHINE_ARN;
  process.env.FULL_ENRICH_STATE_MACHINE_ARN = 'arn:aws:states:eu-west-2:553490163883:stateMachine:fixture';
  try {
    for (const [subject, expectedStage] of [['tagline', 'tagline'], ['imageTheme', 'imageTheme']]) {
      const router = await loadRouter();
      const response = await router.handler({ Records: [{ eventSource: 'aws:sqs', body: JSON.stringify({
        realm: 'scoutsRequest',
        action: 'request',
        subject,
        subjectLabel: subject,
        hex: HEX,
        requestId: `manual-${subject}`,
      }) }] });

      assert.equal(response.statusCode, 200);
      assert.equal(router.executions.length, 1, `${subject} should start the full-enrich state machine`);
      const execution = JSON.parse(router.executions[0].input);
      assert.equal(execution.startStage, expectedStage);
      assert.equal(execution.requestMode, 'manual');
      assert.equal(execution.continueAfterStage, false);
      assert.equal(execution.continueToImage, false);
      assert.equal(execution.requestId, `manual-${subject}`);
    }
  } finally {
    if (previousArn === undefined) delete process.env.FULL_ENRICH_STATE_MACHINE_ARN;
    else process.env.FULL_ENRICH_STATE_MACHINE_ARN = previousArn;
  }
});
