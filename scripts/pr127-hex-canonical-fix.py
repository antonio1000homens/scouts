from pathlib import Path
import re
import subprocess


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace(path, old, new, count=1):
    text = read(path)
    found = text.count(old)
    if found != count:
        raise SystemExit(f'{path}: expected {count} exact matches, found {found}')
    write(path, text.replace(old, new, count))


def sub(path, pattern, repl, count=1, flags=re.S):
    text = read(path)
    text2, n = re.subn(pattern, lambda _match: repl, text, count=count, flags=flags)
    if n != count:
        raise SystemExit(f'{path}: expected {count} regex matches, found {n}: {pattern[:80]}')
    write(path, text2)


# Keep unrelated SSM/deploy behaviour out of this visibility/identity PR.
subprocess.run([
    'git', 'checkout', '921d683ca31970d9e0755052a9a37a166a768edf', '--',
    'lambdas/scouts-slack-handler/deploy.sh'
], check=True)

# Persistence: metadata.status.isHidden on events/<hex>.json is canonical.
path = 'lambdas/sqs2scouts/function/persistence-processor.mjs'
replace(path, "import { occurrenceStorageKey } from './occurrence-identity.mjs';\n", '')
sub(path,
    r"function extractOccurrenceVisibility\(message, rawSubject, action\) \{.*?\n\}\n\nasync function persistVisibilityOverlays\(\{.*?\n\}\n\nexport function buildPersistEventPayload",
    """function extractOccurrenceVisibility(message, rawSubject, action) {
    const actionObject = parsePersistPatch(action) || {};
    const subjectObject = rawSubject && typeof rawSubject === 'object'
        ? rawSubject
        : parsePersistPatch(rawSubject) || {};
    const hidden = actionObject.metadata?.status?.isHidden
        ?? actionObject.status?.isHidden
        ?? actionObject.isHidden
        ?? subjectObject.metadata?.status?.isHidden
        ?? subjectObject.isHidden;
    if (typeof hidden !== 'boolean') return null;
    // Visibility is canonical HEX state. Legacy occurrenceId selectors are
    // deliberately ignored so one calendar instance cannot diverge from siblings.
    return { isHidden: hidden };
}

export function buildPersistEventPayload""")
sub(path,
    r"            let persistSubject = rawSubject;\n            let persistAction = action;\n            const visibility = extractOccurrenceVisibility\(messageBody, rawSubject, action\);\n            if \(visibility\) \{.*?\n            \}\n            const event = buildPersistEventPayload\(existingEvent, persistSubject, persistAction\);",
    """            const visibility = extractOccurrenceVisibility(messageBody, rawSubject, action);
            const event = buildPersistEventPayload(existingEvent, rawSubject, action);""")
replace(path,
    """                isHidden: visibility ? (existingEvent.metadata?.status?.isHidden === true) : ((actionIsHidden || statusIsHidden)
                    ? true
                    : metadataStatus.isHidden === true),""",
    """                isHidden: typeof visibility?.isHidden === 'boolean'
                    ? visibility.isHidden
                    : ((actionIsHidden || statusIsHidden) ? true : metadataStatus.isHidden === true),""")
sub(path,
    r"            // Replace the hex file content with the subject content\n            if \(!visibility\) \{.*?\n            \}\n            \n            // Reconcile the existing review card",
    """            // Persist the HEX document first, then publish that canonical state to
            // every current agenda instance sharing the HEX.
            await saveHexEventToS3(hexValue, event);
            await publishHexEventToAgenda(hexValue, event);
            
            // Reconcile the existing review card""")
replace(path,
    """            const decisionSubject = {
                hex: hexValue,
                title: eventTitle,
                ...(visibility?.occurrenceId ? { occurrenceId: visibility.occurrenceId } : {}),
            };""",
    """            const decisionSubject = {
                hex: hexValue,
                title: eventTitle,
            };""")

