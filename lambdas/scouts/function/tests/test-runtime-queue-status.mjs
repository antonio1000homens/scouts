import assert from 'node:assert/strict';
import test from 'node:test';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const {
  getRuntimeQueueStatus,
  resetRuntimeDlqClientsForTests,
  setRuntimeDlqClientsForTests,
} = await import('../runtime-dlq.mjs');

const queueNames = [
  'scoutsRequests',
  'scoutsProcessing',
  'scoutsRequestsDLQ',
  'scoutsProcessingDLQ',
];

function mockSqs(send) {
  const commands = [];
  return {
    commands,
    client: {
      async send(command) {
        commands.push(command);
        return send(command);
      },
    },
  };
}

test('queue status reads counts from SQS and age from CloudWatch', async () => {
  const sqs = mockSqs((command) => {
    assert.ok(command instanceof GetQueueAttributesCommand);
    assert.ok(!command.input.AttributeNames.includes('ApproximateAgeOfOldestMessage'));
    return { Attributes: { ApproximateNumberOfMessages: '2', ApproximateNumberOfMessagesNotVisible: '1', ApproximateNumberOfMessagesDelayed: '0' } };
  });
  let metricCommand;
  setRuntimeDlqClientsForTests({
    sqs: sqs.client,
    cloudwatch: {
      async send(command) {
        metricCommand = command;
        return {
          MetricDataResults: queueNames.map((name, index) => ({
            Id: `age${index}`,
            Timestamps: [new Date('2026-11-03T19:55:00Z')],
            Values: [index + 3],
          })),
        };
      },
    },
  });

  try {
    const result = await getRuntimeQueueStatus();
    assert.ok(metricCommand instanceof GetMetricDataCommand);
    assert.equal(metricCommand.input.MetricDataQueries.length, 4);
    assert.ok(metricCommand.input.MetricDataQueries.every(({ MetricStat }) => (
      MetricStat.Metric.Namespace === 'AWS/SQS'
      && MetricStat.Metric.MetricName === 'ApproximateAgeOfOldestMessage'
      && MetricStat.Metric.Dimensions.some(({ Name, Value }) => Name === 'QueueName' && queueNames.includes(Value))
    )));
    assert.equal(sqs.commands.length, 4);
    assert.equal(result.queues[0].visible, 2);
    assert.equal(result.queues[0].inFlight, 1);
    assert.equal(result.queues[0].oldestMessageAgeSeconds, 3);
    assert.equal(result.queues[0].oldestMessageAgeAt, '2026-11-03T19:55:00.000Z');
    assert.equal(result.queues[0].oldestMessageAgeStatus, 'available');
  } finally {
    resetRuntimeDlqClientsForTests();
  }
});

test('missing CloudWatch samples preserve SQS counts and report age unavailable', async () => {
  const sqs = mockSqs(() => ({ Attributes: { ApproximateNumberOfMessages: '0' } }));
  setRuntimeDlqClientsForTests({
    sqs: sqs.client,
    cloudwatch: { async send() { return { MetricDataResults: [] }; } },
  });

  try {
    const result = await getRuntimeQueueStatus();
    assert.equal(result.queues[0].ok, true);
    assert.equal(result.queues[0].visible, 0);
    assert.equal(result.queues[0].oldestMessageAgeSeconds, null);
    assert.equal(result.queues[0].oldestMessageAgeAt, null);
    assert.equal(result.queues[0].oldestMessageAgeStatus, 'no_datapoint');
  } finally {
    resetRuntimeDlqClientsForTests();
  }
});

test('CloudWatch errors do not discard queue counts', async () => {
  const sqs = mockSqs(() => ({ Attributes: { ApproximateNumberOfMessages: '4' } }));
  setRuntimeDlqClientsForTests({
    sqs: sqs.client,
    cloudwatch: { async send() { throw Object.assign(new Error('metric read denied'), { name: 'AccessDeniedException' }); } },
  });

  try {
    const result = await getRuntimeQueueStatus();
    assert.equal(result.queues[0].ok, true);
    assert.equal(result.queues[0].visible, 4);
    assert.equal(result.queues[0].oldestMessageAgeSeconds, null);
    assert.equal(result.queues[0].oldestMessageAgeStatus, 'unavailable');
    assert.equal(result.queues[0].oldestMessageAgeError, 'AccessDeniedException');
  } finally {
    resetRuntimeDlqClientsForTests();
  }
});
