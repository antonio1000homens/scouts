import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SFNClient, DescribeExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import {
  getEnrichmentState,
  evaluateEnrichmentEligibility,
  buildGenerationId,
} from '/opt/nodejs/enrichment-state.mjs';
// Updated: Testing CI deployment mode to bypass environment parsing issues

const {
  CUBS_EVENTS_CALENDAR_URL,
  CUBS_PROGRAMME_CALENDAR_URL,
  SCOUTS_EVENTS_CALENDAR_URL,
  SCOUTS_PROGRAMME_CALENDAR_URL,
  BEAVERS_EVENTS_CALENDAR_URL,
  BEAVERS_PROGRAMME_CALENDAR_URL,
  TARGET_BUCKET,
  REQUIRED_API_KEY_PARAMETER,
  SCOUTS2SQS_FUNCTION_URL,
  SCOUTS_REQUESTS_QUEUE_URL: SCOUTS_REQUESTS_QUEUE_URL_ENV,
  IMAGE_ENRICH_STATE_MACHINE_ARN,
} = process.env;

const DEFAULT_BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const DEFAULT_SCOUTS2SQS_URL = '';
const QUEUED_REQUESTS_RUNTIME_KEY = 'runtime/scoutsQueued.json';
const PROCESSING_REQUESTS_RUNTIME_KEY = 'runtime/scoutsProcessing.json';
const COMPLETED_REQUESTS_RUNTIME_KEY = 'runtime/scoutsComplete.json';
const QUEUED_RUNTIME_STALE_PRUNE_MS = 24 * 60 * 60 * 1000;

const SECTION_CUBS = 'cubs';
const SECTION_BEAVERS = 'beavers';
const SECTION_SCOUTS = 'scouts';
const SECTION_ALL = 'all';
const EVENT_IMAGE_PREFIX = 'website/eventImages/';
const LEGACY_EVENT_IMAGE_PREFIX = 'website/images/';
const RELATIVE_IMAGE_PREFIXES = [EVENT_IMAGE_PREFIX, LEGACY_EVENT_IMAGE_PREFIX];

function normaliseApiKeyCandidate(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalised = normaliseApiKeyCandidate(item);
      if (normalised) return normalised;
    }
    return '';
  }
  return String(value).trim();
}

function apiKeyMeta(value) {
  const key = normaliseApiKeyCandidate(value);
  return {
    present: Boolean(key),
    length: key.length,
    last4: key ? key.slice(-4) : '',
  };
}

function normaliseSection(value, fallback = SECTION_CUBS) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const candidate = String(value).trim().toLowerCase();
  if (!candidate) {
    return fallback;
  }

  if (candidate === SECTION_CUBS) return SECTION_CUBS;
  if (candidate === SECTION_BEAVERS) return SECTION_BEAVERS;
  if (candidate === SECTION_SCOUTS) return SECTION_SCOUTS;
  if (candidate === SECTION_ALL) return SECTION_ALL;
  return fallback;
}

function combineSections(first, second) {
  const normalisedFirst = normaliseSection(first, null);
  const normalisedSecond = normaliseSection(second, null);

  if (!normalisedFirst && !normalisedSecond) return SECTION_CUBS;
  if (!normalisedFirst) return normalisedSecond;
  if (!normalisedSecond) return normalisedFirst;
  if (normalisedFirst === normalisedSecond) return normalisedFirst;
  return SECTION_ALL;
}

function normalizeComparableText(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildEventIdentityKey(event) {
  if (!event) return '';
  const dateKey = event.sortKey || event.start?.sortKey || event.start?.raw || '';
  const titleKey = normalizeComparableText(event.title ?? event.summary ?? '');
  const locationKey = normalizeComparableText(event.location ?? '');
  const primary = [dateKey, titleKey, locationKey].filter(Boolean).join('|');
  if (primary) {
    return primary;
  }

  const uidKey = normalizeComparableText(event.uid ?? '');
  if (uidKey) {
    return `uid:${uidKey}`;
  }

  return '';
}

function buildEventChangeKey(event, index = 0) {
  if (!event || typeof event !== 'object') return `idx:${index}`;
  const hex = typeof event.hex === 'string' ? event.hex.trim().toLowerCase() : '';
  if (hex) return `hex:${hex}`;
  const uid = typeof event.uid === 'string' ? event.uid.trim() : '';
  if (uid) return `uid:${uid}`;
  const identity = buildEventIdentityKey(event);
  if (identity) return `identity:${identity}`;
  return `idx:${index}`;
}

function buildEventChangeSnapshot(event) {
  const image = event?.image && typeof event.image === 'object' ? event.image : {};
  return {
    tagline: getEventTagline(event),
    imageTheme: image.theme ?? null,
    imageUrl: image.url ?? null,
    status: getEventStatusObject(event) ?? null,
    hiddenAt: getEventStatusObject(event)?.isHidden === true ? true : null,
  };
}

function areChangeValuesEqual(left, right) {
  const leftValue = left ?? null;
  const rightValue = right ?? null;

  if (leftValue === rightValue) {
    return true;
  }

  if (typeof leftValue === 'object' && leftValue !== null && typeof rightValue === 'object' && rightValue !== null) {
    try {
      return JSON.stringify(leftValue) === JSON.stringify(rightValue);
    } catch (_) {
      return false;
    }
  }

  return false;
}

function listModifiedEvents(beforeEvents = [], afterEvents = []) {
  const beforeMap = new Map();
  for (let index = 0; index < beforeEvents.length; index += 1) {
    const event = beforeEvents[index];
    const key = buildEventChangeKey(event, index);
    beforeMap.set(key, event);
  }

  const modified = [];

  for (let index = 0; index < afterEvents.length; index += 1) {
    const current = afterEvents[index];
    const key = buildEventChangeKey(current, index);
    const previous = beforeMap.get(key) || null;
    const beforeSnapshot = buildEventChangeSnapshot(previous || {});
    const afterSnapshot = buildEventChangeSnapshot(current || {});

    const fields = ['tagline', 'imageTheme', 'imageUrl', 'status', 'hiddenAt'];
    const changes = [];
    for (const field of fields) {
      if (!areChangeValuesEqual(beforeSnapshot[field], afterSnapshot[field])) {
        changes.push({
          field,
          before: beforeSnapshot[field] ?? null,
          after: afterSnapshot[field] ?? null,
        });
      }
    }

    if (changes.length > 0) {
      modified.push({
        key,
        uid: current?.uid ?? null,
        hex: current?.hex ?? null,
        title: current?.title ?? current?.summary ?? null,
        changes,
      });
    }
  }

  return modified;
}

function buildNormalizationSummary() {
  return {
    description: 'Canonical storage shape applied during refresh and persistence flows.',
    rules: [
      'HEX identifiers are stored under metadata.hex in lowercase.',
      'Event metadata is stored in the canonical metadata shape: metadata.tagline, metadata.image, and metadata.status.',
      'Request history is stored on the HEX top-level requests array and excluded from agenda metadata.',
      'Agenda storage is reduced to the canonical shape: uid, summary, dtstart, lastModified, and metadata.',
    ],
  };
}

function normalizeImagePrompt(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

function getEventMetadata(event) {
  if (!event || typeof event !== 'object') return null;
  return event.metadata && typeof event.metadata === 'object' ? event.metadata : null;
}

function trimOptionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function getEventImageContainer(event) {
  if (!event || typeof event !== 'object') return null;
  const metadataImage = getEventMetadata(event)?.image;
  return metadataImage && typeof metadataImage === 'object' ? metadataImage : null;
}

function getEventImageTheme(event) {
  const image = getEventImageContainer(event);
  if (!image) return null;
  const candidate = image.theme ?? null;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed || null;
}

function getEventImageUrl(event) {
  const image = getEventImageContainer(event);
  if (!image) return null;
  const candidate = image.url ?? null;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed || null;
}

function getEventStatusObject(event) {
  if (!event || typeof event !== 'object') return null;
  const metadataStatus = getEventMetadata(event)?.status;
  return metadataStatus && typeof metadataStatus === 'object' ? metadataStatus : null;
}

function isEventApproved(event) {
  if (!event || typeof event !== 'object') return false;
  const status = getEventStatusObject(event);
  return status?.isApproved === true;
}

function buildStatusForStorage(event) {
  const status = getEventStatusObject(event);
  const isHidden = status?.isHidden === true;
  const isApproved = status?.isApproved === true;
  return {
    isHidden,
    isApproved,
  };
}

function buildAgendaMetadata(event) {
  if (!event || typeof event !== 'object') return null;
  const sourceMetadata = getEventMetadata(event);
  const metadata = sourceMetadata && typeof sourceMetadata === 'object'
    ? JSON.parse(JSON.stringify(sourceMetadata))
    : {};
  metadata.hex = trimOptionalText(metadata.hex)?.toLowerCase() ?? null;
  metadata.tagline = trimOptionalText(metadata.tagline);
  metadata.image = {
    theme: getEventImageTheme(event),
    url: getEventImageUrl(event),
  };
  metadata.status = buildStatusForStorage(event);
  // Request history is stored on HEX top-level `requests` and is not required in agenda metadata.
  if ('requests' in metadata) delete metadata.requests;
  if ('requestIds' in metadata) delete metadata.requestIds;
  return metadata;
}

function appendMetadataRequestRecord(eventData, record) {
  if (!eventData || typeof eventData !== 'object' || !record || typeof record !== 'object') {
    return false;
  }
  if (!Array.isArray(eventData.requests)) {
    eventData.requests = [];
  }

  const normalizedRecord = {
    timestamp: typeof record.timestamp === 'string' && record.timestamp.trim()
      ? record.timestamp.trim()
      : new Date().toISOString(),
    requestId: typeof record.requestId === 'string' && record.requestId.trim()
      ? record.requestId.trim()
      : null,
    realm: typeof record.realm === 'string' && record.realm.trim() ? record.realm.trim() : null,
    subject: typeof record.subject === 'string' && record.subject.trim() ? record.subject.trim() : null,
    action: typeof record.action === 'string' && record.action.trim() ? record.action.trim() : null,
    status: typeof record.status === 'string' && record.status.trim() ? record.status.trim() : null,
  };

  const key = `${normalizedRecord.requestId ?? ''}|${normalizedRecord.realm ?? ''}|${normalizedRecord.subject ?? ''}|${normalizedRecord.action ?? ''}|${normalizedRecord.status ?? ''}`;
  const existingIndex = eventData.requests.findIndex((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryKey = `${entry.requestId ?? ''}|${entry.realm ?? ''}|${entry.subject ?? ''}|${entry.action ?? ''}|${entry.status ?? ''}`;
    return entryKey === key && key !== '|||';
  });

  if (existingIndex >= 0) {
    eventData.requests[existingIndex] = {
      ...eventData.requests[existingIndex],
      ...normalizedRecord,
    };
    return true;
  }

  eventData.requests.push(normalizedRecord);
  return true;
}

function getQueuedRuntimeHexFromSubject(subject) {
  if (typeof subject === 'string') {
    const trimmed = subject.trim().toLowerCase();
    if (trimmed && /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
      return trimmed;
    }
    return null;
  }
  if (!subject || typeof subject !== 'object') {
    return null;
  }
  const candidate = subject.hex ?? null;
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim().toLowerCase()
    : null;
}

function normaliseRuntimeText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return text || null;
}

function getQueuedRuntimeHexFromPayload(payload) {
  const directHex = normaliseRuntimeText(payload?.hex ?? payload?.requestHex ?? null);
  if (directHex && /^[0-9a-f]+$/i.test(directHex)) {
    return directHex.toLowerCase();
  }
  return getQueuedRuntimeHexFromSubject(payload?.subject);
}

function getQueuedRuntimeTitleFromPayload(payload) {
  const directTitle = normaliseRuntimeText(payload?.title ?? null);
  if (directTitle) {
    return directTitle;
  }

  const subject = payload?.subject;
  if (!subject || typeof subject !== 'object') {
    return null;
  }
  return normaliseRuntimeText(subject.title ?? null);
}

function getQueuedRuntimeSubjectFromPayload(payload) {
  const explicitSubject = normaliseRuntimeText(payload?.subjectLabel ?? null);
  if (explicitSubject) {
    return explicitSubject;
  }

  if (typeof payload?.subject === 'string') {
    return normaliseRuntimeText(payload.subject);
  }

  if (payload?.subject && typeof payload.subject === 'object') {
    return normaliseRuntimeText(payload.subject.value ?? null);
  }

  return null;
}

function buildQueuedRuntimeRequestEntry(payload, messageId = null, timestamp = new Date().toISOString()) {
  const requestId = typeof payload?.requestId === 'string' && payload.requestId.trim()
    ? payload.requestId.trim()
    : null;
  const runtimeMessageId = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;
  const hex = getQueuedRuntimeHexFromPayload(payload);
  const subject = getQueuedRuntimeSubjectFromPayload(payload);
  const realm = typeof payload?.realm === 'string' && payload.realm.trim() ? payload.realm.trim() : null;
  const action = typeof payload?.action === 'string' && payload.action.trim() ? payload.action.trim() : null;
  const taskToken = normaliseRuntimeText(payload?.taskToken ?? null);
  const orchestrationType = normaliseRuntimeText(payload?.orchestrationType ?? null);
  const orchestrationStep = normaliseRuntimeText(payload?.orchestrationStep ?? null);

  return {
    requestTime: timestamp,
    requestId,
    messageId: runtimeMessageId,
    hex,
    title: getQueuedRuntimeTitleFromPayload(payload),
    subject,
    realm,
    action,
    taskToken,
    orchestrationType,
    orchestrationStep,
    status: 'queued',
  };
}

function deduplicateQueuedRuntimeRequests(entries = []) {
  const deduped = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const taskToken = normaliseRuntimeText(entry.taskToken ?? null);
    const key = taskToken
      ? [
          'taskToken',
          taskToken,
          entry.orchestrationStep ?? '',
          entry.status ?? '',
        ].join('|')
      : [
          entry.requestId ?? '',
          entry.messageId ?? '',
          entry.hex ?? '',
          entry.realm ?? '',
          entry.action ?? '',
          entry.status ?? '',
        ].join('|');
    deduped.set(key, entry);
  }
  return Array.from(deduped.values()).slice(0, 200);
}

function getRuntimeSnapshotRequests(snapshot) {
  return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function getQueuedRuntimeRequestId(entry) {
  if (typeof entry?.requestId === 'string' && entry.requestId.trim()) return entry.requestId.trim();
  if (typeof entry?.messageId === 'string' && entry.messageId.trim()) return entry.messageId.trim();
  return '';
}

function getQueuedRuntimeRequestHex(entry) {
  if (typeof entry?.hex === 'string' && entry.hex.trim()) return entry.hex.trim().toLowerCase();
  return '';
}

function getQueuedRuntimeRequestKey(entry) {
  const taskToken = typeof entry?.taskToken === 'string' && entry.taskToken.trim()
    ? entry.taskToken.trim()
    : '';
  if (taskToken) return `taskToken:${taskToken}`;
  const requestId = getQueuedRuntimeRequestId(entry);
  if (requestId) return requestId;
  const hex = getQueuedRuntimeRequestHex(entry);
  const title = typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : '';
  return [hex, title].filter(Boolean).join('|');
}

function getQueuedRuntimeRequestTimestamp(entry) {
  const candidate = typeof entry?.requestTime === 'string' && entry.requestTime.trim()
    ? entry.requestTime.trim()
    : (typeof entry?.updatedAt === 'string' && entry.updatedAt.trim() ? entry.updatedAt.trim() : '');
  if (!candidate) return 0;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRuntimeRequestKeySet(snapshot) {
  return new Set(
    getRuntimeSnapshotRequests(snapshot)
      .map((entry) => getQueuedRuntimeRequestKey(entry))
      .filter(Boolean)
  );
}

function getQueuedRuntimeHexSignature(entry) {
  const hex = getQueuedRuntimeRequestHex(entry);
  if (!hex) return '';
  const realm = typeof entry?.realm === 'string' && entry.realm.trim() ? entry.realm.trim() : '';
  const action = typeof entry?.action === 'string' && entry.action.trim() ? entry.action.trim() : '';
  const title = typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : '';
  return [hex, realm, action, title].filter(Boolean).join('|');
}

function buildRuntimeRequestState(snapshot) {
  const requestKeys = buildRuntimeRequestKeySet(snapshot);
  const hexSignatures = new Map();

  for (const entry of getRuntimeSnapshotRequests(snapshot)) {
    const signature = getQueuedRuntimeHexSignature(entry);
    if (!signature) continue;
    const timestampMs = getQueuedRuntimeRequestTimestamp(entry);
    const existingTimestampMs = hexSignatures.get(signature) ?? 0;
    if (timestampMs >= existingTimestampMs) {
      hexSignatures.set(signature, timestampMs);
    }
  }

  return { requestKeys, hexSignatures };
}

function pruneQueuedRuntimeRequests(entries = [], processingSnapshot = null, completedSnapshot = null, nowMs = Date.now()) {
  const processingState = buildRuntimeRequestState(processingSnapshot);
  const completedState = buildRuntimeRequestState(completedSnapshot);
  const latestQueuedByHex = new Map();
  const retainedWithoutHex = [];
  let removedCount = 0;

  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const key = getQueuedRuntimeRequestKey(entry);
    const hexSignature = getQueuedRuntimeHexSignature(entry);
    const timestampMs = getQueuedRuntimeRequestTimestamp(entry);
    const isOlderThanPruneThreshold = timestampMs > 0 && (nowMs - timestampMs) > QUEUED_RUNTIME_STALE_PRUNE_MS;
    const completedTimestampMs = hexSignature ? (completedState.hexSignatures.get(hexSignature) ?? 0) : 0;
    const matchesCompletedRequest = (key && completedState.requestKeys.has(key))
      || (hexSignature && completedState.hexSignatures.has(hexSignature) && (
        completedTimestampMs === 0 || timestampMs === 0 || completedTimestampMs >= timestampMs
      ));
    const existsDownstream = (key && processingState.requestKeys.has(key))
      || (hexSignature && processingState.hexSignatures.has(hexSignature));

    if (matchesCompletedRequest) {
      removedCount += 1;
      continue;
    }

    if (isOlderThanPruneThreshold && !existsDownstream) {
      removedCount += 1;
      continue;
    }

    if (!hexSignature) {
      retainedWithoutHex.push({ entry, index });
      continue;
    }

    const existing = latestQueuedByHex.get(hexSignature);
    if (!existing || timestampMs >= existing.timestampMs) {
      if (existing) {
        removedCount += 1;
      }
      latestQueuedByHex.set(hexSignature, { entry, index, timestampMs });
      continue;
    }

    removedCount += 1;
  }

  const retained = [
    ...retainedWithoutHex,
    ...Array.from(latestQueuedByHex.values()),
  ]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.entry);

  return {
    requests: deduplicateQueuedRuntimeRequests(retained),
    removedCount,
  };
}

