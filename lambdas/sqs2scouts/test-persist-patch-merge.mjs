import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPersistEventPayload } from './function/persistence-processor.mjs';
import {
    extractVisibilityPersistMutation,
    prepareVisibilityPersistGuard,
    verifyVisibilityPersistGuard,
} from './function/image-provider-adapter.mjs';

const HOLIDAY_HEX = '686f6c69646179';

function canonicalEvent(isHidden = false) {
    return {
        title: 'HOLIDAY',
        metadata: {
            hex: HOLIDAY_HEX,
            tagline: 'School holiday',
            image: {
                theme: 'calendar',
                url: '/website/eventImages/holiday.webp',
            },
            status: {
                isApproved: false,
                isHidden,
            },
        },
        requests: [],
    };
}

function agendaEvent(uid, isHidden = false) {
    return {
        uid,
        summary: 'HOLIDAY',
        dtstart: '20260923T183000',
        metadata: {
            hex: HOLIDAY_HEX,
            tagline: 'School holiday',
            image: { theme: 'calendar', url: '/website/eventImages/holiday.webp' },
            status: { isApproved: false, isHidden },
        },
    };
}

function visibilityMessage(isHidden = true) {
    return {
        realm: 'persist',
        operation: 'persist',
        subject: HOLIDAY_HEX,
        action: JSON.stringify({
            metadata: {
                hex: HOLIDAY_HEX,
                status: { isHidden },
            },
        }),
    };
}

test('buildPersistEventPayload preserves existing HEX data when approval arrives as a patch subject', () => {
    const existingEvent = {
        hex: 'abc123',
        title: 'Tolworth City Farm Conservation Evening',
        metadata: {
            tagline: 'Help the farm get ready for spring.',
            image: {
                theme: 'Community volunteering at dusk',
                url: '/website/eventImages/existing.webp',
            },
            status: {
                isApproved: false,
                isHidden: false,
            },
        },
        image: {
            theme: 'Community volunteering at dusk',
            url: '/website/eventImages/existing.webp',
        },
        source: {
            uid: 'event-1',
        },
    };

    const result = buildPersistEventPayload(
        existingEvent,
        {
            hexId: 'abc123',
            isApproved: true,
        },
        'persist',
    );

    assert.equal(result.title, existingEvent.title);
    assert.equal(result.metadata.tagline, existingEvent.metadata.tagline);
    assert.equal(result.image.url, existingEvent.image.url);
    assert.equal(result.isApproved, true);
    assert.equal(result.hexId, 'abc123');
});

test('encoded action patch deep-merges metadata.status.isHidden into the canonical event', () => {
    const existingEvent = canonicalEvent(false);
    const result = buildPersistEventPayload(
        existingEvent,
        HOLIDAY_HEX,
        visibilityMessage(true).action,
    );

    assert.equal(result.metadata.status.isHidden, true);
    assert.equal(result.metadata.status.isApproved, false);
    assert.equal(result.metadata.tagline, existingEvent.metadata.tagline);
    assert.deepEqual(result.metadata.image, existingEvent.metadata.image);
});

test('visibility mutation is extracted from the encoded downstream action contract', () => {
    assert.deepEqual(extractVisibilityPersistMutation(visibilityMessage(true)), {
        hex: HOLIDAY_HEX,
        isHidden: true,
    });
});

test('duplicate title HEX visibility mutation fails before the persistence worker can write S3', async () => {
    await assert.rejects(
        () => prepareVisibilityPersistGuard(visibilityMessage(true), {
            loadAgenda: async () => ({
                value: {
                    events: [
                        agendaEvent('osm-event-1'),
                        agendaEvent('osm-event-2'),
                        agendaEvent('osm-event-3'),
                        agendaEvent('osm-event-4'),
                        agendaEvent('osm-event-5'),
                    ],
                },
                eTag: '"agenda-before"',
            }),
            loadEvent: async () => ({ value: canonicalEvent(false), eTag: '"0fe52dbc"' }),
        }),
        (error) => error?.code === 'AMBIGUOUS_EVENT_OCCURRENCE' && error?.matched === 5,
    );
});

test('read-back assertion rejects an acknowledged write that kept isHidden false', async () => {
    const guard = await prepareVisibilityPersistGuard(visibilityMessage(true), {
        loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', false)] }, eTag: '"agenda-before"' }),
        loadEvent: async () => ({ value: canonicalEvent(false), eTag: '"0fe52dbc"' }),
    });

    await assert.rejects(
        () => verifyVisibilityPersistGuard(guard, {
            loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', false)] }, eTag: '"agenda-after"' }),
            loadEvent: async () => ({ value: canonicalEvent(false), eTag: '"0fe52dbc"' }),
        }),
        (error) => error?.code === 'PERSISTENCE_READ_BACK_MISMATCH',
    );
});

test('read-back assertion rejects an unchanged ETag when visibility changed', async () => {
    const guard = await prepareVisibilityPersistGuard(visibilityMessage(true), {
        loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', false)] }, eTag: '"agenda-before"' }),
        loadEvent: async () => ({ value: canonicalEvent(false), eTag: '"0fe52dbc"' }),
    });

    await assert.rejects(
        () => verifyVisibilityPersistGuard(guard, {
            loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', true)] }, eTag: '"agenda-after"' }),
            loadEvent: async () => ({ value: canonicalEvent(true), eTag: '"0fe52dbc"' }),
        }),
        (error) => error?.code === 'PERSISTENCE_ETAG_UNCHANGED',
    );
});

test('visibility persistence succeeds only after canonical and agenda read back the requested value', async () => {
    const guard = await prepareVisibilityPersistGuard(visibilityMessage(true), {
        loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', false)] }, eTag: '"agenda-before"' }),
        loadEvent: async () => ({ value: canonicalEvent(false), eTag: '"0fe52dbc"' }),
    });

    const verified = await verifyVisibilityPersistGuard(guard, {
        loadAgenda: async () => ({ value: { events: [agendaEvent('osm-event-1', true)] }, eTag: '"agenda-after"' }),
        loadEvent: async () => ({ value: canonicalEvent(true), eTag: '"new-etag"' }),
    });

    assert.deepEqual(verified, {
        hex: HOLIDAY_HEX,
        isHidden: true,
        eTag: '"new-etag"',
    });
});
