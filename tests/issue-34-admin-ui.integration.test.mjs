import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import './issue-43-runtime-activity.test.mjs';
import './issue-43-dlq-admin-enhancements.test.mjs';
import './issue-91-presentation.test.mjs';
import './issue-114-manual-job-recovery.test.mjs';
import '../lambdas/scouts/function/tests/test-dlq-activity.mjs';

const html = readFileSync('website/admin/index.html', 'utf8');
const simplify = readFileSync('website/admin/admin-simplify.js', 'utf8');
const css = readFileSync('website/admin/admin-simplify.css', 'utf8');
const adminScript = readFileSync('website/admin/admin-script.js', 'utf8');
const agendaRefresh = readFileSync('website/admin/admin-agenda-refresh.js', 'utf8');
const activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const diagnosticsEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const scoutsService = readFileSync('lambdas/scouts/function/scouts-service.mjs', 'utf8');
const requestActivity = readFileSync('lambdas/shared-layer/nodejs/request-activity.mjs', 'utf8');
const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const enrichmentState = readFileSync('lambdas/shared-layer/nodejs/enrichment-state.mjs', 'utf8');
const imageProvider = readFileSync('lambdas/sqs2scouts/function/image-provider-worker.mjs', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax check failed:\n${result.stderr}`);
}

function assertNodeTest(path) {
  const result = spawnSync(process.execPath, ['--test', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} tests failed:\n${result.stdout}\n${result.stderr}`);
}

test('admin page loads simplified agenda refresh controller after legacy controller', () => {
  assert.match(html, /admin-simplify\.css/);
  assert.match(html, /admin-script\.js[\s\S]*admin-simplify\.js[\s\S]*admin-agenda-refresh\.js/);
  assertSyntax('website/admin/admin-agenda-refresh.js');
  assertSyntax('lambdas/scouts/function/scouts-entry.mjs');
  assertSyntax('lambdas/shared-layer/nodejs/request-activity.mjs');
});

test('default UI exposes Operations separately while Activity owns lifecycle presentation', () => {
  assert.match(simplify, /Operations/);
  assert.match(simplify, /Scheduled refresh and recovery controls/);
  assert.match(activityCentre, /Activity/);
  assert.match(css, /admin-diagnostics-drawer/);
  assert.doesNotMatch(simplify, /pollAuthoritativeActivity|request lifecycle ready|All services available/);
});

test('agenda UI no longer exposes an enrichment-count selector', () => {
  assert.doesNotMatch(html, /id="refresh-action"/);
  assert.doesNotMatch(html, /AI off|1 event|5 events|10 events|Events to enrich/);
  assert.match(html, />Sync calendars & agenda<\/button>/);
  assert.match(agendaRefresh, /document\.getElementById\('refresh-action'\)\?\.remove\(\)/);
});

test('normal agenda reconciliation does not send a browser enrichment limit', () => {
  assert.match(agendaRefresh, /subject: 'calendars'/);
  assert.match(agendaRefresh, /action: 'refreshAllCalendars'/);
  assert.match(agendaRefresh, /calendar: 'all'/);
  assert.doesNotMatch(agendaRefresh, /maxEvents|maxScoutRequests/);
  assert.match(scoutsService, /bodyParams\?\.maxEvents \?\? queryParams\?\.maxEvents/);
  assert.match(scoutsService, /process\.env\.max_events_start \|\| '5'/);
  assert.match(scoutsService, /process\.env\.max_events_resume \|\| '1'/);
});