function buildQueuedRuntimeSnapshotPayload(requests, timestamp = new Date().toISOString()) {
  const requestIds = Array.from(new Set(requests.map((entry) => entry?.requestId).filter(Boolean))).slice(0, 50);
  const hexes = Array.from(new Set(requests.map((entry) => entry?.hex).filter(Boolean))).slice(0, 50);
  const links = Array.from(new Map(
    requests
      .filter((entry) => entry?.requestId && entry?.hex)
      .map((entry) => [`${entry.requestId}|${entry.hex}`, {
        requestId: entry.requestId,
        hex: entry.hex,
        sourceMessageId: entry.messageId ?? null,
        realm: entry.realm ?? null,
        action: entry.action ?? null,
      }])
  ).values()).slice(0, 100);

  return {
    source: 'scouts',
    queue: 'scoutsRequests',
    updatedAt: timestamp,
    requests,
    requestIds,
    hexes,
    links,
    recordCount: requests.length,
  };
}

async function appendQueuedRuntimeSnapshot(payload, messageId = null) {
  const bucket = TARGET_BUCKET || DEFAULT_BUCKET;
  const timestamp = new Date().toISOString();
  const nextEntry = buildQueuedRuntimeRequestEntry(payload, messageId, timestamp);
  const existingSnapshot = await getJsonFromS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, 'runtime:scoutsQueued');
  const processingSnapshot = await getJsonFromS3(bucket, PROCESSING_REQUESTS_RUNTIME_KEY, 'runtime:processingrequests');
  const completedSnapshot = await getJsonFromS3(bucket, COMPLETED_REQUESTS_RUNTIME_KEY, 'runtime:completedrequests');
  const mergedRequests = deduplicateQueuedRuntimeRequests([
    ...(Array.isArray(existingSnapshot?.requests) ? existingSnapshot.requests : []),
    nextEntry,
  ]);
  const { requests } = pruneQueuedRuntimeRequests(mergedRequests, processingSnapshot, completedSnapshot, Date.now());
  const snapshot = buildQueuedRuntimeSnapshotPayload(requests, timestamp);

  await putJsonToS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, snapshot, 'runtime:scoutsQueued', true);
}

async function touchQueuedRuntimeSnapshot(bucket, existingSnapshot = null) {
  const queuedSnapshot = existingSnapshot ?? await getJsonFromS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, 'runtime:scoutsQueued');
  const processingSnapshot = await getJsonFromS3(bucket, PROCESSING_REQUESTS_RUNTIME_KEY, 'runtime:processingrequests');
  const completedSnapshot = await getJsonFromS3(bucket, COMPLETED_REQUESTS_RUNTIME_KEY, 'runtime:completedrequests');
  const queuedRequests = getRuntimeSnapshotRequests(queuedSnapshot);
  const { requests } = pruneQueuedRuntimeRequests(queuedRequests, processingSnapshot, completedSnapshot, Date.now());
  const nextSnapshot = buildQueuedRuntimeSnapshotPayload(requests);
  await putJsonToS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, nextSnapshot, 'runtime:scoutsQueued', true);
  return nextSnapshot;
}


function getRequestHistory(eventData) {
  if (!eventData || typeof eventData !== 'object') return [];
  if (Array.isArray(eventData.requests)) return eventData.requests;
  const metadata = getEventMetadata(eventData);
  if (Array.isArray(metadata?.requests)) return metadata.requests;
  return [];
}

function getLatestRequestTimestamp(eventData) {
  const history = getRequestHistory(eventData);
  let latest = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    if (!raw) continue;
    const epoch = Date.parse(raw);
    if (Number.isFinite(epoch) && epoch > latest) {
      latest = epoch;
    }
  }
  return latest;
}

function removeTopLevelFieldsDuplicatedByMetadata(event) {
  if (!event || typeof event !== 'object') return false;
  const metadata = getEventMetadata(event);
  if (!metadata) return false;

  let changed = false;

  if (typeof metadata.tagline === 'string' && metadata.tagline.trim()) {
    if ('tagline' in event) {
      delete event.tagline;
      changed = true;
    }
    if ('AI' in event) {
      delete event.AI;
      changed = true;
    }
    if ('ai' in event) {
      delete event.ai;
      changed = true;
    }
  }

  if (metadata.image && typeof metadata.image === 'object' && event.image && typeof event.image === 'object') {
    if (metadata.image.theme != null && 'theme' in event.image) {
      delete event.image.theme;
      changed = true;
    }
    if (metadata.image.url != null && 'url' in event.image) {
      delete event.image.url;
      changed = true;
    }
    if (metadata.image.prompt != null && 'prompt' in event.image) {
      delete event.image.prompt;
      changed = true;
    }
    if (Object.keys(event.image).length === 0) {
      delete event.image;
      changed = true;
    }
  }

  if ('requestIds' in event) {
    delete event.requestIds;
    changed = true;
  }

  if (typeof metadata.hex === 'string' && metadata.hex.trim()) {
    if ('hex' in event) {
      delete event.hex;
      changed = true;
    }
    if ('hexId' in event) {
      delete event.hexId;
      changed = true;
    }
  }

  if (metadata.status && typeof metadata.status === 'object') {
    if ('status' in event) {
      delete event.status;
      changed = true;
    }
    if ('approved' in event) {
      delete event.approved;
      changed = true;
    }
    if ('isApproved' in event) {
      delete event.isApproved;
      changed = true;
    }
    if ('isHidden' in event) {
      delete event.isHidden;
      changed = true;
    }
    if ('hidden' in event) {
      delete event.hidden;
      changed = true;
    }
    if ('hiddenAt' in event) {
      delete event.hiddenAt;
      changed = true;
    }
  }

  return changed;
}

function buildHexMetadata({
  hex = null,
  tagline = null,
  imageTheme = null,
  imageUrl = null,
  isHidden = false,
  isApproved = false,
} = {}) {
  return {
    hex: trimOptionalText(hex)?.toLowerCase() ?? null,
    tagline: trimOptionalText(tagline),
    image: {
      theme: trimOptionalText(imageTheme),
      url: trimOptionalText(imageUrl),
    },
    status: {
      isHidden: isHidden === true,
      isApproved: isApproved === true,
    },
  };
}

function sanitizeEventUid(uid) {
  if (uid === undefined || uid === null) return null;
  let candidate = String(uid).trim();
  if (!candidate) return null;
  candidate = candidate.split(/[\/\\]/)[0] || candidate;
  candidate = candidate.replace(/\s+/g, '-');
  candidate = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
  candidate = candidate.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const digitPrefixMatch = candidate.match(/^(.*?\d+)/);
  if (digitPrefixMatch) {
    candidate = digitPrefixMatch[1];
  }
  return candidate || null;
}

function applySanitizedUidToEvent(event) {
  if (!event) return null;
  const rawUid = event.uid ?? event.originalUid ?? event.raw?.UID ?? null;
  const sanitized = sanitizeEventUid(rawUid);
  if (!sanitized) return null;
  if (rawUid && rawUid !== sanitized) {
    event.originalUid = rawUid;
  } else if (event.originalUid && event.originalUid === event.uid) {
    event.originalUid = undefined;
  }
  event.uid = sanitized;
  return sanitized;
}

function titleToHex(title) {
  if (!title) return null;
  const normalized = String(title).trim().toLowerCase();
  if (!normalized) return null;
  return Buffer.from(normalized, 'utf8').toString('hex');
}

function buildHexStorageKey(title) {
  const hex = titleToHex(title);
  if (!hex) {
    throw new Error('Cannot build HEX storage key without a valid title');
  }
  return `events/${hex}.json`;
}

function extractImageKeyDetails(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return { key: null, hadLeadingSlash: false, isLegacy: false, isPreferred: false, isAbsolute: false };
  }

  const trimmed = imageUrl.trim();
  if (!trimmed) {
    return { key: null, hadLeadingSlash: false, isLegacy: false, isPreferred: false, isAbsolute: false };
  }

  const isAbsolute = /^https?:\/\//i.test(trimmed) || trimmed.startsWith('s3://');
  let candidate = trimmed;
  let hadLeadingSlash = false;

  if (!isAbsolute && candidate.startsWith('/')) {
    hadLeadingSlash = true;
    candidate = candidate.substring(1);
  }

  if (isAbsolute) {
    const parts = candidate.split('/');
    const keyStartIndex = parts.findIndex((part, idx) => {
      if (idx === 0) return false;
      if (idx === 1 && part === '') return false;
      if (part.includes('s3') || part.includes('amazonaws')) return false;
      return true;
    });
    candidate = keyStartIndex >= 0 ? parts.slice(keyStartIndex).join('/') : candidate;
  }

  return {
    key: candidate,
    hadLeadingSlash,
    isLegacy: candidate.startsWith(LEGACY_EVENT_IMAGE_PREFIX),
    isPreferred: candidate.startsWith(EVENT_IMAGE_PREFIX),
    isAbsolute,
  };
}

async function migrateLegacyImageIfNeeded(bucket, imageUrl) {
  const details = extractImageKeyDetails(imageUrl);
  if (!details.key || !details.isLegacy) {
    return null;
  }

  const suffix = details.key.slice(LEGACY_EVENT_IMAGE_PREFIX.length);
  const destinationKey = `${EVENT_IMAGE_PREFIX}${suffix}`;

  if (destinationKey === details.key) {
    return null;
  }

  try {
    const copyCommand = new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${details.key}`,
      Key: destinationKey,
    });
    await s3.send(copyCommand);
    console.log(`[Image Migration] Copied ${details.key} -> ${destinationKey}`);
    return details.hadLeadingSlash ? `/${destinationKey}` : destinationKey;
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey') {
      console.warn(`[Image Migration] Legacy image missing for ${details.key}`);
    } else {
      console.warn(`[Image Migration] Failed to migrate ${details.key} -> ${destinationKey}:`, error?.message || String(error));
    }
    return null;
  }
}

function unfoldIcs(text) {
  if (!text) return '';
  return text.replace(/\r?\n[ \t]/g, '');
}

function cleanValue(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function toIsoString(value) {
  if (!value) return null;
  const upper = value.toUpperCase().trim();
  if (/^\d{8}T\d{6}Z$/.test(upper)) {
    return `${upper.slice(0, 4)}-${upper.slice(4, 6)}-${upper.slice(6, 8)}T${upper.slice(9, 11)}:${upper.slice(11, 13)}:${upper.slice(13, 15)}Z`;
  }
  if (/^\d{8}T\d{6}$/.test(upper)) {
    return `${upper.slice(0, 4)}-${upper.slice(4, 6)}-${upper.slice(6, 8)}T${upper.slice(9, 11)}:${upper.slice(11, 13)}:${upper.slice(13, 15)}`;
  }
  if (/^\d{8}$/.test(upper)) {
    return `${upper.slice(0, 4)}-${upper.slice(4, 6)}-${upper.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/.test(upper)) {
    return upper;
  }
  return upper;
}

function buildSortKey(value) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 8) {
    return `${digits}000000`;
  }
  if (digits.length >= 14) {
    return digits.slice(0, 14);
  }
  return digits.padEnd(14, '0');
}

// (OAuth flow removed) - helper code and test scripts were removed to simplify
// fetching public ICS feeds. If you need to access protected feeds, provide
// a proxy or use a pre-authorised calendar URL in your configuration.

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const sfn = new SFNClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const SCOUTS_REQUESTS_QUEUE_URL = SCOUTS_REQUESTS_QUEUE_URL_ENV || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests";
const ACTIVE_EXECUTIONS_LIMIT = 20;
const GEMINI_USAGE_TABLE_NAME = String(process.env.GEMINI_USAGE_TABLE_NAME || '').trim();
const GEMINI_DAILY_REQUEST_LIMIT = Math.max(0, Math.floor(Number(process.env.GEMINI_DAILY_REQUEST_LIMIT || 0)));

function buildImageEnrichRuntimeStageIndex(runtimeQueueSnapshots = {}) {
  const stageIndex = new Map();
  const snapshots = [
    { snapshot: runtimeQueueSnapshots?.processingSnapshot, fallbackStage: 'processing' },
    { snapshot: runtimeQueueSnapshots?.queuedSnapshot, fallbackStage: 'queued' },
    { snapshot: runtimeQueueSnapshots?.completedSnapshot, fallbackStage: 'completed' },
  ];

  for (const { snapshot, fallbackStage } of snapshots) {
    for (const entry of getRuntimeSnapshotRequests(snapshot)) {
      const orchestrationType = normaliseRuntimeText(entry?.orchestrationType ?? null);
      if (orchestrationType !== 'imageEnrich') {
        continue;
      }

      const hex = normaliseRuntimeText(entry?.hex ?? null)?.toLowerCase() ?? null;
      if (!hex) continue;

      const updatedAt = firstDefinedValue(
        entry?.updatedAt,
        entry?.requestTime,
        entry?.completedAt,
        null,
      );
      const timestampValue = hasText(updatedAt) ? new Date(updatedAt).getTime() : 0;
      const existing = stageIndex.get(hex);
      if (existing && existing.timestampValue > timestampValue) {
        continue;
      }

      stageIndex.set(hex, {
        currentStage: normaliseRuntimeText(entry?.orchestrationStep ?? null) ?? fallbackStage,
        workerStatus: normaliseRuntimeText(entry?.status ?? null) ?? fallbackStage,
        requestId: normaliseRuntimeText(entry?.requestId ?? null),
        updatedAt: hasText(updatedAt) ? String(updatedAt) : null,
        timestampValue,
      });
    }
  }

  return stageIndex;
}

async function describeExecutionInput(executionArn) {
  if (!hasText(executionArn)) {
    return {};
  }
  const response = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  if (!hasText(response?.input)) {
    return {};
  }
  try {
    return JSON.parse(response.input);
  } catch (_) {
    return {};
  }
}

async function listActiveImageEnrichExecutions(runtimeQueueSnapshots = null) {
  const stateMachineArn = trimOptionalText(IMAGE_ENRICH_STATE_MACHINE_ARN);
  if (!stateMachineArn) {
    return {
      configured: false,
      stateMachineArn: null,
      activeExecutionCount: 0,
      activeExecutions: [],
    };
  }

  const response = await sfn.send(new ListExecutionsCommand({
    stateMachineArn,
    statusFilter: 'RUNNING',
    maxResults: ACTIVE_EXECUTIONS_LIMIT,
  }));

  const runtimeStageIndex = buildImageEnrichRuntimeStageIndex(runtimeQueueSnapshots || {});
  const activeExecutions = Array.isArray(response?.executions)
    ? await Promise.all(response.executions.map(async (execution) => {
        const executionInput = await describeExecutionInput(execution?.executionArn ?? null);
        const hex = trimOptionalText(executionInput?.requestHex ?? executionInput?.hex ?? null)?.toLowerCase() ?? null;
        const runtimeStage = hex ? runtimeStageIndex.get(hex) : null;
        return {
          executionArn: execution?.executionArn ?? null,
          name: execution?.name ?? null,
          status: execution?.status ?? 'RUNNING',
          startDate: execution?.startDate
            ? new Date(execution.startDate).toISOString()
            : null,
          stopDate: execution?.stopDate
            ? new Date(execution.stopDate).toISOString()
            : null,
          hex,
          requestId: trimOptionalText(executionInput?.requestId ?? runtimeStage?.requestId ?? null),
          currentStage: trimOptionalText(runtimeStage?.currentStage ?? null),
          workerStatus: trimOptionalText(runtimeStage?.workerStatus ?? null),
          updatedAt: trimOptionalText(runtimeStage?.updatedAt ?? null),
        };
      }))
    : [];

  return {
    configured: true,
    stateMachineArn,
    executionCount: activeExecutions.length,
    activeExecutionCount: activeExecutions.length,
    executions: activeExecutions,
    activeExecutions,
  };
}

// Themed icons are configurable via optional S3 configuration; keep an empty default
// so the runtime falls back to the static Scout logo when nothing is provided.
function formatDateComponent(value, params) {
  if (!value) return null;
  const timezone = params?.tzid || params?.tz || null;
  const iso = toIsoString(value);
  const allDay = /^\d{8}$/i.test(value);
  let epochMillis = null;
  if (iso) {
    const isoForDate = allDay
      ? `${iso}T00:00:00Z`
      : iso.endsWith('Z')
        ? iso
        : `${iso}${timezone ? '' : 'Z'}`;
    const parsed = Date.parse(isoForDate);
    if (!Number.isNaN(parsed)) {
      epochMillis = parsed;
    }
  }
  return {
    raw: value,
    iso,
    timezone,
    allDay,
    epochMillis,
    sortKey: buildSortKey(value),
  };
}

function parseIcsEvents(icsText) {
  const unfolded = unfoldIcs(icsText);
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  const events = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.split('END:VEVENT')[0];
    if (!block) continue;

    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const event = { raw: {} };

    for (const line of lines) {
      const [propertyPart, valuePart] = line.split(':', 2);
      if (!propertyPart || valuePart === undefined) continue;

      const [propertyName, ...paramParts] = propertyPart.split(';');
      const property = propertyName.toUpperCase();
      const params = {};

      for (const paramPart of paramParts) {
        const [key, paramValue] = paramPart.split('=');
        if (key && paramValue) {
          params[key.toLowerCase()] = paramValue;
        }
      }

      const cleanedValue = cleanValue(valuePart);
      event.raw[property] = cleanedValue;

      switch (property) {
        case 'UID':
          event.uid = cleanedValue;
          break;
        case 'SUMMARY':
          event.title = cleanedValue;
          break;
        case 'DESCRIPTION':
          event.description = cleanedValue;
          break;
        case 'LOCATION':
          event.location = cleanedValue;
          break;
        case 'URL':
          event.url = cleanedValue;
          break;
        case 'CATEGORIES':
          event.categories = cleanedValue
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          break;
        case 'DTSTAMP':
        case 'LAST-MODIFIED':
          event.lastModified = formatDateComponent(cleanedValue, params);
          break;
        case 'DTSTART':
          event.start = formatDateComponent(cleanedValue, params);
          break;
        case 'DTEND':
          event.end = formatDateComponent(cleanedValue, params);
          break;
        default:
          break;
      }
    }

    // No longer extracting images from ICS - imagery is provided asynchronously or via themed fallbacks
    event.image = {
      prompt: null,
      url: null,
    };

    const sanitizedUid = applySanitizedUidToEvent(event);
    if (!sanitizedUid) continue;

    const sortKey = event.start?.sortKey || buildSortKey(event.raw.DTSTART);
    if (!event.title || !sortKey) continue;

    event.sortKey = sortKey;
    events.push(event);
  }

  return events.sort((a, b) => {
    if (a.sortKey === b.sortKey) return 0;
    return a.sortKey > b.sortKey ? 1 : -1;
  });
}

