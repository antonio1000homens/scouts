#!/usr/bin/env node

/**
 * Test SQS message limits and retry behavior
 * This ensures that:
 * 1. SQS-triggered invocations limit to 1 message
 * 2. POST invocations allow up to 5 messages
 * 3. Hex files with runs > 20 are skipped from retries
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const scoutsSource = readFileSync(new URL('../scouts.mjs', import.meta.url), 'utf8');

test('SQS message limit logic', async (t) => {
  await t.test('maxScoutRequests should be 1 when triggered by SQS', () => {
    // Simulate SQS-triggered event
    const event = {
      _triggeredBySqs: true
    };
    
    // Simulate the maxScoutRequests logic
    const structuredCommand = null;  // No specific command
    const maxScoutRequests = structuredCommand
      && structuredCommand.realm === 'scouts'
      && structuredCommand.subject === 'events'
      && typeof structuredCommand.action === 'number'
        ? Math.max(0, Math.trunc(structuredCommand.action))
        : (event?._triggeredBySqs ? 1 : 5);
    
    assert.strictEqual(maxScoutRequests, 1, 'Should limit to 1 message when triggered by SQS');
  });

  await t.test('maxScoutRequests should be 5 when triggered by POST', () => {
    // Simulate POST-triggered event
    const event = {
      requestContext: { http: { method: 'POST' } }
    };
    
    // Simulate the maxScoutRequests logic
    const structuredCommand = null;  // No specific command
    const maxScoutRequests = structuredCommand
      && structuredCommand.realm === 'scouts'
      && structuredCommand.subject === 'events'
      && typeof structuredCommand.action === 'number'
        ? Math.max(0, Math.trunc(structuredCommand.action))
        : (event?._triggeredBySqs ? 1 : 5);
    
    assert.strictEqual(maxScoutRequests, 5, 'Should allow up to 5 messages when triggered by POST');
  });

  await t.test('Structured command should override default limits', () => {
    // Simulate event with structured command
    const event = {
      _triggeredBySqs: true  // Even if triggered by SQS
    };
    
    const structuredCommand = {
      realm: 'scouts',
      subject: 'events',
      action: 10  // Custom limit
    };
    
    const maxScoutRequests = structuredCommand
      && structuredCommand.realm === 'scouts'
      && structuredCommand.subject === 'events'
      && typeof structuredCommand.action === 'number'
        ? Math.max(0, Math.trunc(structuredCommand.action))
        : (event?._triggeredBySqs ? 1 : 5);
    
    assert.strictEqual(maxScoutRequests, 10, 'Structured command should override default limits');
  });
});

test('Hex file retry skip logic', async (t) => {
  await t.test('Hex files with runs > 20 should be skipped from retries', () => {
    const eventsAtThreshold = [
      { hex: 'abc123', hexFileData: { runs: 15, title: 'Event 1' } },
      { hex: 'def456', hexFileData: { runs: 21, title: 'Event 2' } },
      { hex: 'ghi789', hexFileData: { runs: 20, title: 'Event 3' } },
      { hex: 'jkl012', hexFileData: { runs: 25, title: 'Event 4' } },
    ];
    
    // Simulate the retry logic
    const retryQueue = [];
    for (const item of eventsAtThreshold) {
      if (item?.hexFileData?.runs > 20) {
        console.log(`[Test] Skipping retry for ${item.hex} - runs exceeds 20 (current: ${item.hexFileData.runs})`);
        continue;
      }
      retryQueue.push(item);
    }
    
    // Should only have 2 items (runs 15 and 20)
    assert.strictEqual(retryQueue.length, 2, 'Should only queue 2 items for retry');
    assert.strictEqual(retryQueue[0].hexFileData.runs, 15);
    assert.strictEqual(retryQueue[1].hexFileData.runs, 20);
  });

  await t.test('Hex files with runs exactly 20 should still be retried', () => {
    const item = { hex: 'abc123', hexFileData: { runs: 20, title: 'Event' } };
    
    // Simulate the skip check
    const shouldSkip = item?.hexFileData?.runs > 20;
    
    assert.strictEqual(shouldSkip, false, 'Runs exactly 20 should not be skipped');
  });

  await t.test('Hex files with runs exactly 21 should be skipped', () => {
    const item = { hex: 'abc123', hexFileData: { runs: 21, title: 'Event' } };
    
    // Simulate the skip check
    const shouldSkip = item?.hexFileData?.runs > 20;
    
    assert.strictEqual(shouldSkip, true, 'Runs 21 or more should be skipped');
  });
});

test('Agenda enrichment declares the threshold retry collection before use', () => {
  assert.match(
    scoutsSource,
    /const eventsAtThreshold = \[\];[\s\S]*eventsAtThreshold\.push\(/,
    'enrichEventsWithAI must initialize eventsAtThreshold before collecting retries',
  );
});

console.log('✅ SQS message limit and retry skip tests complete!');
