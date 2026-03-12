#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || '2ndtolworth';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const SOURCE_AWS_PROFILE = (process.env.SOURCE_AWS_PROFILE || '').trim();
const TARGET_AWS_PROFILE = (process.env.TARGET_AWS_PROFILE || '').trim();
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(process.cwd(), 'tmp/scouts-bucket-cutover');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_PREFIX = `migration/cutover/${TIMESTAMP}`;
const LEGACY_TOP_LEVEL_FIELDS = new Set([
    'tagline',
    'AI',
    'ai',
    'image',
    'status',
    'approved',
    'isApproved',
    'isHidden',
    'hidden',
    'hiddenAt',
]);

mkdirSync(OUTPUT_DIR, { recursive: true });

function runAws(args, options = {}) {
    const profile = typeof options.profile === 'string' ? options.profile.trim() : '';
    const cliArgs = [...args, '--region', REGION];
    if (profile) {
        cliArgs.unshift('--profile', profile);
    }
    return execFileSync('aws', cliArgs, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        ...options,
    });
}

function runAwsJson(args, options = {}) {
    const output = runAws(args, options);
    return output.trim() ? JSON.parse(output) : {};
}

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeBoolean(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return null;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function readS3Json(bucket, key) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'scouts-cutover-read-'));
    const filePath = path.join(tmpDir, path.basename(key) || 'object.json');
    try {
        runAws(['s3', 'cp', `s3://${bucket}/${key}`, filePath], {
            profile: bucket === SOURCE_BUCKET ? SOURCE_AWS_PROFILE : TARGET_AWS_PROFILE,
        });
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function writeS3Json(bucket, key, value) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'scouts-cutover-write-'));
    const filePath = path.join(tmpDir, path.basename(key) || 'object.json');
    try {
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
        ], { profile: TARGET_AWS_PROFILE });
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function listBucketObjects(bucket, prefix = '') {
    const all = [];
    let continuationToken = null;

    do {
        const args = ['s3api', 'list-objects-v2', '--bucket', bucket, '--output', 'json'];
        if (prefix) args.push('--prefix', prefix);
        if (continuationToken) args.push('--continuation-token', continuationToken);
        const page = runAwsJson(args, {
            profile: bucket === SOURCE_BUCKET ? SOURCE_AWS_PROFILE : TARGET_AWS_PROFILE,
        });
        const contents = Array.isArray(page.Contents) ? page.Contents : [];
        all.push(...contents);
        continuationToken = page.IsTruncated ? page.NextContinuationToken : null;
    } while (continuationToken);

    return all;
}

