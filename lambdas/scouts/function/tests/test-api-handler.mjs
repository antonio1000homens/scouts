import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = path.resolve(import.meta.dirname, '../scouts-service.mjs');
const HEX = '726577617264732074726970';
const OCCURRENCE = 'occ_0123456789abcdef01234567';

function command(name) {
  return class {
    constructor(input) { this.input = input; this.name = name; }
  };
}

async function loadService() {
  const sent = [];
  const activities = [];
  let s3Send = async () => ({});
  const S3Client = class { async send(request) { return s3Send(request); } };
  const SQSClient = class { async send(request) { sent.push(request.input); return { MessageId: 'message-fixture', MD5OfMessageBody: 'md5-fixture' }; } };
  const SFNClient = class { async send() { return { executions: [] }; } };
  const context = vm.createContext({ Buffer, URL, console: { ...console, log() {}, warn() {}, error() {} }, process, setTimeout, clearTimeout });
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
    if (specifier === '@aws-sdk/client-s3') return synthetic(specifier, { S3Client, PutObjectCommand: command('PutObjectCommand'), GetObjectCommand: command('GetObjectCommand'), DeleteObjectCommand: command('DeleteObjectCommand'), HeadObjectCommand: command('HeadObjectCommand'), ListObjectsV2Command: command('ListObjectsV2Command'), CopyObjectCommand: command('CopyObjectCommand') });
    if (specifier === '@aws-sdk/client-sqs') return synthetic(specifier, { SQSClient, SendMessageCommand: command('SendMessageCommand') });
    if (specifier === '@aws-sdk/client-sfn') return synthetic(specifier, { SFNClient, DescribeExecutionCommand: command('DescribeExecutionCommand'), ListExecutionsCommand: command('ListExecutionsCommand') });
    if (specifier === 'crypto') return synthetic(specifier, { randomUUID: () => 'request-fixture' });
    if (specifier === 'node:async_hooks') return synthetic(specifier, { AsyncLocalStorage });
    if (specifier === '/opt/nodejs/ssm-secrets.mjs') return synthetic(specifier, { getRequiredSecret: async () => 'fixture-key' });
    if (specifier === '/opt/nodejs/request-activity.mjs') return synthetic(specifier, {
      listRequestActivity: async () => ({ requests: [] }),
      recordRequestActivity: async (entry) => { activities.push(entry); return entry; },
    });
    if (specifier === '/opt/nodejs/enrichment-state.mjs') return synthetic(specifier, { getEnrichmentState: async () => null, evaluateEnrichmentEligibility: async () => ({ eligible: true }), buildGenerationId: () => 'fixture-generation' });
    if (specifier === '/opt/nodejs/occurrence-identity.mjs') return synthetic(specifier, { resolveOccurrenceId: () => OCCURRENCE, occurrenceStorageKey: (id) => `occurrences/${id}.json` });
    if (specifier === './image-head-memo.mjs') {
      // Load the real local helper in the same VM context as scouts-service.
      const memoPath = path.resolve(import.meta.dirname, '../image-head-memo.mjs');
      const memoModule = new vm.SourceTextModule(readFileSync(memoPath, 'utf8'), { context, identifier: memoPath });
      modules.set(specifier, memoModule);
      return memoModule;
    }
    if (specifier === './runtime-activity-index.mjs') {
      const indexPath = path.resolve(import.meta.dirname, '../runtime-activity-index.mjs');
      const indexModule = new vm.SourceTextModule(readFileSync(indexPath, 'utf8'), { context, identifier: indexPath });
      modules.set(specifier, indexModule);
      return indexModule;
    }
    if (specifier === './s3-request-metrics.mjs') {
      const metricsPath = path.resolve(import.meta.dirname, '../s3-request-metrics.mjs');
      const metricsModule = new vm.SourceTextModule(readFileSync(metricsPath, 'utf8'), { context, identifier: metricsPath });
      modules.set(specifier, metricsModule);
      return metricsModule;
    }
    if (specifier === './runtime-deferred-refresh.mjs') {
      return synthetic(specifier, {
        enqueueDeferredRefresh: async () => ({ enqueued: true, state: 'ready' }),
      });
    }
    throw new Error(`Unhandled import ${specifier}`);
  };
  await module.link(linker);
  await module.evaluate();
  return {
    handler: module.namespace.lambdaHandler,
    getFreshIcsFromS3: module.namespace.getFreshIcsFromS3,
    setS3Send(send) { s3Send = send; },
    sent,
    activities,
  };
}

