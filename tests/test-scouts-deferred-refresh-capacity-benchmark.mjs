import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessBenchmark,
  cleanupBenchmarkTable,
} from '../scripts/scouts-deferred-refresh-capacity-benchmark.mjs';

function completedReport(overrides = {}) {
  return {
    benchmark: { syntheticItems: 100 },
    enqueue: { succeeded: 100 },
    dispatch: { dispatched: 100, remainingReady: 0, remainingLeased: 0 },
    throttles: { total: 0 },
    ...overrides,
  };
}

test('capacity assessment passes only after all synthetic work drains without throttling', () => {
  assert.deepEqual(assessBenchmark(completedReport()), { status: 'pass', blockers: [] });
});

test('capacity assessment fails a fully drained run that encountered throttling', () => {
  const report = completedReport({ throttles: { total: 1 } });
  assert.deepEqual(assessBenchmark(report), {
    status: 'fail',
    blockers: ['throttled_operations'],
  });
});

test('capacity assessment fails incomplete enqueues, dispatches, and remaining backlog', () => {
  const report = completedReport({
    enqueue: { succeeded: 99 },
    dispatch: { dispatched: 98, remainingReady: 1, remainingLeased: 1 },
  });
  assert.deepEqual(assessBenchmark(report), {
    status: 'fail',
    blockers: [
      'enqueue_incomplete',
      'dispatch_incomplete',
      'ready_backlog_remaining',
      'leased_backlog_remaining',
    ],
  });
});

test('capacity assessment fails when backlog could not be measured', () => {
  const report = completedReport({
    dispatch: { dispatched: 0, remainingReady: null, remainingLeased: null },
  });
  assert.deepEqual(assessBenchmark(report), {
    status: 'fail',
    blockers: [
      'dispatch_incomplete',
      'ready_backlog_unmeasured',
      'leased_backlog_unmeasured',
    ],
  });
});

test('cleanup deletes only a table tagged for the current benchmark run', async () => {
  const calls = [];
  const result = await cleanupBenchmarkTable(async (args) => {
    calls.push(args);
    if (args[1] === 'describe-table') return { Table: { TableArn: 'arn:aws:dynamodb:eu-west-2:553490163883:table/benchmark', TableStatus: 'ACTIVE' } };
    if (args[1] === 'list-tags-of-resource') return {
      Tags: [
        { Key: 'RunId', Value: 'run-123' },
        { Key: 'Purpose', Value: 'issue-174-capacity-benchmark' },
      ],
    };
    return {};
  }, 'benchmark', 'run-123');

  assert.deepEqual(result, { deleted: true, absent: false });
  assert.deepEqual(calls.map((args) => args[1]), [
    'describe-table',
    'list-tags-of-resource',
    'wait',
    'delete-table',
    'wait',
  ]);
});

test('cleanup refuses a benchmark table with a different run tag', async () => {
  const calls = [];
  const result = await cleanupBenchmarkTable(async (args) => {
    calls.push(args);
    if (args[1] === 'describe-table') return { Table: { TableArn: 'arn:aws:dynamodb:eu-west-2:553490163883:table/benchmark' } };
    return { Tags: [{ Key: 'RunId', Value: 'another-run' }, { Key: 'Purpose', Value: 'issue-174-capacity-benchmark' }] };
  }, 'benchmark', 'run-123');

  assert.deepEqual(result, { deleted: false, error: 'BenchmarkTableOwnershipMismatch' });
  assert.equal(calls.some((args) => args[1] === 'delete-table'), false);
});

test('cleanup reports uncertainty when a table remains invisible after a create attempt', async () => {
  const result = await cleanupBenchmarkTable(async () => {
    const error = new Error('ResourceNotFoundException');
    error.stderr = 'ResourceNotFoundException: requested resource not found';
    throw error;
  }, 'benchmark', 'run-123', { sleep: async () => {} });

  assert.deepEqual(result, { deleted: false, error: 'BenchmarkTableNotVisibleAfterCreateAttempt' });
});
