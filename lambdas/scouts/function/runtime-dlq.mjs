import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const REQUESTS_QUEUE_URL = process.env.SCOUTS_REQUESTS_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const PROCESSING_QUEUE_URL = process.env.SCOUTS_PROCESSING_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing';
const REQUESTS_DLQ_URL = process.env.SCOUTS_REQUESTS_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequestsDLQ';
const PROCESSING_DLQ_URL = process.env.SCOUTS_PROCESSING_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ';
const MAX_SAMPLE_MESSAGES = 10;
const MAX_BODY_PREVIEW_CHARS = 12_000;
const REDRIVE_RATE_PER_SECOND = 1;

const sqs = new SQSClient({ region: REGION });

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

export async function inspectRuntimeDlq(queueName, maxMessages = 5) {
  const config = resolveDlq(queueName);
  const requestedMax = Number(maxMessages);
  const safeMax = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(MAX_SAMPLE_MESSAGES, Math.floor(requestedMax)))
    : 5;

  const [attrs, response] = await Promise.all([
    queueAttributes(config.queueUrl),
    sqs.send(new ReceiveMessageCommand({
      QueueUrl: config.queueUrl,
      MaxNumberOfMessages: safeMax,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    })),
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