# Agenda projection: the canonical HEX document wins for every same-HEX instance.
path = 'lambdas/sqs2scouts/function/agenda-publisher.mjs'
sub(path,
    r"export function mergeCanonicalEventIntoAgenda\(agenda, canonicalEvent, hex, options = \{\}\) \{.*?\n\}\n\nexport async function publishCanonicalEventToAgenda\(\{ loadAgenda, writeAgenda, hex, event, occurrenceId = null, visibility \}\) \{.*?\n\}",
    """export function mergeCanonicalEventIntoAgenda(agenda, canonicalEvent, hex) {
  if (!agenda || typeof agenda !== 'object' || !Array.isArray(agenda.events)) {
    throw new Error('agenda.json is missing its events array');
  }
  const normalisedHex = canonicalHex(hex, 'Agenda publication HEX');
  const canonicalMetadata = metadataForAgenda(canonicalEvent, normalisedHex);

  let matched = 0;
  const events = agenda.events.map((event) => {
    if (eventHex(event) !== normalisedHex) return event;
    matched += 1;
    return {
      ...event,
      metadata: clone(canonicalMetadata),
    };
  });

  if (matched === 0) {
    const error = new Error(`No agenda event matches HEX ${normalisedHex}`);
    error.code = 'AGENDA_EVENT_NOT_FOUND';
    throw error;
  }
  return {
    agenda: {
      ...agenda,
      generatedAt: new Date().toISOString(),
      events,
    },
    matched,
  };
}

export async function publishCanonicalEventToAgenda({ loadAgenda, writeAgenda, hex, event }) {
  if (typeof loadAgenda !== 'function' || typeof writeAgenda !== 'function') {
    throw new Error('Agenda publication requires loadAgenda and writeAgenda functions');
  }
  const agenda = await loadAgenda();
  const merged = mergeCanonicalEventIntoAgenda(agenda, event, hex);
  const put = await writeAgenda(merged.agenda);
  return {
    matched: merged.matched,
    eTag: put?.ETag || null,
    publishedAt: merged.agenda.generatedAt,
  };
}""")

