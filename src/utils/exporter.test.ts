/**
 * Run: npx tsx src/utils/exporter.test.ts
 *
 * The markdown export, and the one thing that is easy to get wrong about
 * putting a logo in it.
 *
 * Markdown is a format people read as plain text. The mark has to travel as a
 * data URI — an exported file may not fetch anything — but thirteen kilobytes
 * of base64 above the title makes the source unopenable in an editor, so the
 * payload goes in a reference definition at the FOOT of the file and the top
 * carries only the reference. That placement is the property worth pinning:
 * it renders identically either way, so nothing else would catch a regression.
 */
import type { Story } from '../types';
import { AEIA_MARK } from '../assets/aeiaMark';
import { exportStoryWithEdits, safeFilename, storyToMarkdown } from './exporter';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const story = {
  id: 's1', title: 'A Night at the Hearth', format: 'sillytavern',
  characterName: 'Mara', userName: 'You', messageCount: 2, importedAt: 1,
  messages: [
    { id: 'm1', name: 'Mara', role: 'ai', content: 'The hearth had burned down to embers.' },
    { id: 'm2', name: 'You', role: 'user', content: 'I said nothing at all.' },
  ],
  highlights: [{ id: 'h1', messageId: 'm1', text: 'burned down', color: 'yellow', timestamp: 1 }],
} as unknown as Story;

const AT = Date.parse('2026-08-16T12:00:00Z');
const md = storyToMarkdown(story, AT);
const lines = md.split('\n');

/* ---- the mark ---- */

ok(lines[0] === '![Aeia Reader][aeia-reader-mark]', 'the mark is the first line, by reference');
ok(md.includes(`[aeia-reader-mark]: ${AEIA_MARK}`), 'and its definition resolves');

// The payload must be at the END. This is the whole reason for the reference
// form; inlining it would pass every other assertion here.
const defAt = md.indexOf('[aeia-reader-mark]: data:');
ok(defAt > md.indexOf('I said nothing at all'),
  'the base64 sits below the story, not above it');
ok(lines.filter(l => l.trim()).pop() === `[aeia-reader-mark]: ${AEIA_MARK}`,
  'and it is the LAST line — everything a person reads comes first');

// One mark, not one per message.
ok(md.split('data:image').length === 2, 'the mark is embedded exactly once');
ok(!/https?:\/\//.test(md), 'and the file fetches nothing');

/* ---- front matter ---- */

ok(md.includes('# A Night at the Hearth'), 'the title is a heading');
ok(md.includes('**Character:** Mara · **User:** You'), 'the cast is named');
ok(/2 passages · 12 words · exported from Aeia Reader on /.test(md),
  'a stat line says what this is and where it came from');
ok(/2026/.test(md), 'and when');
ok(md.includes('### Mara') && md.includes('### You'), 'speakers head their passages');
ok(md.includes('> burned down'), 'highlights are collected at the end');

// Kobold has no per-message speaker, so it gets no speaker headings.
const kobold = storyToMarkdown({ ...story, format: 'kobold' } as Story, AT);
ok(!kobold.includes('### Mara'), 'a Kobold story is not given speaker headings');
ok(kobold.startsWith('![Aeia Reader]'), 'but still carries the mark');

// Default date: no argument means "now", and must not throw.
ok(storyToMarkdown(story).includes('exported from Aeia Reader on'),
  'the date defaults to today');

/* ---- the round-trip export is untouched by any of this ---- */

const jsonl = exportStoryWithEdits(story, undefined);
ok(!jsonl.includes('Aeia'), 'the re-importable export carries no branding at all');
ok(jsonl.split('\n').length === 3, 'and is still one header line plus one line per message');
ok(JSON.parse(jsonl.split('\n')[1]).mes === 'The hearth had burned down to embers.',
  'and still parses as SillyTavern JSONL');

ok(safeFilename('A Night at the Hearth') === 'A_Night_at_the_Hearth', 'filenames are made safe');
ok(safeFilename('///') === 'story', 'and never empty');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
