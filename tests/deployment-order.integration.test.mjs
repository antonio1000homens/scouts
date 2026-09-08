import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
const scoutsDeploy = readFileSync('lambdas/scouts/deploy.sh', 'utf8');
const sqs2scoutsDeploy = readFileSync('lambdas/sqs2scouts/deploy.sh', 'utf8');
const scouts2sqsDeploy = readFileSync('lambdas/scouts2sqs/deploy.sh', 'utf8');
const slackDeploy = readFileSync('lambdas/scouts-slack-handler/deploy.sh', 'utf8');
const sharedLayerResolver = readFileSync('lambdas/tools/shared-layer-artifact.sh', 'utf8');
const sharedLayerDeploy = readFileSync('lambdas/shared-layer/deploy.sh', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const sqs2scoutsTemplate = readFileSync('lambdas/cloudformation/templates/sqs2scouts.yaml', 'utf8');
const scouts2sqsTemplate = readFileSync('lambdas/cloudformation/templates/scouts2sqs.yaml', 'utf8');
const slackTemplate = readFileSync('lambdas/cloudformation/templates/slack-handler.yaml', 'utf8');
const adminIndex = readFileSync('website/admin/index.html', 'utf8');
const adminScript = readFileSync('website/admin/admin-script.js', 'utf8');
const adminSimplify = readFileSync('website/admin/admin-simplify.js', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const agendaHexRepair = readFileSync('lambdas/scouts/function/agenda-hex-repair.mjs', 'utf8');
const deployEntry = readFileSync('deploy.sh', 'utf8');

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
  const verify = indexOfRequired('- name: Verify sqs2scouts worker', 'sqs2scouts verification step');
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

test('modern cutover removes the retired image-enrich deployment target', () => {
  assert.doesNotMatch(workflow, /scouts_image_enrich/);
  assert.doesNotMatch(workflow, /scouts-image-enrich/);
  assert.doesNotMatch(workflow, /Deploy image-enrich state machine/);
});

test('worker and ingress deployment handlers match the modern cutover', () => {
  assert.match(sqs2scoutsDeploy, /HANDLER="\$\{HANDLER:-image-provider-adapter\.lambdaHandler\}"/);
  assert.match(scouts2sqsDeploy, /HANDLER="\$\{HANDLER:-request-router\.lambdaHandler\}"/);
  assert.match(workflow, /\[ "\$HANDLER" = "image-provider-adapter\.lambdaHandler" \]/);
  assert.doesNotMatch(workflow, /full-enrich-adapter\.lambdaHandler/);
});

test('shared layer is content-addressed and published centrally', () => {
  assert.match(sharedLayerResolver, /shared_layer_source_hash/);
  assert.match(sharedLayerResolver, /! -name '\*\.test\.mjs'/);
  assert.match(sharedLayerResolver, /! -name '\*\.integration\.test\.mjs'/);
  assert.match(sharedLayerResolver, /lambdas\/shared-layer\/\$\{layer_hash\}\/scouts-shared-layer\.zip/);
  assert.match(sharedLayerResolver, /lambda list-layer-versions/);
  assert.match(sharedLayerResolver, /source-sha256:\$\{layer_hash\}/);
  assert.match(sharedLayerResolver, /lambda publish-layer-version/);
  assert.match(sharedLayerResolver, /SCOUTS_SHARED_LAYER_VERSION_ARN/);
  assert.match(sharedLayerDeploy, /resolve_shared_layer_version/);
  assert.match(sharedLayerDeploy, /GITHUB_ENV/);
});

test('shared layer resolver rechecks after artifact preparation before publishing', () => {
  const prepareIndex = sharedLayerResolver.indexOf('prepare_shared_layer_zip');
  const recheckMarkerIndex = sharedLayerResolver.indexOf('Another deployment may have published');
  const publishIndex = sharedLayerResolver.indexOf('aws lambda publish-layer-version');
  assert.notEqual(prepareIndex, -1);
  assert.notEqual(recheckMarkerIndex, -1);
  assert.notEqual(publishIndex, -1);
  assert.ok(prepareIndex < recheckMarkerIndex, 'concurrency recheck must happen after artifact preparation');
  assert.ok(recheckMarkerIndex < publishIndex, 'concurrency recheck must happen before publishing');
  assert.match(sharedLayerResolver, /Reusing concurrently published shared Lambda layer version/);
});

test('CI resolves one shared layer before any Lambda consumer deploys', () => {
  const resolver = indexOfRequired('- name: Resolve shared Lambda layer version', 'shared layer resolver step');
  const sqs2scouts = indexOfRequired('- name: Deploy sqs2scouts', 'sqs2scouts deployment step');
  const scouts2sqs = indexOfRequired('- name: Deploy scouts2sqs', 'scouts2sqs deployment step');
  const scouts = indexOfRequired('- name: Deploy Scouts function', 'Scouts deployment step');
  const slack = indexOfRequired('- name: Deploy Scouts Slack handler', 'Slack deployment step');

  assert.ok(resolver < sqs2scouts);
  assert.ok(resolver < scouts2sqs);
  assert.ok(resolver < scouts);
  assert.ok(resolver < slack);
  assert.match(workflow, /run: bash lambdas\/shared-layer\/deploy\.sh/);
  assert.match(workflow, /needs\.plan-and-test\.outputs\.sqs2scouts == 'true'[\s\S]*needs\.plan-and-test\.outputs\.scouts_slack_handler == 'true'/);
});

test('shared-layer test changes run safety tests without redeploying all consumers', () => {
  assert.match(workflow, /lambdas\/shared-layer\/nodejs\/\*\.test\.mjs\|lambdas\/shared-layer\/nodejs\/\*\.integration\.test\.mjs\)\n\s*;;/);
  assert.match(workflow, /lambdas\/shared-layer\/nodejs\/\*\.mjs\|lambdas\/shared-layer\/nodejs\/package\.json\|lambdas\/shared-layer\/nodejs\/package-lock\.json\)[\s\S]*scouts_function=true[\s\S]*scouts_slack_handler=true[\s\S]*scouts2sqs=true[\s\S]*sqs2scouts=true/);
  assert.match(workflow, /lambdas\/shared-layer\/\*\|[\s\S]*retry_safety=true/);
});

