#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const BUCKET = process.env.BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const PREFIX = process.env.PREFIX || 'events/';
const AWS_PROFILE = (process.env.AWS_PROFILE || '').trim();
const APPLY = process.env.APPLY === '1';
const REPORT_PATH = process.env.REPORT_PATH || path.resolve(process.cwd(), 'tmp/event-shape-cleanup-report.json');

function runAws(args) {
  const cliArgs = [...args, '--region', REGION];
  if (AWS_PROFILE) {
    cliArgs.unshift('--profile', AWS_PROFILE);
  }
  return execFileSync('aws', cliArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

function runAwsJson(args) {
  const output = runAws(args);
  return output.trim() ? JSON.parse(output) : {};
}

function withTempFile(key, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scouts-event-cleanup-'));
  const filePath = path.join(dir, path.basename(key) || 'object.json');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listKeys(bucket, prefix) {
  const keys = [];
  let continuationToken = null;
  do {
    const args = ['s3api', 'list-objects-v2', '--bucket', bucket, '--output', 'json'];
    if (prefix) args.push('--prefix', prefix);
    if (continuationToken) args.push('--continuation-token', continuationToken);
    const page = runAwsJson(args);
    for (const entry of page.Contents || []) {
      if (typeof entry.Key === 'string' && entry.Key.endsWith('.json')) {
        keys.push(entry.Key);
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : null;
  } while (continuationToken);
  return keys;
}

function readJsonFromS3(bucket, key) {
  return withTempFile(key, (filePath) => {
    runAws(['s3', 'cp', `s3://${bucket}/${key}`, filePath]);
    return JSON.parse(readFileSync(filePath, 'utf8'));
  });
}

function writeJsonToS3(bucket, key, value) {
  return withTempFile(key, (filePath) => {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    runAws([
      's3',
      'cp',
      filePath,
      `s3://${bucket}/${key}`,
      '--content-type',
      'application/json',
      '--cache-control',
      'no-store',
    ]);
  });
}

function cleanupEventDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { changed: false, value: input, removed: [] };
  }

  const value = JSON.parse(JSON.stringify(input));
  const removed = [];
  let metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : null;
  const drop = (container, key, label) => {
    if (container && typeof container === 'object' && Object.prototype.hasOwnProperty.call(container, key)) {
      delete container[key];
      removed.push(label);
    }
  };

  const legacyHex = typeof value.hex === 'string' && value.hex.trim()
    ? value.hex.trim().toLowerCase()
    : (typeof value.hexId === 'string' && value.hexId.trim()
        ? value.hexId.trim().toLowerCase()
        : '');

  if (!metadata && legacyHex) {
    metadata = {};
    value.metadata = metadata;
    removed.push('created metadata');
  }

  if (metadata) {
    const metadataHex = typeof metadata.hex === 'string' && metadata.hex.trim()
      ? metadata.hex.trim().toLowerCase()
      : '';

    if (!metadataHex && legacyHex) {
      metadata.hex = legacyHex;
      removed.push('moved hex -> metadata.hex');
    } else if (metadataHex && metadata.hex !== metadataHex) {
      metadata.hex = metadataHex;
      removed.push('normalized metadata.hex');
    }
    drop(metadata, 'hexId', 'metadata.hexId');
  }

  drop(value, 'hex', 'hex');
  drop(value, 'hexId', 'hexId');

  drop(value, 'location', 'location');
  drop(value, 'section', 'section');
  drop(value, 'icsType', 'icsType');
  drop(value, 'dstart', 'dstart');
  drop(value, 'processing', 'processing');
  drop(value, 'lastNotificationSent', 'lastNotificationSent');
  drop(value, 'requestIds', 'requestIds');

  if (value.image && typeof value.image === 'object') {
    drop(value.image, 'prompt', 'image.prompt');
  }
  if (value.metadata?.image && typeof value.metadata.image === 'object') {
    drop(value.metadata.image, 'prompt', 'metadata.image.prompt');
  }
  if (value.metadata && typeof value.metadata === 'object') {
    drop(value.metadata, 'requestIds', 'metadata.requestIds');
  }

  return {
    changed: removed.length > 0,
    value,
    removed,
  };
}

function main() {
  const keys = listKeys(BUCKET, PREFIX);
  const changed = [];
  let scanned = 0;
  let unchanged = 0;

  for (const key of keys) {
    scanned += 1;
    const document = readJsonFromS3(BUCKET, key);
    const result = cleanupEventDocument(document);
    if (!result.changed) {
      unchanged += 1;
      continue;
    }
    changed.push({
      key,
      removed: result.removed,
    });
    if (APPLY) {
      writeJsonToS3(BUCKET, key, result.value);
    }
  }

  const report = {
    bucket: BUCKET,
    prefix: PREFIX,
    region: REGION,
    mode: APPLY ? 'apply' : 'dry-run',
    scanned,
    changed: changed.length,
    unchanged,
    keys: changed,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify(report, null, 2));
}

main();
