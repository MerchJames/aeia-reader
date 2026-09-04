/**
 * Run: npx tsx src/utils/smartExport.test.ts
 *
 * What goes into an export, and what a filtered export must never do.
 *
 * Every export in this app used to take the whole story, so "just the
 * character's lines" meant exporting everything and editing it afterwards.
 * A selection is the fix, and it is only safe to offer because of one property:
 *
 * **A selection never touches the story.** It is a filter applied on the way
 * out. Dropping your turns from a file does not drop them from the library, and
 * nothing here returns a mutated message — the originals come back untouched
 * and the copies are new objects.
 *
 * The other property is about not producing rubbish: a passage whose only
 * content was an OOC aside must be DROPPED, not exported as a speaker name with
 * nothing under it. A blank entry in a file reads as a broken exporter rather
 * than as the reader's own choice.
 */
import type { Message, Story } from '../types';
import {
  DEFAULT_SELECTION, applySelection, chaptersOf, coverSubtitle,
  describeSelection, selectChapters, selectMessages, stripOoc,
  type ExportSelection,
} from './smartExport';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const msg = (over: Partial<Message> & { id: string }): Message => ({
  role: 'ai', name: 'Mara', content: 'She set the lamp down.', ...over,
});

const sel = (over: Partial<ExportSelection> = {}): ExportSelection =>
  ({ ...DEFAULT_SELECTION, ...over });

const cast: Message[] = [
  msg({ id: 'm1', content: 'She set the lamp down.' }),
  msg({ id: 'm2', role: 'user', name: 'You', content: 'I said nothing.' }),
  msg({ id: 'm3', content: 'The lamp guttered once and held.' }),
  msg({ id: 'm4', role: 'user', name: 'You', content: 'I watched the door.' }),
];

/* ── Whose turns ─────────────────────────────────────────────────────────── */
{
  eq(selectMessages(cast, sel()).length, 4, 'by default everyone is in');
  eq(selectMessages(cast, sel({ speakers: 'ai' })).map(m => m.id).join(), 'm1,m3',
    'the character only — the case this was built for');
  eq(selectMessages(cast, sel({ speakers: 'user' })).map(m => m.id).join(), 'm2,m4',
    'or your own turns only');
  ok(selectMessages(cast, sel({ speakers: 'ai' })).every(m => m.role === 'ai'),
    'and nothing else slips through');
}

/* ── A selection never touches the story ─────────────────────────────────── */
{
  const before = JSON.stringify(cast);
  const out = selectMessages(cast, sel({ speakers: 'ai', includeOoc: false }));
  eq(JSON.stringify(cast), before, 'the story is unchanged by exporting a slice of it');
  ok(out.every(m => !cast.includes(m)), 'every exported message is a copy, not the original');
}

/* ── Hidden entries ──────────────────────────────────────────────────────── */
{
  const withHidden = [...cast, msg({ id: 'm5', content: 'A system note.', hidden: true })];
  eq(selectMessages(withHidden, sel()).map(m => m.id).includes('m5'), false,
    'hidden entries stay out by default, as they do on the page');
  eq(selectMessages(withHidden, sel({ includeHidden: true })).map(m => m.id).includes('m5'), true,
    'and come in when asked for');
}

/* ── Out-of-character asides ─────────────────────────────────────────────── */
{
  eq(stripOoc('Before. [OOC: are you still there?] After.'), 'Before. After.', 'the bracket form');
  eq(stripOoc('Before. ((OOC: brb)) After.'), 'Before. After.', 'the double-paren form');
  eq(stripOoc('Before. (OOC: one sec) After.'), 'Before. After.', 'and the single-paren form');
  eq(stripOoc('She said (quietly) nothing.'), 'She said (quietly) nothing.',
    'an ordinary parenthesis is not an aside');
  eq(stripOoc('A [bracketed] beat.'), 'A [bracketed] beat.', 'nor is an ordinary bracket');

  const chatty = [
    msg({ id: 'a', content: 'Prose. [OOC: sorry, phone] More prose.' }),
    // The case that matters: nothing here BUT the aside.
    msg({ id: 'b', content: '((OOC: back in five))' }),
    msg({ id: 'c', content: 'Still here.' }),
  ];
  const kept = selectMessages(chatty, sel({ includeOoc: false }));
  eq(kept.map(m => m.id).join(), 'a,c',
    'a passage that was only an aside is dropped, not exported blank');
  eq(kept[0].content, 'Prose. More prose.', 'and the rest keeps its prose');

  eq(selectMessages(chatty, sel()).length, 3, 'with asides on, nothing is dropped');
}

