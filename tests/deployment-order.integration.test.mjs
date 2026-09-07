import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');

function indexOfRequired(text, label) {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, `missing ${label}`);
  return index;
}

test('deployment workflow uses consolidated runner lanes', () => {
  assert.match(workflow, /\n  plan-and-test:\n/);
  assert.match(workflow, /\n  deploy-web:\n/);
  assert.match(workflow, /\n  deploy-aws:\n/);

  assert.doesNotMatch(workflow, /\n  deploy-scouts-queues:\n/);
  assert.doesNotMatch(workflow, /\n  deploy-sqs2scouts:\n/);
  assert.doesNotMatch(workflow, /\n  deploy-scouts2sqs:\n/);
});

test('AWS deployment order keeps queues before sqs2scouts before scouts2sqs', () => {
  const queues = indexOfRequired('- name: Deploy Scouts queues', 'queues deployment step');
  const sqs2scouts = indexOfRequired('- name: Deploy sqs2scouts', 'sqs2scouts deployment step');
  const verify = indexOfRequired('- name: Verify sqs2scouts adapter', 'sqs2scouts verification step');
  const scouts2sqs = indexOfRequired('- name: Deploy scouts2sqs', 'scouts2sqs deployment step');

  assert.ok(queues < sqs2scouts, 'queues must deploy before sqs2scouts');
  assert.ok(sqs2scouts < verify, 'sqs2scouts must be verified after deployment');
  assert.ok(verify < scouts2sqs, 'scouts2sqs must run only after sqs2scouts verification');
});

test('manual scouts2sqs target preserves prerequisite semantics without forcing sqs2scouts', () => {
  assert.match(workflow, /scouts2sqs\) aws_bootstrap=true; scouts_queues=true; scouts2sqs=true ;;/);
  assert.doesNotMatch(workflow, /scouts2sqs\)[^\n]*sqs2scouts=true/);
});

test('PRs validate but never enter deployment lanes', () => {
  assert.match(workflow, /deploy-web:[\s\S]*if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /deploy-aws:[\s\S]*github\.event_name != 'pull_request'/);
});
