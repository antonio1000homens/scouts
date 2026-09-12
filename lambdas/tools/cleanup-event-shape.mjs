#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  assertCanonicalEventDocument,
  buildCanonicalEventDocument,
  buildCanonicalMetadata,
  normalizeCanonicalHex,
  titleToHex,
} from '../shared-layer/nodejs/canonical-event.mjs';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const BUCKET = process.env.BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const PREFIX = process.env.PREFIX || 'events/';
const AGENDA_KEY = process.env.AGENDA_KEY || 'agenda.json';
const NORMALIZE_AGENDA = process.env.NORMALIZE_AGENDA !== '0';
const AWS_PROFILE = (process.env.AWS_PROFILE || '').trim();
const APPLY = process.env.APPLY === '1';
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const BACKUP_PREFIX = process.env.BACKUP_PREFIX || `migration-backups/canonical-events/${RUN_ID}/`;
const REPORT_PATH = process.env.REPORT_PATH || path.resolve(process.cwd(), 'tmp/event-shape-cleanup-report.json');

function runAws(args) {
  const cliArgs = [...args, '--region', REGION];
  if (AWS_PROFILE) cliArgs.unshift('--profile', AWS_PROFILE);
  return execFileSync('aws', cliArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
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
      if (typeof entry.Key === 'string' && entry.Key.endsWith('.json')) keys.push(entry.Key);
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

function backupS3Object(bucket, key) {
  const backupKey = `${BACKUP_PREFIX}${key}`;
  runAws(['s3', 'cp', `s3://${bucket}/${key}`, `s3://${bucket}/${backupKey}`]);
  return backupKey;
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

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'approved', 'hidden'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off', 'visible', 'unhidden'].includes(normalized)) return false;
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return null;
}

function firstBoolean(...values) {
  for (const value of values) {
    const candidate = booleanValue(value);
    if (candidate !== null) return candidate;
  }
  return false;
}

function expectedHexFromKey(key) {
  const name = path.basename(key, '.json').trim().toLowerCase();
  return /^[0-9a-f]+$/.test(name) ? name : null;
}

function legacyFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const found = [];
  const topLevel = [
    'AI', 'ai', 'tagline', 'image', 'imageTheme', 'imageUrl', 'sourceImg',
    'status', 'approved', 'isApproved', 'isHidden', 'hidden', 'hiddenAt',
    'hex', 'hexId', 'requestIds', 'processing', 'lastNotificationSent',
    'location', 'section', 'icsType', 'dstart',
  ];
  for (const field of topLevel) if (Object.prototype.hasOwnProperty.call(input, field)) found.push(field);
  if (input.metadata && typeof input.metadata === 'object') {
    for (const field of ['hexId', 'imageTheme', 'imageUrl', 'requests', 'requestIds']) {
      if (Object.prototype.hasOwnProperty.call(input.metadata, field)) found.push(`metadata.${field}`);
    }
    if (input.metadata.image && typeof input.metadata.image === 'object') {
      for (const field of ['prompt', 'src', 'href', 'isApproved']) {
        if (Object.prototype.hasOwnProperty.call(input.metadata.image, field)) found.push(`metadata.image.${field}`);
      }
    }
  }
  return found.sort();
}

export function normalizeEventDocument(input, { expectedHex = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('event document must be a JSON object');
  }

  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const metadataImage = metadata.image && typeof metadata.image === 'object' && !Array.isArray(metadata.image)
    ? metadata.image
    : {};
  const topImage = input.image && typeof input.image === 'object' && !Array.isArray(input.image)
    ? input.image
    : {};
  const metadataStatus = metadata.status && typeof metadata.status === 'object' && !Array.isArray(metadata.status)
    ? metadata.status
    : {};
  const topStatus = input.status && typeof input.status === 'object' && !Array.isArray(input.status)
    ? input.status
    : {};

  const source = input.source && typeof input.source === 'object' && !Array.isArray(input.source)
    ? input.source
    : {};
  const title = firstText(input.title, input.summary, input.name, source.title, source.summary);
  if (!title) throw new Error('event document is missing title');

  const hex = normalizeCanonicalHex(
    expectedHex
      ?? metadata.hex
      ?? metadata.hexId
      ?? input.hex
      ?? input.hexId
      ?? titleToHex(title),
  );

  const tagline = firstText(metadata.tagline, input.tagline, input.AI, input.ai) ?? null;
  const imageTheme = firstText(
    metadataImage.theme,
    metadata.imageTheme,
    topImage.theme,
    input.imageTheme,
  ) ?? null;
  const imageUrl = firstText(
    metadataImage.url,
    metadataImage.src,
    metadataImage.href,
    metadata.imageUrl,
    topImage.url,
    topImage.src,
    topImage.href,
    input.imageUrl,
    input.sourceImg,
  ) ?? null;
  const isHidden = firstBoolean(
    metadataStatus.isHidden,
    topStatus.isHidden,
    input.isHidden,
    input.hidden,
    typeof input.status === 'string' ? input.status : null,
  );
  const isApproved = firstBoolean(
    metadataStatus.isApproved,
    topStatus.isApproved,
    metadataImage.isApproved,
    topImage.isApproved,
    input.isApproved,
    input.approved,
  );
  const requests = Array.isArray(input.requests)
    ? input.requests
    : (Array.isArray(metadata.requests) ? metadata.requests : []);

  const value = buildCanonicalEventDocument({
    title,
    hex,
    tagline,
    imageTheme,
    imageUrl,
    isHidden,
    isApproved,
    requests,
  });
  assertCanonicalEventDocument(value, { expectedHex: hex });

  return {
    changed: JSON.stringify(value) !== JSON.stringify(input),
    value,
    legacyFields: legacyFields(input),
  };
}

export function normalizeAgendaEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('agenda event must be an object');
  }
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const normalized = normalizeEventDocument({
    ...input,
    title: firstText(input.title, input.summary, input.name),
    requests: [],
  });
  const cleaned = structuredClone(input);
  const legacyTopLevel = [
    'AI', 'ai', 'tagline', 'image', 'imageTheme', 'imageUrl', 'sourceImg',
    'status', 'approved', 'isApproved', 'isHidden', 'hidden', 'hiddenAt', 'hex', 'hexId',
  ];
  for (const field of legacyTopLevel) delete cleaned[field];
  cleaned.metadata = buildCanonicalMetadata({
    hex: normalized.value.metadata.hex,
    tagline: normalized.value.metadata.tagline,
    imageTheme: normalized.value.metadata.image.theme,
    imageUrl: normalized.value.metadata.image.url,
    isHidden: normalized.value.metadata.status.isHidden,
    isApproved: normalized.value.metadata.status.isApproved,
  });
  const changed = JSON.stringify(cleaned) !== JSON.stringify(input)
    || JSON.stringify(metadata) !== JSON.stringify(cleaned.metadata);
  return { changed, value: cleaned, legacyFields: legacyFields(input) };
}

