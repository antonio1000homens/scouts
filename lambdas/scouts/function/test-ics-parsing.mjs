import { readFileSync } from 'fs';
import { parseIcsEvents } from './scouts.mjs';

// Read the test ICS file
const icsContent = readFileSync('./tests/cubs-programme.ics', 'utf8');

// Parse the events
const events = parseIcsEvents(icsContent);

console.log(`Parsed ${events.length} events from ICS file:`);
events.forEach((event, index) => {
  console.log(`${index + 1}. ${event.title} - ${event.start?.raw}`);
});

// Show first few events in detail
console.log('\nFirst 3 events in detail:');
events.slice(0, 3).forEach((event, index) => {
  console.log(`\nEvent ${index + 1}:`);
  console.log(`  Title: ${event.title}`);
  console.log(`  UID: ${event.uid}`);
  console.log(`  Start: ${event.start?.raw} (${event.start?.iso})`);
  console.log(`  Location: ${event.location || 'Not specified'}`);
  console.log(`  Description: ${event.description || 'Not specified'}`);
});