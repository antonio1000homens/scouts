import { processRevisionedApprovalRecords } from './approval-lifecycle-adapter.mjs';
import { lambdaHandler as imageProviderWorkerHandler } from './image-provider-worker.mjs';
import { normalizeLegacyApprovalCards } from './legacy-approval-card-normalizer.mjs';

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return imageProviderWorkerHandler(event);

  const delegated = await processRevisionedApprovalRecords(records);
  if (delegated.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Revisioned approval persistence processed' }),
    };
  }

  const result = await imageProviderWorkerHandler({ ...event, Records: delegated });
  await normalizeLegacyApprovalCards(delegated);
  return result;
}
