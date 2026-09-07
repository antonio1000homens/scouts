import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const adminSource = readFileSync('website/admin/admin-script.js', 'utf8');
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
  const { functions } = loadFunctionsFromSource(adminSource, [functionName], sandbox);
  return functions[functionName](...args);
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
