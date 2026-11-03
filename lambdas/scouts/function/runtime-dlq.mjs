import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const REQUESTS_QUEUE_URL = process.env.SCOUTS_REQUESTS_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const PROCESSING_QUEUE_URL = process.env.SCOUTS_PROCESSING_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing';
const REQUESTS_DLQ_URL = process.env.SCOUTS_REQUESTS_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequestsDLQ';
const PROCESSING_DLQ_URL = process.env.SCOUTS_PROCESSING_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ';
const MAX_SAMPLE_MESSAGES = 10;
const MAX_BODY_PREVIEW_CHARS = 12_000;
const REDRIVE_RATE_PER_SECOND = 1;

let sqs = new SQSClient({ region: REGION });
let cloudwatch = new CloudWatchClient({ region: REGION });

const DLQS = Object.freeze({
  scoutsRequestsDLQ: {
    name: 'scoutsRequestsDLQ',
    queueUrl: REQUESTS_DLQ_URL,
    sourceQueueName: 'scoutsRequests',
    sourceQueueUrl: REQUESTS_QUEUE_URL,
  },
  scoutsProcessingDLQ: {
    name: 'scoutsProcessingDLQ',
    queueUrl: PROCESSING_DLQ_URL,
    sourceQueueName: 'scoutsProcessing',
    sourceQueueUrl: PROCESSING_QUEUE_URL,
  },
});

const QUEUE_STATUS_TARGETS = Object.freeze([
  { name: 'scoutsRequests', queueUrl: REQUESTS_QUEUE_URL },
  { name: 'scoutsProcessing', queueUrl: PROCESSING_QUEUE_URL },
  { name: 'scoutsRequestsDLQ', queueUrl: REQUESTS_DLQ_URL },
  { name: 'scoutsProcessingDLQ', queueUrl: PROCESSING_DLQ_URL },
]);

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function isoFromEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric).toISOString();
}

