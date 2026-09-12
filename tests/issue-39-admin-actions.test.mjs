import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const adminSource = readFileSync('website/admin/admin-script.js', 'utf8');
const adminHtml = readFileSync('website/admin/index.html', 'utf8');
const approvalWorkflowSource = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');
const privateStorageSource = readFileSync('website/admin/private-storage-client.js', 'utf8');
const scoutsEntrySource = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const approvalCoordinatorSource = readFileSync('lambdas/shared-layer/nodejs/approval-coordinator.mjs', 'utf8');
const TEST_HEX = '746573742d6576656e74';

function actionSandbox(overrides = {}) {
  const sent = [];
  const event = {
    summary: 'Synthetic Scouts Test Event',
    metadata: {
      hex: TEST_HEX,
      status: { isApproved: false, isHidden: false },
    },
  };
  const entry = { event, allHidden: false };

  const sandbox = {
    apiAuthReady: true,
    uiCommandInFlight: false,
    currentEventIndex: 0,
    visibleEventEntries: [entry],
    uniqueEventEntries: [entry],
    eventsData: [event],
    latestBackendRequestId: null,
    sendScoutsCommand: async (payload) => {
      sent.push(structuredClone(payload));
      return { _httpStatus: 200, queueAccepted: true, requestId: 'test-request-id' };
    },
    pollQueueDepthSnapshots: async () => {},
    pollGeneratedRequestUntilSettled: async () => {},
    refreshApiActionButtons: () => {},
    updateApiAuthStatus: () => {},
    updateModalStatus: () => {},
    updateRuntimeDetails: () => {},
    pinRuntimeDetails: () => {},
    updateRuntimePanelsFromResult: () => {},
    updateRuntimeRequestId: () => {},
    updateEventsCount: () => {},
    updateSidebarUi: () => {},
    renderEvents: () => {},
    updateModalContent: () => {},
    refreshModalCurrentMetadata: () => {},
    loadEvents: () => {},
    getSelectedModalEntry: () => entry,
    getEventHex: () => TEST_HEX,
    isHiddenEvent: () => false,
    isEntryHidden: (candidate) => Boolean(candidate?.allHidden),
    isEntryApproved: () => false,
    isEntryComplete: () => false,
    applyLocalHiddenState: () => {},
    applyLocalApprovalState: () => {},
    applyLocalPersistedField: () => {},
    extractBackendRequestId: (result) => result?.requestId ?? null,
    appendBackendRequestIdMessage: (message) => message,
    getFieldOperationConfig: (field) => ({
      subjectKey: field === 'imageUrl' ? 'imageUrl' : field,
      payloadKey: field,
      label: field,
      queueLabel: field === 'tagline' ? 'AI tagline' : field === 'imageTheme' ? 'AI image theme' : field === 'full' ? 'full enrichment' : 'AI image',
    }),
    getModalFieldValue: () => 'synthetic-value',
    isAcceptedAdminImageUrl: () => true,
    document: {
      getElementById(id) {
        if (id === 'refresh-action') return { value: '5' };
        return { value: '', textContent: '', className: '', style: {} };
      },
    },
    ...overrides,
  };
  return { sandbox, sent, event, entry };
}

async function invokeAdminFunction(functionName, args, sandbox) {
  const dependencies = functionName === 'pollGeneratedRequestUntilSettled'
    ? ['stopGeneratedRequestPolling', 'findAuthoritativeRequest', 'isTerminalAuthoritativeRequest', 'describeAuthoritativeRequestOutcome', 'refreshGeneratedEvent']
    : [];
  const { functions } = loadFunctionsFromSource(adminSource, [functionName, ...dependencies], sandbox);
  return functions[functionName](...args);
}

function progressSandbox(activityResponses, overrides = {}) {
  const statuses = [];
  const refreshed = { events: 0, modal: 0 };
  let responseIndex = 0;
  const entry = {
    event: { summary: 'Progress Test Event', metadata: { hex: TEST_HEX } },
  };
  const sandbox = {
    hasText: (value) => value !== null && value !== undefined && String(value).trim().length > 0,
    generatedRequestPollTimer: null,
    generatedRequestPollToken: 0,
    GENERATED_REQUEST_POLL_TIMEOUT_MS: 30000,
    currentEventIndex: 0,
    visibleEventEntries: [entry],
    pollQueueDepthSnapshots: async () => activityResponses[Math.min(responseIndex++, activityResponses.length - 1)],
    updateModalStatus: (message, tone) => statuses.push({ message, tone }),
    loadEvents: async () => { refreshed.events += 1; },
    updateModalContent: () => { refreshed.modal += 1; },
    getEventHex: (event) => event?.metadata?.hex || '',
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date: { now: () => 0 },
    ...overrides,
  };
  return { sandbox, statuses, refreshed };
}

