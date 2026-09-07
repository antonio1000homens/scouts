import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');

function jobBlock(name, nextName = null) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing following workflow job ${nextName}`);
  return workflow.slice(start, end);
}

test('sqs2scouts evaluates after skipped prerequisites', () => {
  const block = jobBlock('deploy-sqs2scouts');
  assert.match(block, /if:\s*\|\s*\n\s*always\(\)\s*&&/);
  assert.match(block, /needs\.deploy-scouts-queues\.result == 'success'/);
  assert.match(block, /needs\.deploy-scouts-queues\.result == 'skipped'/);
});

test('scouts2sqs waits for sqs2scouts deployment result', () => {
  const block = jobBlock('deploy-scouts2sqs', 'deploy-sqs2scouts');
  assert.match(block, /needs:\s*\[[^\]]*deploy-sqs2scouts[^\]]*\]/);
  assert.match(block, /needs\.deploy-sqs2scouts\.result == 'success'/);
  assert.match(block, /needs\.deploy-sqs2scouts\.result == 'skipped'/);
});
