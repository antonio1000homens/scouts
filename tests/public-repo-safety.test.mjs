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

test('tracked text does not contain developer home-directory paths', () => {
  const offenders = [];

  for (const path of trackedFiles) {
    const bytes = readFileSync(path);

    // Git-tracked text files do not necessarily have a conventional extension
    // (.gitignore, .env.example, Dockerfile, etc.). Inspect every tracked file
    // and skip only files that are clearly binary based on an embedded NUL byte.
    if (bytes.includes(0)) continue;

    const content = bytes.toString('utf8');
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(content) || /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i.test(content)) {
      offenders.push(path);
    }
  }

  assert.deepEqual(offenders, [], `Developer home-directory paths found in:\n${offenders.join('\n')}`);
});

test('workflow actions are pinned to immutable commit SHAs', () => {
  const offenders = [];

  for (const path of trackedFiles.filter((value) => value.startsWith('.github/workflows/'))) {
    const content = readFileSync(path, 'utf8');
    const actionRefs = [...content.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map((match) => match[1]);

    for (const actionRef of actionRefs) {
      if (!/@[0-9a-f]{40}$/i.test(actionRef)) offenders.push(`${path}: ${actionRef}`);
    }
  }

  assert.deepEqual(offenders, [], `Unpinned GitHub Actions:\n${offenders.join('\n')}`);
});