function dedupeSectionedEvents(events, { defaultSection = SECTION_CUBS } = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const merged = new Map();

  for (const rawEvent of events) {
    if (!rawEvent) continue;
    const section = normaliseSection(rawEvent.section, defaultSection);
    const candidate = {
      ...rawEvent,
      section,
    };
    if (!applySanitizedUidToEvent(candidate)) {
      continue;
    }
    const identityKey = buildEventIdentityKey(candidate)
      || (candidate.uid ? `uid:${candidate.uid}` : null);
    if (!identityKey) {
      continue;
    }

    if (!merged.has(identityKey)) {
      merged.set(identityKey, candidate);
      continue;
    }

    const existing = merged.get(identityKey);
    existing.section = combineSections(existing.section, candidate.section);

    if (!existing.uid && candidate.uid) {
      existing.uid = candidate.uid;
    }

    // Prefer titles that start with uppercase letter
    if (!existing.title && candidate.title) {
      existing.title = candidate.title;
    } else if (existing.title && candidate.title) {
      const existingStartsUpper = /^[A-Z]/.test(existing.title);
      const candidateStartsUpper = /^[A-Z]/.test(candidate.title);
      if (!existingStartsUpper && candidateStartsUpper) {
        existing.title = candidate.title;
      }
    }

    if (!existing.location && candidate.location) {
      existing.location = candidate.location;
    }

    if ((!existing.start || !existing.start.raw) && candidate.start) {
      existing.start = candidate.start;
    }

    if (!existing.sortKey && candidate.sortKey) {
      existing.sortKey = candidate.sortKey;
    }

    if (!existing.lastModified && candidate.lastModified) {
      existing.lastModified = candidate.lastModified;
    }

    if (candidate.image) {
      existing.image = existing.image ?? {};
      if (!existing.image.url && candidate.image.url) {
        existing.image.url = candidate.image.url;
      }
      if (!existing.image.theme && candidate.image.theme) {
        existing.image.theme = candidate.image.theme;
      }
    }

    merged.set(identityKey, existing);
  }

  return Array.from(merged.values());
}

async function fetchCalendar(url, label) {
  if (!url) {
    throw new Error(`Missing URL for ${label} calendar`);
  }
  // Default behaviour: request the calendar URL without Authorization headers.
  // Historically the function supported fetching calendars with additional
  // authentication. That behaviour was intentionally removed to simplify
  // operations where public ICS feeds are used. If you need to access a
  // protected feed, provide a proxy or use a pre-authorised calendar URL in
  // the relevant `*_CALENDAR_URL` environment variable.

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to fetch ${label} calendar: ${response.status} ${response.statusText} ${body}`);
  }

  return response.text();
}



async function putJsonToS3(bucket, key, payload, label, suppressLog = false) {
  const isEventKey = typeof key === 'string' && key.startsWith('events/');
  const isAgendaKey = typeof key === 'string' && /(^|\/)agenda\.json$/i.test(key);
  // For event files under the 'events/' prefix, ensure we don't persist a top-level `uid` field.
  const toStore = (isEventKey || isAgendaKey)
    ? (function () {
        try {
          let clone = JSON.parse(JSON.stringify(payload));
          if (clone && typeof clone === 'object') {
            if (isEventKey) {
              if (!Array.isArray(clone.requests)) {
                clone.requests = [];
              }
              if ('uid' in clone) delete clone.uid;
              if ('originalUid' in clone) delete clone.originalUid;
              removeTopLevelFieldsDuplicatedByMetadata(clone);
            }
            if (isAgendaKey && Array.isArray(clone.events)) {
              clone.events = clone.events.map((event) => prepareEventForStorage(event));
            }
          }
          return clone;
        } catch (err) {
          return payload;
        }
      })()
    : payload;

  const body = JSON.stringify(toStore, null, 2);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    CacheControl: 'no-store',
  });

  await s3.send(command);
  if (!suppressLog) {
    console.log(`Stored ${label} data in s3://${bucket}/${key}`);
  }
}

async function putRawIcsToS3(bucket, key, icsData, label) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: icsData,
    ContentType: 'text/calendar',
    CacheControl: 'max-age=300',
  });

  await s3.send(command);
  console.log(`Stored raw ${label} ICS data in s3://${bucket}/${key}`);
}

/**
 * Download an image from a URL and upload it to S3.
 * Returns the S3 URL (using the website endpoint) or null if download fails.
 */
async function downloadImageToS3(imageUrl, bucket, eventTitle) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    console.warn('[Image Download] Invalid image URL provided');
    return null;
  }

  const trimmedUrl = imageUrl.trim();
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    console.warn('[Image Download] URL must start with http:// or https://');
    return null;
  }

  try {
    console.log(`[Image Download] Downloading image from: ${trimmedUrl}`);
    
    // Fetch the image
    const response = await fetch(trimmedUrl);
    if (!response.ok) {
      console.warn(`[Image Download] Failed to fetch image: ${response.status} ${response.statusText}`);
      return null;
    }

    // Get the content type to determine file extension
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    let extension = '.jpg';
    if (contentType.includes('png')) {
      extension = '.png';
    } else if (contentType.includes('gif')) {
      extension = '.gif';
    } else if (contentType.includes('webp')) {
      extension = '.webp';
    } else if (contentType.includes('svg')) {
      extension = '.svg';
    }

    // Create a sanitized filename based on event title or timestamp
    const timestamp = Date.now();
    const sanitizedTitle = eventTitle
      ? eventTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50)
      : 'event';
    const filename = `${sanitizedTitle}-${timestamp}${extension}`;
    const s3Key = `${EVENT_IMAGE_PREFIX}${filename}`;

    // Download image as buffer
    const imageBuffer = await response.arrayBuffer();
    
    // Upload to S3
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: Buffer.from(imageBuffer),
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000', // Cache for 1 year
    });

    await s3.send(command);
    console.log(`[Image Download] Uploaded image to s3://${bucket}/${s3Key}`);

    // Return the S3 website URL
    // Format: http://BUCKET.s3-website.REGION.amazonaws.com/KEY
    const region = process.env.AWS_REGION || 'eu-west-2';
    const s3WebsiteUrl = `http://${bucket}.s3-website.${region}.amazonaws.com/${s3Key}`;
    
    console.log(`[Image Download] Image available at: ${s3WebsiteUrl}`);
    return s3WebsiteUrl;
  } catch (error) {
    console.error(`[Image Download] Error downloading image from ${trimmedUrl}:`, error.message);
    return null;
  }
}

/**
 * Return the ICS body from S3 if the object's LastModified is within freshnessMs.
 * Returns the body string when fresh, or null when stale/missing/error.
 */
async function getFreshIcsFromS3(bucket, key, freshnessMs = 60 * 60 * 1000) {
  try {
    const headCmd = new HeadObjectCommand({ Bucket: bucket, Key: key });
    const head = await s3.send(headCmd);
    const lastModified = head?.LastModified ? new Date(head.LastModified).getTime() : null;
    if (lastModified && Date.now() - lastModified <= freshnessMs) {
      // Read the object content and return it
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const resp = await s3.send(getCmd);
      const body = await resp.Body.transformToString();
      console.log(`Using cached ICS from s3://${bucket}/${key} (LastModified=${head.LastModified})`);
      return body;
    }
    return null;
  } catch (error) {
    // If object doesn't exist or cannot be read, treat as not fresh
    if (error && (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.Code === 'NoSuchKey')) {
      return null;
    }
    console.warn(`Failed to check/read s3://${bucket}/${key}: ${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

async function getJsonFromS3(bucket, key, label) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await s3.send(command);
    const bodyString = await response.Body.transformToString();
    const data = JSON.parse(bodyString);
    return data;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

async function deleteObjectFromS3(bucket, key, label) {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  await s3.send(command);
  console.log(`Deleted ${label} data from s3://${bucket}/${key}`);
}

async function purgeEventFilesFromS3(bucket, prefix = 'events/') {
  const removed = [];
  let continuationToken = undefined;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const response = await s3.send(listCommand);
    const objects = response?.Contents || [];

    if (!objects.length && !response?.IsTruncated) {
      break;
    }

    for (const object of objects) {
      const key = object?.Key;
      if (!key) continue;

      let uid = null;
      let title = null;

      try {
        const data = await getJsonFromS3(bucket, key, `event:${key}`);
        if (data && typeof data === 'object') {
          applySanitizedUidToEvent(data);
        }
        uid = data?.uid ?? null;
        title = data?.title ?? data?.summary ?? null;
      } catch (error) {
        console.warn(`[Reset] Unable to read s3://${bucket}/${key} before deletion:`, error?.message || String(error));
      }

      await deleteObjectFromS3(bucket, key, `event:${uid || key}`);
      removed.push({
        key,
        uid: uid ?? null,
        title: title ?? null,
      });
    }

    continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return removed;
}

async function deleteOrphanedHexFiles(bucket, agendaData) {
  const removed = [];
  let continuationToken = undefined;
  
  // Build set of normalized titles from agenda for fast lookup
  const agendaTitles = new Set();
  if (agendaData?.events) {
    for (const event of agendaData.events) {
      const title = event.summary || event.title;
      if (title) {
        agendaTitles.add(normalizeComparableText(title));
      }
    }
  }

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'events/',
      ContinuationToken: continuationToken,
    });
    const response = await s3.send(listCommand);
    const objects = response?.Contents || [];

    if (!objects.length && !response?.IsTruncated) {
      break;
    }

    for (const object of objects) {
      const key = object?.Key;
      if (!key || !key.endsWith('.json')) continue;

      let hexData = null;
      try {
        hexData = await getJsonFromS3(bucket, key, `hex:${key}`);
      } catch (error) {
        console.warn(`[Cleanup] Unable to read s3://${bucket}/${key}:`, error?.message || String(error));
        continue;
      }

      if (!hexData || typeof hexData !== 'object') continue;

      const title = hexData.title || hexData.summary;
      if (!title) continue;

      // Check if missing AI, image theme, and image url
      const hasAI = !!getEventTagline(hexData);
      const hasImageTheme = !!getEventImageTheme(hexData);
      const hasImageUrl = !!getEventImageUrl(hexData);
      const missingAllContent = !hasAI && !hasImageTheme && !hasImageUrl;

      if (!missingAllContent) continue;

      // Check if title exists in agenda (case insensitive)
      const normalizedTitle = normalizeComparableText(title);
      const isInAgenda = agendaTitles.has(normalizedTitle);

      if (isInAgenda) continue;

      // Delete the orphaned HEX file
      try {
        await deleteObjectFromS3(bucket, key, `orphaned-hex:${title}`);
        removed.push({
          key,
          title,
          reason: 'missing content and not in agenda'
        });
        console.log(`[Cleanup] Deleted orphaned HEX file: ${key} (${title})`);
      } catch (deleteError) {
        console.warn(`[Cleanup] Failed to delete s3://${bucket}/${key}:`, deleteError?.message || String(deleteError));
      }
    }

    continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return removed;
}



function formatRemovedEventsForAction(removedEvents) {
  if (!removedEvents || removedEvents.length === 0) {
    return 'No events removed';
  }

  return removedEvents
    .map((event, index) => {
      const derivedUid =
        event?.uid
        ?? (event?.key ? event.key.replace(/^events\//, '').replace(/\.json$/i, '') : null)
        ?? `event-${index + 1}`;
      const titleSuffix = event?.title ? ` - ${event.title}` : '';
      return `${derivedUid}${titleSuffix}`;
    })
    .join('\n');
}

async function postToScoutsRequestsQueue(payload, contextLabel) {
  // Do not forward persistent identifiers (uid/originalUid) to SQS.
  // Clone the payload to avoid mutating the caller's object, then strip uid fields
  // from any object subject before sending.
  let outgoing = payload;
  try {
    outgoing = JSON.parse(JSON.stringify(payload));
    if (outgoing && typeof outgoing === 'object' && outgoing.subject && typeof outgoing.subject === 'object') {
      // Remove top-level identifier fields that we don't want to propagate
      delete outgoing.subject.uid;
      delete outgoing.subject.originalUid;
    }
  } catch (err) {
    // If cloning fails, fall back to using the original payload but still avoid adding uids
    if (payload && typeof payload === 'object' && payload.subject && typeof payload.subject === 'object') {
      try {
        delete payload.subject.uid;
        delete payload.subject.originalUid;
      } catch (_) {
        // ignore
      }
    }
    outgoing = payload;
  }

  if (outgoing && typeof outgoing === 'object') {
    if (typeof outgoing.requestId !== 'string' || !outgoing.requestId.trim()) {
      outgoing.requestId = randomUUID();
    } else {
      outgoing.requestId = outgoing.requestId.trim();
    }
  }

  const command = new SendMessageCommand({
    QueueUrl: SCOUTS_REQUESTS_QUEUE_URL,
    MessageBody: JSON.stringify(outgoing),
  });

  try {
    const sendResult = await sqs.send(command);
    console.log(`[SQS] ${contextLabel}:`, JSON.stringify(outgoing));
    try {
      await appendQueuedRuntimeSnapshot(outgoing, sendResult?.MessageId ?? null);
    } catch (runtimeError) {
      console.warn('[Runtime] Failed to update scoutsQueued snapshot:', runtimeError?.message || runtimeError);
    }
    return {
      messageId: sendResult?.MessageId ?? null,
      md5OfMessageBody: sendResult?.MD5OfMessageBody ?? null,
      queueUrl: SCOUTS_REQUESTS_QUEUE_URL,
      payload: outgoing,
    };
  } catch (error) {
    console.error(`[${contextLabel}] Failed to send message to scoutsRequests queue:`, error.message);
    throw new Error(`scoutsRequests queue notification failed: ${error.message}`);
  }
}

async function notifyResetToScoutsRequestsQueue(removedEvents) {
  const actionSummary = formatRemovedEventsForAction(removedEvents);
  console.log('[Reset] Sending scoutsRequests queue notification', {
    removedEventsCount: removedEvents?.length || 0,
  });
  await postToScoutsRequestsQueue(
    {
      realm: 'scouts',
      subject: 'reset',
      action: actionSummary,
    },
    'Reset',
  );
}



function parseBooleanFlag(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (!normalised) return true;
    return ['true', '1', 'yes', 'y', 'on'].includes(normalised);
  }
  return false;
}

function decodeRequestBody(event) {
  if (!event?.body) return {};
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(rawBody);
  } catch (error) {
    console.warn('Failed to parse JSON body:', error.message);
    return {};
  }
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function sanitizeLogValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, seen));
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = /api[_-]?key|authorization|token/i.test(key)
      ? '[REDACTED]'
      : sanitizeLogValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

function normaliseProcessingRealm(realm) {
  if (typeof realm !== 'string') return null;
  const candidate = realm.trim().toLowerCase();
  if (!candidate) return null;
  if (candidate === 'tagline') return 'tagline';
  if (candidate === 'imagetheme') return 'imageTheme';
  if (candidate === 'image') return 'image';
  return null;
}

function normaliseProcessingList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = [];
  const seen = new Set();
  for (const entry of value) {
    const realm = normaliseProcessingRealm(entry);
    if (!realm || seen.has(realm)) continue;
    seen.add(realm);
    unique.push(realm);
  }
  return unique;
}

function addProcessingRealmToIndex(index, hexValue, realm) {
  const hex = typeof hexValue === 'string' ? hexValue.trim().toLowerCase() : '';
  const normalizedRealm = normaliseProcessingRealm(realm);
  if (!hex || !normalizedRealm) return;

  const existing = index.get(hex) ?? [];
  if (existing.includes(normalizedRealm)) return;
  index.set(hex, [...existing, normalizedRealm]);
}

function hasEventTagline(event) {
  const tagline = getEventTagline(event);
  return typeof tagline === 'string' && tagline.length > 0;
}

function getEventTagline(event) {
  if (!event || typeof event !== 'object') return null;
  const metadataTagline = getEventMetadata(event)?.tagline;
  if (typeof metadataTagline === 'string') {
    const trimmedMetadataTagline = metadataTagline.trim();
    if (trimmedMetadataTagline.length > 0) {
      return trimmedMetadataTagline;
    }
  }
  return null;
}

function deriveProcessingRealmFromEvent(event, isEligibleForImageProcessing = true) {
  if (!event || typeof event !== 'object') return null;
  if (isEventHidden(event)) return null;
  if (!hasEventTagline(event)) return 'tagline';
  if (isEligibleForImageProcessing && !getEventImageTheme(event)) return 'imageTheme';
  if (isEligibleForImageProcessing && !getEventImageUrl(event)) return 'image';
  return null;
}

async function isGeminiCircuitOpen(now = new Date()) {
  if (GEMINI_DAILY_REQUEST_LIMIT <= 0 || !GEMINI_USAGE_TABLE_NAME) {
    return { open: true, reason: 'budget_circuit_open' };
  }
  const day = now.toISOString().slice(0, 10);
  try {
    const response = await dynamo.send(new GetItemCommand({
      TableName: GEMINI_USAGE_TABLE_NAME,
      Key: { usageDay: { S: day }, usageScope: { S: 'requests' } },
      ConsistentRead: true,
    }));
    const count = Number(response?.Item?.requestCount?.N || 0);
    return count >= GEMINI_DAILY_REQUEST_LIMIT
      ? { open: true, reason: 'budget_circuit_open', count }
      : { open: false, count };
  } catch (error) {
    console.warn('[Enrichment] Failed to read Gemini daily circuit; skipping automatic enqueue:', error?.message || error);
    return { open: true, reason: 'budget_circuit_unavailable' };
  }
}

async function checkEnrichmentEligibility(hex, stage, context = {}) {
  const circuit = await isGeminiCircuitOpen();
  if (circuit.open) {
    console.log(JSON.stringify({ hex, stage, skipReason: circuit.reason, attemptCount: null, nextRetryAt: null }));
    return { eligible: false, reason: circuit.reason };
  }
  try {
    const state = await getEnrichmentState(hex, stage);
    const generationId = context.event
      ? buildGenerationId(hex, stage, context.event)
      : null;
    const evaluation = evaluateEnrichmentEligibility(state, new Date(), generationId);
    if (!evaluation.eligible) {
      console.log(JSON.stringify({
        hex,
        stage,
        state: state?.state || null,
        attemptCount: Number(state?.attemptCount || 0),
        nextRetryAt: state?.nextRetryAt || null,
        skipReason: evaluation.reason,
        requestId: context.requestId || null,
      }));
    }
    return { ...evaluation, state };
  } catch (error) {
    console.warn('[Enrichment] Failed to read per-stage state; skipping automatic enqueue:', error?.message || error);
    return { eligible: false, reason: 'state_store_unavailable' };
  }
}

