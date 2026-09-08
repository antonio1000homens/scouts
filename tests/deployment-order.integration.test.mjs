import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
const scoutsDeploy = readFileSync('lambdas/scouts/deploy.sh', 'utf8');
const imageEnrichDecommission = readFileSync('lambdas/scouts-image-enrich/decommission.sh', 'utf8');
const adminIndex = readFileSync('website/admin/index.html', 'utf8');
const adminSimplify = readFileSync('website/admin/admin-simplify.js', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');

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

test('service changes still pull in the queues prerequisite', () => {
  assert.match(workflow, /if \[ "\$\{scouts_function\}" = 'true' \] \|\| \[ "\$\{scouts2sqs\}" = 'true' \] \|\| \[ "\$\{sqs2scouts\}" = 'true' \]; then\n\s*scouts_queues=true/);
});

test('manual scouts2sqs target preserves prerequisite semantics without forcing sqs2scouts', () => {
  assert.match(workflow, /scouts2sqs\) aws_bootstrap=true; scouts_queues=true; scouts2sqs=true ;;/);
  assert.doesNotMatch(workflow, /scouts2sqs\)[^\n]*sqs2scouts=true/);
});

test('PRs validate but never enter deployment lanes', () => {
  assert.match(workflow, /deploy-web:[\s\S]*if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /deploy-aws:[\s\S]*github\.event_name != 'pull_request'/);
});

test('Scouts deployment resolves the managed full-enrich stack before historical fallback', () => {
  const managed = scoutsDeploy.indexOf('scouts-full-enrich-managed-poc scouts-full-enrich');
  assert.notEqual(managed, -1, 'managed and fallback stack lookup must be explicit');
  assert.match(scoutsDeploy, /for candidate_stack in scouts-full-enrich-managed-poc scouts-full-enrich; do/);
  assert.match(scoutsDeploy, /StateMachineArn could not be resolved from scouts-full-enrich-managed-poc or scouts-full-enrich/);
});

test('legacy image-enrich decommission resolves stack-owned ARN and fails closed', () => {
  assert.doesNotMatch(imageEnrichDecommission, /list-state-machines/);
  assert.match(imageEnrichDecommission, /Outputs\[\?OutputKey=='StateMachineArn'\]\.OutputValue \| \[0\]/);
  assert.match(imageEnrichDecommission, /does not expose StateMachineArn; refusing to decommission/);
  assert.match(imageEnrichDecommission, /--status-filter RUNNING/);
  assert.match(imageEnrichDecommission, /--max-results 1/);
  assert.match(imageEnrichDecommission, /Unable to verify running executions[^\n]*refusing to decommission/);
});

test('admin polling is synchronously cut over to canonical full-enrich activity', () => {
  const legacyScriptIndex = adminIndex.indexOf('<script src="admin-script.js"></script>');
  const simplifyScriptIndex = adminIndex.indexOf('<script src="admin-simplify.js"></script>');
  assert.notEqual(legacyScriptIndex, -1);
  assert.notEqual(simplifyScriptIndex, -1);
  assert.ok(legacyScriptIndex < simplifyScriptIndex, 'admin-simplify must load after the legacy controller it overrides');

  assert.match(adminSimplify, /legacySendScoutsCommand\(\{ realm: 'runtime', subject: 'activity', action: 'status' \}\)/);
  assert.match(adminSimplify, /pollQueueDepthSnapshots = pollAuthoritativeActivity;/);
  assert.match(scoutsEntry, /buildRuntimeActivity/);
  assert.match(scoutsEntry, /realm\)\.toLowerCase\(\) === 'runtime'/);
  assert.match(scoutsEntry, /subject\)\.toLowerCase\(\) === 'activity'/);
  assert.match(runtimeActivity, /fullEnrich: workflowSummary\(FULL_ENRICH_STATE_MACHINE_ARN, fullExecutions\)/);
  assert.doesNotMatch(runtimeActivity, /imageEnrich:\s*workflowSummary/);
});