function parseJson(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function subjectHex(subject) {
  if (subject && typeof subject === 'object') {
    return firstText(subject.hex, subject.hexId, subject.requestHex).toLowerCase();
  }
  const candidate = text(subject).toLowerCase();
  return /^[0-9a-f]+$/i.test(candidate) ? candidate : '';
}

export function summariseDlqPayload(body) {
  const payload = parseJson(body);
  if (!payload || typeof payload !== 'object') {
    return {
      parsed: false,
      realm: null,
      action: null,
      requestId: null,
      hex: null,
      requestTimestamp: null,
      subject: null,
    };
  }

  const subject = payload.subject;
  const requestId = firstText(
    payload.requestId,
    payload.metadata?.requestId,
    subject?.requestId,
    payload.message?.requestId,
  );
  const hex = firstText(
    payload.hex,
    payload.hexId,
    payload.requestHex,
    payload.metadata?.hex,
    subjectHex(subject),
  ).toLowerCase();
  const requestTimestamp = firstText(
    payload.requestTime,
    payload.requestedAt,
    payload.createdAt,
    payload.timestamp,
    payload.metadata?.requestedAt,
  );

  return {
    parsed: true,
    realm: firstText(payload.realm, payload.message?.realm) || null,
    action: firstText(payload.action, payload.operation, payload.message?.action) || null,
    requestId: requestId || null,
    hex: hex || null,
    requestTimestamp: requestTimestamp || null,
    subject: typeof subject === 'string'
      ? subject
      : (subject && typeof subject === 'object'
          ? firstText(subject.title, subject.summary, subject.name) || null
          : null),
  };
}

function resolveDlq(queueName) {
  const key = text(queueName);
  const config = DLQS[key];
  if (!config) {
    const error = new Error(`Unsupported DLQ: ${key || 'missing queue name'}`);
    error.statusCode = 400;
    throw error;
  }
  return config;
}

function bodyPreview(body) {
  const raw = typeof body === 'string' ? body : '';
  if (raw.length <= MAX_BODY_PREVIEW_CHARS) return raw;
  return `${raw.slice(0, MAX_BODY_PREVIEW_CHARS)}\n… [truncated]`;
}

export function setRuntimeDlqClientsForTests({ sqs: nextSqs, cloudwatch: nextCloudWatch } = {}) {
  if (nextSqs && typeof nextSqs.send !== 'function') throw new TypeError('SQS test client must expose send(command)');
  if (nextCloudWatch && typeof nextCloudWatch.send !== 'function') throw new TypeError('CloudWatch test client must expose send(command)');
  if (nextSqs) sqs = nextSqs;
  if (nextCloudWatch) cloudwatch = nextCloudWatch;
}

export function resetRuntimeDlqClientsForTests() {
  sqs = new SQSClient({ region: REGION });
  cloudwatch = new CloudWatchClient({ region: REGION });
}

async function queueAgeMetrics(targets) {
  const sampledAt = new Date();
  const response = await cloudwatch.send(new GetMetricDataCommand({
    MetricDataQueries: targets.map(({ name }, index) => ({
      Id: `age${index}`,
      Label: name,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SQS',
          MetricName: 'ApproximateAgeOfOldestMessage',
          Dimensions: [{ Name: 'QueueName', Value: name }],
        },
        Period: 60,
        Stat: 'Maximum',
      },
      ReturnData: true,
    })),
    StartTime: new Date(sampledAt.getTime() - 15 * 60 * 1000),
    EndTime: sampledAt,
    ScanBy: 'TimestampDescending',
    MaxDatapoints: Math.max(1, targets.length * 15),
  }));
  const byQueue = new Map();
  for (const result of response?.MetricDataResults || []) {
    const index = Number(String(result?.Id || '').replace(/^age/, ''));
    const target = Number.isInteger(index) ? targets[index] : null;
    if (!target) continue;
    const samples = (result.Timestamps || []).map((timestamp, sampleIndex) => ({
      timestamp: new Date(timestamp).getTime(),
      value: Number(result.Values?.[sampleIndex]),
    })).filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.value) && sample.value >= 0)
      .sort((left, right) => right.timestamp - left.timestamp);
    if (samples.length) {
      byQueue.set(target.name, {
        seconds: samples[0].value,
        sampledAt: new Date(samples[0].timestamp).toISOString(),
      });
    }
  }
  return { sampledAt: sampledAt.toISOString(), byQueue };
}

function oldestMessageAgeFields(measurement, error = null) {
  return {
    oldestMessageAgeSeconds: measurement?.seconds ?? null,
    oldestMessageAgeAt: measurement?.sampledAt ?? null,
    oldestMessageAgeStatus: measurement ? 'available' : error ? 'unavailable' : 'no_datapoint',
    ...(error ? { oldestMessageAgeError: error?.name || 'CloudWatchUnavailable' } : {}),
  };
}

async function queueAttributes(queueUrl) {
  const response = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: [
      'QueueArn',
      'ApproximateNumberOfMessages',
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed',
    ],
  }));
  const attrs = response?.Attributes || {};
  return {
    queueArn: text(attrs.QueueArn) || null,
    visible: Number(attrs.ApproximateNumberOfMessages || 0),
    inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible || 0),
    delayed: Number(attrs.ApproximateNumberOfMessagesDelayed || 0),
  };
}

/** Read SQS queue depth and CloudWatch oldest-message age on demand without sampling messages. */
export async function getRuntimeQueueStatus() {
  const [ageSnapshot, queues] = await Promise.all([
    queueAgeMetrics(QUEUE_STATUS_TARGETS).catch((error) => ({ byQueue: new Map(), error })),
    Promise.all(QUEUE_STATUS_TARGETS.map(async ({ name, queueUrl }) => {
      try {
        const attributes = await queueAttributes(queueUrl);
        return {
          name,
          visible: attributes.visible,
          inFlight: attributes.inFlight,
          delayed: attributes.delayed,
          ok: true,
        };
      } catch (error) {
        return {
          name,
          visible: null,
          inFlight: null,
          delayed: null,
          ok: false,
          error: error?.name || 'QueueStatusUnavailable',
        };
      }
    })),
  ]);
  const withAge = queues.map((queue) => ({
    ...queue,
    ...oldestMessageAgeFields(ageSnapshot.byQueue.get(queue.name), ageSnapshot.error),
  }));
  return {
    sampledAt: new Date().toISOString(),
    source: 'sqs:GetQueueAttributes+cloudwatch:GetMetricData',
    queues: withAge,
    note: 'SQS queue counts are approximate. Oldest-message age is an AWS/SQS CloudWatch sample and may have no datapoint when there are no active messages. No messages are sampled or changed.',
  };
}