export function normalizeAgendaDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.events)) {
    throw new Error('agenda.json must be an object containing an events array');
  }
  let changed = false;
  const events = input.events.map((event) => {
    const normalized = normalizeAgendaEvent(event);
    if (normalized.changed) changed = true;
    return normalized.value;
  });
  return {
    changed,
    value: changed ? { ...input, events } : input,
  };
}

function ensureReportDirectory() {
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
}

export function main() {
  const keys = listKeys(BUCKET, PREFIX);
  const changed = [];
  const invalid = [];
  let scanned = 0;
  let unchanged = 0;

  for (const key of keys) {
    scanned += 1;
    try {
      const document = readJsonFromS3(BUCKET, key);
      const expectedHex = expectedHexFromKey(key);
      const result = normalizeEventDocument(document, { expectedHex });
      if (!result.changed) {
        unchanged += 1;
        continue;
      }
      const entry = {
        key,
        expectedHex,
        legacyFields: result.legacyFields,
        backupKey: null,
      };
      if (APPLY) {
        entry.backupKey = backupS3Object(BUCKET, key);
        writeJsonToS3(BUCKET, key, result.value);
      }
      changed.push(entry);
    } catch (error) {
      invalid.push({ key, error: error?.message || String(error) });
    }
  }

  let agenda = { enabled: NORMALIZE_AGENDA, key: AGENDA_KEY, changed: false, backupKey: null, error: null };
  if (NORMALIZE_AGENDA) {
    try {
      const document = readJsonFromS3(BUCKET, AGENDA_KEY);
      const result = normalizeAgendaDocument(document);
      agenda.changed = result.changed;
      if (result.changed && APPLY) {
        agenda.backupKey = backupS3Object(BUCKET, AGENDA_KEY);
        writeJsonToS3(BUCKET, AGENDA_KEY, result.value);
      }
    } catch (error) {
      agenda.error = error?.message || String(error);
      invalid.push({ key: AGENDA_KEY, error: agenda.error });
    }
  }

  const report = {
    bucket: BUCKET,
    prefix: PREFIX,
    agenda,
    region: REGION,
    mode: APPLY ? 'apply' : 'dry-run',
    backupPrefix: APPLY ? BACKUP_PREFIX : null,
    scanned,
    changed: changed.length,
    unchanged,
    invalid: invalid.length,
    keys: changed,
    errors: invalid,
    generatedAt: new Date().toISOString(),
  };

  ensureReportDirectory();
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));

  if (invalid.length > 0) process.exitCode = 1;
  return report;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) main();