test('admin agenda refresh publishes the selected enrichment count', async () => {
  const { sandbox, sent } = actionSandbox();
  await invokeAdminFunction('refreshLambda', ['refreshAgenda'], sandbox);
  assert.deepEqual(sent, [{
    realm: 'scouts',
    subject: 'agenda',
    action: 5,
    maxEvents: 5,
  }]);
});

test('admin generation buttons publish field-specific actions with only the selected HEX', async () => {
  const cases = [
    ['tagline', 'generateTagline'],
    ['imageTheme', 'generateImageTheme'],
    ['imageUrl', 'generateImage'],
    ['full', 'generateFull'],
  ];

  for (const [field, action] of cases) {
    const { sandbox, sent } = actionSandbox();
    await invokeAdminFunction('requestGeneratedField', [field, action], sandbox);
    assert.deepEqual(sent, [{
      realm: 'scouts',
      subject: { hex: TEST_HEX },
      action,
    }], `${field} request contract changed`);
  }
});

test('admin generation progress stops on a matching completed request and refreshes the modal', async () => {
  const progress = progressSandbox([{ requests: [{ requestId: 'request-1', state: 'completed' }] }]);
  await invokeAdminFunction('pollGeneratedRequestUntilSettled', ['request-1', {
    hex: TEST_HEX,
    config: { label: 'Tagline', queueLabel: 'AI tagline' },
    eventLabel: 'Progress Test Event',
  }], progress.sandbox);

  assert.equal(progress.refreshed.events, 1);
  assert.equal(progress.refreshed.modal, 1);
  assert.deepEqual(progress.statuses.at(-1), {
    message: 'Tagline completed for "Progress Test Event".',
    tone: 'success',
  });
});

test('admin generation progress reports a matching terminal failure and refreshes the modal', async () => {
  const progress = progressSandbox([{ requests: [{
    requestId: 'request-2',
    state: 'needs_attention',
    failure: { message: 'Gemini daily limit reached' },
  }] }]);
  await invokeAdminFunction('pollGeneratedRequestUntilSettled', ['request-2', {
    hex: TEST_HEX,
    config: { label: 'Tagline', queueLabel: 'AI tagline' },
    eventLabel: 'Progress Test Event',
  }], progress.sandbox);

  assert.equal(progress.refreshed.events, 1);
  assert.equal(progress.refreshed.modal, 1);
  assert.deepEqual(progress.statuses.at(-1), {
    message: 'Tagline needs_attention: Gemini daily limit reached for "Progress Test Event".',
    tone: 'error',
  });
});

test('admin generation progress times out when no matching request update arrives', async () => {
  let nowCall = 0;
  const progress = progressSandbox([{ requests: [{ requestId: 'other-request', state: 'completed' }] }], {
    Date: { now: () => (nowCall++ === 0 ? 0 : 30000) },
  });
  await invokeAdminFunction('pollGeneratedRequestUntilSettled', ['request-3', {
    hex: TEST_HEX,
    config: { label: 'Tagline', queueLabel: 'AI tagline' },
    eventLabel: 'Progress Test Event',
  }], progress.sandbox);

  assert.equal(progress.refreshed.events, 0);
  assert.deepEqual(progress.statuses.at(-1), {
    message: 'No AI tagline update received for "Progress Test Event" within 30 seconds.',
    tone: 'error',
  });
});

test('admin hide and unhide publish idempotent visibility state for the same HEX', async () => {
  const hide = actionSandbox();
  await invokeAdminFunction('hideEvent', [0, false, 'hide'], hide.sandbox);
  assert.equal(hide.sent.length, 1);
  assert.equal(hide.sent[0].realm, 'scouts');
  assert.equal(hide.sent[0].action, 'hide');
  assert.deepEqual(hide.sent[0].subject, { hex: TEST_HEX, isHidden: true });
  assert.match(hide.sent[0].hiddenAt, /^\d{4}-\d{2}-\d{2}T/);

  const unhide = actionSandbox({ isHiddenEvent: () => true });
  unhide.entry.allHidden = true;
  await invokeAdminFunction('unhideEvent', [0, false, 'unhide'], unhide.sandbox);
  assert.deepEqual(unhide.sent, [{
    realm: 'scouts',
    subject: { hex: TEST_HEX, isHidden: false },
    action: 'unhide',
  }]);
});