function mergeProcessingSnapshotIntoIndex(snapshot, index, eventByHex) {
  const requests = Array.isArray(snapshot?.requests)
    ? snapshot.requests
    : (Array.isArray(snapshot?.observed?.requests) ? snapshot.observed.requests : []);
  for (const request of requests) {
    const hex = typeof request?.hex === 'string' ? request.hex.trim().toLowerCase() : '';
    if (!hex) continue;

    const requestSubject = typeof request?.subject === 'string' ? request.subject.trim().toLowerCase() : '';
    if (requestSubject === 'tagline') {
      addProcessingRealmToIndex(index, hex, 'tagline');
      continue;
    }
    if (requestSubject === 'imagetheme') {
      addProcessingRealmToIndex(index, hex, 'imageTheme');
      continue;
    }
    if (requestSubject === 'imageurl') {
      addProcessingRealmToIndex(index, hex, 'image');
      continue;
    }

    const requestRealm = normaliseProcessingRealm(request?.realm);
    if (requestRealm) {
      addProcessingRealmToIndex(index, hex, requestRealm);
      continue;
    }

    const derivedRealm = deriveProcessingRealmFromEvent(eventByHex.get(hex));
    if (derivedRealm) {
      addProcessingRealmToIndex(index, hex, derivedRealm);
    }
  }

  const links = Array.isArray(snapshot?.links)
    ? snapshot.links
    : (Array.isArray(snapshot?.observed?.links) ? snapshot.observed.links : []);
  for (const link of links) {
    const hex = typeof link?.hex === 'string' ? link.hex.trim().toLowerCase() : '';
    if (!hex) continue;

    const linkedRealm = normaliseProcessingRealm(link?.realm);
    if (linkedRealm) {
      addProcessingRealmToIndex(index, hex, linkedRealm);
      continue;
    }

    const linkRealm = typeof link?.realm === 'string' ? link.realm.trim().toLowerCase() : '';
    if (linkRealm === 'scoutsrequest') {
      const derivedRealm = deriveProcessingRealmFromEvent(eventByHex.get(hex));
      if (derivedRealm) {
        addProcessingRealmToIndex(index, hex, derivedRealm);
      }
    }
  }

  const hexes = Array.isArray(snapshot?.hexes)
    ? snapshot.hexes
    : (Array.isArray(snapshot?.observed?.hexes)
      ? snapshot.observed.hexes
      : (Array.isArray(snapshot?.hexIds)
        ? snapshot.hexIds
        : (Array.isArray(snapshot?.observed?.hexIds) ? snapshot.observed.hexIds : [])));
  for (const rawHex of hexes) {
    const hex = typeof rawHex === 'string' ? rawHex.trim().toLowerCase() : '';
    if (!hex) continue;
    const derivedRealm = deriveProcessingRealmFromEvent(eventByHex.get(hex));
    if (derivedRealm) {
      addProcessingRealmToIndex(index, hex, derivedRealm);
    }
  }
}

async function readRuntimeQueueSnapshots(bucket) {
  const queuedSnapshot = await getJsonFromS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, 'runtime:queuedrequests');
  const processingSnapshot = await getJsonFromS3(bucket, PROCESSING_REQUESTS_RUNTIME_KEY, 'runtime:processingrequests');
  const completedSnapshot = await getJsonFromS3(bucket, COMPLETED_REQUESTS_RUNTIME_KEY, 'runtime:completedrequests');

  const queuedRequests = getRuntimeSnapshotRequests(queuedSnapshot);
  const prunedQueuedResult = pruneQueuedRuntimeRequests(queuedRequests, processingSnapshot, completedSnapshot, Date.now());
  let nextQueuedSnapshot = queuedSnapshot;
  if (prunedQueuedResult.removedCount > 0) {
    nextQueuedSnapshot = buildQueuedRuntimeSnapshotPayload(prunedQueuedResult.requests);
    await putJsonToS3(bucket, QUEUED_REQUESTS_RUNTIME_KEY, nextQueuedSnapshot, 'runtime:scoutsQueued', true);
  }

  return { queuedSnapshot: nextQueuedSnapshot, processingSnapshot, completedSnapshot };
}

function summariseRuntimeQueueSnapshot(snapshot) {
  const counts = snapshot?.counts && typeof snapshot.counts === 'object' ? snapshot.counts : null;
  return {
    updatedAt: typeof snapshot?.updatedAt === 'string' ? snapshot.updatedAt : null,
    counts: counts ? {
      visible: Number.isFinite(counts.visible) ? counts.visible : null,
      inFlight: Number.isFinite(counts.inFlight) ? counts.inFlight : null,
      delayed: Number.isFinite(counts.delayed) ? counts.delayed : null,
    } : null,
  };
}

async function buildActiveProcessingIndex(bucket, events, liveQueuedByHex = new Map(), runtimeSnapshots = null) {
  const activeProcessingByHex = new Map();
  const eventByHex = new Map();
  for (const event of events || []) {
    const hex = typeof event?.hex === 'string' ? event.hex.trim().toLowerCase() : '';
    if (!hex || eventByHex.has(hex)) continue;
    eventByHex.set(hex, event);
  }

  const snapshots = runtimeSnapshots && typeof runtimeSnapshots === 'object'
    ? runtimeSnapshots
    : await readRuntimeQueueSnapshots(bucket);
  const queuedSnapshot = snapshots?.queuedSnapshot ?? null;
  const processingSnapshot = snapshots?.processingSnapshot ?? null;
  mergeProcessingSnapshotIntoIndex(queuedSnapshot, activeProcessingByHex, eventByHex);
  mergeProcessingSnapshotIntoIndex(processingSnapshot, activeProcessingByHex, eventByHex);

  if (liveQueuedByHex instanceof Map) {
    for (const [hex, realms] of liveQueuedByHex.entries()) {
      if (!Array.isArray(realms)) continue;
      for (const realm of realms) {
        addProcessingRealmToIndex(activeProcessingByHex, hex, realm);
      }
    }
  }

  return activeProcessingByHex;
}

function hydrateStoredDataset(dataset) {
  if (!dataset?.events) {
    return { events: [] };
  }

  const hydratedEvents = [];
  for (const event of dataset.events) {
    if (!event) continue;

    const sanitizedUid = applySanitizedUidToEvent(event);
    if (!sanitizedUid) continue;

    const title = event.title ?? event.summary ?? null;
    if (!title) continue;

    const dtstartRaw = typeof event.dtstart === 'string'
      ? event.dtstart
      : event.dtstart?.raw ?? event.start?.raw ?? null;
    const timezone = event.dtstart?.timezone ?? event.start?.timezone ?? null;
    const start = dtstartRaw
      ? formatDateComponent(dtstartRaw, timezone ? { tzid: timezone } : null)
      : null;
    if (!start?.sortKey) continue;

    const lastModifiedRaw = event.lastModified?.raw
      ?? event.lastModifiedRaw
      ?? event.lastModified
      ?? null;
    const lastModified = lastModifiedRaw
      ? formatDateComponent(lastModifiedRaw, null)
      : null;

    hydratedEvents.push({
      uid: sanitizedUid,
      ...(event.originalUid && event.originalUid !== sanitizedUid ? { originalUid: event.originalUid } : {}),
      title,
      start,
      lastModified,
      sortKey: start.sortKey,
      tagline: getEventTagline(event),
      hex: event.metadata?.hex ?? null,
      image: {
        theme: getEventImageTheme(event),
        url: getEventImageUrl(event),
      },
      metadata: buildAgendaMetadata(event),
      status: buildStatusForStorage(event),
    });
  }

  return { ...dataset, events: hydratedEvents };
}

/**
 * Prepare an event for storage in `agenda.json`.
 *
 */
function prepareEventForStorage(event) {
  const summary = event.summary ?? event.title ?? null;
  const dtstart = event.start?.raw ?? event.dtstart ?? null;
  const lastModifiedRaw = event.lastModified?.raw
    ?? (typeof event.lastModified === 'string' ? event.lastModified : null);
  const metadata = buildAgendaMetadata(event);
  return {
    uid: event.uid,
    summary,
    dtstart,
    lastModified: lastModifiedRaw ? { raw: lastModifiedRaw } : null,
    metadata,
  };
}

function isEventHidden(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  return getEventStatusObject(candidate)?.isHidden === true;
}



function ensureImageContainer(image = {}) {
  return {
    theme: image.theme ?? null,
    prompt: image.prompt ?? null,
    url: image.url ?? null,
  };
}



function buildSummaryLocationKey(summary, location) {
  const summaryKey = normalizeComparableText(summary);
  if (!summaryKey) return null;
  const locationKey = normalizeComparableText(location);
  return `${summaryKey}|${locationKey}`;
}

function addEventToMediaIndex(index, event) {
  if (!index || !event) return;
  const key = buildSummaryLocationKey(event.title ?? event.summary, event.location);
  if (!key) return;

  const image = ensureImageContainer(event.image ?? {});
  if (!image.url) return;

  const candidate = {
    tagline: getEventTagline(event),
    image: {
      url: image.url,
      theme: image.theme ?? null,
    },
  };

  const existing = index.get(key);
  if (!existing) {
    index.set(key, candidate);
    return;
  }

  const candidateScore = (candidate.tagline ? 1 : 0) + (candidate.image.theme ? 1 : 0);
  const existingScore = (existing.tagline ? 1 : 0) + (existing.image?.theme ? 1 : 0);

  if (candidateScore > existingScore) {
    index.set(key, candidate);
  }
}

function applyMediaFromIndex(event, index) {
  if (!event || !index) return false;
  const key = buildSummaryLocationKey(event.title ?? event.summary, event.location);
  if (!key) return false;

  const match = index.get(key);
  if (!match || !match.image?.url) return false;

  const targetImage = ensureImageContainer(event.image ?? {});
  let applied = false;

  if (!targetImage.url) {
    targetImage.url = match.image.url;
    applied = true;
  }

  if (!targetImage.theme && match.image.theme) {
    targetImage.theme = match.image.theme;
    applied = true;
  }

  if (!getEventTagline(event) && match.tagline) {
    event.tagline = match.tagline;
    if ('AI' in event) delete event.AI;
    applied = true;
  }

  if (applied) {
    event.image = targetImage;
  }

  return applied;
}

function stripEventEnhancements(event) {
  if (!event) return event;
  const stripped = {
    ...event,
    tagline: null,
    image: ensureImageContainer(),
  };
  if ('AI' in stripped) delete stripped.AI;
  if ('ai' in stripped) delete stripped.ai;
  return stripped;
}

function logImageDiagnostics(label, events, sampleLimit = 5) {
  const total = events?.length ?? 0;
  if (total === 0) {
    console.log(`[Images] ${label}: no events`);
    return;
  }

  let withUrl = 0;
  let withTheme = 0;
  const missingSample = [];

  for (const event of events) {
    if (!event) continue;
    if (event.image?.url) {
      withUrl += 1;
    } else if (missingSample.length < sampleLimit) {
      missingSample.push(event.title || event.uid || '<no title>');
    }
    if (event.image?.theme) {
      withTheme += 1;
    }
  }

  console.log(`[Images] ${label}: total=${total}, url=${withUrl}, theme=${withTheme}`);
  if (missingSample.length) {
    console.log(`[Images] ${label}: sample missing image URLs -> ${missingSample.join('; ')}`);
  }
}

function calculateMissingCounts(events) {
  const now = Date.now();
  let aiMissing = 0;
  let imageThemeMissing = 0;
  let imageUrlMissing = 0;

  for (const event of events ?? []) {
    if (!event) continue;
    const eventTime = event.start?.epochMillis;
    const isFutureEvent = typeof eventTime === 'number' && !Number.isNaN(eventTime) && eventTime > now;
    if (!isFutureEvent) continue;
    if (!hasEventTagline(event)) {
      aiMissing += 1;
    }
    if (!(event.image?.theme)) {
      imageThemeMissing += 1;
    }
    if (!(event.image?.url)) {
      imageUrlMissing += 1;
    }
  }

  return {
    tagline: aiMissing,
    imageTheme: imageThemeMissing,
    imageUrl: imageUrlMissing,
  };
}

function mergeEvents(existingData, newEvents) {
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  const twoMonthsAgoMs = twoMonthsAgo.getTime();
  const now = Date.now();

  const existingEventsMap = new Map();
  const mediaIndex = new Map();
  if (existingData?.events) {
    for (const event of existingData.events) {
      if (!event?.uid || !event.start?.sortKey) continue;
      const normalisedEvent = {
        ...event,
        title: event.title ?? event.summary ?? null,
        section: normaliseSection(event.section, SECTION_CUBS),
        image: ensureImageContainer(event.image),
      };
      existingEventsMap.set(event.uid, normalisedEvent);
      addEventToMediaIndex(mediaIndex, normalisedEvent);
    }
  }

  const mergedEvents = [];

  for (const newEvent of newEvents) {
    if (!newEvent?.uid || !newEvent.start?.sortKey) continue;
    const incomingTitle = newEvent.title ?? newEvent.summary ?? null;

    if (existingEventsMap.has(newEvent.uid)) {
      const existing = existingEventsMap.get(newEvent.uid);
      applySanitizedUidToEvent(existing);
      existing.section = combineSections(existing.section, newEvent.section);
      if (!existing.title && incomingTitle) {
        existing.title = incomingTitle;
      }
      if (!existing.summary && newEvent.summary) {
        existing.summary = newEvent.summary;
      }
      if (!existing.location && newEvent.location) {
        existing.location = newEvent.location;
      }
      if (newEvent.start?.raw) {
        const existingRaw = existing.start?.raw;
        if (!existingRaw || existingRaw !== newEvent.start.raw) {
          existing.start = newEvent.start;
          existing.sortKey = newEvent.sortKey ?? existing.sortKey;
        }
      }
      if (newEvent.lastModified) {
        existing.lastModified = newEvent.lastModified;
      }
      const existingImage = ensureImageContainer(existing.image);
      const newImage = ensureImageContainer(newEvent.image);
      if (!existingImage.url && newImage.url) {
        existingImage.url = newImage.url;
      }
      if (!existingImage.prompt && newImage.prompt) {
        existingImage.prompt = newImage.prompt;
      }
      existing.image = existingImage;
      applyMediaFromIndex(existing, mediaIndex);
      addEventToMediaIndex(mediaIndex, existing);
      mergedEvents.push(existing);
      existingEventsMap.delete(newEvent.uid);
      continue;
    }

    const eventTime = newEvent.start?.epochMillis || 0;
    const isFutureEvent = eventTime > now;
    const preparedEvent = {
      ...newEvent,
      title: incomingTitle,
      tagline: isFutureEvent ? null : getEventTagline(newEvent),
      image: ensureImageContainer(newEvent.image),
      section: normaliseSection(newEvent.section, SECTION_CUBS),
    };

    if (!applySanitizedUidToEvent(preparedEvent)) {
      continue;
    }

    applyMediaFromIndex(preparedEvent, mediaIndex);

    const isHistoricalWithoutImage =
      eventTime && eventTime < twoMonthsAgoMs && !preparedEvent.image.url;
    if (isHistoricalWithoutImage) {
      continue;
    }

    mergedEvents.push(preparedEvent);
    addEventToMediaIndex(mediaIndex, preparedEvent);
  }

  for (const existingEvent of existingEventsMap.values()) {
    applySanitizedUidToEvent(existingEvent);
    const eventTime = existingEvent.start?.epochMillis || 0;
    existingEvent.title = existingEvent.title ?? existingEvent.summary ?? null;
    applyMediaFromIndex(existingEvent, mediaIndex);
    const hasImageUrl = !!existingEvent.image?.url;
    if (eventTime >= twoMonthsAgoMs || hasImageUrl) {
      mergedEvents.push(existingEvent);
      addEventToMediaIndex(mediaIndex, existingEvent);
    }
  }

  return mergedEvents.sort((a, b) => {
    if (a.sortKey === b.sortKey) return 0;
    return a.sortKey > b.sortKey ? 1 : -1;
  });
}

function mergeEventDataForQueue(existingData, incomingData) {
  const existing = existingData && typeof existingData === 'object' ? existingData : {};
  const incoming = incomingData && typeof incomingData === 'object' ? incomingData : {};
  const merged = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'image' || key === '_fromEventFile') {
      continue;
    }
    if (value !== undefined && value !== null) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }

  const existingImage = ensureImageContainer(existing.image);
  const incomingImage = ensureImageContainer(incoming.image);
  merged.image = {
    prompt: incomingImage.prompt ?? existingImage.prompt ?? null,
    url: incomingImage.url ?? existingImage.url ?? null,
  };

  if (merged._fromEventFile) {
    delete merged._fromEventFile;
  }

  return merged;
}

/**
 * Clean up hidden past events from agenda and return list of removed events.
 * Hidden events that are in the past are removed from agenda.json.
 */
async function cleanupHiddenPastEvents(events) {
  const now = Date.now();
  const removedEvents = [];
  const retainedEvents = [];

  for (const event of events ?? []) {
    if (!event) continue;

    const isHidden = isEventHidden(event);
    const eventTime = event.start?.epochMillis;
    const isPastEvent = typeof eventTime === 'number' && !Number.isNaN(eventTime) && eventTime <= now;

    if (isHidden && isPastEvent) {
      // Remove hidden past events
      console.log(`[Hidden Cleanup] Removing hidden past event: ${event.title} (${event.uid})`);
      removedEvents.push({
        uid: event.uid,
        title: event.title,
        eventTime: new Date(eventTime).toISOString(),
      });
    } else {
      // Retain all other events (including hidden future events)
      retainedEvents.push(event);
    }
  }

  return { retainedEvents, removedEvents };
}

/**
 * Validate that hidden future events are consistent between agenda and their HEX files.
 * Returns list of inconsistencies found and fixed.
 */
