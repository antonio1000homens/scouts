import { recordWorkerDeliveryExhausted } from '/opt/nodejs/request-activity.mjs';
import { activityInputFromDlqRecord } from './dlq-activity.mjs';

export async function lambdaHandler(event = {}) {
  const failures = [];
  for (const record of Array.isArray(event.Records) ? event.Records : []) {
    const activity = activityInputFromDlqRecord(record);
    if (!activity) {
      console.warn('[DlqActivity] Ignoring processing DLQ message without a requestId', record?.messageId || record?.messageID || 'unknown');
      continue;
    }
    try {
      await recordWorkerDeliveryExhausted(activity);
      console.log('[DlqActivity] Recorded terminal worker delivery failure', JSON.stringify({ requestId: activity.requestId, hex: activity.hex }));
    } catch (error) {
      console.error('[DlqActivity] Failed to record terminal activity', error?.message || error);
      failures.push({ itemIdentifier: record.messageId || record.messageID });
    }
  }
  return { batchItemFailures: failures };
}