# Persistence safety guard follows the same HEX-canonical invariant.
path = 'lambdas/sqs2scouts/function/full-enrich-helpers.mjs'
sub(path,
    r"export function extractVisibilityPersistMutation\(message\) \{.*?\n\}\n\nexport function buildVisibilityPersistGuard\(message, agendaSnapshot, eventSnapshot\) \{.*?\n\}\n\nexport function verifyVisibilityPersistReadback\(guard, agendaSnapshot, eventSnapshot\) \{.*?\n\}\n\nexport function normaliseStage",
    """export function extractVisibilityPersistMutation(message) {
  const actionPatch = parseObject(message?.action);
  const subjectPatch = parseObject(message?.subject);
  const patch = actionPatch || subjectPatch || {};
  const subject = message?.subject && typeof message.subject === 'object' && !Array.isArray(message.subject)
    ? message.subject
    : {};

  const isHidden = firstBoolean(
    actionPatch?.metadata?.status?.isHidden,
    actionPatch?.status?.isHidden,
    actionPatch?.isHidden,
    actionPatch?.hidden,
    subject?.metadata?.status?.isHidden,
    subject?.status?.isHidden,
    subject?.isHidden,
    subject?.hidden,
  );
  if (isHidden === null) return null;

  const hex = firstHex(
    typeof message?.subject === 'string' ? message.subject : null,
    message?.hex,
    message?.requestHex,
    actionPatch?.metadata?.hex,
    actionPatch?.hex,
    subject?.metadata?.hex,
    subject?.hex,
    patch?.requestHex,
  );
  if (!hex) {
    throw codedError('VISIBILITY_PERSIST_HEX_MISSING', 'Visibility persistence request is missing a canonical HEX identifier');
  }
  return { hex, isHidden };
}

export function buildVisibilityPersistGuard(message, agendaSnapshot, eventSnapshot) {
  const mutation = extractVisibilityPersistMutation(message);
  if (!mutation) return null;

  const agenda = snapshotValue(agendaSnapshot);
  const canonical = snapshotValue(eventSnapshot);
  const beforeETag = text(eventSnapshot?.eTag);
  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === mutation.hex)
    : [];

  if (matching.length === 0) {
    throw codedError(
      'VISIBILITY_TARGET_NOT_FOUND',
      `Visibility persistence target ${mutation.hex} is not present in agenda.json`,
      { hex: mutation.hex, matched: 0 },
    );
  }
  if (!canonical || typeof canonical !== 'object') {
    throw codedError(
      'VISIBILITY_CANONICAL_EVENT_NOT_FOUND',
      `Canonical event events/${mutation.hex}.json was not found`,
      { hex: mutation.hex },
    );
  }
  return {
    ...mutation,
    beforeETag,
    beforeHidden: eventHidden(canonical),
    beforeMatched: matching.length,
  };
}

export function verifyVisibilityPersistReadback(guard, agendaSnapshot, eventSnapshot) {
  if (!guard) return null;
  const agenda = snapshotValue(agendaSnapshot);
  const canonical = snapshotValue(eventSnapshot);
  const afterETag = text(eventSnapshot?.eTag);
  const actualHidden = eventHidden(canonical);

  if (actualHidden !== guard.isHidden) {
    throw codedError(
      'PERSISTENCE_READ_BACK_MISMATCH',
      `Canonical event ${guard.hex} read-back has metadata.status.isHidden=${String(actualHidden)}; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, actual: actualHidden },
    );
  }
  if (guard.beforeHidden !== guard.isHidden && guard.beforeETag && afterETag === guard.beforeETag) {
    throw codedError(
      'PERSISTENCE_ETAG_UNCHANGED',
      `Canonical event ${guard.hex} changed visibility but its S3 ETag did not change`,
      { hex: guard.hex, eTag: afterETag },
    );
  }

  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === guard.hex)
    : [];
  if (matching.length === 0) {
    throw codedError(
      'PERSISTENCE_AGENDA_IDENTITY_MISMATCH',
      `Visibility persistence read-back for ${guard.hex} resolved no agenda occurrences`,
      { hex: guard.hex, matched: 0 },
    );
  }
  const mismatched = matching.filter((event) => eventHidden(event) !== guard.isHidden);
  if (mismatched.length > 0) {
    throw codedError(
      'PERSISTENCE_AGENDA_READ_BACK_MISMATCH',
      `Agenda visibility read-back for ${guard.hex} has ${mismatched.length} mismatched occurrences; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, mismatched: mismatched.length, matched: matching.length },
    );
  }
  return {
    hex: guard.hex,
    isHidden: guard.isHidden,
    eTag: afterETag,
    matched: matching.length,
  };
}

export function normaliseStage""")

# Calendar refresh: occurrence IDs remain calendar identity only; no overlay reads.
path = 'lambdas/scouts/function/scouts-service.mjs'
replace(path,
    "import { resolveOccurrenceId, occurrenceStorageKey } from '/opt/nodejs/occurrence-identity.mjs';",
    "import { resolveOccurrenceId } from '/opt/nodejs/occurrence-identity.mjs';")
sub(path,
    r"\n  const occurrenceStateById = new Map\(\);.*?\n  for \(let index = 0; index < events.length; index\+\+\) \{",
    "\n  for (let index = 0; index < events.length; index++) {")
sub(path,
    r"\n    if \(baseEvent\.occurrenceId\) \{\n      const occurrenceState = occurrenceStateById\.get\(baseEvent\.occurrenceId\) \?\? null;\n      if \(occurrenceState\?\.status && typeof occurrenceState\.status\.isHidden === 'boolean'\) \{.*?\n      \}\n    \}",
    "")
sub(path,
    r"    const candidateOccurrenceId = normalizeNullableText\(\n      firstDefinedValue\(subjectObject\?\.occurrenceId, bodyParams\?\.occurrenceId, queryParams\?\.occurrenceId\),\n    \);\n",
    "")
