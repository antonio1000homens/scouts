import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBenchmark } from '../scripts/scouts-deferred-refresh-capacity-benchmark.mjs';

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