test('function stacks consume a shared layer ARN and no longer publish LayerVersion resources', () => {
  for (const [name, template] of [
    ['scouts', scoutsTemplate],
    ['sqs2scouts', sqs2scoutsTemplate],
    ['scouts2sqs', scouts2sqsTemplate],
    ['slack-handler', slackTemplate],
  ]) {
    assert.match(template, /SharedLayerVersionArn:/, `${name} must accept the central layer ARN`);
    assert.match(template, /HasSharedLayerVersionArn/, `${name} must prefer the central layer ARN`);
    assert.doesNotMatch(template, /Type: AWS::Lambda::LayerVersion/, `${name} must not publish its own layer version`);
  }
});

test('sqs2scouts uses the canonical enrichment-state environment variable name', () => {
  assert.match(sqs2scoutsTemplate, /GEMINI_ENRICHMENT_STATE_TABLE_NAME:\s*!Ref GeminiEnrichmentStateTableName/);
  assert.doesNotMatch(sqs2scoutsTemplate, /GEMINI_ENRICH_STATE_TABLE_NAME:/);
});

test('local deploy scripts keep using the shared resolver compatibility entrypoint', () => {
  for (const [name, deploy] of [
    ['scouts', scoutsDeploy],
    ['sqs2scouts', sqs2scoutsDeploy],
    ['scouts2sqs', scouts2sqsDeploy],
    ['slack-handler', slackDeploy],
  ]) {
    assert.match(deploy, /shared-layer-artifact\.sh/, `${name} must source the shared resolver`);
    assert.match(deploy, /prepare_shared_layer_artifact/, `${name} must resolve the shared layer before CloudFormation`);
  }
  assert.match(sharedLayerResolver, /Using supplied shared Lambda layer/);
});

