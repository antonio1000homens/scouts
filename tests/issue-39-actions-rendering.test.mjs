import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const processorSource = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const publicSource = readFileSync('website/scripts/event-loader.js', 'utf8');
const liveRegressionSource = readFileSync('lambdas/tools/live-canonical-event-smoke.mjs', 'utf8');
const liveRegressionWorkflowSource = readFileSync('.github/workflows/live-regression-canary.yml', 'utf8');

test('Slack approval action IDs retain the documented processing mapping', () => {
  const { functions } = loadFunctionsFromSource(processorSource, ['mapActionId']);
  assert.equal(functions.mapActionId('scouts_request_hide'), 'HIDE');
  assert.equal(functions.mapActionId('scouts_request_skip'), 'SKIP');
  assert.equal(functions.mapActionId('scouts_request_approve'), 'PERSIST');
  assert.equal(functions.mapActionId('scouts_request_edit'), 'EDIT');
});

test('unknown/tampered action tokens are not silently translated into an allowed action', () => {
  const { functions } = loadFunctionsFromSource(processorSource, ['mapActionId']);
  const tampered = 'scouts_request_approve<script>';
  assert.equal(functions.mapActionId(tampered), tampered);
  assert.match(processorSource, /const allowedRealms = new Set\(\['tagline', 'imageTheme', 'image', 'persist'\]\)/);
  assert.match(processorSource, /Dropped unsupported realm|Dropping unsupported realm/);
});

function loadPublicHelpers() {
  const document = {
    currentScript: { src: 'https://site.invalid/website/scripts/event-loader.js' },
    addEventListener() {},
    getElementById() { return null; },
  };
  const window = {
    location: { href: 'https://site.invalid/' },
    addEventListener() {},
    requestAnimationFrame(callback) { callback(); },
    getComputedStyle() { return { getPropertyValue: () => '', columnGap: '0', gap: '0' }; },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document,
    window,
    URL,
    Intl,
    Date,
    fetch: async () => { throw new Error('network disabled in public-loader unit tests'); },
  };

  vm.runInNewContext(`${publicSource}\nthis.__publicHelpers = { getMetadataData, getStatusData, isApprovedEventImage, normaliseImagePath, resolveImageUrl, withImageWidthParam, createEventImageMarkup, isHiddenEvent, isRegressionEvent };`, sandbox, {
    timeout: 1_000,
  });
  return sandbox.__publicHelpers;
}

