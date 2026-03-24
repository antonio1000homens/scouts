#!/usr/bin/env node
// Downloads all hex files from S3 and checks for legacy top-level fields
import { execFileSync } from 'child_process';

const BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const REGION = 'eu-west-2';
const PROFILE = 'scouts';
const PREFIX = 'events/';

const LEGACY_TOP_FIELDS = ['AI', 'ai', 'tagline', 'approved', 'isApproved', 'isHidden', 'hidden', 'hiddenAt', 'hexId', 'sourceImg', 'location', 'section', 'icsType', 'processing', 'lastNotificationSent', 'requestIds', 'hex'];
const LEGACY_STATUS_AS_STRING = true; // status should be object, not string
const LEGACY_IMAGE_FIELDS = ['prompt', 'src', 'href'];

function aws(args) {
  return execFileSync('aws', [...args, '--region', REGION, '--profile', PROFILE], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

// List all keys
const listOut = aws(['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', PREFIX, '--output', 'json']);
const keys = JSON.parse(listOut).Contents.map(c => c.Key);

console.log(`Checking ${keys.length} hex files...\n`);

let clean = 0;
const dirty = [];

for (const key of keys) {
  const raw = aws(['s3', 'cp', `s3://${BUCKET}/${key}`, '-']);
  const data = JSON.parse(raw);
  const found = [];

  for (const field of LEGACY_TOP_FIELDS) {
    if (field in data) found.push(field);
  }

  if (typeof data.status === 'string') found.push('status (string, should be in metadata.status)');

  if (data.image && typeof data.image === 'object') {
    for (const field of LEGACY_IMAGE_FIELDS) {
      if (field in data.image) found.push(`image.${field}`);
    }
    if (data.metadata?.image) found.push('image (top-level duplicate)');
  }

  if (found.length === 0) {
    clean++;
  } else {
    dirty.push({ key, title: data.title ?? data.summary ?? '?', found });
  }
}

console.log(`Scanned : ${keys.length}`);
console.log(`Clean   : ${clean}`);
console.log(`Dirty   : ${dirty.length}\n`);

if (dirty.length > 0) {
  for (const { key, title, found } of dirty) {
    console.log(`  [${title}]`);
    console.log(`    key   : ${key}`);
    console.log(`    legacy: ${found.join(', ')}`);
  }
  process.exit(1);
} else {
  console.log('✓ All hex files are clean. Normalisation logic in scouts.mjs can be safely removed.');
}
