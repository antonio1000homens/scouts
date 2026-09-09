import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const functionDir = path.join(repoRoot, 'lambdas/sqs2scouts/function');
const deployScript = readFileSync(path.join(repoRoot, 'lambdas/sqs2scouts/deploy.sh'), 'utf8');

function packagedFiles() {
  const block = deployScript.match(/zip -jq sqs2scouts-lambda\.zip \\\n([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, 'Could not find the sqs2scouts ZIP manifest in deploy.sh');
  return [...block.matchAll(/^\s*([^\\\s]+)(?:\s*\\)?$/gm)].map((match) => match[1]);
}

function relativeImports(zipPath, entry) {
  const source = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  return [...source.matchAll(/from\s+['"](\.\/?[^'"]+)['"]/g)]
    .map((match) => path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1])));
}

test('sqs2scouts deployment ZIP contains every handler-relative import', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'scouts-sqs2scouts-package-'));
  const zipPath = path.join(tempDir, 'sqs2scouts-lambda.zip');
  try {
    const files = packagedFiles();
    execFileSync('zip', ['-jq', zipPath, ...files.map((file) => path.resolve(functionDir, file))], { stdio: 'pipe' });
    const entries = new Set(execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n'));
    assert.ok(entries.has('image-provider-adapter.mjs'));
    assert.ok(entries.has('gemini-text-models.mjs'));

    const pending = ['image-provider-adapter.mjs'];
    const visited = new Set();
    while (pending.length) {
      const entry = pending.pop();
      if (visited.has(entry)) continue;
      visited.add(entry);
      assert.ok(entries.has(entry), `Artifact is missing ${entry}`);
      for (const imported of relativeImports(zipPath, entry)) {
        assert.ok(entries.has(imported), `${entry} imports ${imported}, but the deployment ZIP omits it`);
        pending.push(imported);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
