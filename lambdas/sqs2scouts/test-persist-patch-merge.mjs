import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPersistEventPayload } from './function/sqs2scouts.mjs';

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