export async function inspectRuntimeDlq(queueName, maxMessages = 5) {
  const config = resolveDlq(queueName);
  const requestedMax = Number(maxMessages);
  const safeMax = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(MAX_SAMPLE_MESSAGES, Math.floor(requestedMax)))
    : 5;

  const [attrs, response, ageSnapshot] = await Promise.all([
    queueAttributes(config.queueUrl),
    sqs.send(new ReceiveMessageCommand({
      QueueUrl: config.queueUrl,
      MaxNumberOfMessages: safeMax,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    })),
    queueAgeMetrics([config]).catch((error) => ({ byQueue: new Map(), error })),
  ]);

  const messages = (response?.Messages || []).map((message) => {
    const attributes = message?.Attributes || {};
    return {
      messageId: text(message?.MessageId) || null,
      sentAt: isoFromEpochMs(attributes.SentTimestamp),
      firstReceivedAt: isoFromEpochMs(attributes.ApproximateFirstReceiveTimestamp),
      receiveCount: Number(attributes.ApproximateReceiveCount || 0),
      summary: summariseDlqPayload(message?.Body),
      bodyPreview: bodyPreview(message?.Body),
    };
  });

  return {
    queueName: config.name,
    sourceQueueName: config.sourceQueueName,
    sampledAt: new Date().toISOString(),
    visible: attrs.visible,
    inFlight: attrs.inFlight,
    delayed: attrs.delayed,
    ...oldestMessageAgeFields(ageSnapshot.byQueue.get(config.name), ageSnapshot.error),
    sampleCount: messages.length,
    messages,
    note: 'SQS has no peek API. Sampling uses visibility timeout 0 and does not delete messages, but ApproximateReceiveCount can increase.',
  };
}

export async function redriveRuntimeDlq(queueName, expectedVisible = null) {
  const config = resolveDlq(queueName);
  const attrs = await queueAttributes(config.queueUrl);
  if (!attrs.queueArn) {
    const error = new Error(`Queue ARN unavailable for ${config.name}`);
    error.statusCode = 503;
    throw error;
  }

  const expected = Number(expectedVisible);
  if (Number.isFinite(expected) && expected >= 0 && attrs.visible !== Math.floor(expected)) {
    const error = new Error(`DLQ count changed from ${Math.floor(expected)} to ${attrs.visible}; inspect again before redriving.`);
    error.statusCode = 409;
    error.currentVisible = attrs.visible;
    throw error;
  }
  if (attrs.visible <= 0) {
    return {
      queueName: config.name,
      sourceQueueName: config.sourceQueueName,
      status: 'empty',
      visibleAtStart: 0,
      startedAt: new Date().toISOString(),
      taskHandle: null,
    };
  }

  const result = await sqs.send(new StartMessageMoveTaskCommand({
    SourceArn: attrs.queueArn,
    MaxNumberOfMessagesPerSecond: REDRIVE_RATE_PER_SECOND,
  }));

  return {
    queueName: config.name,
    sourceQueueName: config.sourceQueueName,
    status: 'started',
    visibleAtStart: attrs.visible,
    maxMessagesPerSecond: REDRIVE_RATE_PER_SECOND,
    startedAt: new Date().toISOString(),
    taskHandle: text(result?.TaskHandle) || null,
  };
}
