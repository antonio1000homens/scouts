import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';

const sourcePath = path.resolve(import.meta.dirname, '../persistence-processor.mjs');
const HEX = '686f6c69646179';
const OCCURRENCE_A = 'occ_0123456789abcdef01234567';
const OCCURRENCE_B = 'occ_89abcdef0123456789abcdef';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function body(value) {
  return { transformToString: async () => JSON.stringify(value) };
}

function command(name) {
  return class {
    constructor(input) {
      this.input = input;
      this.name = name;
    }
  };
}

async function loadPersistenceModule(store, sentMessages) {
  const S3Client = class {
    async send(request) {
      const { Key } = request.input;
      if (request.name === 'GetObjectCommand') {
        if (!(Key in store)) {
          const error = new Error(`Missing ${Key}`);
          error.name = 'NoSuchKey';
          throw error;
        }
        return { Body: body(store[Key]), ETag: '"fixture"' };
      }
      if (request.name === 'PutObjectCommand') {
        store[Key] = JSON.parse(Buffer.from(request.input.Body).toString('utf8'));
        return { ETag: '"fixture-after"' };
      }
      throw new Error(`Unexpected S3 command ${request.name}`);
    }
  };
  const sqsClient = { send: async (request) => { sentMessages.push(request.input); return {}; } };
  const sfnClient = { send: async () => ({}) };
  const context = vm.createContext({
    Buffer,
    URL,
    console,
    process,
    setTimeout,
    clearTimeout,
  });
  const module = new vm.SourceTextModule(readFileSync(sourcePath, 'utf8'), {
    context,
    identifier: sourcePath,
    initializeImportMeta(meta) {
      meta.url = `file://${sourcePath}`;
    },
  });
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
    if (specifier === 'node:async_hooks') return synthetic(specifier, { AsyncLocalStorage });
    if (specifier === '@aws-sdk/client-s3') return synthetic(specifier, { S3Client, GetObjectCommand: command('GetObjectCommand'), PutObjectCommand: command('PutObjectCommand') });
    if (specifier === '@aws-sdk/client-sqs') return synthetic(specifier, { SQSClient: class {}, SendMessageCommand: command('SendMessageCommand'), GetQueueAttributesCommand: command('GetQueueAttributesCommand') });
    if (specifier === '@aws-sdk/client-sfn') return synthetic(specifier, { SFNClient: class {}, SendTaskFailureCommand: command('SendTaskFailureCommand'), SendTaskSuccessCommand: command('SendTaskSuccessCommand') });
    if (specifier === 'crypto') return synthetic(specifier, { default: { randomUUID: () => 'fixture-request', randomBytes: () => Buffer.from('fixture') } });
    if (specifier === 'https') return synthetic(specifier, { default: { request: () => { throw new Error('Unexpected HTTPS call'); } } });
    if (specifier === 'fs') return synthetic(specifier, { readFileSync: (file) => String(file).endsWith('scouts.conf') ? JSON.stringify({}) : readFileSync(file) });
    if (specifier === 'sharp') return synthetic(specifier, { default: () => ({}) });
    if (specifier === '/opt/nodejs/ssm-secrets.mjs') return synthetic(specifier, { getOptionalSecret: async () => null, getRequiredSecret: async () => 'fixture-secret' });
    if (specifier === '/opt/nodejs/request-activity.mjs') return synthetic(specifier, { recordRequestActivity: async () => null });
    if (specifier === '/opt/nodejs/image-output-contract.mjs') return synthetic(specifier, {
      resolveCanonicalImageDimensions: () => ({ width: 1200, height: 900 }),
      normaliseGeneratedJpeg: async (buffer) => buffer,
    });
    if (specifier === '/opt/nodejs/enrichment-state.mjs') {
      return synthetic(specifier, {
        buildGenerationId: () => 'fixture-generation', getEnrichmentState: async () => null,
        reserveEnrichmentAttempt: async () => ({}), markGeminiSucceeded: async () => ({}),
        markEnrichmentSucceeded: async () => ({}), markEnrichmentFailure: async () => ({}),
        loadReusableGeneration: async () => null, evaluateEnrichmentEligibility: async () => ({ eligible: true }),
        claimEnrichmentEscalation: async () => ({}), enrichmentStateConfig: {},
      });
    }
    if (specifier.endsWith('/agenda-publisher.mjs')) {
      return synthetic(specifier, { publishCanonicalEventToAgenda: async ({ loadAgenda, writeAgenda, occurrenceId, visibility, hex, event }) => {
        const agenda = await loadAgenda();
        agenda.events = agenda.events.map((entry) => {
          if (entry?.metadata?.hex !== hex || (occurrenceId && entry.occurrenceId !== occurrenceId)) return entry;
          return { ...entry, metadata: { ...entry.metadata, image: clone(event.metadata.image), tagline: event.metadata.tagline, status: { ...entry.metadata.status, isHidden: typeof visibility === 'boolean' ? visibility === true : entry.metadata.status.isHidden } } };
        });
        await writeAgenda(agenda);
        return { matched: 1 };
      } });
    }
    if (specifier.endsWith('/occurrence-identity.mjs')) return synthetic(specifier, { occurrenceStorageKey: (id) => `occurrences/${id}.json` });
    if (specifier.endsWith('/gemini-text-models.mjs')) return synthetic(specifier, { generateGeminiTextWithFallback: async () => ({}), parseGeminiTextModels: () => [], GEMINI_TEXT_RESPONSE_SCHEMAS: {}, validateGeminiTextResponse: () => ({}) });
    if (specifier.endsWith('/runtime-request-entry.mjs')) return synthetic(specifier, { buildRuntimeRequestEntry: () => ({}) });
    if (specifier.endsWith('/slack-decision-sync.mjs')) return synthetic(specifier, { reconcileSlackDecision: async () => ({ decision: { status: 'PERSISTED' } }) });
    throw new Error(`Unhandled import ${specifier}`);
  };
  await module.link(linker);
  await module.evaluate();
  return {
    createPersistenceHandler: module.namespace.createPersistenceHandler,
  };
}

