from pathlib import Path
import re

path = Path('lambdas/sqs2scouts/function/tests/test-persistence-handler.mjs')
text = path.read_text()
old = """    publishCanonicalEventToAgenda: async ({ loadAgenda, writeAgenda, occurrenceId, visibility, hex, event }) => {
      const agenda = await loadAgenda();
      agenda.events = agenda.events.map((entry) => entry.metadata.hex === hex
        && (!occurrenceId || entry.occurrenceId === occurrenceId)
        ? { ...entry, metadata: { ...entry.metadata, status: { ...entry.metadata.status, isHidden: visibility === true } } }
        : entry);
      await writeAgenda(agenda);
      return { matched: 1 };
    },"""
new = """    publishCanonicalEventToAgenda: async ({ loadAgenda, writeAgenda, hex, event }) => {
      const agenda = await loadAgenda();
      let matched = 0;
      agenda.events = agenda.events.map((entry) => {
        if (entry.metadata.hex !== hex) return entry;
        matched += 1;
        return { ...entry, metadata: clone(event.metadata) };
      });
      await writeAgenda(agenda);
      return { matched };
    },"""
if text.count(old) != 1:
    raise SystemExit(f'expected one persistence publisher fixture, found {text.count(old)}')
text = text.replace(old, new, 1)
text, n = re.subn(
    r"\ntest\('real persistence handler rejects an occurrence read-back mismatch and records attention'.*\Z",
    "\n",
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit('expected obsolete occurrence read-back test')
path.write_text(text)