async function validateHiddenFutureEvents(events, bucket) {
  const now = Date.now();
  const inconsistencies = [];

  for (const event of events ?? []) {
    if (!event) continue;

    const isHidden = isEventHidden(event);
    const eventTime = event.start?.epochMillis;
    const isFutureEvent = typeof eventTime === 'number' && !Number.isNaN(eventTime) && eventTime > now;

    // Only validate hidden future events
    if (!isHidden || !isFutureEvent) continue;

    const eventTitle = event.title ?? event.summary ?? null;
    if (!eventTitle) continue;

    // Check if HEX file exists for this event
    try {
      const titleHex = titleToHex(eventTitle);
      const hexKey = buildHexStorageKey(eventTitle);
      const hexData = await getJsonFromS3(bucket, hexKey, `hex:${eventTitle}`);

      if (hexData) {
        // HEX file exists, check if hidden status matches
        const hexIsHidden = isEventHidden(hexData);
        if (!hexIsHidden) {
          // Agenda says hidden but HEX says not hidden - this is inconsistent
          console.log(`[Hidden Validation] Inconsistency found for ${eventTitle}: agenda hidden=true, hex hidden=false`);
          inconsistencies.push({
            uid: event.uid,
            title: eventTitle,
            agendaHidden: true,
            hexHidden: false,
            action: 'detected_only_hex_immutable',
          });
          console.log(`[Hidden Validation] HEX create-only mode: skipping write for ${eventTitle}`);
        }
      }
    } catch (error) {
      console.warn(`[Hidden Validation] Error validating hidden event ${eventTitle}:`, error.message);
    }
  }

  return inconsistencies;
}

/**
 * Check if an image file exists in S3 bucket.
 * Returns true if the object exists and is accessible, false otherwise.
 */
async function imageExistsInS3(bucket, imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return false;
  }

  // Extract the key from the URL
  // URLs look like: http://BUCKET.s3-website.REGION.amazonaws.com/KEY
  // or direct S3 paths like: website/eventImages/file.jpg
  let key = null;

  try {
    key = extractImageKeyDetails(imageUrl).key;
    if (!key) return false;

    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    await s3.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.Code === 'NotFound' || error.Code === 'NoSuchKey') {
      return false;
    }
    return false;
  }
}

/**
 * Check all images in a list of events and remove broken ones.
 * Returns a list of repaired events with details about removed images.
 */
async function verifyAndRepairEventImages(events, bucket) {
  const repairedEvents = [];
  const brokenImages = [];

  for (const event of events ?? []) {
    if (!event) continue;

    const eventCopy = JSON.parse(JSON.stringify(event));
    eventCopy.image = ensureImageContainer(eventCopy.image);
    let imageUrl = eventCopy.image?.url;

    if (!imageUrl) {
      repairedEvents.push(eventCopy);
      continue;
    }

    const migratedUrl = await migrateLegacyImageIfNeeded(bucket, imageUrl);
    if (migratedUrl && migratedUrl !== imageUrl) {
      imageUrl = migratedUrl;
      eventCopy.image.url = migratedUrl;
    }

    const exists = await imageExistsInS3(bucket, imageUrl);

    if (!exists) {
      console.log(`[Image Repair] Removing broken image from ${eventCopy.title}: ${imageUrl}`);
      brokenImages.push({
        uid: eventCopy.uid,
        title: eventCopy.title,
        imageUrl,
        section: eventCopy.section,
      });

      // Remove the image URL but keep the stored theme/prompt metadata
      eventCopy.image = {
        theme: eventCopy.image?.theme ?? null,
        prompt: eventCopy.image?.prompt ?? null,
        url: null,
      };
    }

    repairedEvents.push(eventCopy);
  }

  return { repairedEvents, brokenImages };
}

/**
 * Check and repair a specific HEX file if it has a broken image.
 * Returns the updated hex data or null if no repair was needed.
 */
async function verifyAndRepairHexFile(bucket, hexKey, hexData) {
  if (!hexData || !hexData.image?.url) {
    return null;
  }

  let currentUrl = hexData.image.url;
  let mutatedHex = null;
  let mutationType = null;

  const migratedUrl = await migrateLegacyImageIfNeeded(bucket, currentUrl);

  if (migratedUrl && migratedUrl !== currentUrl) {
    currentUrl = migratedUrl;
    mutatedHex = {
      ...hexData,
      image: {
        ...hexData.image,
        url: migratedUrl,
      },
    };
    mutationType = 'migrated';
  }

  const exists = await imageExistsInS3(bucket, currentUrl);

  if (!exists) {
    console.log(`[Image Repair] Removing broken image from HEX file ${hexKey}: ${currentUrl}`);
    const repairedHex = {
      ...hexData,
      image: {
        theme: hexData.image?.theme ?? null,
        prompt: hexData.image?.prompt ?? null,
        url: null,
      },
    };
    return {
      updatedHex: repairedHex,
      status: 'removed',
    };
  }

  if (mutationType === 'migrated' && mutatedHex) {
    console.log(`[Image Migration] Detected migratable HEX image URL for ${hexKey}: ${currentUrl}`);
    return {
      updatedHex: mutatedHex,
      status: 'migrated',
    };
  }

  return null;
}

async function enrichEventsWithAI(events, context, collectionName, options = {}) {
  const now = Date.now();
  const enrichedEvents = [];
  const collection = collectionName ?? 'events';
  const bucketName = TARGET_BUCKET || DEFAULT_BUCKET;
  const hasScoutRequestLimit = Number.isFinite(options?.maxScoutRequests);
  const maxScoutRequestLimit = hasScoutRequestLimit
    ? Math.max(0, Math.trunc(options.maxScoutRequests))
    : Infinity;
  let newScoutRequestCount = 0;

  const firstFutureEventIndex = events.findIndex(e => e.start?.epochMillis > now);
  const startIndexForImages = firstFutureEventIndex === -1
    ? Math.max(0, events.length - 3)
    : Math.max(0, firstFutureEventIndex - 3);

  // Collect events that reach run threshold for batched notification
  const hexNotifications = new Map(); // Map<hexValue, { realm, title }>
  const processedTitles = new Set(); // Track processed titles to avoid duplicates
  const liveQueuedProcessingByHex = new Map(); // Map<hexValue, Array<'tagline'|'imageTheme'|'image'>>

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const baseEvent = {
      ...event,
      image: ensureImageContainer(event.image),
    };
    let isHidden = isEventHidden(baseEvent);

    const sanitizedUid = applySanitizedUidToEvent(baseEvent);
    if (!sanitizedUid) {
      continue;
    }

    const eventTime = baseEvent.start?.epochMillis || 0;
    const isFutureEvent = eventTime > now;
    const isEligibleForImageProcessing = index >= startIndexForImages;

    // Use HEX-encoded title for storage key (shared across events with same title)
    const eventTitle = baseEvent.title ?? baseEvent.summary ?? null;
    let hexKey = null;
    let existingHexFile = null;
    let hexLabel = null;
    let titleHex = null;
    let hadPersistedHex = false;
    
    if (eventTitle) {
      try {
        titleHex = titleToHex(eventTitle);
        hexKey = buildHexStorageKey(eventTitle);
        hexLabel = `hex:${eventTitle}`;
        existingHexFile = await getJsonFromS3(bucketName, hexKey, hexLabel);
        if (existingHexFile) {
          hadPersistedHex = true;
          baseEvent.hex = existingHexFile.metadata?.hex ?? titleHex;
          // Hex file is canonical source - always use its values when present
          const existingTagline = getEventTagline(existingHexFile);
          if (existingTagline) {
            baseEvent.tagline = existingTagline;
            if ('AI' in baseEvent) delete baseEvent.AI;
          }
          const existingHexTheme = getEventImageTheme(existingHexFile);
          if (existingHexTheme) {
            baseEvent.image.theme = existingHexTheme;
          }
          const existingHexUrl = getEventImageUrl(existingHexFile);
          if (existingHexUrl) {
            baseEvent.image.url = existingHexUrl;
          }
          const existingHexStatus = getEventStatusObject(existingHexFile);
          if (existingHexStatus) {
            baseEvent.status = existingHexStatus;
            baseEvent.metadata = baseEvent.metadata && typeof baseEvent.metadata === 'object'
              ? baseEvent.metadata
              : {};
            baseEvent.metadata.status = {
              isHidden: existingHexStatus.isHidden === true,
              isApproved: existingHexStatus.isApproved === true,
            };
          }
          if (isEventApproved(existingHexFile)) {
            baseEvent.approved = true;
          }
          if (!isHidden && isEventHidden(existingHexFile)) {
            isHidden = true;
          }
        } else {
          // No HEX file exists, populate it with event data if available
          const baseTagline = getEventTagline(baseEvent);
          if (baseTagline || baseEvent.image.theme || baseEvent.image.url) {
            const newHexData = {
              title: eventTitle,
              metadata: buildHexMetadata({
                hex: titleHex,
                tagline: baseTagline,
                imageTheme: baseEvent.image.theme ?? null,
                imageUrl: baseEvent.image.url ?? null,
                isApproved: isEventApproved(baseEvent) || baseEvent.approved === true,
                isHidden: isEventHidden(baseEvent),
              }),
              requests: [],
            };
            try {
              await putJsonToS3(bucketName, hexKey, newHexData, hexLabel);
              existingHexFile = newHexData;
            } catch (err) {
              console.error(`[HEX] Failed to create new HEX file for ${titleHex}:`, err.message);
            }
          }
        }
        // Ensure baseEvent carries the hex identifier for downstream storage/UI
        if (!baseEvent.hex && titleHex) {
          baseEvent.hex = titleHex;
        }
      } catch (err) {
        console.error(`[HEX] Error processing HEX file for ${eventTitle}:`, err.message);
      }
    } else {
      console.log(`[HEX] No title for event, skipping HEX file processing for UID ${sanitizedUid}`);
    }

    if (!isHidden) {
      isHidden = isEventHidden(baseEvent);
    }

    const needsAi = !isHidden && !hasEventTagline(baseEvent);
    const needsPrompt = !isHidden && !needsAi && isEligibleForImageProcessing && !baseEvent.image.theme;
    const needsEventImage = !isHidden && !needsAi && !needsPrompt && isEligibleForImageProcessing && !baseEvent.image.url;
    let queuedScoutRequest = false;
    const realmToQueue = needsAi
      ? 'tagline'
      : needsPrompt
        ? 'imageTheme'
        : needsEventImage
          ? 'image'
          : null;

    // Only process each title once for HEX file operations
    if (!isHidden && realmToQueue && !baseEvent._fromEventFile && hexKey && !processedTitles.has(eventTitle)) {
      processedTitles.add(eventTitle);
      
      if (newScoutRequestCount >= maxScoutRequestLimit) {
        // Reached the configured queue publish limit. We should stop
        // scheduling additional scoutsRequests notifications, but continue
        // processing the remaining events so agenda.json and HEX files can be
        // updated with fresh data.
        // Intentionally do not break here.
      }

      // Check if HEX file content matches current event (no changes)
      let hasChanges = true;
      
      if (existingHexFile) {
        // Compare persisted fields to detect changes
        const existingTagline = getEventTagline(existingHexFile);
        const baseTagline = getEventTagline(baseEvent);
        const aiMatch = (existingTagline ?? null) === (baseTagline ?? null);
        const themeMatch = getEventImageTheme(existingHexFile) === (baseEvent.image?.theme ?? null);
        const urlMatch = getEventImageUrl(existingHexFile) === (baseEvent.image?.url ?? null);

        hasChanges = !aiMatch || !themeMatch || !urlMatch;
      }

      // Prepare HEX file data - merge event data into HEX, HEX wins conflicts
      const mergedTagline = getEventTagline(existingHexFile) ?? getEventTagline(baseEvent);
      const hexFileData = {
        title: eventTitle,
        metadata: buildHexMetadata({
          hex: titleHex,
          tagline: mergedTagline,
          imageTheme: getEventImageTheme(existingHexFile) || baseEvent.image.theme || null,
          imageUrl: getEventImageUrl(existingHexFile) || baseEvent.image.url || null,
          isApproved: isEventApproved(existingHexFile) || isEventApproved(baseEvent) || baseEvent.approved === true,
          isHidden: isEventHidden(existingHexFile) || isEventHidden(baseEvent),
        }),
        requests: Array.isArray(existingHexFile?.requests)
          ? JSON.parse(JSON.stringify(existingHexFile.requests))
          : [],
      };
      
      // Update baseEvent with merged data (HEX wins)
      baseEvent.tagline = hexFileData.metadata.tagline;
      if ('AI' in baseEvent) delete baseEvent.AI;
      baseEvent.image.theme = hexFileData.metadata.image.theme;
      baseEvent.image.url = hexFileData.metadata.image.url;
      if (hexFileData.metadata.status.isApproved === true) {
        baseEvent.approved = true;
      }

      const updatedNeedsAi = !hasEventTagline(hexFileData);
      const updatedNeedsPrompt = !updatedNeedsAi && isEligibleForImageProcessing && !getEventImageTheme(hexFileData);
      const updatedNeedsEventImage = !updatedNeedsAi && !updatedNeedsPrompt && isEligibleForImageProcessing && !getEventImageUrl(hexFileData);
      const updatedProcessingRealm = updatedNeedsAi
        ? 'tagline'
        : updatedNeedsPrompt
          ? 'imageTheme'
          : updatedNeedsEventImage
            ? 'image'
            : null;
      const updatedRealm = updatedProcessingRealm;

      // Cooldown: controlled by env var SCOUTS_NOTIFICATION_COOLDOWN_MINUTES (default 1 minute)
      const cooldownMinutes = Number.isFinite(Number(process.env.SCOUTS_NOTIFICATION_COOLDOWN_MINUTES))
        ? Math.max(0, Math.trunc(Number(process.env.SCOUTS_NOTIFICATION_COOLDOWN_MINUTES)))
        : 1;
      const notificationCooldownMs = cooldownMinutes * 60 * 1000;
      const lastNotificationTime = getLatestRequestTimestamp(existingHexFile);
      const timeSinceLastNotification = now - lastNotificationTime;
      const isInCooldownPeriod = timeSinceLastNotification < notificationCooldownMs;

      if (!hasChanges && titleHex && hexKey) {
        eventsAtThreshold.push({
          hex: titleHex,
          title: eventTitle,
          hexKey,
          label: hexLabel,
          hexFileData,
        });
      }

      if (updatedRealm) {
        let canQueueRequest = false;
        try {
          if (!hadPersistedHex && !existingHexFile) {
            await putJsonToS3(bucketName, hexKey, hexFileData, hexLabel, true);
            existingHexFile = hexFileData;
          } else if (hadPersistedHex && hasChanges) {
            console.log(`[HEX] Create-only mode: skipping rewrite for existing HEX ${titleHex}`);
          }

          // Queue notifications without rewriting existing HEX files. The
          // per-HEX/per-stage state and global budget circuit are checked
          // before publishing so cooldown/quarantined work never churns SQS.
          const eligibility = await checkEnrichmentEligibility(titleHex, updatedRealm, {
            requestId: baseEvent.requestId,
            event: hexFileData,
          });
          canQueueRequest = eligibility.eligible;
          if (!canQueueRequest) {
            console.log('[Enrichment] Skipping automatic request', {
              hex: titleHex,
              stage: updatedRealm,
              skipReason: eligibility.reason,
            });
          }
        } catch (writeErr) {
          console.error(`[HEX] Failed to create missing HEX file for ${titleHex}:`, writeErr.message);
        }

        if (canQueueRequest && titleHex && !isInCooldownPeriod) {
          queuedScoutRequest = true;
        }

        if (queuedScoutRequest) {
          // Collect HEX for individual notification instead of sending immediately
          if (!hexNotifications.has(titleHex) && newScoutRequestCount < maxScoutRequestLimit) {
            hexNotifications.set(titleHex, {
              realm: 'scoutsRequest',
              hexData: hexFileData,
              processingRealm: updatedProcessingRealm,
            });
            newScoutRequestCount += 1;
          }
        }
      }
    }

    enrichedEvents.push(baseEvent);

    if (
      queuedScoutRequest
      && maxScoutRequestLimit !== Infinity
      && newScoutRequestCount >= maxScoutRequestLimit
    ) {
      // We have queued notifications up to the limit. Continue processing
      // to ensure event/HEX merging still happens; do not break the loop.
    }
  }
  // Continue processing completed; no early-stop truncation so enrichedEvents
  // contains processed event objects for all input events.

  // Send individual retry messages for stuck events (limited by maxScoutRequestLimit)
    if (eventsAtThreshold.length > 0) {
    let retryCount = 0;
    for (const item of eventsAtThreshold) {
      // Respect the maxScoutRequestLimit for retries too
      if (retryCount >= maxScoutRequestLimit) {
        break;
      }
      
      try {
        const retryStage = deriveProcessingRealmFromEvent(item.hexFileData);
        const eligibility = await checkEnrichmentEligibility(item.hex, retryStage || 'tagline', { event: item.hexFileData });
        if (!eligibility.eligible) {
          continue;
        }
        await postToScoutsRequestsQueue(
          {
            realm: 'scoutsRequest',
            subject: item.hexFileData,
            action: 'new',
          },
          'Enrichment:Retry',
        );
        const retryProcessingRealm = deriveProcessingRealmFromEvent(item.hexFileData);
        if (retryProcessingRealm && item.hex) {
          addProcessingRealmToIndex(liveQueuedProcessingByHex, item.hex, retryProcessingRealm);
        }
        retryCount++;
      } catch (queueError) {
        console.error(`[SQS] Failed to send retry message for ${item.title}:`, queueError.message);
      }
    }
  }

  // Send individual notifications per unique HEX
  if (hexNotifications.size > 0) {
    for (const [hexValue, notificationData] of hexNotifications.entries()) {
        try {
          await postToScoutsRequestsQueue(
            {
              realm: 'scoutsRequest',
              subject: notificationData.hexData,
              action: notificationData.processingRealm === 'tagline' ? 'new' : 'imageEnrich',
              requestMode: 'auto',
              approvalMode: 'auto',
            },
            'Enrichment:New',
          );
          if (notificationData.processingRealm && hexValue) {
            addProcessingRealmToIndex(liveQueuedProcessingByHex, hexValue, notificationData.processingRealm);
          }
          // Create-only mode: do not rewrite existing HEX files for notification timestamps.
        } catch (queueError) {
          console.error(`[SQS] Failed to send new message for ${notificationData.hexData.title}:`, queueError.message);
        }
    }
  }

  // Create-only mode: no post-enrichment HEX rewrites.

  return {
    events: enrichedEvents,
    liveQueuedProcessingByHex,
  };
}

function formatInvocationResponse({ isHttpInvocation, corsHeaders, statusCode, body, headers = {} }) {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);

  if (isHttpInvocation) {
    return {
      statusCode,
      headers: {
        ...corsHeaders,
        ...headers,
      },
      body: responseBody,
    };
  }

  if (body === '') {
    return {
      statusCode,
      status: 'ok',
    };
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      return {
        statusCode,
        body,
      };
    }
  }

  if (body && typeof body === 'object') {
    return body;
  }

  return {
    statusCode,
    body,
  };
}

