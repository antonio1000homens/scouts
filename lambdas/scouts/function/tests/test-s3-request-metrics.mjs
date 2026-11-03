import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithS3RequestMetrics, sendS3Command } from '../s3-request-metrics.mjs';

test('S3 SDK calls across nested Scouts helpers log once with aggregate operation counts', async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args);
  class GetObjectCommand {}
  class PutObjectCommand {}
  const client = { async send(command) { return { operation: command.constructor.name }; } };

  try {
    await runWithS3RequestMetrics('scheduled-refresh', async () => {
      await sendS3Command(client, new GetObjectCommand());
      await runWithS3RequestMetrics('non-scheduled', async () => {
        await sendS3Command(client, new GetObjectCommand());
        await sendS3Command(client, new PutObjectCommand());
      });
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], '[S3 Request Reduction] SDK calls by operation');
  assert.deepEqual(messages[0][1], {
    source: 'scheduled-refresh',
    operationCounts: { GetObject: 2, PutObject: 1 },
  });
});
