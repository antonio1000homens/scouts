import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../request-router.mjs', import.meta.url), 'utf8');

test('request router is the deployed entry point and preserves activity identity', () => {
  assert.match(source, /export async function lambdaHandler\(event\)/);
  assert.match(source, /requestId: input\.requestId/);
  assert.match(source, /rootRequestId: input\.rootRequestId/);
  assert.match(source, /await recordRequestActivity\(\{/);
});

test('already-complete requests are terminal no-ops', () => {
  const start = source.indexOf("if (input.startStage === 'complete')");
  const end = source.indexOf("if (input.imageProvider === 'disabled'", start);
  const completeBranch = source.slice(start, end);
  assert.match(completeBranch, /Event already complete; no execution required/);
  assert.match(completeBranch, /state: 'completed'/);
  assert.match(completeBranch, /stage: 'agenda_published'/);
  assert.match(completeBranch, /return \{ status: 'complete'/);
});
