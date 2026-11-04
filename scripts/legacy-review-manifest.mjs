import { realpathSync, openSync, closeSync, fchmodSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

function isWithin(parent, target) {
  const path = relative(parent, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function buildReviewManifest({ account, region, generatedAt, plans }) {
  return {
    format: 'scouts-legacy-manual-review/v1',
    account,
    region,
    generatedAt,
    rows: plans.map((plan) => ({
      requestId: plan.id,
      hex: plan.hex,
      sourceStage: plan.stage,
      sourceUpdatedAt: plan.sourceUpdatedAt,
      canonicalEventStatus: plan.retryable ? 'present' : plan.item.failureType.S.endsWith('_MISSING') ? 'missing' : 'invalid',
      plannedState: plan.state,
      plannedStage: plan.item.stage.S,
      retryable: plan.retryable,
      alreadyExists: plan.alreadyExists,
    })),
  };
}

export function validateReviewManifestPath(path) {
  if (!path || typeof path !== 'string') throw new Error('Review manifest path is required');
  const target = resolve(path);
  const parent = realpathSync(dirname(target));
  const safeTarget = resolve(parent, basename(target));
  if (isWithin(REPOSITORY_ROOT, target) || isWithin(REPOSITORY_ROOT, safeTarget)) {
    throw new Error('Review manifest must be written outside the repository');
  }
  try {
    lstatSync(safeTarget);
    throw new Error('Review manifest destination already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return safeTarget;
}

export function writeReviewManifest(path, manifest) {
  const safeTarget = validateReviewManifestPath(path);
  const fd = openSync(safeTarget, 'wx', 0o600);
  try {
    // Enforce the intended mode even when the process has an unusual umask.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (error) {
    closeSync(fd);
    unlinkSync(safeTarget);
    throw error;
  }
  closeSync(fd);
  return safeTarget;
}
