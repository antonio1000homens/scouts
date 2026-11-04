import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const entryPath = path.resolve(import.meta.dirname, '../scouts-entry.mjs');

function command(name) {
  return class {
    constructor(input) { this.input = input; this.name = name; }
  };
}

async function loadEntry({ snapshotsEnabled = false } = {}) {
  const s3Commands = [];
  const context = vm.createContext({
    Buffer,
    URL,
    Date,
    console: { info() {}, log() {}, warn() {}, error() {} },
    process: { env: { SCOUTS_LEGACY_RUNTIME_SNAPSHOTS: String(snapshotsEnabled) } },
  });
  const module = new vm.SourceTextModule(readFileSync(entryPath, 'utf8'), {
    context,
    identifier: entryPath,
  });
  const modules = new Map();
  const synthetic = (specifier, exports) => {
    const result = new vm.SyntheticModule(Object.keys(exports), function initialize() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: specifier });
    modules.set(specifier, result);
    return result;
  };
  const linker = async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier === 'crypto') return synthetic(specifier, { default: crypto });
    if (specifier === '@aws-sdk/client-dynamodb') return synthetic(specifier, {
      BatchGetItemCommand: command('BatchGetItemCommand'),
      DynamoDBClient: class { async send() { throw new Error('Unexpected DynamoDB call'); } },
      UpdateItemCommand: command('UpdateItemCommand'),
    });
    if (specifier === '@aws-sdk/client-s3') return synthetic(specifier, {
      GetObjectCommand: command('GetObjectCommand'),
      ListObjectsV2Command: command('ListObjectsV2Command'),
      S3Client: class { async send(request) { s3Commands.push(request); throw new Error('Unexpected S3 call'); } },
    });
    if (specifier === '@aws-sdk/client-sqs') return synthetic(specifier, {
      SendMessageCommand: command('SendMessageCommand'),
      SQSClient: class { async send() { throw new Error('Unexpected SQS call'); } },
    });
    if (specifier === '/opt/nodejs/ssm-secrets.mjs') return synthetic(specifier, {
      getRequiredSecret: async () => 'fixture-api-key',
    });
    if (specifier === '/opt/nodejs/request-activity.mjs') return synthetic(specifier, {
      recordRequestActivity: async () => null,
      withRequestActivityContext: async (_context, callback) => callback(),
    });
    if (specifier === '/opt/nodejs/approval-coordinator.mjs') return synthetic(specifier, {
      coordinateEventApproval: async () => ({ ok: false }),
    });
    if (specifier === '/opt/nodejs/event-review.mjs') return synthetic(specifier, {
      buildEventReviewSnapshot: async () => null,
    });
    if (specifier === '/opt/nodejs/enrichment-state.mjs') return synthetic(specifier, {
      normaliseEnrichmentStage: (stage) => stage,
      retryManualReviewEnrichment: async () => null,
    });
    if (specifier === './agenda-hex-repair.mjs') return synthetic(specifier, {
      repairAgendaHexMetadata: async () => ({ repairedCount: 0, missingCount: 0, prunedCount: 0, renamedHexResetCount: 0 }),
    });
    if (specifier === './s3-request-metrics.mjs') return synthetic(specifier, {
      runWithS3RequestMetrics: (_source, callback) => callback(),
      sendS3Command: async (client, request) => client.send(request),
      s3ObjectCategory: () => 'runtime',
    });
    if (specifier === './scouts-service.mjs') return synthetic(specifier, {
      handler: async () => ({ statusCode: 200, body: '{}' }),
    });
    if (specifier === './runtime-activity.mjs') return synthetic(specifier, {
      buildRuntimeActivity: async () => ({ requests: [] }),
    });
    if (specifier === './runtime-dlq.mjs') return synthetic(specifier, {
      getRuntimeQueueStatus: async () => ({ queues: [] }),
      inspectRuntimeDlq: async () => ({ messages: [] }),
      redriveRuntimeDlq: async () => ({ redriven: 0 }),
    });
    if (specifier === './runtime-deferred-refresh.mjs') return synthetic(specifier, {
      drainDeferredRefreshQueue: async () => ({ dispatched: 0 }),
      getDeferredRefreshStatus: async () => ({}),
    });
    if (specifier === './runtime-schedule.mjs') return synthetic(specifier, {
      getScheduledRefreshSettings: async () => ({ enabled: false }),
      getScheduledRefreshStatus: async () => ({ health: 'ok' }),
      isScheduledRefreshInvocation: () => false,
      setScheduledRefreshEnabled: async () => ({ health: 'ok' }),
    });
    throw new Error(`Unhandled import ${specifier}`);
  };

  await module.link(linker);
  await module.evaluate();
  return { handler: module.namespace.handler, s3Commands };
}

function snapshotRequest(apiKey = 'fixture-api-key', snapshot = 'queued') {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    body: JSON.stringify({ realm: 'runtime', subject: 'snapshot', action: 'get', snapshot }),
  };
}

test('authenticated legacy snapshot requests return 410 before reading S3 when retired', async () => {
  const { handler, s3Commands } = await loadEntry({ snapshotsEnabled: false });

  const result = await handler(snapshotRequest());

  assert.equal(result.statusCode, 410);
  assert.equal(JSON.parse(result.body).status, 'retired');
  assert.equal(s3Commands.length, 0);
});

test('legacy snapshot route still requires the admin API key', async () => {
  const { handler, s3Commands } = await loadEntry({ snapshotsEnabled: false });

  const result = await handler(snapshotRequest(null));

  assert.equal(result.statusCode, 403);
  assert.equal(s3Commands.length, 0);
});
