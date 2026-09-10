import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

const prohibitedTrackedPath = (path) => {
  if (path.includes('/.wrangler/') || path.startsWith('.wrangler/')) return true;
  if (path.startsWith('lambdas/tools/tmp/')) return true;
  if (path === '.env' || path.endsWith('/.env')) return true;
  if (/^distribution-config(?:-[^.]+)?\.json$/.test(path)) return true;
  if (['etag.txt', 'resources-to-import.json', 'iam_policy.json', 'vsstudio-policy-updated.json'].includes(path)) return true;
  return false;
};

test('private/generated deployment artefacts are not tracked', () => {
  const prohibited = trackedFiles.filter(prohibitedTrackedPath);
  assert.deepEqual(prohibited, [], `Prohibited tracked files:\n${prohibited.join('\n')}`);
});

test('calendar parser fixture is explicitly synthetic and contains no obvious UK mobile number', () => {
  const fixture = readFileSync('lambdas/scouts/function/tests/cubs-programme.ics', 'utf8');

  assert.match(fixture, /Synthetic/i);
  assert.match(fixture, /example\.invalid/i);
  assert.doesNotMatch(fixture, /(?:\+44\s?7|\b07)\d(?:[\s-]?\d){8}/);
  assert.doesNotMatch(fixture, /what\s*3\s*words|what3words/i);
});

test('agent documentation does not contain a developer home-directory path', () => {
  const agents = readFileSync('AGENTS.md', 'utf8');
  assert.doesNotMatch(agents, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.doesNotMatch(agents, /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i);
});