function copyObject(sourceKey) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'scouts-cutover-copy-'));
    const filePath = path.join(tmpDir, path.basename(sourceKey) || 'object.bin');
    try {
        runAws(['s3', 'cp', `s3://${SOURCE_BUCKET}/${sourceKey}`, filePath], {
            profile: SOURCE_AWS_PROFILE,
        });
        runAws(['s3', 'cp', filePath, `s3://${TARGET_BUCKET}/${sourceKey}`], {
            profile: TARGET_AWS_PROFILE,
        });
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function resolveTargetEventKeys(sourceObjects) {
    try {
        return listBucketObjects(TARGET_BUCKET, 'events/')
            .map((entry) => entry.Key)
            .filter((key) => key.endsWith('.json'));
    } catch (error) {
        console.warn(`Falling back to source manifest for event-key validation: ${error.message}`);
        return sourceObjects
            .map((entry) => entry.key ?? entry.Key)
            .filter((key) => typeof key === 'string' && key.startsWith('events/') && key.endsWith('.json'));
    }
}

function removeLegacyTopLevelFields(objectValue) {
    for (const key of LEGACY_TOP_LEVEL_FIELDS) {
        delete objectValue[key];
    }
    delete objectValue.hexId;
    return objectValue;
}

function canonicalizeEventObject(input, fallbackHex = null) {
    const objectValue = input && typeof input === 'object' && !Array.isArray(input) ? clone(input) : {};
    const metadata = objectValue.metadata && typeof objectValue.metadata === 'object' ? clone(objectValue.metadata) : {};
    const legacyImage = objectValue.image && typeof objectValue.image === 'object' ? objectValue.image : {};
    const legacyStatus = objectValue.status && typeof objectValue.status === 'object' ? objectValue.status : {};

    const hex = normalizeText(
        objectValue.hex
        ?? metadata.hex
        ?? objectValue.hexId
        ?? metadata.hexId
        ?? fallbackHex
    );
    if (hex) {
        const normalizedHex = hex.toLowerCase();
        objectValue.hex = normalizedHex;
        metadata.hex = normalizedHex;
    }
    delete metadata.hexId;

    metadata.tagline = normalizeText(metadata.tagline ?? objectValue.tagline ?? objectValue.AI ?? objectValue.ai);
    metadata.image = {
        theme: normalizeText(
            metadata.image?.theme
            ?? metadata.image?.prompt
            ?? legacyImage.theme
            ?? legacyImage.prompt
        ),
        url: normalizeText(metadata.image?.url ?? legacyImage.url),
    };
    metadata.status = {
        isApproved: normalizeBoolean(
            metadata.status?.isApproved
            ?? legacyStatus.isApproved
            ?? objectValue.isApproved
            ?? objectValue.approved
        ) ?? false,
        isHidden: normalizeBoolean(
            metadata.status?.isHidden
            ?? legacyStatus.isHidden
            ?? objectValue.isHidden
            ?? objectValue.hidden
            ?? (typeof objectValue.status === 'string' && objectValue.status.trim().toLowerCase() === 'hidden' ? true : null)
            ?? (objectValue.hiddenAt ? true : null)
        ) ?? false,
    };

    objectValue.metadata = metadata;
    removeLegacyTopLevelFields(objectValue);
    return objectValue;
}

function canonicalizeAgendaDocument(documentValue) {
    const base = documentValue && typeof documentValue === 'object' && !Array.isArray(documentValue)
        ? clone(documentValue)
        : {};
    const events = Array.isArray(base.events) ? base.events : [];
    base.events = events.map((eventValue) => canonicalizeEventObject(eventValue, eventValue?.hex ?? eventValue?.metadata?.hex ?? null));
    return base;
}

function findLegacyFields(objectValue) {
    return Array.from(LEGACY_TOP_LEVEL_FIELDS).filter((key) => Object.prototype.hasOwnProperty.call(objectValue, key));
}

function validateEventObject(objectValue, key) {
    const failures = [];
    if (!objectValue || typeof objectValue !== 'object' || Array.isArray(objectValue)) {
        failures.push(`${key}: object is not a JSON object`);
        return failures;
    }
    const legacyFields = findLegacyFields(objectValue);
    if (legacyFields.length > 0) {
        failures.push(`${key}: legacy top-level fields remain: ${legacyFields.join(', ')}`);
    }
    if (!objectValue.metadata || typeof objectValue.metadata !== 'object') {
        failures.push(`${key}: metadata object missing`);
        return failures;
    }
    if (!objectValue.metadata.status || typeof objectValue.metadata.status !== 'object') {
        failures.push(`${key}: metadata.status missing`);
    }
    if (!objectValue.metadata.image || typeof objectValue.metadata.image !== 'object') {
        failures.push(`${key}: metadata.image missing`);
    }
    return failures;
}

function uploadReport(localPath, targetKey) {
    try {
        runAws(
            ['s3', 'cp', localPath, `s3://${TARGET_BUCKET}/${targetKey}`, '--content-type', 'application/json', '--cache-control', 'no-store'],
            { profile: TARGET_AWS_PROFILE }
        );
    } catch (error) {
        console.warn(`Skipping remote report upload for ${targetKey}: ${error.message}`);
    }
}

function main() {
    console.log(`Scouts cutover starting: ${SOURCE_BUCKET} -> ${TARGET_BUCKET} (${REGION})`);

    const sourceObjects = listBucketObjects(SOURCE_BUCKET);
    const manifest = {
        generatedAt: new Date().toISOString(),
        region: REGION,
        sourceBucket: SOURCE_BUCKET,
        targetBucket: TARGET_BUCKET,
        objectCount: sourceObjects.length,
        objects: sourceObjects.map((entry) => ({
            key: entry.Key,
            size: entry.Size,
            etag: entry.ETag,
            lastModified: entry.LastModified,
        })),
    };
    const manifestPath = path.join(OUTPUT_DIR, `manifest-${TIMESTAMP}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    uploadReport(manifestPath, `${RUN_PREFIX}/manifest.json`);
    console.log(`Manifest written with ${sourceObjects.length} objects`);

    for (const entry of sourceObjects) {
        copyObject(entry.Key);
    }
    console.log(`Copied ${sourceObjects.length} source objects to target bucket`);

    const targetEventObjects = resolveTargetEventKeys(sourceObjects);

    let migratedEventCount = 0;
    for (const key of targetEventObjects) {
        const eventValue = readS3Json(TARGET_BUCKET, key);
        const hexHint = path.basename(key, '.json');
        const canonical = canonicalizeEventObject(eventValue, hexHint);
        writeS3Json(TARGET_BUCKET, key, canonical);
        migratedEventCount += 1;
    }
    console.log(`Migrated ${migratedEventCount} event objects`);

    const agendaDocument = readS3Json(TARGET_BUCKET, 'agenda.json');
    const canonicalAgenda = canonicalizeAgendaDocument(agendaDocument);
    writeS3Json(TARGET_BUCKET, 'agenda.json', canonicalAgenda);
    console.log('Migrated agenda.json');

    const validationFailures = [];
    for (const key of targetEventObjects) {
        const objectValue = readS3Json(TARGET_BUCKET, key);
        validationFailures.push(...validateEventObject(objectValue, key));
    }

    const validatedAgenda = readS3Json(TARGET_BUCKET, 'agenda.json');
    if (!validatedAgenda || typeof validatedAgenda !== 'object' || Array.isArray(validatedAgenda)) {
        validationFailures.push('agenda.json: document is not an object');
    } else if (!Array.isArray(validatedAgenda.events)) {
        validationFailures.push('agenda.json: events array missing');
    } else {
        validatedAgenda.events.forEach((eventValue, index) => {
            validationFailures.push(...validateEventObject(eventValue, `agenda.json events[${index}]`));
        });
    }

    const validationReport = {
        generatedAt: new Date().toISOString(),
        sourceBucket: SOURCE_BUCKET,
        targetBucket: TARGET_BUCKET,
        migratedEventCount,
        agendaEventCount: Array.isArray(validatedAgenda?.events) ? validatedAgenda.events.length : 0,
        validationFailureCount: validationFailures.length,
        validationFailures,
    };
    const reportPath = path.join(OUTPUT_DIR, `validation-${TIMESTAMP}.json`);
    writeFileSync(reportPath, `${JSON.stringify(validationReport, null, 2)}\n`, 'utf8');
    uploadReport(reportPath, `${RUN_PREFIX}/validation.json`);

    if (validationFailures.length > 0) {
        console.error('Validation failed:');
        for (const failure of validationFailures) {
            console.error(`- ${failure}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Validation passed with zero legacy top-level fields remaining');
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Validation: ${reportPath}`);
}

main();
