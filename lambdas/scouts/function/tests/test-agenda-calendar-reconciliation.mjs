import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = path.resolve(import.meta.dirname, '../agenda-hex-repair.mjs');

async function loadModule() {
  const context = vm.createContext({ Buffer, console, process, Date });
  const module = new vm.SourceTextModule(readFileSync(sourcePath, 'utf8'), {
    context,
    identifier: sourcePath,
  });

  await module.link(async (specifier) => {
    if (specifier !== '@aws-sdk/client-s3') {
      throw new Error(`Unhandled import ${specifier}`);
    }

    class S3Client {
      async send() { return {}; }
    }
    class Command {
      constructor(input) { this.input = input; }
    }

    return new vm.SyntheticModule(
      ['GetObjectCommand', 'PutObjectCommand', 'S3Client'],
      function initialize() {
        this.setExport('GetObjectCommand', Command);
        this.setExport('PutObjectCommand', Command);
        this.setExport('S3Client', S3Client);
      },
      { context, identifier: specifier },
    );
  });

  await module.evaluate();
  return module.namespace;
}

const api = await loadModule();
const NOW = Date.UTC(2026, 8, 17, 16, 0, 0);

function agendaEvent({ uid, summary, dtstart, lastModified, hex = null }) {
  return {
    uid,
    occurrenceId: 'occ_same',
    summary,
    dtstart,
    lastModified: { raw: lastModified },
    metadata: {
      hex: hex ?? api.titleToHex(summary),
      tagline: summary === 'Community Impact' ? 'old tagline' : 'current tagline',
      image: { theme: 'theme', url: 'image.jpg' },
      status: { isHidden: false, isApproved: true },
    },
  };
}

test('calendar parser sanitizes OSM UIDs while preserving the source title', () => {
  const events = api.parseCalendarFeedEvents([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:osm-scouts-programme-9959785-Europe/London',
    'DTSTART;TZID=Europe/London:20270310T183000',
    'SUMMARY:Community Impact: Litter Picking',
    'DTSTAMP:20260917T010405Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{
    uid: 'osm-scouts-programme-9959785',
    summary: 'Community Impact: Litter Picking',
    dtstart: '20270310T183000',
    lastModified: '20260917T010405Z',
  }]);
});

test('renamed programme event keeps the current source candidate and removes its stale duplicate', () => {
  const uid = 'osm-scouts-programme-9959785';
  const currentSummary = 'Community Impact: Litter Picking: Tolworth Broadway and Round About';
  const agenda = {
    events: [
      agendaEvent({
        uid,
        summary: currentSummary,
        dtstart: '20270310T183000',
        lastModified: '20260917T010405Z',
      }),
      agendaEvent({
        uid,
        summary: 'Community Impact',
        dtstart: '20270310T183000',
        lastModified: '20260912T233431Z',
      }),
    ],
  };

  const result = api.reconcileAgendaDocument(agenda, [{
    uid,
    summary: currentSummary,
    dtstart: '20270310T183000',
    lastModified: '20260917T010405Z',
  }], { authoritative: true, now: NOW });

  assert.equal(result.agenda.events.length, 1);
  assert.equal(result.agenda.events[0].summary, currentSummary);
  assert.equal(result.deduplicatedCount, 1);
  assert.equal(result.renamedCount, 0);
});

test('source rename without an already-current candidate resets title-keyed enrichment', () => {
  const uid = 'osm-scouts-programme-9959785';
  const currentSummary = 'Community Impact: Litter Picking: Tolworth Broadway and Round About';
  const agenda = {
    events: [agendaEvent({
      uid,
      summary: 'Community Impact',
      dtstart: '20270310T183000',
      lastModified: '20260912T233431Z',
    })],
  };

  const result = api.reconcileAgendaDocument(agenda, [{
    uid,
    summary: currentSummary,
    dtstart: '20270310T183000',
    lastModified: '20260917T010405Z',
  }], { authoritative: true, now: NOW });

  const event = result.agenda.events[0];
  assert.equal(event.summary, currentSummary);
  assert.equal(event.metadata.hex, api.titleToHex(currentSummary));
  assert.equal(event.metadata.tagline, null);
  assert.equal(event.metadata.image.url, null);
  assert.equal(event.metadata.status.isApproved, false);
  assert.equal(result.renamedCount, 1);
});

test('authoritative calendar snapshot prunes a future agenda event removed from the source', () => {
  const agenda = {
    events: [agendaEvent({
      uid: 'osm-scouts-programme-9630620',
      summary: 'Surbiton Festival',
      dtstart: '20260926T113000',
      lastModified: '20260322T074128Z',
    })],
  };

  const result = api.reconcileAgendaDocument(agenda, [{
    uid: 'osm-scouts-myscout-event-1777118',
    summary: 'Surbiton Festival Parade',
    dtstart: '20260926T114000',
    lastModified: '20260917T010404Z',
  }], { authoritative: true, now: NOW });

  assert.equal(result.agenda.events.length, 0);
  assert.equal(result.prunedCount, 1);
});

test('non-authoritative refresh retains unmatched future agenda events', () => {
  const agenda = {
    events: [agendaEvent({
      uid: 'osm-scouts-programme-9630620',
      summary: 'Surbiton Festival',
      dtstart: '20260926T113000',
      lastModified: '20260322T074128Z',
    })],
  };

  const result = api.reconcileAgendaDocument(agenda, [], {
    authoritative: false,
    now: NOW,
  });

  assert.equal(result.agenda.events.length, 1);
  assert.equal(result.prunedCount, 0);
});