test('admin approve publishes approval state and refuses an already-approved event', async () => {
  const approval = actionSandbox();
  await invokeAdminFunction('approveEvent', [0, false, 'approve'], approval.sandbox);
  assert.deepEqual(approval.sent, [{
    realm: 'scouts',
    subject: { hex: TEST_HEX, isApproved: true },
    action: 'approve',
  }]);

  const duplicate = actionSandbox({ isEntryApproved: () => true });
  await invokeAdminFunction('approveEvent', [0, false, 'approve'], duplicate.sandbox);
  assert.equal(duplicate.sent.length, 0, 'duplicate approval must not publish another request');
});

test('admin actions fail closed when auth is unavailable or the event has no HEX', async () => {
  const unauthenticated = actionSandbox({ apiAuthReady: false });
  await invokeAdminFunction('requestGeneratedField', ['tagline', 'generateTagline'], unauthenticated.sandbox);
  assert.equal(unauthenticated.sent.length, 0);

  const missingHex = actionSandbox({ getEventHex: () => null });
  await invokeAdminFunction('hideEvent', [0, false, 'hide'], missingHex.sandbox);
  assert.equal(missingHex.sent.length, 0);
});

test('issue 91 loads the revisioned approval controller immediately after its bootstrap dependencies', () => {
  const privateStorageIndex = adminHtml.indexOf('<script src="private-storage-client.js"></script>');
  const approvalIndex = adminHtml.indexOf('<script src="admin-approval-workflow.js"');
  const simplifyIndex = adminHtml.indexOf('<script src="admin-simplify.js"></script>');
  assert.ok(privateStorageIndex >= 0 && approvalIndex > privateStorageIndex, 'approval controller must load after private storage bootstrap');
  assert.ok(simplifyIndex > approvalIndex, 'approval controller must load before mutation/presentation wrappers');
  assert.match(privateStorageSource, /approvalBootstrapGuard/);
  assert.match(privateStorageSource, /handleApprovalWorkflowLoadError/);
  assert.match(approvalWorkflowSource, /window\.scoutsApprovalWorkflowReady = true/);
  assert.match(approvalWorkflowSource, /window\.approveEvent = async function issue91ApproveEvent/);
  assert.match(approvalWorkflowSource, /Approve shown changes/);
});

test('issue 91 admin approval submits the complete server-issued review snapshot', () => {
  for (const field of ['hex', 'tagline', 'imageTheme', 'imageUrl', 'isHidden']) {
    assert.match(approvalWorkflowSource, new RegExp(`${field}:`));
  }
  assert.match(approvalWorkflowSource, /subject: 'event'/);
  assert.match(approvalWorkflowSource, /action: 'review'/);
  assert.match(approvalWorkflowSource, /sameReviewableValues/);
  assert.match(approvalWorkflowSource, /reviewSnapshot,/);
  assert.match(approvalWorkflowSource, /baseRevision: reviewSnapshot\.revision/);
  assert.doesNotMatch(approvalWorkflowSource, /sha256Prefix|crypto\?\.subtle|TextEncoder/);
  assert.match(approvalWorkflowSource, /requiresGeneratedImage/);
  assert.match(approvalWorkflowSource, /final review required/i);
});

test('issue 91 backend intercepts revisioned approval and rejects stale review state', () => {
  assert.match(scoutsEntrySource, /function revisionedApprovalCommand/);
  assert.match(scoutsEntrySource, /coordinateEventApproval/);
  assert.match(scoutsEntrySource, /review: buildEventReviewSnapshot\(eventObject\)/);
  assert.match(approvalCoordinatorSource, /compareEventReviewRevision\(canonical, renderedRevision\)/);
  assert.match(approvalCoordinatorSource, /statusCode: 409/);
  assert.match(approvalCoordinatorSource, /STALE_REVIEW/);
  assert.match(approvalCoordinatorSource, /approvalOperationId/);
  assert.match(approvalCoordinatorSource, /approvalIdempotencyKey/);
  assert.match(approvalCoordinatorSource, /rootRequestId/);
});

test('issue 91 missing-image approval queues one correlated image child and keeps final approval false', () => {
  assert.match(approvalCoordinatorSource, /if \(patch\.approval\.requiresGeneratedImage\)/);
  assert.match(approvalCoordinatorSource, /const imageRequestId = `\$\{root\}:image:\$\{revision\}`/);
  assert.match(approvalCoordinatorSource, /approvalMode: 'review_generated_image'/);
  assert.match(approvalCoordinatorSource, /state: 'awaiting_image'/);
  assert.match(approvalCoordinatorSource, /Generating image — final review required/);
  assert.match(approvalCoordinatorSource, /subject: \{ metadata: patch\.metadata \}/);
});
