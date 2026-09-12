import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const processorSource = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const publicSource = readFileSync('website/scripts/event-loader.js', 'utf8');

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

  vm.runInNewContext(`${publicSource}\nthis.__publicHelpers = { getMetadataData, getStatusData, isApprovedEventImage, normaliseImagePath, resolveImageUrl, withImageWidthParam, createEventImageMarkup, isHiddenEvent };`, sandbox, {
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
