import { lambdaHandler } from './scouts.mjs';

// Trigger a reset to force fresh ICS data fetch
const resetEvent = {
  requestContext: { http: { method: 'POST' } },
  body: JSON.stringify({
    realm: 'scouts',
    subject: 'agenda', 
    action: 'reset'
  }),
  headers: {}
};

console.log('Triggering reset to fetch fresh ICS data...');

try {
  const result = await lambdaHandler(resetEvent);
  console.log('Reset completed with status:', result.statusCode);
  
  if (result.statusCode === 200) {
    const body = JSON.parse(result.body);
    console.log('Events count after reset:', body.eventsCount);
    console.log('Reset details:', body.resetDetails);
  } else {
    console.error('Reset failed:', result.body);
  }
} catch (error) {
  console.error('Error during reset:', error.message);
}