replace(path,
    """        subject: {
          hex: candidateHex,
          ...(candidateOccurrenceId ? { occurrenceId: candidateOccurrenceId } : {}),
          isHidden: isHideOperation,
        },""",
    """        subject: {
          hex: candidateHex,
          isHidden: isHideOperation,
        },""")
replace(path,
    """        queuedHex: candidateHex,
        ...(candidateOccurrenceId ? { occurrenceId: candidateOccurrenceId } : {}),
        requestId:""",
    """        queuedHex: candidateHex,
        requestId:""")

# Slack may receive old occurrence identity, but forwards only canonical HEX.
path = 'lambdas/scouts-slack-handler/function/slack-handler.mjs'
replace(path, "                            ...(occurrenceId ? { occurrenceId } : {}),\n", '')

# Admin: optimistic shared state and duplicate protection are HEX-scoped.
path = 'website/admin/admin-script.js'
sub(path,
    r"function applyLocalPersistedField\(entry, field, value\) \{.*?\n\}\n\nfunction applyLocalHiddenState",
    """function hexScopedEntries(entry) {
    if (!entry || !entry.event) return [];
    const hex = getEventHex(entry.event);
    if (!hex) return [entry];
    const matches = uniqueEventEntries.filter((candidate) => getEventHex(candidate?.event) === hex);
    return matches.length > 0 ? matches : [entry];
}

function applyLocalPersistedField(entry, field, value) {
    hexScopedEntries(entry).forEach((candidate) => {
        const event = candidate.event;
        event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        if (field === 'tagline') {
            event.tagline = value;
            event.metadata.tagline = value;
            if (Object.prototype.hasOwnProperty.call(event, 'AI')) delete event.AI;
            if (Object.prototype.hasOwnProperty.call(event, 'ai')) delete event.ai;
            return;
        }
        if (!event.image || typeof event.image !== 'object') event.image = {};
        event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object' ? event.metadata.image : {};
        if (field === 'imageTheme') {
            event.image.theme = value;
            event.metadata.image.theme = value;
            if (Object.prototype.hasOwnProperty.call(event.image, 'prompt')) delete event.image.prompt;
            return;
        }
        event.image.url = value;
        event.metadata.image.url = value;
    });
}

function applyLocalHiddenState""")
sub(path,
    r"function applyLocalHiddenState\(entry, hiddenAtIso, hidden = true\) \{.*?\n\}\n\nfunction applyVisibilityOverrides\(entries, options = \{\}\) \{.*?\n\}\n\nasync function persistCurrentField",
    """function applyLocalHiddenState(entry, hiddenAtIso, hidden = true) {
    if (!entry || !entry.event) return;
    const hex = getEventHex(entry.event);
    const effectiveHiddenAt = hidden
        ? (hasText(hiddenAtIso) ? hiddenAtIso : new Date().toISOString())
        : null;
    hexScopedEntries(entry).forEach((candidate) => {
        const event = candidate.event;
        event.isHidden = hidden === true;
        event.hiddenAt = effectiveHiddenAt;
        event.status = event.status && typeof event.status === 'object' ? event.status : {};
        event.status.isHidden = hidden === true;
        event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        event.metadata.status = event.metadata.status && typeof event.metadata.status === 'object' ? event.metadata.status : {};
        event.metadata.status.isHidden = hidden === true;
        candidate.allHidden = hidden === true;
    });
    if (hex) localVisibilityOverrides.set(hex, { hidden: hidden === true, hiddenAt: effectiveHiddenAt });
}

function applyVisibilityOverrides(entries, options = {}) {
    if (!Array.isArray(entries) || localVisibilityOverrides.size === 0) return false;
    const allowConfirm = options.allowConfirm !== false;
    let changed = false;
    for (const [hex, override] of localVisibilityOverrides.entries()) {
        const candidates = entries.filter((entry) => getEventHex(entry?.event) === hex);
        if (candidates.length === 0) continue;
        const backendStateMatches = candidates.every((entry) => isHiddenEvent(entry.event) === Boolean(override.hidden));
        if (allowConfirm && backendStateMatches) {
            localVisibilityOverrides.delete(hex);
            continue;
        }
        candidates.forEach((entry) => {
            const event = entry.event;
            const nextHiddenAt = override.hidden
                ? (hasText(override.hiddenAt) ? override.hiddenAt : (event.hiddenAt || new Date().toISOString()))
                : null;
            if (event.isHidden !== Boolean(override.hidden) || event.hiddenAt !== nextHiddenAt || entry.allHidden !== Boolean(override.hidden)) changed = true;
            event.isHidden = Boolean(override.hidden);
            event.hiddenAt = nextHiddenAt;
            event.status = event.status && typeof event.status === 'object' ? event.status : {};
            event.status.isHidden = Boolean(override.hidden);
            event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
            event.metadata.status = event.metadata.status && typeof event.metadata.status === 'object' ? event.metadata.status : {};
            event.metadata.status.isHidden = Boolean(override.hidden);
            entry.allHidden = Boolean(override.hidden);
        });
    }
    return changed;
}

async function persistCurrentField""")
sub(path,
    r"function uiOperationKey\(entry, action\) \{\n    const event = entry\?\.event \|\| \{\};\n    return `\$\{entry\?\.occurrenceId \|\| event\.occurrenceId \|\| getEventHex\(event\) \|\| entry\?\.key \|\| 'unknown'\}:\$\{action\}`;\n\}",
    """function uiOperationKey(entry, action) {
    const event = entry?.event || {};
    return `${getEventHex(event) || entry?.occurrenceId || event.occurrenceId || entry?.key || 'unknown'}:${action}`;
}""")
sub(path,
    r"function applyLocalApprovalState\(entry, approved = true\) \{.*?\n\}\n\nasync function approveEvent",
    """function applyLocalApprovalState(entry, approved = true) {
    hexScopedEntries(entry).forEach((candidate) => {
        const event = candidate.event;
        event.approved = approved;
        event.isApproved = approved;
        event.status = event.status && typeof event.status === 'object' ? event.status : {};
        event.status.isApproved = approved;
        event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        event.metadata.status = event.metadata.status && typeof event.metadata.status === 'object' ? event.metadata.status : {};
        event.metadata.status.isApproved = approved;
    });
}

async function approveEvent""")