export async function lambdaHandler(event = {}) {
  const corsHeaders = {
    'Content-Type': 'application/json',
  };
  const isHttpInvocation = Boolean(
    event?.requestContext?.http
    || event?.httpMethod
    || event?.headers
    || event?.queryStringParameters
    || typeof event?.body !== 'undefined'
  );
  const respond = (statusCode, body, headers = {}) => formatInvocationResponse({
    isHttpInvocation,
    corsHeaders,
    statusCode,
    body,
    headers,
  });

  // Check for X-Blocked header and rate limit information
  const headers = event?.headers || {};
  const xBlocked = headers['X-Blocked'] || headers['x-blocked'];
  const rateLimitLimit = headers['X-RateLimit-Limit'] || headers['x-ratelimit-limit'];
  const rateLimitRemaining = headers['X-RateLimit-Remaining'] || headers['x-ratelimit-remaining'];
  const rateLimitReset = headers['X-RateLimit-Reset'] || headers['x-ratelimit-reset'];

  // Log rate limit headers if present
  if (rateLimitLimit || rateLimitRemaining || rateLimitReset) {
    console.log('[Rate Limit Info]', {
      limit: rateLimitLimit || 'not provided',
      remaining: rateLimitRemaining || 'not provided',
      resetIn: rateLimitReset ? `${rateLimitReset} seconds` : 'not provided'
    });
  }

  // Terminate if blocked
  if (xBlocked === 'true' || xBlocked === true) {
    console.error('[BLOCKED REQUEST] Request blocked by rate limiter', {
      blocked: xBlocked,
      rateLimitLimit,
      rateLimitRemaining,
      rateLimitReset,
      eventHeaders: headers,
      requestContext: event?.requestContext,
      sourceIp: event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp
    });
    
    return respond(429, {
      status: 'blocked',
      message: 'Request blocked due to rate limiting',
      retryAfter: rateLimitReset ? `${rateLimitReset} seconds` : 'unknown'
    }, {
      'X-Blocked': 'true',
      'Retry-After': rateLimitReset || '3600'
    });
  }

  const bucket = TARGET_BUCKET || DEFAULT_BUCKET;
  const agendaKey = 'agenda.json';

  const feedDefinitions = [
    {
      key: 'calendar/cubs-events.ics',
      url: CUBS_EVENTS_CALENDAR_URL || null,
      label: 'Cubs Events',
      section: SECTION_CUBS,
      icsType: 'cubs-events',
    },
    {
      key: 'calendar/cubs-programme.ics',
      url: CUBS_PROGRAMME_CALENDAR_URL || null,
      label: 'Cubs Programme',
      section: SECTION_CUBS,
      icsType: 'cubs-programme',
    },
    {
      key: 'calendar/scouts-events.ics',
      url: SCOUTS_EVENTS_CALENDAR_URL || null,
      label: 'Scouts Events',
      section: SECTION_SCOUTS,
      icsType: 'scouts-events',
    },
    {
      key: 'calendar/scouts-programme.ics',
      url: SCOUTS_PROGRAMME_CALENDAR_URL || null,
      label: 'Scouts Programme',
      section: SECTION_SCOUTS,
      icsType: 'scouts-programme',
    },
    {
      key: 'calendar/beavers-events.ics',
      url: BEAVERS_EVENTS_CALENDAR_URL || null,
      label: 'Beavers Events',
      section: SECTION_BEAVERS,
      icsType: 'beavers-events',
    },
    {
      key: 'calendar/beavers-programme.ics',
      url: BEAVERS_PROGRAMME_CALENDAR_URL || null,
      label: 'Beavers Programme',
      section: SECTION_BEAVERS,
      icsType: 'beavers-programme',
    },
  ];
  const configuredFeeds = feedDefinitions.filter((feed) => typeof feed.url === 'string' && feed.url.trim());

  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'POST').toUpperCase();
  if (method === 'OPTIONS') {
    return respond(200, '');
  }
  const queryParams = event?.queryStringParameters || {};
  const multiValueHeaders = event?.multiValueHeaders || {};
  const multiValueQueryParams = event?.multiValueQueryStringParameters || {};
  const bodyParams = decodeRequestBody(event);

  console.log('[Invocation] Request payload', sanitizeLogValue(
    isHttpInvocation
      ? {
          method,
          query: queryParams,
          body: bodyParams,
        }
      : event,
  ));

  const requestApiKeyCandidates = [
    { source: 'headers.x-api-key', value: headers['x-api-key'] },
    { source: 'headers.X-Api-Key', value: headers['X-Api-Key'] },
    { source: 'headers.X-API-KEY', value: headers['X-API-KEY'] },
    { source: 'headers.x_api_key', value: headers['x_api_key'] },
    { source: 'headers.api-key', value: headers['api-key'] },
    { source: 'headers.API_KEY', value: headers.API_KEY },
    { source: 'multiValueHeaders.x-api-key', value: multiValueHeaders['x-api-key'] },
    { source: 'multiValueHeaders.X-Api-Key', value: multiValueHeaders['X-Api-Key'] },
    { source: 'query.apiKey', value: queryParams.apiKey },
    { source: 'query.API_KEY', value: queryParams.API_KEY },
    { source: 'query.x-api-key', value: queryParams['x-api-key'] },
    { source: 'multiValueQuery.apiKey', value: multiValueQueryParams.apiKey },
    { source: 'multiValueQuery.API_KEY', value: multiValueQueryParams.API_KEY },
    { source: 'multiValueQuery.x-api-key', value: multiValueQueryParams['x-api-key'] },
  ];

  let requestApiKey = '';
  let requestApiKeySource = 'none';
  for (const candidate of requestApiKeyCandidates) {
    const normalised = normaliseApiKeyCandidate(candidate.value);
    if (normalised) {
      requestApiKey = normalised;
      requestApiKeySource = candidate.source;
      break;
    }
  }

  const requiredApiKey = normaliseApiKeyCandidate(await getRequiredSecret('REQUIRED_API_KEY_PARAMETER'));
  if (isHttpInvocation && requiredApiKey && requestApiKey !== requiredApiKey && !event?._triggeredBySqs) {
    const requestMeta = apiKeyMeta(requestApiKey);
    const requiredMeta = apiKeyMeta(requiredApiKey);
    const apiHeaderKeys = Object.keys(headers || {}).filter((key) => /api[_-]?key/i.test(key));
    const apiQueryKeys = Object.keys(queryParams || {}).filter((key) => /api[_-]?key/i.test(key));
    const apiMultiHeaderKeys = Object.keys(multiValueHeaders || {}).filter((key) => /api[_-]?key/i.test(key));
    const apiMultiQueryKeys = Object.keys(multiValueQueryParams || {}).filter((key) => /api[_-]?key/i.test(key));

    console.warn('[Auth] Invalid API key comparison', {
      requestApiKeySource,
      requestApiKeyPresent: requestMeta.present,
      requestApiKeyLength: requestMeta.length,
      requestApiKeyLast4: requestMeta.last4,
      requiredApiKeyPresent: requiredMeta.present,
      requiredApiKeyLength: requiredMeta.length,
      requiredApiKeyLast4: requiredMeta.last4,
      apiHeaderKeys,
      apiQueryKeys,
      apiMultiHeaderKeys,
      apiMultiQueryKeys,
      hasRequestContextHttp: Boolean(event?.requestContext?.http),
      method,
    });

    return respond(403, { error: 'Forbidden: Invalid API Key' });
  }

  const normaliseOptionalString = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return value;
    const normalised = String(value).trim();
    return normalised || null;
  };

  const commandRealmCandidate =
    bodyParams.realm
    ?? queryParams.realm
    ?? event?.realm
    ?? event?.detail?.realm
    ?? null;
  const commandSubjectCandidate =
    bodyParams.subject
    ?? queryParams.subject
    ?? event?.subject
    ?? event?.detail?.subject
    ?? null;
  const commandActionCandidate =
    bodyParams.action
    ?? queryParams.action
    ?? event?.action
    ?? event?.detail?.action
    ?? null;

  const structuredCommand = (() => {
    const realm = normaliseOptionalString(commandRealmCandidate);
    if (!realm) return null;
    const subject = normaliseOptionalString(commandSubjectCandidate);
    let action = commandActionCandidate;
    if (typeof action === 'string' || action instanceof String) {
      const trimmed = String(action).trim();
      if (!trimmed) {
        action = null;
      } else if (/^-?\d+$/.test(trimmed)) {
        action = Number(trimmed);
      } else {
        action = trimmed;
      }
    }
    return { realm, subject, action };
  })();

  const parseCalendarTokens = (value) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => parseCalendarTokens(entry));
    }
    if (typeof value === 'object') {
      return [];
    }

    const raw = String(value).trim();
    if (!raw) return [];

    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw);
        return parseCalendarTokens(parsed);
      } catch (_) {
        // Fallback to comma split
      }
    }

    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  const normaliseCalendarToken = (value) => String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const commandActionString = typeof structuredCommand?.action === 'string'
    ? structuredCommand.action.trim().toLowerCase()
    : null;
  const commandActionToken = typeof commandActionString === 'string'
    ? commandActionString.replace(/[^a-z0-9]+/g, '')
    : null;
  const commandSubjectString = typeof structuredCommand?.subject === 'string'
    ? structuredCommand.subject.trim().toLowerCase()
    : null;

  const calendarSubjectTokens = new Set([
    'calendar',
    'calendars',
    'all',
    'events',
    'programme',
    'program',
    'cubs',
    'scouts',
    'beavers',
    'cubs-events',
    'cubs-programme',
    'cubs-program',
    'scouts-events',
    'scouts-programme',
    'scouts-program',
    'beavers-events',
    'beavers-programme',
    'beavers-program',
  ]);

  const isScoutsCalendarCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandActionToken
    && commandActionToken.startsWith('refresh')
    && commandSubjectString
    && calendarSubjectTokens.has(commandSubjectString)
  );

  const rawCalendarTokens = [
    ...parseCalendarTokens(bodyParams.calendar),
    ...parseCalendarTokens(bodyParams.calendars),
    ...parseCalendarTokens(bodyParams.feed),
    ...parseCalendarTokens(queryParams.calendar),
    ...parseCalendarTokens(queryParams.calendars),
    ...parseCalendarTokens(queryParams.feed),
  ];

  if (isScoutsCalendarCommand) {
    if (commandSubjectString === 'calendars' || commandSubjectString === 'all') {
      rawCalendarTokens.push('all');
    } else if (commandSubjectString !== 'calendar') {
      rawCalendarTokens.push(commandSubjectString);
    }
  }

  if (isScoutsCalendarCommand && typeof structuredCommand.action === 'string') {
    const actionToken = structuredCommand.action.trim().toLowerCase();
    if (actionToken && actionToken !== 'refresh' && !actionToken.replace(/[^a-z0-9]+/g, '').startsWith('refresh')) {
      rawCalendarTokens.push(actionToken);
    }
  }

  const requestedCalendarTokens = Array.from(
    new Set(rawCalendarTokens.map(normaliseCalendarToken).filter(Boolean))
  );

  const resetRequested = Boolean(
    (structuredCommand
      && structuredCommand.realm === 'scouts'
      && (structuredCommand.subject ?? 'agenda') === 'agenda'
      && commandActionString === 'reset')
    || parseBooleanFlag(
      queryParams.reset
      ?? bodyParams.reset
      ?? bodyParams?.parameters?.reset
      ?? event?.reset
      ?? event?.detail?.reset,
    )
  );

  const maxScoutRequests = structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandSubjectString === 'agenda'
    && typeof structuredCommand.action === 'number'
      ? Math.max(0, Math.trunc(structuredCommand.action))
      : Number.isFinite(parseInt(bodyParams?.maxEvents ?? queryParams?.maxEvents, 10))
        ? Math.max(0, Math.trunc(parseInt(bodyParams?.maxEvents ?? queryParams?.maxEvents, 10)))
      : (event?._triggeredBySqs 
          ? parseInt(process.env.max_events_resume || '1', 10)
          : parseInt(process.env.max_events_start || '5', 10));

  if (
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandSubjectString === 'scoutsrequest'
    && commandActionString === 'requeue'
  ) {
    const normalizeNullableText = (value) => {
      if (value === undefined || value === null) return null;
      const text = String(value).trim();
      return text ? text : null;
    };

    const eventCandidate =
      (bodyParams?.event && typeof bodyParams.event === 'object' ? bodyParams.event : null)
      ?? (bodyParams?.subjectEvent && typeof bodyParams.subjectEvent === 'object' ? bodyParams.subjectEvent : null)
      ?? (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null);

    const fallbackHex =
      (typeof bodyParams?.hex === 'string' ? bodyParams.hex.trim() : '')
      || (typeof queryParams?.hex === 'string' ? queryParams.hex.trim() : '');

    const subject = (() => {
      const base = eventCandidate && typeof eventCandidate === 'object'
        ? JSON.parse(JSON.stringify(eventCandidate))
        : {};

      const title = base.title ?? base.summary ?? null;
      const derivedHex = typeof base.hex === 'string' && base.hex.trim()
        ? base.hex.trim().toLowerCase()
        : (fallbackHex || (typeof title === 'string' && title.trim() ? titleToHex(title.trim()) : null));

      if (!derivedHex) {
        return null;
      }

      if (!base.image || typeof base.image !== 'object') {
        base.image = {};
      }
      base.tagline = getEventTagline(base);
      if ('AI' in base) delete base.AI;
      if ('ai' in base) delete base.ai;
      base.image.theme = normalizeNullableText(base.image.theme);
      base.image.prompt = normalizeNullableText(base.image.prompt);
      base.image.url = normalizeNullableText(base.image.url);
      base.hex = derivedHex;
      return base;
    })();

    if (!subject) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing hex/event context for scoutsRequest requeue' }),
      };
    }

    const queueResult = await postToScoutsRequestsQueue(
      {
        realm: 'scoutsRequest',
        subject,
        action: 'new',
      },
      'AdminRequeue',
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        message: `Requeue request submitted for ${subject.hex}`,
        queuedHex: subject.hex,
        queueAccepted: true,
        requestId: queueResult?.payload?.requestId ?? null,
        queuedMessage: {
          requestId: queueResult?.payload?.requestId ?? null,
          realm: queueResult?.payload?.realm ?? 'scoutsRequest',
          action: queueResult?.payload?.action ?? 'new',
          subjectHex: queueResult?.payload?.subject?.hex ?? subject.hex,
          subjectTitle: queueResult?.payload?.subject?.title ?? queueResult?.payload?.subject?.summary ?? null,
          missing: {
            tagline: !hasEventTagline(queueResult?.payload?.subject),
            imageTheme: queueResult?.payload?.subject?.image?.theme == null,
            imageUrl: queueResult?.payload?.subject?.image?.url == null,
          },
          queueUrl: queueResult?.queueUrl ?? SCOUTS_REQUESTS_QUEUE_URL,
          messageId: queueResult?.messageId ?? null,
          md5OfMessageBody: queueResult?.md5OfMessageBody ?? null,
        },
      }),
    };
  }

  const mapMetadataFieldToken = (token) => {
    if (!token) return null;
    const normalized = String(token).trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'tagline') return 'tagline';
    if (normalized === 'imagetheme') return 'imageTheme';
    if (normalized === 'imageurl') return 'imageUrl';
    if (normalized === 'image') return 'eventImage';
    if (normalized === 'persist') return 'all';
    return null;
  };

  const mapMetadataFieldFromActionToken = (token) => {
    if (!token) return null;
    if (token === 'generatefull') return 'all';
    if (token === 'generatetagline') return 'tagline';
    if (token === 'generateimagetheme') return 'imageTheme';
    if (token === 'generateimage') return 'imageUrl';
    return null;
  };

  const requestedMetadataField = mapMetadataFieldToken(commandSubjectString)
    ?? mapMetadataFieldFromActionToken(commandActionToken);
  const isMetadataPersistCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandActionToken
    && (commandActionToken.startsWith('persist') || commandActionToken === 'approve')
    && (
      requestedMetadataField !== null
      || (structuredCommand.subject && typeof structuredCommand.subject === 'object')
    )
  );

  if (isMetadataPersistCommand) {
    const normalizeNullableText = (value) => {
      if (value === undefined || value === null) return null;
      const text = String(value).trim();
      return text ? text : null;
    };
    const normalizeNullableBoolean = (value) => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value === 'boolean') return value;
      const normalized = String(value).trim().toLowerCase();
      if (!normalized) return null;
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
      return null;
    };

    const eventCandidate =
      (bodyParams?.event && typeof bodyParams.event === 'object' ? bodyParams.event : null)
      ?? (bodyParams?.subjectEvent && typeof bodyParams.subjectEvent === 'object' ? bodyParams.subjectEvent : null)
      ?? (structuredCommand?.subject && typeof structuredCommand.subject === 'object' ? structuredCommand.subject : null)
      ?? (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? null;
    const subjectObject =
      (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? (structuredCommand?.subject && typeof structuredCommand.subject === 'object' ? structuredCommand.subject : null)
      ?? null;

    const candidateHex = normalizeNullableText(
      firstDefinedValue(
        bodyParams?.hex,
        queryParams?.hex,
        structuredCommand?.hex,
        subjectObject?.hex,
        eventCandidate?.hex,
      ),
    )?.toLowerCase() ?? null;

    if (!candidateHex) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing hex value for persist operation' }),
      };
    }

    if (!/^[0-9a-f]+$/i.test(candidateHex)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid hex value for persist operation' }),
      };
    }

    const candidateTitle = normalizeNullableText(
      firstDefinedValue(
        subjectObject?.title,
        eventCandidate?.title,
        bodyParams?.title,
      ),
    );
    const candidateTagline = normalizeNullableText(
      firstDefinedValue(
        bodyParams?.tagline,
        subjectObject?.metadata?.tagline,
        subjectObject?.tagline,
        eventCandidate?.metadata?.tagline,
        eventCandidate?.tagline,
      ),
    );
    const candidateImageTheme = normalizeNullableText(
      firstDefinedValue(
        bodyParams?.imageTheme,
        subjectObject?.metadata?.imageTheme,
        subjectObject?.imageTheme,
        subjectObject?.image?.theme,
        eventCandidate?.metadata?.imageTheme,
        eventCandidate?.imageTheme,
        eventCandidate?.image?.theme,
      ),
    );
    const candidateImageUrl = normalizeNullableText(
      firstDefinedValue(
        bodyParams?.imageUrl,
        subjectObject?.metadata?.imageUrl,
        subjectObject?.imageUrl,
        subjectObject?.image?.url,
        eventCandidate?.metadata?.imageUrl,
        eventCandidate?.imageUrl,
        eventCandidate?.image?.url,
      ),
    );
    const candidateIsHidden = normalizeNullableBoolean(
      firstDefinedValue(
        bodyParams?.isHidden,
        bodyParams?.hidden,
        subjectObject?.isHidden,
        subjectObject?.hidden,
        eventCandidate?.isHidden,
        eventCandidate?.hidden,
      ),
    );
    const candidateIsApproved = normalizeNullableBoolean(
      firstDefinedValue(
        bodyParams?.isApproved,
        bodyParams?.approved,
        subjectObject?.isApproved,
        subjectObject?.approved,
        eventCandidate?.isApproved,
        eventCandidate?.approved,
      ),
    );

    const requiredPersistField = requestedMetadataField === 'all'
      ? null
      : requestedMetadataField === 'eventImage'
        ? 'imageUrl'
        : requestedMetadataField;
    const subject = {
      hex: candidateHex,
      ...(candidateTitle ? { title: candidateTitle } : {}),
    };
    const persistedFields = [];

    if ((requiredPersistField === null || requiredPersistField === 'tagline') && candidateTagline) {
      subject.tagline = candidateTagline;
      persistedFields.push('tagline');
    }

    if ((requiredPersistField === null || requiredPersistField === 'imageTheme') && candidateImageTheme) {
      subject.imageTheme = candidateImageTheme;
      persistedFields.push('imageTheme');
    }

    if ((requiredPersistField === null || requiredPersistField === 'imageUrl') && candidateImageUrl) {
      subject.imageUrl = candidateImageUrl;
      persistedFields.push('imageUrl');
    }

    if (candidateIsHidden !== null) {
      subject.isHidden = candidateIsHidden;
      persistedFields.push('isHidden');
    }

    if (candidateIsApproved !== null) {
      subject.isApproved = candidateIsApproved;
      persistedFields.push('isApproved');
    }

    if (persistedFields.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ 
          error: 'No updatable metadata fields found for persist operation',
          realmError: 'persist',
          realmErrorDetail: 'No updatable metadata fields found for persist operation'
        }),
      };
    }

    const fieldLevelPersistField = (
      (requiredPersistField === 'tagline' || requiredPersistField === 'imageTheme' || requiredPersistField === 'imageUrl')
      && persistedFields.length === 1
      && persistedFields[0] === requiredPersistField
    ) ? requiredPersistField : null;

    const queuePayload = fieldLevelPersistField
      ? {
          realm: 'scoutsRequest',
          subject: fieldLevelPersistField,
          subjectLabel: fieldLevelPersistField,
          hex: candidateHex,
          ...(candidateTitle ? { title: candidateTitle } : {}),
          ...(fieldLevelPersistField === 'tagline' ? { tagline: candidateTagline } : {}),
          ...(fieldLevelPersistField === 'imageTheme' ? { imageTheme: candidateImageTheme } : {}),
          ...(fieldLevelPersistField === 'imageUrl' ? { imageUrl: candidateImageUrl } : {}),
          action: 'persist',
        }
      : {
          realm: 'persist',
          subject,
          action: 'persist',
        };

    const queueResult = await postToScoutsRequestsQueue(
      queuePayload,
      `AdminPersist:${persistedFields.join(',')}`,
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        message: `Persist request submitted for ${candidateHex}`,
        queueAccepted: true,
        queuedHex: candidateHex,
        persistedFields,
        requestId: queueResult?.payload?.requestId ?? null,
        queuedMessage: {
          requestId: queueResult?.payload?.requestId ?? null,
          realm: queueResult?.payload?.realm ?? (fieldLevelPersistField ? 'scoutsRequest' : 'persist'),
          action: queueResult?.payload?.action ?? 'persist',
          subjectHex: queueResult?.payload?.hex ?? queueResult?.payload?.subject?.hex ?? candidateHex,
          subjectTitle: queueResult?.payload?.title ?? null,
          subjectField: typeof queueResult?.payload?.subject === 'string' ? queueResult.payload.subject : null,
          queueUrl: queueResult?.queueUrl ?? SCOUTS_REQUESTS_QUEUE_URL,
          messageId: queueResult?.messageId ?? null,
          md5OfMessageBody: queueResult?.md5OfMessageBody ?? null,
        },
      }),
    };
  }

  const isHideEventCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && (commandActionToken === 'hide' || commandActionToken === 'hidden')
  );
  const isUnhideEventCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && (commandActionToken === 'unhide' || commandActionToken === 'show')
  );

  if (isHideEventCommand || isUnhideEventCommand) {
    const isHideOperation = isHideEventCommand === true;
    const normalizeNullableText = (value) => {
      if (value === undefined || value === null) return null;
      const text = String(value).trim();
      return text ? text : null;
    };
    const subjectObject =
      (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? (structuredCommand?.subject && typeof structuredCommand.subject === 'object' ? structuredCommand.subject : null);
    const candidateHex = normalizeNullableText(
      firstDefinedValue(
        subjectObject?.hex,
        bodyParams?.hex,
        queryParams?.hex,
      ),
    )?.toLowerCase() ?? null;

    if (!candidateHex) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Missing required hex value for ${isHideOperation ? 'hide' : 'unhide'} operation` }),
      };
    }

    if (!/^[0-9a-f]+$/i.test(candidateHex)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Invalid hex value for ${isHideOperation ? 'hide' : 'unhide'} operation` }),
      };
    }

    const queueResult = await postToScoutsRequestsQueue(
      {
        realm: 'persist',
        subject: {
          hex: candidateHex,
          isHidden: isHideOperation,
        },
        action: 'persist',
      },
      isHideOperation ? 'AdminHide' : 'AdminUnhide',
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        message: `${isHideOperation ? 'Hide' : 'Unhide'} request submitted for ${candidateHex}`,
        queueAccepted: true,
        queuedHex: candidateHex,
        requestId: queueResult?.payload?.requestId ?? null,
        queuedMessage: {
          requestId: queueResult?.payload?.requestId ?? null,
          realm: queueResult?.payload?.realm ?? 'persist',
          action: queueResult?.payload?.action ?? 'persist',
          subjectHex: queueResult?.payload?.subject?.hex ?? candidateHex,
          subjectTitle: null,
          queueUrl: queueResult?.queueUrl ?? SCOUTS_REQUESTS_QUEUE_URL,
          messageId: queueResult?.messageId ?? null,
          md5OfMessageBody: queueResult?.md5OfMessageBody ?? null,
        },
      }),
    };
  }

  const isMetadataGenerateFullCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandActionToken === 'generatefull'
  );
  const metadataGenerateField = requestedMetadataField === 'all' ? null : requestedMetadataField;
  const isMetadataGenerateCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && (commandActionToken?.startsWith('generate') || commandActionToken === 'request')
    && metadataGenerateField !== null
  );

  if (isMetadataGenerateFullCommand) {
    const normalizeNullableText = (value) => {
      if (value === undefined || value === null) return null;
      const text = String(value).trim();
      return text ? text : null;
    };

    const eventCandidate =
      (bodyParams?.event && typeof bodyParams.event === 'object' ? bodyParams.event : null)
      ?? (bodyParams?.subjectEvent && typeof bodyParams.subjectEvent === 'object' ? bodyParams.subjectEvent : null)
      ?? (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? null;
    const subjectObject =
      (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? null;

    const candidateHex =
      normalizeNullableText(bodyParams?.hex)?.toLowerCase()
      ?? normalizeNullableText(queryParams?.hex)?.toLowerCase()
      ?? normalizeNullableText(subjectObject?.hex)?.toLowerCase()
      ?? normalizeNullableText(eventCandidate?.hex)?.toLowerCase()
      ?? null;

    if (!candidateHex) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing hex value for full enrichment generation request' }),
      };
    }

    if (!/^[0-9a-f]+$/i.test(candidateHex)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid hex value for image enrichment generation request' }),
      };
    }

    const candidateTitle = normalizeNullableText(
      firstDefinedValue(
        subjectObject?.title,
        eventCandidate?.title,
        bodyParams?.title,
      ),
    );
    const candidateTagline = normalizeNullableText(
      firstDefinedValue(
        subjectObject?.metadata?.tagline,
        subjectObject?.tagline,
        eventCandidate?.metadata?.tagline,
        eventCandidate?.tagline,
        null,
      ),
    );

    const queuePayload = {
      realm: 'scoutsRequest',
      action: candidateTagline ? 'imageEnrich' : 'new',
      source: 'scouts',
      requestMode: 'auto',
      approvalMode: 'auto',
      subject: {
        hex: candidateHex,
        ...(candidateTitle ? { title: candidateTitle } : {}),
      },
      hex: candidateHex,
      ...(candidateTitle ? { title: candidateTitle } : {}),
    };

    const queueResult = await postToScoutsRequestsQueue(
      queuePayload,
      'AdminGenerate:full',
    );

    const queuedAction = queueResult?.payload?.action ?? queuePayload.action ?? 'imageEnrich';
    const requestLabel = queuedAction === 'imageEnrich' ? 'Image enrichment' : 'Metadata generation';

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        message: `${requestLabel} request submitted for ${candidateHex}`,
        queueAccepted: true,
        queuedHex: candidateHex,
        subjectLabel: 'full',
        requestId: queueResult?.payload?.requestId ?? null,
        queuedMessage: {
          requestId: queueResult?.payload?.requestId ?? null,
          realm: queueResult?.payload?.realm ?? 'scoutsRequest',
          action: queuedAction,
          subjectHex: queueResult?.payload?.hex ?? queueResult?.payload?.subject?.hex ?? candidateHex,
          subjectTitle: queueResult?.payload?.title ?? queueResult?.payload?.subject?.title ?? null,
          queueUrl: queueResult?.queueUrl ?? SCOUTS_REQUESTS_QUEUE_URL,
          messageId: queueResult?.messageId ?? null,
          md5OfMessageBody: queueResult?.md5OfMessageBody ?? null,
        },
      }),
    };
  }

  if (isMetadataGenerateCommand) {
    const normalizeNullableText = (value) => {
      if (value === undefined || value === null) return null;
      const text = String(value).trim();
      return text ? text : null;
    };

    const eventCandidate =
      (bodyParams?.event && typeof bodyParams.event === 'object' ? bodyParams.event : null)
      ?? (bodyParams?.subjectEvent && typeof bodyParams.subjectEvent === 'object' ? bodyParams.subjectEvent : null)
      ?? (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? null;
    const subjectObject =
      (bodyParams?.subject && typeof bodyParams.subject === 'object' ? bodyParams.subject : null)
      ?? null;

    const candidateHex =
      normalizeNullableText(bodyParams?.hex)?.toLowerCase()
      ?? normalizeNullableText(queryParams?.hex)?.toLowerCase()
      ?? normalizeNullableText(subjectObject?.hex)?.toLowerCase()
      ?? normalizeNullableText(eventCandidate?.hex)?.toLowerCase()
      ?? null;

    if (!candidateHex) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Missing hex value for ${metadataGenerateField} generation request` }),
      };
    }

    if (!/^[0-9a-f]+$/i.test(candidateHex)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Invalid hex value for ${metadataGenerateField} generation request` }),
      };
    }

    const targetRealm = metadataGenerateField === 'tagline'
      ? 'tagline'
      : metadataGenerateField === 'imageTheme'
        ? 'imageTheme'
        : 'image';

    const candidateTitle = normalizeNullableText(
      firstDefinedValue(
        subjectObject?.title,
        eventCandidate?.title,
        bodyParams?.title,
      ),
    );

    const fieldLevelGenerateField = (metadataGenerateField === 'tagline' || metadataGenerateField === 'imageTheme' || metadataGenerateField === 'imageUrl')
      ? metadataGenerateField
      : null;

    const queuePayload = fieldLevelGenerateField
      ? {
          realm: 'scoutsRequest',
          subject: fieldLevelGenerateField,
          subjectLabel: fieldLevelGenerateField,
          hex: candidateHex,
          ...(candidateTitle ? { title: candidateTitle } : {}),
          action: 'request',
        }
      : {
          realm: targetRealm,
          subject: candidateHex,
          action: 'request',
        };

    const queueResult = await postToScoutsRequestsQueue(
      queuePayload,
      `AdminGenerate:${metadataGenerateField}`,
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        message: `${metadataGenerateField} generation request submitted for ${candidateHex}`,
        queueAccepted: true,
        queuedHex: candidateHex,
        subjectLabel: metadataGenerateField,
        requestId: queueResult?.payload?.requestId ?? null,
        queuedMessage: {
          requestId: queueResult?.payload?.requestId ?? null,
          realm: queueResult?.payload?.realm ?? (fieldLevelGenerateField ? 'scoutsRequest' : targetRealm),
          action: queueResult?.payload?.action ?? 'request',
          subjectHex: queueResult?.payload?.hex ?? candidateHex,
          subjectTitle: queueResult?.payload?.title ?? null,
          subjectField: typeof queueResult?.payload?.subject === 'string' ? queueResult.payload.subject : null,
          queueUrl: queueResult?.queueUrl ?? SCOUTS_REQUESTS_QUEUE_URL,
          messageId: queueResult?.messageId ?? null,
          md5OfMessageBody: queueResult?.md5OfMessageBody ?? null,
        },
      }),
    };
  }

  const resolveRequestedFeeds = (feeds, tokens) => {
    if (!Array.isArray(feeds) || feeds.length === 0) {
      return [];
    }
    if (!Array.isArray(tokens) || tokens.length === 0 || tokens.includes('all')) {
      return feeds;
    }

    const byType = new Map(feeds.map((feed) => [normaliseCalendarToken(feed.icsType), feed]));
    const bySection = new Map();
    for (const feed of feeds) {
      const section = normaliseCalendarToken(feed.section);
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(feed);
    }

    const selected = new Map();
    const aliasToTypes = {
      'cubs-events': ['cubs-events'],
      'cubs-program': ['cubs-programme'],
      'cubs-programme': ['cubs-programme'],
      'scouts-events': ['scouts-events'],
      'scouts-program': ['scouts-programme'],
      'scouts-programme': ['scouts-programme'],
      'beavers-events': ['beavers-events'],
      'beavers-program': ['beavers-programme'],
      'beavers-programme': ['beavers-programme'],
    };

    for (const token of tokens) {
      if (token === 'events') {
        for (const feed of feeds.filter((entry) => entry.icsType.endsWith('-events'))) {
          selected.set(feed.key, feed);
        }
        continue;
      }
      if (token === 'programme' || token === 'program') {
        for (const feed of feeds.filter((entry) => entry.icsType.endsWith('-programme'))) {
          selected.set(feed.key, feed);
        }
        continue;
      }
      if (token === 'cubs' || token === 'scouts' || token === 'beavers') {
        const sectionFeeds = bySection.get(token) || [];
        for (const feed of sectionFeeds) {
          selected.set(feed.key, feed);
        }
        continue;
      }
      if (aliasToTypes[token]) {
        for (const type of aliasToTypes[token]) {
          const match = byType.get(type);
          if (match) selected.set(match.key, match);
        }
        continue;
      }
      const direct = byType.get(token);
      if (direct) {
        selected.set(direct.key, direct);
      }
    }

    return Array.from(selected.values());
  };

  const selectedFeeds = resolveRequestedFeeds(configuredFeeds, requestedCalendarTokens);

  if (isScoutsCalendarCommand && requestedCalendarTokens.length > 0 && selectedFeeds.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Invalid calendar selection',
        calendarTokens: requestedCalendarTokens,
      }),
    };
  }

  // Handle sqs2scouts realm - process persisted and hidden notifications
  if (structuredCommand && structuredCommand.realm === 'sqs2scouts') {
    console.log('[sqs2scouts] Processing sqs2scouts request:', structuredCommand);
    
    const action = structuredCommand.action;
    
    try {
      const subject = typeof structuredCommand.subject === 'string' 
        ? JSON.parse(structuredCommand.subject)
        : structuredCommand.subject;
      
      const hexValue = subject?.hex ? String(subject.hex).trim().toLowerCase() : null;
      if (!hexValue) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'sqs2scouts payload missing hex identifier' })
        };
      }

      const requestRecord = {
        timestamp: new Date().toISOString(),
        requestId: (() => {
          const candidates = [
            subject?.requestId,
            bodyParams?.requestId,
            queryParams?.requestId,
            event?.requestId,
            event?.detail?.requestId,
            event?.messageId,
            event?.requestContext?.requestId,
          ];
          for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
          }
          return null;
        })(),
        realm: 'sqs2scouts',
        subject: hexValue,
        action: typeof action === 'string' && action.trim() ? action.trim() : null,
        status: (() => {
          const statusCandidate =
            (typeof subject?.status === 'string' && subject.status.trim() ? subject.status.trim() : null)
            || (typeof action === 'string' && action.trim() ? action.trim() : null)
            || 'received';
          return statusCandidate;
        })(),
      };

      const hexKey = `events/${hexValue}.json`;
      let hexData = await getJsonFromS3(bucket, hexKey, `hex:${hexValue}`);
      if (hexData && typeof hexData === 'object') {
        let hexChanged = false;
        if (appendMetadataRequestRecord(hexData, requestRecord)) {
          hexChanged = true;
        }
        if (hexChanged) {
          await putJsonToS3(bucket, hexKey, hexData, `hex:${hexValue}`, true);
          console.log(`[sqs2scouts] Updated HEX request history for ${hexValue}`);
        }
      }

      if (action === 'persisted') {
        // Handle persisted action - check completeness and update agenda
        console.log(`[sqs2scouts] Processing persisted notification for ${hexValue}`);

        if (!hexData) {
          console.warn(`[sqs2scouts] HEX file not found for ${hexValue}`);
          return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({ error: `HEX file not found for ${hexValue}` })
          };
        }

        const isComplete = hasEventTagline(hexData) && getEventImageUrl(hexData) && getEventImageTheme(hexData);

        if (!isComplete) {
          console.log(`[sqs2scouts] Incomplete data for ${hexValue}, skipping requeue from callback path.`);
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ status: 'ok', message: `Incomplete data for ${hexValue}, no requeue performed.` })
          };
        }

        console.log(`[sqs2scouts] Complete data for ${hexValue}, updating agenda.json.`);
        const existingAgendaRaw = await getJsonFromS3(bucket, agendaKey, 'agenda');
        const existingAgenda = hydrateStoredDataset(existingAgendaRaw);
        
        console.log(`[sqs2scouts] Loaded agenda with ${existingAgenda?.events?.length || 0} events`);
        
        let updated = false;
        if (existingAgenda?.events) {
          existingAgenda.events.forEach(event => {
            // Check both title and summary since storage format uses summary
            const eventTitle = event.title || event.summary;
            if (eventTitle) {
              const eventHex = titleToHex(eventTitle);
              if (eventHex === hexValue) {
                console.log(`[sqs2scouts] Updating event "${eventTitle}" (hex: ${eventHex}) with tagline and image from HEX ${hexValue}`);
                event.tagline = getEventTagline(hexData);
                if ('AI' in event) delete event.AI;
                if ('ai' in event) delete event.ai;
                event.image = {
                  theme: getEventImageTheme(hexData),
                  prompt: null,
                  url: getEventImageUrl(hexData),
                };
                const currentStatus = getEventStatusObject(event) ?? {};
                const nextStatus = getEventStatusObject(hexData) ?? {};
                event.status = {
                  isHidden: nextStatus.isHidden === true || currentStatus.isHidden === true,
                  isApproved: nextStatus.isApproved === true || currentStatus.isApproved === true || isEventApproved(hexData),
                };
                if (!event.metadata || typeof event.metadata !== 'object') {
                  event.metadata = {};
                }
                event.metadata.hex = hexValue;
                event.metadata.tagline = event.tagline;
                event.metadata.image = {
                  theme: event.image.theme ?? null,
                  prompt: null,
                  url: event.image.url ?? null,
                };
                event.metadata.status = {
                  isHidden: event.status.isHidden === true,
                  isApproved: event.status.isApproved === true,
                };
                updated = true;
              }
            }
          });
        }
        
        if (!updated) {
          console.warn(`[sqs2scouts] No matching event found in agenda for HEX ${hexValue}. HEX data title: "${hexData.title || hexData.summary || 'unknown'}"`);
        }

        if (updated) {
          const agendaPayload = {
            generatedAt: new Date().toISOString(),
            events: existingAgenda.events.map(prepareEventForStorage),
          };
          await putJsonToS3(bucket, agendaKey, agendaPayload, 'agenda');
          console.log(`[sqs2scouts] Updated agenda.json with data from HEX ${hexValue}`);
        }

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ status: 'ok', message: `Agenda processed for HEX ${hexValue}.` })
        };
        
      } else if (action === 'hidden') {
        // Handle hidden action - mark event as hidden in agenda
        console.log(`[sqs2scouts] Processing hidden notification for ${hexValue}`);
        
        const uid = subject.uid || hexValue;
        
        // Update agenda.json to mark event as hidden
        const existingAgendaRaw = await getJsonFromS3(bucket, agendaKey, 'agenda');
        const existingAgenda = hydrateStoredDataset(existingAgendaRaw);
        
        let updated = false;
        if (existingAgenda?.events) {
          existingAgenda.events.forEach(event => {
            const eventTitle = event.title || event.summary;
            if (eventTitle) {
              const eventHex = titleToHex(eventTitle);
              if (eventHex === hexValue || event.uid === uid) {
                const currentStatus = getEventStatusObject(event) ?? {};
                event.status = {
                  isHidden: true,
                  isApproved: currentStatus.isApproved === true || isEventApproved(event),
                };
                if (!event.metadata || typeof event.metadata !== 'object') {
                  event.metadata = {};
                }
                event.metadata.hex = event.hex ?? eventHex ?? hexValue;
                event.metadata.status = {
                  isHidden: true,
                  isApproved: event.status.isApproved === true,
                };
                updated = true;
              }
            }
          });
        }

        if (updated) {
          const agendaPayload = {
            generatedAt: new Date().toISOString(),
            events: existingAgenda.events.map(prepareEventForStorage),
          };
          await putJsonToS3(bucket, agendaKey, agendaPayload, 'agenda');
          console.log(`[sqs2scouts] Marked event as hidden in agenda.json for HEX ${hexValue}`);
        }

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ status: 'ok', message: `Event ${hexValue} marked as hidden.` })
        };
        
      } else {
        // Unsupported action
        console.warn(`[sqs2scouts] Unsupported action: ${action}`);
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: `Unsupported action: ${action}` })
        };
      }

    } catch (error) {
      console.error('[sqs2scouts] Error processing sqs2scouts request:', error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: `sqs2scouts processing failed: ${error.message}` })
      };
    }
  }

  console.log('Fetching calendars', {
    bucket,
    agendaKey,
    configuredFeedsCount: configuredFeeds.length,
    configuredFeedTypes: configuredFeeds.map((feed) => feed.icsType),
    selectedFeedsCount: selectedFeeds.length,
    selectedFeedTypes: selectedFeeds.map((feed) => feed.icsType),
    requestedCalendarTokens,
    method,
    resetRequested,
    structuredCommand,
    maxScoutRequests,
    triggeredBySqs: event?._triggeredBySqs,
    maxEventsResumeEnv: process.env.max_events_resume,
    maxEventsStartEnv: process.env.max_events_start,
  });

  let removedEventFiles = [];
  const isScoutsExecutionCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && (isScoutsCalendarCommand || ['events', 'agenda'].includes(commandSubjectString || ''))
  );
  const isAgendaEnrichmentOnlyCommand = Boolean(
    structuredCommand
    && structuredCommand.realm === 'scouts'
    && commandSubjectString === 'agenda'
    && typeof structuredCommand.action === 'number'
  );

  if (isScoutsExecutionCommand) {
    await touchQueuedRuntimeSnapshot(bucket);
  }

  if (resetRequested) {
    try {
      // Delete agenda.json and calendar ICS artefacts when a reset is requested
      await deleteObjectFromS3(bucket, agendaKey, 'agenda');
      // Also remove cached ICS files to force re-fetch on next run
      const icsKeys = [
        `calendar/cubs-events.ics`,
        `calendar/beavers-events.ics`,
        `calendar/cubs-programme.ics`,
        `calendar/beavers-programme.ics`,
      ];
      await Promise.all(icsKeys.map((k) => deleteObjectFromS3(bucket, k, `calendar:${k}`)));
      removedEventFiles = await purgeEventFilesFromS3(bucket, 'events/');
    } catch (error) {
      console.error('Failed to reset cached data:', error.message);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          status: 'error',
          message: 'Failed to reset stored data',
        }),
      };
    }

    try {
      await notifyResetToScoutsRequestsQueue(removedEventFiles);
    } catch (notificationError) {
      console.warn('[Reset] Failed to notify scoutsRequests queue about removed events:', notificationError?.message || notificationError);
    }
  }

  try {
    let dedupedNewEvents = [];
    if (!isAgendaEnrichmentOnlyCommand) {
      // Fetch calendar ICS data, but use S3 cached copies when they were updated within the last 24 hours
      console.log('Fetching ICS calendar feeds with S3 freshness checks...');

      // Try to use fresh copies from S3 (freshness = 24 hours)
      const freshnessMs = 24 * 60 * 60 * 1000;
      const allNewEvents = [];
      const feedSummaries = [];

      for (const feed of selectedFeeds) {
        let ics = await getFreshIcsFromS3(bucket, feed.key, freshnessMs);
        if (!ics) {
          console.log(`Cached ${feed.label} ICS is stale or missing; fetching from remote...`);
          ics = await fetchCalendar(feed.url, feed.label);
          await putRawIcsToS3(bucket, feed.key, ics, feed.label);
        }

        const parsedEvents = parseIcsEvents(ics).map((event) => ({
          ...event,
          section: feed.section,
          icsType: feed.icsType,
        }));
        allNewEvents.push(...parsedEvents);
        feedSummaries.push({ label: feed.label, chars: ics ? ics.length : 0, events: parsedEvents.length });
      }

      if (!selectedFeeds.length) {
        if (configuredFeeds.length === 0) {
          console.warn('[Calendars] No calendar URLs configured; skipping fetch/parsing for this run.');
        } else {
          console.warn('[Calendars] Calendar filter selected no feeds; skipping fetch/parsing for this run.');
        }
      } else if (!configuredFeeds.length) {
        console.warn('[Calendars] No calendar URLs configured; skipping fetch/parsing for this run.');
      } else {
        console.log('ICS Data Summary:');
        feedSummaries.forEach((summary) => {
          console.log(`  ${summary.label} ICS: ${summary.chars} characters (${summary.events} events)`);
        });
      }

      // Combine and dedupe all new events
      dedupedNewEvents = dedupeSectionedEvents(allNewEvents);
      
      console.log(`Parsed ${allNewEvents.length} raw events, ${dedupedNewEvents.length} after deduplication`);
      
      // Log first few events for debugging
      if (dedupedNewEvents.length > 0) {
        console.log('First 5 parsed events:');
        dedupedNewEvents.slice(0, 5).forEach((event, i) => {
          console.log(`  ${i+1}. ${event.title} (${event.start?.raw}) - ${event.icsType}`);
        });
      }
    } else {
      console.log('[Agenda Command] Skipping calendar refresh; using existing agenda.json for enrichment only.');
    }

    const runtimeQueueSnapshots = await readRuntimeQueueSnapshots(bucket);
    const existingAgendaRaw = await (resetRequested ? null : getJsonFromS3(bucket, agendaKey, 'agenda'));
    const existingAgenda = hydrateStoredDataset(existingAgendaRaw);
    const mergedAgenda = mergeEvents(existingAgenda, dedupedNewEvents);

    logImageDiagnostics('Merged agenda before enrichment', mergedAgenda);

    let aiContext = { processedEvent: null };
    let enrichedAgenda;
    let liveQueuedProcessingByHex = new Map();

    if (resetRequested) {
      enrichedAgenda = mergedAgenda.map(stripEventEnhancements);
      console.log('[Images] Reset requested: cleared tagline and image fields');
    } else {
      const enrichmentOptions = maxScoutRequests !== null ? { maxScoutRequests } : undefined;
      const enrichmentResult = await enrichEventsWithAI(mergedAgenda, aiContext, 'agenda', enrichmentOptions);
      enrichedAgenda = Array.isArray(enrichmentResult?.events) ? enrichmentResult.events : [];
      liveQueuedProcessingByHex = enrichmentResult?.liveQueuedProcessingByHex instanceof Map
        ? enrichmentResult.liveQueuedProcessingByHex
        : new Map();
    }

    logImageDiagnostics('Final agenda before storage', enrichedAgenda);

    // Verify and repair images in the enriched agenda
    console.log('[Image Verification] Starting image verification for agenda events...');
    const { repairedEvents: verifiedAgenda, brokenImages } = await verifyAndRepairEventImages(enrichedAgenda, bucket);
    
    if (brokenImages.length > 0) {
      console.log(`[Image Verification] Found ${brokenImages.length} broken images and removed their broken URLs from agenda output`);
    }

    // Clean up hidden past events and validate hidden future events
    console.log('[Hidden Events] Starting hidden event cleanup and validation...');
    const { retainedEvents: cleanedAgenda, removedEvents: hiddenPastEvents } = await cleanupHiddenPastEvents(verifiedAgenda);
    
    if (hiddenPastEvents.length > 0) {
      console.log(`[Hidden Events] Removed ${hiddenPastEvents.length} hidden past events from agenda`);
    }

    // Validate hidden future events are consistent with HEX files
    const hiddenInconsistencies = await validateHiddenFutureEvents(cleanedAgenda, bucket);
    
    if (hiddenInconsistencies.length > 0) {
      console.log(`[Hidden Events] Found and fixed ${hiddenInconsistencies.length} inconsistencies in hidden future events`);
    }

    const trimmedAgenda = cleanedAgenda.map(prepareEventForStorage);
    const modifiedEvents = listModifiedEvents(mergedAgenda, cleanedAgenda);

    const agendaMissing = calculateMissingCounts(cleanedAgenda);

    // Build array of processed events with generated metadata for response debugging
    const processedEvents = cleanedAgenda
      .filter(event => getEventTagline(event) || event.image?.theme || event.image?.url)
      .map(event => ({
        uid: event.uid ?? null,
        title: event.title ?? null,
        tagline: getEventTagline(event),
        imageTheme: event.image?.theme ?? null,
        imageUrl: event.image?.url ?? null,
        ...(isEventApproved(event) ? { approved: true } : {}),
        section: event.section ?? null,
      }));

    const generatedAt = new Date().toISOString();
    const agendaPayload = {
      generatedAt,
      events: trimmedAgenda,
    };

    await putJsonToS3(bucket, agendaKey, agendaPayload, 'agenda');

    // Clean up orphaned HEX files
    let orphanedHexFiles = [];
    try {
      orphanedHexFiles = await deleteOrphanedHexFiles(bucket, agendaPayload);
      if (orphanedHexFiles.length > 0) {
        console.log(`[Cleanup] Removed ${orphanedHexFiles.length} orphaned HEX files`);
      }
    } catch (cleanupError) {
      console.warn('[Cleanup] Failed to clean up orphaned HEX files:', cleanupError?.message || String(cleanupError));
    }

    // Verify and repair images in HEX files
    let hexFilesRepaired = 0;
    let hexFilesWithBrokenImages = 0;
    let hexFilesMigrated = 0;
    try {
      console.log('[HEX Image Verification] Starting image verification for HEX files...');
      let continuationToken = undefined;

      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'events/',
          ContinuationToken: continuationToken,
        });
        const response = await s3.send(listCommand);
        const objects = response?.Contents || [];

        if (!objects.length && !response?.IsTruncated) {
          break;
        }

        for (const object of objects) {
          const key = object?.Key;
          if (!key || !key.endsWith('.json')) continue;

          try {
            const hexData = await getJsonFromS3(bucket, key, `hex:${key}`);
            if (!hexData || typeof hexData !== 'object') continue;

            const repairResult = await verifyAndRepairHexFile(bucket, key, hexData);

            if (repairResult) {
              const { updatedHex, status } = repairResult;
              if (status === 'removed') {
                hexFilesWithBrokenImages += 1;
              } else if (status === 'migrated') {
                hexFilesMigrated += 1;
              }
              console.log(`[HEX Image Verification] Create-only mode: skipping rewrite for ${key}`);
            }
          } catch (readError) {
            console.warn(`[HEX Image Verification] Failed to read HEX file ${key}:`, readError.message);
          }
        }

        continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);

      if (hexFilesWithBrokenImages > 0) {
        console.log(`[HEX Image Verification] Found ${hexFilesWithBrokenImages} HEX files with broken images, repaired ${hexFilesRepaired}`);
      }
      if (hexFilesMigrated > 0) {
        console.log(`[HEX Image Verification] Migrated ${hexFilesMigrated} HEX files to ${EVENT_IMAGE_PREFIX}`);
      }
    } catch (hexVerifyError) {
      console.warn('[HEX Image Verification] Error during HEX file image verification:', hexVerifyError?.message || String(hexVerifyError));
    }

    let imageEnrichExecutions = null;
    try {
      imageEnrichExecutions = await listActiveImageEnrichExecutions(runtimeQueueSnapshots);
    } catch (stepFunctionsError) {
      console.warn('[Step Functions] Failed to list active image-enrich executions:', stepFunctionsError?.message || String(stepFunctionsError));
      imageEnrichExecutions = {
        configured: Boolean(trimOptionalText(IMAGE_ENRICH_STATE_MACHINE_ARN)),
        stateMachineArn: trimOptionalText(IMAGE_ENRICH_STATE_MACHINE_ARN),
        executionCount: 0,
        activeExecutionCount: 0,
        executions: [],
        activeExecutions: [],
        error: stepFunctionsError?.message || String(stepFunctionsError),
      };
    }

    const responseBody = {
      status: 'ok',
      eventsCount: trimmedAgenda.length,
      generatedAt,
      modifiedEventsCount: modifiedEvents.length,
      modifiedEvents,
      normalization: buildNormalizationSummary(),
      processedEvents,
      runtimeQueueSnapshots: {
        queued: summariseRuntimeQueueSnapshot(runtimeQueueSnapshots?.queuedSnapshot),
        processing: summariseRuntimeQueueSnapshot(runtimeQueueSnapshots?.processingSnapshot),
        completed: summariseRuntimeQueueSnapshot(runtimeQueueSnapshots?.completedSnapshot),
      },
      stepFunctions: {
        imageEnrich: imageEnrichExecutions,
      },
      aiSummary: {
        processedEvent: aiContext.processedEvent ?? null,
        missing: {
          agenda: agendaMissing,
        },
      },
    };

    if (method === 'GET') {
      responseBody.agenda = agendaPayload;
    }
    if (resetRequested) {
      responseBody.reset = true;
      responseBody.resetDetails = {
        removedEventsCount: removedEventFiles.length,
        removedEvents: removedEventFiles.map((event) => ({
          uid: event?.uid ?? null,
          title: event?.title ?? null,
          key: event?.key ?? null,
        })),
      };
    }

    if (orphanedHexFiles.length > 0) {
      responseBody.cleanup = {
        orphanedHexFilesCount: orphanedHexFiles.length,
        orphanedHexFiles: orphanedHexFiles.map((file) => ({
          key: file?.key ?? null,
          title: file?.title ?? null,
          reason: file?.reason ?? null,
        })),
      };
    }

    if (brokenImages.length > 0 || hexFilesWithBrokenImages > 0) {
      responseBody.imageRepair = {
        agendaBrokenImagesCount: brokenImages.length,
        brokenImages: brokenImages.map((img) => ({
          uid: img.uid,
          title: img.title,
          section: img.section,
          brokenUrl: img.imageUrl,
        })),
        hexFilesBrokenImagesCount: hexFilesWithBrokenImages,
        hexFilesRepaired,
        repairNotificationsSent: 0,
      };
    }

    if (hiddenPastEvents.length > 0 || hiddenInconsistencies.length > 0) {
      responseBody.hiddenEvents = {
        cleanupCount: hiddenPastEvents.length,
        removedPastHiddenEvents: hiddenPastEvents.map((evt) => ({
          uid: evt.uid,
          title: evt.title,
          eventTime: evt.eventTime,
        })),
        inconsistenciesFixed: hiddenInconsistencies.length,
        inconsistencyDetails: hiddenInconsistencies.map((inc) => ({
          uid: inc.uid,
          title: inc.title,
          agendaHidden: inc.agendaHidden,
          hexHidden: inc.hexHidden,
          action: inc.action,
        })),
      };
    }

    return respond(200, responseBody);
  } catch (error) {
    console.error('Failed to refresh scout calendars', error);
    return respond(500, {
      status: 'error',
      message: error.message,
    });
  } finally {
    if (isScoutsExecutionCommand) {
      await touchQueuedRuntimeSnapshot(bucket);
    }
  }
}

export const handler = lambdaHandler;

// Named exports for testing
export {
  buildQueuedRuntimeRequestEntry,
  prepareEventForStorage,
  pruneQueuedRuntimeRequests,
};