function fixtureStore() {
  const canonical = {
    title: 'Holiday',
    uid: 'uid-holiday',
    metadata: {
      hex: HEX,
      tagline: 'School holiday',
      image: { theme: 'calendar', url: '/website/eventImages/holiday.webp' },
      status: { isHidden: false, isApproved: false },
    },
  };
  return {
    [`events/${HEX}.json`]: canonical,
    'agenda.json': {
      events: [
        { occurrenceId: OCCURRENCE_A, uid: 'uid-a', metadata: clone(canonical.metadata) },
        { occurrenceId: OCCURRENCE_B, uid: 'uid-b', metadata: clone(canonical.metadata) },
      ],
    },
    'scouts.conf': {},
  };
}

test('real persistence handler exercises SQS messageBody occurrence hide and unhide boundaries', async () => {
  const store = fixtureStore();
  const sentMessages = [];
  const activity = [];
  const { createPersistenceHandler } = await loadPersistenceModule(store, sentMessages);
  const handler = createPersistenceHandler({
    recordRequestActivity: async (entry) => activity.push(entry),
    s3Client: { send: async (request) => {
      const { Key } = request.input;
      if (request.name === 'GetObjectCommand') {
        if (!(Key in store)) { const error = new Error('Missing'); error.name = 'NoSuchKey'; throw error; }
        return { Body: body(store[Key]), ETag: '"fixture"' };
      }
      if (request.name === 'PutObjectCommand') { store[Key] = JSON.parse(Buffer.from(request.input.Body).toString('utf8')); return { ETag: '"fixture-after"' }; }
      throw new Error(`Unexpected S3 command ${request.name}`);
    } },
    sqsClient: { send: async (request) => { sentMessages.push(request.input); return {}; } },
    publishCanonicalEventToAgenda: async ({ loadAgenda, writeAgenda, occurrenceId, visibility, hex, event }) => {
      const agenda = await loadAgenda();
      agenda.events = agenda.events.map((entry) => entry.metadata.hex === hex
        && (!occurrenceId || entry.occurrenceId === occurrenceId)
        ? { ...entry, metadata: { ...entry.metadata, status: { ...entry.metadata.status, isHidden: visibility === true } } }
        : entry);
      await writeAgenda(agenda);
      return { matched: 1 };
    },
  });
  const invoke = async (requestId, occurrenceId, isHidden) => handler({ Records: [{ eventSource: 'aws:sqs', messageId: `message-${requestId}`, body: JSON.stringify({
    realm: 'persist', operation: 'persist', requestId, rootRequestId: 'root-visibility', occurrenceId,
    hex: HEX, subject: HEX, action: JSON.stringify({ metadata: { hex: HEX, status: { isHidden } } }),
  }) }] });

  const hideResult = await invoke('request-hide', OCCURRENCE_A, true);
  assert.equal(hideResult.statusCode, 200, hideResult.body);
  assert.equal(store[`occurrences/${OCCURRENCE_A}.json`].status.isHidden, true);
  assert.equal(store['agenda.json'].events.find((entry) => entry.occurrenceId === OCCURRENCE_A).metadata.status.isHidden, true);
  assert.equal(store['agenda.json'].events.find((entry) => entry.occurrenceId === OCCURRENCE_B).metadata.status.isHidden, false);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, false);
  assert.equal(activity.at(-1).state, 'completed');

  assert.equal((await invoke('request-hide', OCCURRENCE_A, true)).statusCode, 200);
  assert.equal(store['agenda.json'].events.find((entry) => entry.occurrenceId === OCCURRENCE_B).metadata.status.isHidden, false);

  await invoke('request-unhide', OCCURRENCE_A, false);
  assert.equal(store[`occurrences/${OCCURRENCE_A}.json`].status.isHidden, false);
  assert.equal(store['agenda.json'].events.find((entry) => entry.occurrenceId === OCCURRENCE_A).metadata.status.isHidden, false);
  assert.equal(store['agenda.json'].events.find((entry) => entry.occurrenceId === OCCURRENCE_B).metadata.status.isHidden, false);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, false);
  assert.equal(activity.at(-1).state, 'completed');
  assert.equal(sentMessages.length, 3);

  await invoke('request-hide-wide', undefined, true);
  assert.equal(store[`occurrences/${OCCURRENCE_A}.json`].status.isHidden, true);
  assert.equal(store[`occurrences/${OCCURRENCE_B}.json`].status.isHidden, true);
  assert.equal(store['agenda.json'].events.every((entry) => entry.metadata.status.isHidden === true), true);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, false);
  assert.equal(activity.at(-1).state, 'completed');
  assert.equal(sentMessages.length, 4);
});