path = 'website/admin/admin-approval-workflow.js'
replace(path,
    """        const operationKey = typeof uiOperationKey === 'function'
            ? uiOperationKey(entry, 'approve')
            : `${entry?.occurrenceId || event?.occurrenceId || hex}:approve`;""",
    """        const operationKey = typeof uiOperationKey === 'function'
            ? uiOperationKey(entry, 'approve')
            : `${hex}:approve`;""")

# Documentation.
path = 'website/admin/README.md'
sub(path,
    r"Each published occurrence carries a server-owned opaque `occurrenceId`\..*?UI pending state is action-scoped, so one accepted or slow operation does not disable unrelated event actions or permit duplicate submission of the same action\.",
    """Each published calendar instance carries a server-owned opaque `occurrenceId`, but `occurrenceId` is instance identity only. Shared event state is owned by the canonical HEX document (`events/<hex>.json`): tagline, image theme, image URL, approval and visibility all apply to every agenda instance that resolves to that HEX. HEX and UID are shown only under Advanced diagnostics.

Hide/Unhide therefore writes `metadata.status.isHidden` on the canonical HEX document and republishes that state to every current same-HEX agenda instance. A legacy request may still contain an `occurrenceId`, but it must not narrow or override the HEX-wide mutation. Per-occurrence visibility overlays are no longer read or written; existing `occurrences/*.json` objects are ignored and may be cleaned up separately. Admin and Slack submit the HEX contract. UI pending state for shared actions is HEX-scoped, so same-HEX cards cannot submit duplicate shared operations while one is already pending.""")

