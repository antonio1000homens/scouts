import assert from 'node:assert/strict';
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
  const S3Client = class { async send() { return {}; } };
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
    if (specifier === '/opt/nodejs/ssm-secrets.mjs') return synthetic(specifier, { getRequiredSecret: async () => 'fixture-key' });
    if (specifier === '/opt/nodejs/request-activity.mjs') return synthetic(specifier, { recordRequestActivity: async (entry) => { activities.push(entry); return entry; } });
    if (specifier === '/opt/nodejs/enrichment-state.mjs') return synthetic(specifier, { getEnrichmentState: async () => null, evaluateEnrichmentEligibility: async () => ({ eligible: true }), buildGenerationId: () => 'fixture-generation' });
    if (specifier === '/opt/nodejs/occurrence-identity.mjs') return synthetic(specifier, { resolveOccurrenceId: () => OCCURRENCE, occurrenceStorageKey: (id) => `occurrences/${id}.json` });
    throw new Error(`Unhandled import ${specifier}`);
  };
  await module.link(linker);
  await module.evaluate();
  return { handler: module.namespace.lambdaHandler, sent, activities };
}

function request(body, apiKey = 'fixture-key') {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: apiKey === null ? {} : { 'x-api-key': apiKey },
    body: JSON.stringify(body),
  };
}

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
