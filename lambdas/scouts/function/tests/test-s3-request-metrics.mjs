import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithS3RequestMetrics, sendS3Command } from '../s3-request-metrics.mjs';

const dataBucket = String(process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883').trim();

function command(name, bucket) {
  return {
    constructor: { name: `${name}Command` },
    input: bucket ? { Bucket: bucket, Key: 'private/key.json' } : {},
  };
}

test('S3 request summary separates configured data-bucket calls without logging bucket or key values', async () => {
  const logEntries = [];
  const originalLog = console.log;
  console.log = (...args) => logEntries.push(args);
  try {
    const client = { send: async () => ({}) };
    await runWithS3RequestMetrics('scheduled-refresh', async () => {
      await sendS3Command(client, command('GetObject', dataBucket));
      await sendS3Command(client, command('HeadObject', dataBucket));
      await sendS3Command(client, command('GetObject', 'another-private-bucket'));
      await sendS3Command(client, command('ListObjectsV2', null));
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0][0], '[S3 Request Reduction] SDK calls by operation');
  assert.deepEqual(logEntries[0][1], {
    source: 'scheduled-refresh',
    operationCounts: {
      GetObject: 2,
      HeadObject: 1,
      ListObjectsV2: 1,
    },
    bucketOperationCounts: {
      data: { GetObject: 1, HeadObject: 1 },
      other: { GetObject: 1 },
      unknown: { ListObjectsV2: 1 },
    },
    categoryOperationCounts: {
      other: { GetObject: 2, HeadObject: 1, ListObjectsV2: 1 },
    },
  });
  const logged = JSON.stringify(logEntries[0]);
  assert.doesNotMatch(logged, /another-private-bucket|private\/key\.json/);
});