test('real persistence handler rejects an occurrence read-back mismatch and records attention', async () => {
  const store = fixtureStore();
  const activity = [];
  const sentMessages = [];
  const { createPersistenceHandler } = await loadPersistenceModule(store, sentMessages);
  const handler = createPersistenceHandler({
    recordRequestActivity: async (entry) => activity.push(entry),
    s3Client: { send: async (request) => {
      const { Key } = request.input;
      if (request.name === 'GetObjectCommand') {
        if (!(Key in store)) { const error = new Error('Missing'); error.name = 'NoSuchKey'; throw error; }
        const value = Key.startsWith('occurrences/') ? { ...store[Key], status: { isHidden: false } } : store[Key];
        return { Body: body(value), ETag: '"fixture"' };
      }
      if (request.name === 'PutObjectCommand') { store[Key] = JSON.parse(Buffer.from(request.input.Body).toString('utf8')); return { ETag: '"fixture-after"' }; }
      throw new Error(`Unexpected S3 command ${request.name}`);
    } },
    sqsClient: { send: async (request) => { sentMessages.push(request.input); return {}; } },
  });
  const result = await handler({ Records: [{ eventSource: 'aws:sqs', messageId: 'message-mismatch', body: JSON.stringify({
    realm: 'persist', operation: 'persist', requestId: 'request-mismatch', hex: HEX, occurrenceId: OCCURRENCE_A,
    subject: HEX, action: JSON.stringify({ metadata: { hex: HEX, status: { isHidden: true } } }),
  }) }] });
  assert.equal(result.statusCode, 500);
  assert.equal(activity.at(-1).state, 'needs_attention');
  assert.equal(sentMessages.length, 1, 'only the processing DLQ message should be emitted');
  assert.match(sentMessages[0].MessageBody, /Occurrence visibility read-back mismatch/);
});