path = 'docs/TESTING-STRATEGY.md'
replace(path,
    """fixture hides and unhides one occurrence, reads back the overlay and agenda,
checks the same-HEX sibling and canonical metadata, and requires a completed
activity result.""",
    """fixture hides and unhides a canonical HEX, reads back the HEX document and agenda,
checks every same-HEX sibling receives the same state (including a later-added
occurrence), and requires a completed activity result.""")

# Regression tests.
path = 'lambdas/scouts/function/tests/test-api-handler.mjs'
replace(path,
    "test('real Scouts API handler publishes full-enrich and occurrence mutations with identity intact', async () => {",
    "test('real Scouts API handler publishes full-enrich and HEX-canonical mutations', async () => {")
replace(path,
    """  assert.equal(hideMessage.subject.occurrenceId, OCCURRENCE, JSON.stringify(hideMessage));
  assert.equal(hideMessage.subject.hex, HEX, JSON.stringify(hideMessage));""",
    """  assert.deepEqual(hideMessage.subject, { hex: HEX, isHidden: true }, JSON.stringify(hideMessage));""")
replace(path,
    """  assert.equal(unhideMessage.subject.occurrenceId, OCCURRENCE);
  assert.equal(unhideMessage.subject.isHidden, false);""",
    """  assert.deepEqual(unhideMessage.subject, { hex: HEX, isHidden: false });""")

path = 'lambdas/sqs2scouts/function/tests/test-agenda-publisher.mjs'
sub(path,
    r"test\('shared metadata publication preserves occurrence-owned visibility'.*?\n\}\);\n\ntest\('explicit occurrence visibility changes only the selected same-HEX occurrence'.*?\n\}\);\n\ntest\('HEX-wide visibility changes every matching occurrence'.*?\n\}\);",
    """test('canonical HEX publication overwrites stale per-occurrence visibility', () => {
  const hiddenAgenda = agenda();
  hiddenAgenda.events[0].metadata.status.isHidden = true;
  const result = mergeCanonicalEventIntoAgenda(hiddenAgenda, canonical({
    metadata: {
      hex: HEX,
      tagline: 'Updated',
      image: { theme: 'Watercolour water fight', url: 'website/eventImages/water-games.jpg' },
      status: { isHidden: false, isApproved: true },
    },
  }), HEX);
  assert.deepEqual(result.agenda.events[0].metadata.status, { isHidden: false, isApproved: true });
});

test('legacy occurrence options cannot split same-HEX visibility', () => {
  const source = agenda();
  source.events.push({
    ...structuredClone(source.events[0]),
    uid: 'osm-water-games-2',
    occurrenceId: 'occ_89abcdef0123456701234567',
    dtstart: '20260716T183000',
  });
  const hidden = canonical({
    metadata: { ...canonical().metadata, status: { isHidden: true, isApproved: false } },
  });
  const result = mergeCanonicalEventIntoAgenda(source, hidden, HEX, {
    occurrenceId: 'occ_89abcdef0123456701234567',
    visibility: false,
  });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.agenda.events.map((event) => event.metadata.status.isHidden), [true, true]);
});

test('a later same-HEX occurrence inherits canonical hidden state on publication', () => {
  const source = agenda();
  source.events = [source.events[0], ...[2, 3, 4, 5].map((index) => ({
    ...structuredClone(source.events[0]),
    uid: `osm-water-games-${index}`,
    occurrenceId: `occ_${String(index).repeat(24)}`,
    dtstart: `202607${String(15 + index).padStart(2, '0')}T183000`,
  }))];
  const hidden = canonical({
    metadata: { ...canonical().metadata, status: { isHidden: true, isApproved: false } },
  });
  const result = mergeCanonicalEventIntoAgenda(source, hidden, HEX);
  assert.equal(result.matched, 5);
  assert.deepEqual(result.agenda.events.map((event) => event.metadata.status.isHidden), [true, true, true, true, true]);
});""")

