import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildReviewManifest, validateReviewManifestPath, writeReviewManifest } from '../scripts/legacy-review-manifest.mjs';

const samplePlan = {
  id: 'legacy-manual-review#synthetic-digest',
  hex: '74657374206576656e74',
  stage: 'tagline',
  sourceUpdatedAt: '2026-11-03T12:00:00.000Z',
  retryable: true,
  state: 'manual_review',
  alreadyExists: false,
  item: {
    stage: { S: 'tagline' },
    failureType: { S: 'LEGACY_PRIVATE_PROVIDER_ERROR' },
    title: { S: 'Private event title must not be exported' },
    failureMessage: { S: 'Private raw provider error must not be exported' },
  },
};

test('review manifest contains row classifications but omits event titles and raw errors', () => {
  const manifest = buildReviewManifest({
    account: '553490163883',
    region: 'eu-west-2',
    generatedAt: '2026-11-04T10:00:00.000Z',
    plans: [samplePlan],
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.rows.length, 1);
  assert.equal(manifest.rows[0].canonicalEventStatus, 'present');
  assert.equal(manifest.rows[0].retryable, true);
  assert.equal(serialized.includes('Private event title'), false);
  assert.equal(serialized.includes('PRIVATE_PROVIDER_ERROR'), false);
  assert.equal(serialized.includes('Private raw provider error'), false);
});

test('review manifest writer uses owner-only permissions and refuses overwrite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scouts-review-manifest-'));
  const path = join(directory, 'review.json');
  try {
    writeReviewManifest(path, { rows: [] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { rows: [] });
    assert.throws(() => writeReviewManifest(path, { rows: ['replacement'] }), /EEXIST/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { rows: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('review manifest writer rejects repository destinations', () => {
  const repositoryPath = resolve(fileURLToPath(new URL('../tests/review-manifest-must-not-exist.json', import.meta.url)));
  assert.throws(() => validateReviewManifestPath(repositoryPath), /outside the repository/);
});

test('review manifest path validation rejects existing destinations before a scan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scouts-review-manifest-'));
  const path = join(directory, 'review.json');
  try {
    writeReviewManifest(path, { rows: [] });
    assert.throws(() => validateReviewManifestPath(path), /destination already exists/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration rejects an in-repository manifest path before calling AWS', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scouts-review-manifest-preflight-'));
  const marker = join(directory, 'aws-was-called');
  const fakeAws = join(directory, 'aws');
  const script = fileURLToPath(new URL('../scripts/migrate-legacy-manual-review-activity.mjs', import.meta.url));
  const repositoryPath = fileURLToPath(new URL('./must-not-be-created.json', import.meta.url));

  try {
    writeFileSync(fakeAws, '#!/bin/sh\nprintf called > "$FAKE_AWS_MARKER"\nexit 1\n');
    chmodSync(fakeAws, 0o700);
    const result = spawnSync(process.execPath, [
      script,
      '--profile', 'scouts',
      '--review-manifest', repositoryPath,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: directory, FAKE_AWS_MARKER: marker },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Review manifest must be written outside the repository/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