test('Scouts deployment resolves the managed full-enrich stack before historical fallback', () => {
  const managed = scoutsDeploy.indexOf('scouts-full-enrich-managed-poc scouts-full-enrich');
  assert.notEqual(managed, -1, 'managed and fallback stack lookup must be explicit');
  assert.match(scoutsDeploy, /for candidate_stack in scouts-full-enrich-managed-poc scouts-full-enrich; do/);
  assert.match(scoutsDeploy, /StateMachineArn could not be resolved from scouts-full-enrich-managed-poc or scouts-full-enrich/);
});

test('Scouts Lambda packaging includes every local module imported by the deployed entrypoint', () => {
  assert.match(scoutsEntry, /from '\.\/agenda-hex-repair\.mjs'/);
  assert.match(scoutsDeploy, /zip -q scouts-lambda\.zip[\s\S]*agenda-hex-repair\.mjs/);
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
  assert.match(scoutsEntry, /text\(body\?\.realm\)\.toLowerCase\(\) !== 'runtime'/);
  assert.match(scoutsEntry, /command\.subject === 'activity'/);
  assert.match(scoutsEntry, /command\.action === 'status'/);
  assert.match(runtimeActivity, /fullEnrich: workflowSummary\(FULL_ENRICH_STATE_MACHINE_ARN, fullExecutions\)/);
  assert.doesNotMatch(runtimeActivity, /imageEnrich:\s*workflowSummary/);
});

test('calendar refresh backfills canonical agenda HEX independently of enrichment publication', () => {
  assert.match(agendaHexRepair, /Buffer\.from\(normalized, 'utf8'\)\.toString\('hex'\)/);
  assert.match(agendaHexRepair, /metadata\.hex \|\| event\.hex \|\| event\.hexId/);
  assert.match(agendaHexRepair, /event\.summary \?\? event\.title/);
  assert.match(agendaHexRepair, /event\.metadata = \{[\s\S]*hex: derivedHex/);
  assert.match(agendaHexRepair, /PutObjectCommand/);
  assert.match(agendaHexRepair, /Key: AGENDA_KEY/);

  assert.match(scoutsEntry, /repairAgendaHexMetadata/);
  assert.match(scoutsEntry, /function isCalendarRefreshInvocation/);
  assert.match(scoutsEntry, /action\.startsWith\('refresh'\)/);
  assert.match(scoutsEntry, /return invokeScoutsService\(trustedInternalEvent\)/);
  assert.match(scoutsEntry, /return invokeScoutsService\(event\)/);
  assert.match(scoutsEntry, /maxEvents: schedule\.maxQueuePublishesPerRun/);
});

test('website deployment never publishes the Lambda URL into browser config', () => {
  assert.match(deployEntry, /ADMIN_API_BASE_VALUE="\$\{ADMIN_API_BASE:-\/admin-api\}"/);
  assert.match(deployEntry, /Keep the Lambda URL server-side in the Cloudflare Worker/);
  assert.doesNotMatch(deployEntry, /echo "window\.SCOUTS_URL/);
  assert.match(workflow, /Generate admin runtime config[\s\S]*ADMIN_API_BASE_VALUE/);
  assert.doesNotMatch(workflow, /echo "window\.SCOUTS_URL/);
  assert.doesNotMatch(workflow, /SCOUTS_URL: \$\{\{ vars\./);
  assert.match(workflow, /case "\$\{file\}" in index\.html\|deploy\.sh\|deploy-manual\.sh/);
  assert.match(workflow, /deploy\.sh\|lambdas\/shared-layer/);
});

test('admin refresh commands use the authenticated proxy routes', () => {
  assert.match(adminIndex, /onclick="refreshSelectedCalendar\('all', 'All Calendars', this\.value\)"/);
  assert.match(adminIndex, /onclick="refreshLambda\(this\.value\)"/);
  assert.match(adminScript, /const SCOUTS_URL = configuredScoutsUrl\.startsWith\('\/'\)/);
  assert.match(adminScript, /fetch\(SCOUTS_URL, \{[\s\S]*credentials: 'same-origin'/);
});
