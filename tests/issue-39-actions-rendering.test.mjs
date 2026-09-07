import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const processorSource = readFileSync('lambdas/sqs2scouts/function/sqs2scouts.mjs', 'utf8');
const publicSource = readFileSync('website/scripts/event-loader.js', 'utf8');

const LEGACY_S3_SITE_ORIGIN = 'https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com';
const S3_OBJECT_BASE_URL = LEGACY_S3_SITE_ORIGIN;

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
  assert.match(processorSource, /Unsupported action:/, 'processor must retain an explicit unsupported-action path');
});

function loadPublicHelpers() {
  return loadFunctionsFromSource(publicSource, [
    'getMetadataData',
    'getStatusData',
    'isApprovedEventImage',
    'normaliseImagePath',
    'resolveImageUrl',
    'withImageWidthParam',
    'createEventImageMarkup',
    'isHiddenEvent',
  ], {
    LEGACY_S3_SITE_ORIGIN,
    S3_OBJECT_BASE_URL,
  }).functions;
}

test('public loader recognises hidden events across structured and legacy status shapes', () => {
  const helpers = loadPublicHelpers();
  assert.equal(helpers.isHiddenEvent({ metadata: { status: { isHidden: true } } }), true);
  assert.equal(helpers.isHiddenEvent({ isHidden: 'yes' }), true);
  assert.equal(helpers.isHiddenEvent({ status: 'hidden' }), true);
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

  assert.equal(
    helpers.resolveImageUrl(approved),
    `${S3_OBJECT_BASE_URL}/website/eventImages/test-generated.jpg`,
  );
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
