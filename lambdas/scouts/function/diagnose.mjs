// Quick diagnostic: Check what's in the current agenda vs what should be there
import { readFileSync } from 'fs';

console.log('=== AGENDA.JSON ANALYSIS ===\n');

// Read current agenda
const agendaPath = '../../../scouts/agenda.json';
const agenda = JSON.parse(readFileSync(agendaPath, 'utf8'));

console.log(`Current agenda has ${agenda.events?.length || 0} events:`);
agenda.events?.forEach((e, i) => {
  console.log(`  ${i+1}. ${e.summary} (${e.dtstart})`);
});

console.log('\n=== ICS FILE ANALYSIS ===\n');

// Read test ICS file to see what SHOULD be there
const icsPath = './tests/cubs-programme.ics';
const icsContent = readFileSync(icsPath, 'utf8');

// Count VEVENT blocks
const eventCount = (icsContent.match(/BEGIN:VEVENT/g) || []).length;
console.log(`Cubs Programme ICS has ${eventCount} events`);

// Extract first few summaries
const summaries = [];
const summaryMatches = icsContent.matchAll(/SUMMARY:([^\r\n]+)/g);
for (const match of summaryMatches) {
  summaries.push(match[1]);
  if (summaries.length >= 5) break;
}

console.log('\nFirst 5 events in ICS:');
summaries.forEach((s, i) => console.log(`  ${i+1}. ${s}`));

console.log('\n=== DIAGNOSIS ===');
console.log('The agenda.json contains TEST DATA, not real ICS events.');
console.log('The scouts.mjs Lambda function needs to run to fetch and parse ICS files.');
console.log('\nTo fix: Invoke the Lambda function (via API Gateway or AWS Console) to refresh agenda.json');
