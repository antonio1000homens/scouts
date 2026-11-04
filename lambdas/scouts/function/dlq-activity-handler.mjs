import { recordWorkerDeliveryExhausted } from '/opt/nodejs/request-activity.mjs';
import { activityInputFromDlqRecord } from './dlq-activity.mjs';

export async function lambdaHandler(event = {}) {
  const failures = [];
  for (const record of Array.isArray(event.Records) ? event.Records : []) {
    const messageId = record?.messageId || record?.messageID;
    if (!messageId) {
      console.error('[DlqActivity] SQS record is missing messageId; failing the invocation for retry');
      throw new Error('Processing DLQ record is missing messageId');
    }
    const activity = activityInputFromDlqRecord(record);
    if (!activity) {
      console.error('[DlqActivity] Unable to construct terminal activity; returning record for retry', messageId);
      failures.push({ itemIdentifier: messageId });
      continue;
    }
    try {
      const result = await recordWorkerDeliveryExhausted(activity);
      if (!result) throw new Error('Activity ledger did not confirm persistence');
      if (result.recorded === false) {
        console.log('[DlqActivity] Existing terminal activity supersedes worker delivery failure', activity.requestId);
      } else {
        console.log('[DlqActivity] Recorded terminal worker delivery failure', JSON.stringify({ requestId: activity.requestId, hex: activity.hex }));
      }
    } catch (error) {
      console.error('[DlqActivity] Failed to record terminal activity', error?.message || error);
      failures.push({ itemIdentifier: messageId });
    }
  }
  return { batchItemFailures: failures };
}