function request(body, apiKey = 'fixture-key') {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: apiKey === null ? {} : { 'x-api-key': apiKey },
    body: JSON.stringify(body),
  };
}

test('fresh calendar cache reads use one GetObject and retain the 24-hour freshness decision', async () => {
  const service = await loadService();
  const commands = [];
  service.setS3Send(async (command) => {
    commands.push(command);
    return {
      LastModified: new Date('2026-11-04T12:00:00Z'),
      Body: { transformToString: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' },
    };
  });

  const body = await service.getFreshIcsFromS3(
    'fixture-bucket',
    'calendar/cubs-events.ics',
    24 * 60 * 60 * 1000,
    Date.parse('2026-11-04T13:00:00Z'),
  );

  assert.equal(body, 'BEGIN:VCALENDAR\nEND:VCALENDAR');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'GetObjectCommand');
});

test('stale calendar cache consumes one GetObject body then returns null for remote refresh', async () => {
  const service = await loadService();
  const commands = [];
  let consumed = false;
  service.setS3Send(async (command) => {
    commands.push(command);
    return {
      LastModified: new Date('2026-11-03T12:00:00Z'),
      Body: { transformToString: async () => { consumed = true; return 'stale-calendar'; } },
    };
  });

  const body = await service.getFreshIcsFromS3(
    'fixture-bucket',
    'calendar/cubs-events.ics',
    24 * 60 * 60 * 1000,
    Date.parse('2026-11-04T13:00:00Z'),
  );

  assert.equal(body, null);
  assert.equal(consumed, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'GetObjectCommand');
});

test('real Scouts API handler publishes full-enrich and HEX-canonical mutations', async () => {
  const service = await loadService();
  const full = await service.handler(request({ realm: 'scouts', action: 'generateFull', subject: { hex: HEX } }));
  assert.equal(full.statusCode, 200);
  assert.equal(service.sent.length, 1);
  const fullMessage = JSON.parse(service.sent[0].MessageBody);
  assert.equal(fullMessage.realm, 'scoutsRequest');
  assert.equal(fullMessage.action, 'new');
  assert.equal(fullMessage.subject.hex, HEX);
  assert.equal(fullMessage.requestId, 'request-fixture');
  assert.equal(service.activities[0].state, 'queued');

  const hide = await service.handler(request({ realm: 'scouts', action: 'hide', subject: { hex: HEX, occurrenceId: OCCURRENCE, isHidden: true } }));
  assert.equal(hide.statusCode, 200);
  const hideMessage = JSON.parse(service.sent[1].MessageBody);
  assert.deepEqual(hideMessage.subject, { hex: HEX, isHidden: true }, JSON.stringify(hideMessage));
  assert.equal(hideMessage.visibilityIntent, 'hide');

  const approve = await service.handler(request({ realm: 'scouts', action: 'approve', subject: { hex: HEX, isApproved: true } }));
  assert.equal(approve.statusCode, 200);
  const approveMessage = JSON.parse(service.sent[2].MessageBody);
  assert.equal(approveMessage.subject.isApproved, true);

  const unhide = await service.handler(request({ realm: 'scouts', action: 'unhide', subject: { hex: HEX, occurrenceId: OCCURRENCE, isHidden: false } }));
  assert.equal(unhide.statusCode, 200);
  const unhideMessage = JSON.parse(service.sent[3].MessageBody);
  assert.deepEqual(unhideMessage.subject, { hex: HEX, isHidden: false });
  assert.equal(unhideMessage.visibilityIntent, 'unhide');
});

test('real Scouts API handler accepts HEX-wide visibility without an occurrence selector', async () => {
  const service = await loadService();
  const hide = await service.handler(request({ realm: 'scouts', action: 'hide', subject: { hex: HEX, isHidden: true } }));
  assert.equal(hide.statusCode, 200);
  const hideMessage = JSON.parse(service.sent[0].MessageBody);
  assert.deepEqual(hideMessage.subject, { hex: HEX, isHidden: true });
  assert.equal(hideMessage.realm, 'persist');
});

test('real Scouts API handler rejects a missing API key before publishing', async () => {
  const service = await loadService();
  const response = await service.handler(request({ realm: 'scouts', action: 'generateFull', subject: { hex: HEX } }, null));
  assert.equal(response.statusCode, 403);
  assert.equal(service.sent.length, 0);
});