path = 'lambdas/sqs2scouts/function/tests/test-deployment-artifact.mjs'
sub(path,
    r"test\('visibility guard accepts HEX-wide visibility for five HOLIDAY occurrences'.*\Z",
    """test('visibility guard accepts HEX-wide visibility for five HOLIDAY occurrences', () => {
  const agendaSnapshot = {
    value: { events: [1, 2, 3, 4, 5].map((index) => agendaEvent(`osm-event-${index}`)) },
    eTag: '\"agenda-before\"',
  };
  const eventSnapshot = { value: canonicalEvent(false), eTag: '\"0fe52dbc\"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), agendaSnapshot, eventSnapshot);
  assert.equal(guard.beforeMatched, 5);
  assert.equal(guard.beforeHidden, false);
});

test('legacy occurrence selector is ignored by the visibility guard', () => {
  const occurrenceId = 'occ_0123456789abcdef01234567';
  const agendaSnapshot = {
    value: { events: [1, 2, 3].map((index) => ({ ...agendaEvent(`osm-event-${index}`), occurrenceId: index === 2 ? occurrenceId : `occ_${String(index).repeat(24)}` })) },
  };
  const eventSnapshot = { value: canonicalEvent(false), eTag: '\"before\"' };
  assert.deepEqual(extractVisibilityPersistMutation(occurrenceVisibilityMessage(occurrenceId)), { hex: HOLIDAY_HEX, isHidden: true });
  const guard = buildVisibilityPersistGuard(occurrenceVisibilityMessage(occurrenceId), agendaSnapshot, eventSnapshot);
  assert.equal(guard.beforeMatched, 3);
  assert.equal('occurrenceId' in guard, false);
});

test('visibility read-back rejects an unchanged canonical value', () => {
  const beforeAgenda = { value: { events: [agendaEvent('osm-event-1', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '\"0fe52dbc\"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);
  assert.throws(
    () => verifyVisibilityPersistReadback(guard, { value: { events: [agendaEvent('osm-event-1', true)] } }, { value: canonicalEvent(false), eTag: '\"0fe52dbc\"' }),
    (error) => error?.code === 'PERSISTENCE_READ_BACK_MISMATCH',
  );
});

test('visibility read-back rejects an unchanged S3 ETag when canonical visibility changed', () => {
  const beforeAgenda = { value: { events: [agendaEvent('osm-event-1', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '\"0fe52dbc\"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);
  assert.throws(
    () => verifyVisibilityPersistReadback(guard, { value: { events: [agendaEvent('osm-event-1', true)] } }, { value: canonicalEvent(true), eTag: '\"0fe52dbc\"' }),
    (error) => error?.code === 'PERSISTENCE_ETAG_UNCHANGED',
  );
});

test('visibility read-back rejects one divergent same-HEX agenda instance', () => {
  const beforeAgenda = { value: { events: [agendaEvent('a', false), agendaEvent('b', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '\"old\"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);
  assert.throws(
    () => verifyVisibilityPersistReadback(guard, { value: { events: [agendaEvent('a', true), agendaEvent('b', false)] } }, { value: canonicalEvent(true), eTag: '\"new\"' }),
    (error) => error?.code === 'PERSISTENCE_AGENDA_READ_BACK_MISMATCH',
  );
});

test('visibility read-back succeeds only when canonical S3 and every agenda instance match', () => {
  const beforeAgenda = { value: { events: [agendaEvent('a', false), agendaEvent('b', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '\"old\"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);
  assert.deepEqual(
    verifyVisibilityPersistReadback(guard, { value: { events: [agendaEvent('a', true), agendaEvent('b', true)] } }, { value: canonicalEvent(true), eTag: '\"new\"' }),
    { hex: HOLIDAY_HEX, isHidden: true, eTag: '\"new\"', matched: 2 },
  );
});
""")