test('browser startup does not reconcile calendars or expose polling controls', () => {
  assert.doesNotMatch(html, /agenda-auto-refresh-toggle|agenda-auto-refresh-interval-seconds|status-polling-toggle|status-polling-interval-seconds/);
  assert.doesNotMatch(agendaRefresh, /setInterval|performAgendaReconciliation\(\{ automatic/);
  assert.match(agendaRefresh, /Browser startup must remain read-only/);
});

test('status polling remains read-only and separate from real reconciliation', () => {
  assert.match(adminScript, /function runStatusPollingJob\(\)[\s\S]*pollQueueDepthSnapshots\(\)[\s\S]*loadEvents\(/);
  const pollingBody = adminScript.match(/function runStatusPollingJob\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(pollingBody, /sendScoutsCommand|refreshLambda|invokeLambdaHeartbeat/);
  assert.match(adminScript, /Canonical Activity polling is owned by admin-activity-centre\.js/);
  assert.doesNotMatch(agendaRefresh, /setInterval/);
});

test('backend enrichment state prevents duplicate, succeeded, cooldown and exhausted work', () => {
  assert.match(enrichmentState, /state\.state === 'manual_review'[\s\S]*reason: 'manual_review'/);
  assert.match(enrichmentState, /state\.state === 'succeeded'[\s\S]*reason: 'already_succeeded'/);
  assert.match(enrichmentState, /attemptCount[\s\S]*MAX_ATTEMPTS[\s\S]*reason: 'max_attempts_reached'/);
  assert.match(enrichmentState, /state\.state === 'in_progress'[\s\S]*reason: 'in_progress'/);
  assert.match(enrichmentState, /state\.state === 'retry_wait'[\s\S]*reason: 'cooldown_active'/);
  assert.match(enrichmentState, /ConditionExpression:[\s\S]*#state <> :inProgress[\s\S]*#attemptCount < :max/);
});

test('provider quota circuit remains a backend safety boundary', () => {
  assert.match(imageProvider, /async function providerQuotaCircuitOpen/);
  assert.match(imageProvider, /provider_daily_quota_exhausted/);
  assert.match(imageProvider, /async function markProviderQuotaExhausted/);
  assert.match(imageProvider, /blockedUntil/);
});

test('manual sync has one explicit acknowledgement path', () => {
  assert.match(agendaRefresh, /Syncing calendars & agenda/);
  assert.match(agendaRefresh, /Calendars & agenda synchronised/);
  assert.match(agendaRefresh, /refreshAllCalendars/);
});

test('enrichment starts are exact per reconciliation and distinct from modified events', () => {
  assert.match(scoutsEntry, /withRequestActivityContext/);
  assert.match(scoutsEntry, /reconciliationId: crypto\.randomUUID\(\)/);
  assert.match(scoutsEntry, /enrichmentRequestsStarted/);
  assert.match(scoutsEntry, /enrichmentRequestAccountingSource: 'reconciliation-publication-context'/);
  assert.doesNotMatch(scoutsEntry, /captureActivitySnapshot|countNewEnrichmentRequests|startedAtMs|beforeIds/);

  assert.match(requestActivity, /new AsyncLocalStorage\(\)/);
  assert.match(requestActivity, /trackReconciliationPublication/);
  assert.match(requestActivity, /RECONCILIATION_ENRICHMENT_ACTIONS/);
  assert.match(requestActivity, /reconciliationId = if_not_exists\(reconciliationId, :reconciliationId\)/);
  assert.match(requestActivity, /state !== 'queued' \|\| stage !== 'scoutsrequests'/);
  assert.match(runtimeActivity, /reconciliationId: request\.reconciliationId \|\| null/);
  assertNodeTest('lambdas/shared-layer/nodejs/request-activity.test.mjs');

  assert.match(agendaRefresh, /await loadEvents/);
  assert.doesNotMatch(agendaRefresh, /enrichmentRequestsStarted\s*=\s*modified/);
});

test('admin commands stay on the same-origin proxy and derive missing agenda HEX safely', () => {
  assert.match(adminScript, /const configuredScoutsUrl = window\.SCOUTS_URL \|\| window\.SCOUTS_REFRESH_URL \|\| ''/);
  assert.match(adminScript, /configuredScoutsUrl\.startsWith\('\/'\)/);
  assert.match(adminScript, /const bytes = new TextEncoder\(\)\.encode\(String\(title\)\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(adminScript, /byte\.toString\(16\)\.padStart\(2, '0'\)/);
});

test('missing metadata classification excludes approval and visibility workflow state', () => {
  const classificationBody = agendaRefresh.match(
    /function getMissingMetadataFields\(event\) \{([\s\S]*?)\n    \}/,
  )?.[1] || '';

  assert.match(classificationBody, /missing\.push\('Tagline'\)/);
  assert.match(classificationBody, /missing\.push\('Image Theme'\)/);
  assert.match(classificationBody, /missing\.push\('Image URL'\)/);
  assert.doesNotMatch(classificationBody, /Approval|Visibility|isEventApproved|isHiddenEvent/);
});

test('Activity Centre is the single recurring lifecycle presentation owner', () => {
  assert.match(activityCentre, /activityCommand\('status'\)/);
  assert.match(activityCentre, /function schedulePoll/);
  assert.match(activityCentre, /window\.adminActivityController = Object\.freeze/);
  assert.match(adminScript, /return controller\.refreshNow\(\)/);
  assert.doesNotMatch(simplify, /activityCommand|pollAuthoritativeActivity|pollQueueDepthSnapshots\s*=/);
});

test('Operations contains only scheduled refresh and recovery controls', () => {
  assert.match(diagnosticsEnhancements, /Scheduled calendar refresh/);
  assert.match(diagnosticsEnhancements, /Dead-letter queues/);
  assert.match(diagnosticsEnhancements, /operationsBody/);
  assert.doesNotMatch(diagnosticsEnhancements, /installEventCardRenderHook|enhanceEventCards/);
});

test('presentation updates do not install a document-wide observer', () => {
  assert.doesNotMatch(simplify, /MutationObserver|OBSERVER_OPTIONS|observer\.observe/);
});

test('legacy diagnostics are hidden only after successful simplify initialization', () => {
  assert.match(simplify, /classList\.add\('admin-simplify-ready'\)/);
  assert.match(css, /body\.admin-simplify-ready \.events-layout > \.requests-sidebar/);
  assert.doesNotMatch(css, /\n\.events-layout > \.requests-sidebar,/);
});