test('public loader recognises hidden events only from canonical metadata status', () => {
  const helpers = loadPublicHelpers();
  assert.equal(helpers.isHiddenEvent({ metadata: { status: { isHidden: true } } }), true);
  assert.equal(helpers.isHiddenEvent({ isHidden: 'yes' }), false);
  assert.equal(helpers.isHiddenEvent({ status: 'hidden' }), false);
  assert.equal(helpers.isHiddenEvent({ metadata: { status: { isHidden: false } } }), false);
  assert.match(publicSource, /if \(isHiddenEvent\(event\)\)\s*\{[\s\S]*?Filtering out hidden event/, 'agenda load must filter hidden events before rendering');
});

test('public loader always excludes reserved live regression events even when unhidden', () => {
  const helpers = loadPublicHelpers();
  assert.equal(helpers.isRegressionEvent({ uid: 'scouts-regression-1234' }), true);
  assert.equal(helpers.isRegressionEvent({ source: { uid: 'SCOUTS-REGRESSION-5678' } }), true);
  assert.equal(helpers.isRegressionEvent({ uid: 'normal-calendar-event', source: { uid: 'scouts-regression-source-only' } }), true);
  assert.equal(helpers.isRegressionEvent({ uid: 'normal-calendar-event' }), false);
  assert.equal(helpers.isRegressionEvent({ uid: 'scouts-regressionish-1234' }), false);
  assert.match(
    publicSource,
    /if \(isRegressionEvent\(event\)\)\s*\{[\s\S]*?Filtering out regression event/,
    'reserved canary events must be filtered before date/rendering logic',
  );
});

test('public loader renders generated images only for approved events', () => {
  const helpers = loadPublicHelpers();
  const approved = {
    title: 'Synthetic approved event',
    metadata: {
      status: { isApproved: true, isHidden: false },
      image: { url: 'website/eventImages/test-generated.jpg' },
    },
  };
  const pending = {
    ...approved,
    metadata: {
      ...approved.metadata,
      status: { isApproved: false, isHidden: false },
    },
  };

  const approvedUrl = helpers.resolveImageUrl(approved);
  assert.match(approvedUrl, /\/website\/eventImages\/test-generated\.jpg$/);
  assert.match(helpers.createEventImageMarkup(approved), /test-generated\.jpg\?w=400/);
  assert.equal(helpers.resolveImageUrl(pending), null);
  assert.equal(helpers.createEventImageMarkup(pending), '');
});

test('public loader handles an approved event without an image without broken markup', () => {
  const helpers = loadPublicHelpers();
  const event = {
    title: 'Synthetic text-only event',
    metadata: { status: { isApproved: true, isHidden: false } },
  };
  assert.equal(helpers.resolveImageUrl(event), null);
  assert.equal(helpers.createEventImageMarkup(event), '');
});

test('live regression canary covers all deployed mutation routes with durable event and agenda read-back', () => {
  for (const action of ['generateFull', 'generateTagline', 'generateImageTheme', 'generateImage', 'approve', 'hide', 'unhide']) {
    assert.match(liveRegressionSource, new RegExp(`action: '${action}'`), `live canary must exercise ${action}`);
  }
  assert.match(liveRegressionSource, /waitForEventAndAgenda/);
  assert.match(liveRegressionSource, /metadataMatches/);
  assert.match(liveRegressionSource, /isDeepStrictEqual/);
  assert.match(liveRegressionSource, /headObject\(eventKey\)/);
  assert.match(liveRegressionSource, /requireGeneratedImage/);
  assert.match(liveRegressionSource, /REGRESSION_UID_PREFIX = 'scouts-regression-'/);
  assert.match(liveRegressionSource, /Date\.parse\(FUTURE_DATE_ISO\) > Date\.now\(\)/);
  assert.match(liveRegressionSource, /finally \{/);
  assert.match(liveRegressionSource, /removeAgendaDummies/);
  assert.match(liveRegressionSource, /deleteObjectChecked\(eventKey\)/);
});

test('live regression canary uses conditional S3 writes and explicit ownership for production safety', () => {
  assert.match(liveRegressionSource, /mutateJsonOptimistically/);
  assert.match(liveRegressionSource, /--if-match/);
  assert.match(liveRegressionSource, /--if-none-match/);
  assert.match(liveRegressionSource, /eventExistedBeforeRun/);
  assert.match(liveRegressionSource, /eventCreatedByRun/);
  assert.match(liveRegressionSource, /agendaEntryCreatedByRun/);
  assert.match(liveRegressionSource, /assertOwnedAgendaEvent/);
  assert.match(liveRegressionSource, /Same-HEX sibling remained visible/);
  assert.match(liveRegressionSource, /S3 object still exists after delete/);
});

test('live regression canary verifies deployment and sweeps its full generated-image namespace', () => {
  assert.match(liveRegressionSource, /AWS_PROFILE is required for local live regression runs/);
  assert.match(liveRegressionSource, /verifyAwsIdentity/);
  assert.match(liveRegressionSource, /EXPECTED_AWS_ACCOUNT/);
  assert.match(liveRegressionSource, /verifyDeployedRegressionGuard/);
  assert.match(liveRegressionSource, /DEPLOYED_EVENT_LOADER_KEY/);
  assert.match(liveRegressionSource, /const prefix = `website\/eventImages\/\$\{hex\}-`/);
  assert.match(liveRegressionSource, /listOwnedImageKeys\(hex\)/);
  assert.match(liveRegressionSource, /Canary image prefix still contains/);
});

test('live regression workflow is manual, explicit, OIDC-authenticated and reserves cleanup time', () => {
  assert.match(liveRegressionWorkflowSource, /workflow_dispatch:/);
  assert.match(liveRegressionWorkflowSource, /confirm_live_mutation:/);
  assert.match(liveRegressionWorkflowSource, /id-token: write/);
  assert.match(liveRegressionWorkflowSource, /aws-actions\/configure-aws-credentials/);
  assert.match(liveRegressionWorkflowSource, /\/scouts\/shared\/required-api-key/);
  assert.match(liveRegressionWorkflowSource, /LIVE_TEST_ACK: '1'/);
  assert.match(liveRegressionWorkflowSource, /EXPECTED_AWS_ACCOUNT/);
  assert.match(liveRegressionWorkflowSource, /timeout-minutes:\s*60/);
  assert.doesNotMatch(liveRegressionWorkflowSource, /^\s*push:/m);
  assert.doesNotMatch(liveRegressionWorkflowSource, /^\s*pull_request:/m);
});

test('live regression canary script remains syntactically valid', () => {
  const result = spawnSync(process.execPath, ['--check', 'lambdas/tools/live-canonical-event-smoke.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
