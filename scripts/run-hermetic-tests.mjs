#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const testName = (name) => name.endsWith('.test.mjs') || name.endsWith('.integration.test.mjs') || name.startsWith('test-');

function discover(directory) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.mjs') && testName(entry.name)) files.push(path.relative(root, entryPath));
    }
  };
  visit(absolute);
  return files.sort();
}

const groups = new Map([
  ['shared-layer', discover('lambdas/shared-layer/nodejs')],
  ['scouts', discover('lambdas/scouts/function/tests')],
  ['scouts2sqs', discover('lambdas/scouts2sqs/function/tests')],
  ['sqs2scouts', [
    ...discover('lambdas/sqs2scouts/function/tests'),
    ...discover('lambdas/sqs2scouts').filter((file) => file.startsWith('lambdas/sqs2scouts/test-')),
  ].sort()],
  ['repository', discover('tests')],
]);

const expectedGroups = ['shared-layer', 'scouts', 'scouts2sqs', 'sqs2scouts', 'repository'];
for (const name of expectedGroups) {
  if (!groups.get(name)?.length) throw new Error(`Hermetic test discovery selected zero files for ${name}`);
}

const eslint = path.join(root, 'lambdas/shared-layer/nodejs/node_modules/.bin/eslint');
if (!existsSync(eslint)) {
  throw new Error('ESLint is not installed. Run npm ci in lambdas/shared-layer/nodejs first.');
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

console.log('Hermetic static safety: deployed Lambda no-undef');
run(eslint, [
  'lambdas/scouts/function/**/*.mjs',
  'lambdas/scouts2sqs/function/**/*.mjs',
  'lambdas/sqs2scouts/function/**/*.mjs',
  'lambdas/shared-layer/nodejs/**/*.mjs',
]);

console.log('Hermetic static safety self-check: intentional undefined identifier');
try {
  execFileSync(eslint, ['tests/fixtures/no-undef-regression.mjs'], { cwd: root, encoding: 'utf8' });
  throw new Error('ESLint unexpectedly accepted the no-undef regression fixture');
} catch (error) {
  if (error?.status === undefined) throw error;
  const output = `${error.stdout || ''}${error.stderr || ''}`;
  if (!output.includes('message')) throw new Error('ESLint failed the fixture without reporting the undefined identifier');
}

console.log('Hermetic test files selected:');
for (const [name, files] of groups) console.log(`  ${name}: ${files.length}`);
run(process.execPath, ['--experimental-vm-modules', '--test', ...[...groups.values()].flat()]);