path = 'lambdas/sqs2scouts/function/tests/test-persistence-handler.mjs'
sub(path,
    r"  const hideResult = await invoke\('request-hide', OCCURRENCE_A, true\);.*?  assert.equal\(sentMessages.length, 4\);",
    """  const hideResult = await invoke('request-hide', OCCURRENCE_A, true);
  assert.equal(hideResult.statusCode, 200, hideResult.body);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, true);
  assert.equal(store['agenda.json'].events.every((entry) => entry.metadata.status.isHidden === true), true);
  assert.equal(`occurrences/${OCCURRENCE_A}.json` in store, false);
  assert.equal(`occurrences/${OCCURRENCE_B}.json` in store, false);
  assert.equal(activity.at(-1).state, 'completed');

  assert.equal((await invoke('request-hide', OCCURRENCE_A, true)).statusCode, 200);
  assert.equal(store['agenda.json'].events.every((entry) => entry.metadata.status.isHidden === true), true);

  await invoke('request-unhide', OCCURRENCE_A, false);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, false);
  assert.equal(store['agenda.json'].events.every((entry) => entry.metadata.status.isHidden === false), true);
  assert.equal(activity.at(-1).state, 'completed');
  assert.equal(sentMessages.length, 3);

  await invoke('request-hide-wide', undefined, true);
  assert.equal(store[`events/${HEX}.json`].metadata.status.isHidden, true);
  assert.equal(store['agenda.json'].events.every((entry) => entry.metadata.status.isHidden === true), true);
  assert.equal(activity.at(-1).state, 'completed');
  assert.equal(sentMessages.length, 4);""")
replace(path,
    "test('real persistence handler exercises SQS messageBody occurrence hide and unhide', async () => {",
    "test('real persistence handler treats legacy occurrence selectors as HEX-wide visibility', async () => {")

path = 'tests/issue-94-admin-slack-sync.integration.test.mjs'
sub(path,
    r"test\('Slack hide forwards the shared HEX and preserves an optional occurrence selector'.*?\n\}\);",
    """test('Slack hide forwards only the canonical HEX visibility selector', () => {
  const handler = readFileSync('lambdas/scouts-slack-handler/function/slack-handler.mjs', 'utf8');
  const router = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
  assert.match(handler, /error: 'visibility_hex_required'/);
  assert.match(handler, /realm: 'persist'[\\s\\S]*status: \\{ isHidden: true \\}[\\s\\S]*action: 'persist'/);
  assert.doesNotMatch(handler, /subject: \\{[\\s\\S]{0,160}occurrenceId[\\s\\S]{0,160}status: \\{ isHidden: true \\}/);
  assert.match(router, /slackMetadata:[\\s\\S]*message\\.slackMetadata/);
  assert.match(router, /decisionSource/);
});""")

path = 'tests/issue-91-presentation.test.mjs'
replace(path,
    "const approvalWorkflow = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');\n",
    "const approvalWorkflow = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');\nconst adminScript = readFileSync('website/admin/admin-script.js', 'utf8');\n")
marker = "test('issue 91 successful final approval updates state and immediately refreshes its presentation', () => {"
insert = """test('issue 91 shared Admin state uses HEX-scoped optimistic updates and pending keys', () => {
  assert.match(adminScript, /function hexScopedEntries\\(entry\\)/);
  assert.match(adminScript, /function applyLocalApprovalState[\\s\\S]*hexScopedEntries\\(entry\\)/);
  assert.match(adminScript, /function applyLocalPersistedField[\\s\\S]*hexScopedEntries\\(entry\\)/);
  assert.match(adminScript, /return `\\$\\{getEventHex\\(event\\) \\|\\| entry\\?\\.occurrenceId/);
  assert.match(approvalWorkflow, /: `\\$\\{hex\\}:approve`/);
});

"""
replace(path, marker, insert + marker)

# Guard against accidentally leaving production occurrence visibility ownership.
for production_path in [
    'lambdas/sqs2scouts/function/persistence-processor.mjs',
    'lambdas/scouts/function/scouts-service.mjs',
]:
    if 'occurrenceStorageKey' in read(production_path):
        raise SystemExit(f'{production_path}: occurrenceStorageKey still used in production visibility path')
if 'persistVisibilityOverlays' in read('lambdas/sqs2scouts/function/persistence-processor.mjs'):
    raise SystemExit('per-occurrence visibility persistence still present')