/* ── An image-only passage survives an emptied body ──────────────────────── */
{
  const withArt = [msg({ id: 'i', content: '[OOC: here]', images: ['data:image/png;base64,x'] })];
  eq(selectMessages(withArt, sel({ includeOoc: false })).length, 1,
    'a passage with a picture is still a passage once its text is gone');
}

/* ── Thinking ────────────────────────────────────────────────────────────── */
{
  const thought = [msg({ id: 't', content: 'The prose.', reasoning: 'the working' })];
  eq(selectMessages(thought, sel())[0].reasoning, undefined,
    'a chain of thought stays out of an export by default');
  eq(selectMessages(thought, sel({ includeReasoning: true }))[0].reasoning, 'the working',
    'and comes with when asked for');
}

/* ── Chapters ────────────────────────────────────────────────────────────── */
{
  const story = { messages: cast, format: 'sillytavern' as const };
  const chapters = chaptersOf(story);
  // A user turn opens a chapter, which is how `buildChains` reads a chat.
  eq(chapters.length, 3, 'a chat breaks into chapters at the reader’s turns');
  eq(chapters[0].from, 0, 'the first starts at the beginning');
  eq(chapters[1].count, 2, 'and a chapter carries the replies that follow it');
  eq(chapters.map(c => c.index).join(), '0,1,2', 'numbered in order for the picker');

  eq(selectChapters(cast, chapters, null).length, 4, 'no choice means all of it');
  eq(selectChapters(cast, chapters, [1]).map(m => m.id).join(), 'm2,m3',
    'one chapter brings its own messages and no others');
  eq(selectChapters(cast, chapters, [0, 2]).map(m => m.id).join(), 'm1,m4',
    'and a non-contiguous pick keeps reading order');

  const doc = {
    format: 'document' as const,
    messages: [
      msg({ id: 'd1', role: 'ai', name: '', content: '# One\n\nText.', startsChain: true }),
      msg({ id: 'd2', role: 'ai', name: '', content: 'More.' }),
      msg({ id: 'd3', role: 'ai', name: '', content: '# Two\n\nText.', startsChain: true }),
    ],
  };
  const docChapters = chaptersOf(doc);
  eq(docChapters.length, 2, 'a document breaks at its headings');
  eq(docChapters[0].title, 'One', 'and takes its name from the heading');
  eq(docChapters[1].title, 'Two', 'for each of them');
}

/* ── The two applied together, in the right order ────────────────────────── */
{
  const story = { messages: cast, format: 'sillytavern' as const };
  // Chapters first, then the message filters — the other order would filter the
  // messages the chapter boundaries are computed from and shift every boundary.
  const out = applySelection(story, sel({ chapters: [1], speakers: 'ai' }));
  eq(out.map(m => m.id).join(), 'm3', 'chapter 2, character only');
  eq(applySelection(story, sel()).length, 4, 'and the default is the whole story');
}

/* ── The line the reader reads before committing ─────────────────────────── */
{
  const kept = selectMessages(cast, sel({ speakers: 'ai' }));
  const line = describeSelection(cast.length, kept, sel({ speakers: 'ai' }));
  ok(line.includes('2 of 4'), 'it says how much of the story is going');
  ok(line.includes('character only'), 'and why');
  ok(/~\d/.test(line), 'and roughly how many words');

  const everything = describeSelection(4, cast, sel());
  ok(everything.includes('4 of 4'), 'a full export says so plainly');
  ok(!everything.includes('only'), 'with no filters named that are not on');
}

/* ── The cover is the export's own, not a second one ─────────────────────── */
{
  // `htmlExport` already draws a full-page title card with the Aeia mark and a
  // print page-break. A rival here would be two covers to keep in step. All
  // this module owns is the one line the reader could not previously say.
  eq(coverSubtitle('  a chat, read as a book  '), 'a chat, read as a book', 'trimmed');
  eq(coverSubtitle('two   spaces'), 'two spaces', 'and its whitespace collapsed');
  eq(coverSubtitle('   '), undefined, 'nothing is not a subtitle');
  eq(coverSubtitle(''), undefined, 'and neither is empty');
  eq(coverSubtitle('x'.repeat(400))?.length, 120,
    'a long one is cut, so it cannot push the title off a printed page');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
