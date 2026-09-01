/**
 * Run: npx tsx src/utils/stSync.test.ts
 *
 * Syncing with a real SillyTavern chat file.
 *
 * This is the only feature in the app that writes a file somebody else's
 * program owns, and the failure it must never have is not "the merge was
 * wrong" — it is "the file came back subtly poorer than it went in". Our
 * importer keeps six fields per message and discards `send_date`, `swipe_id`,
 * `swipe_info`, `gen_started`, the rest of `extra`, `force_avatar` and most of
 * the header. A merge that rebuilt the file from our `Story` would produce
 * something that loads perfectly in ST and has quietly lost its history, and
 * the reader would find out weeks later.
 *
 * So the load-bearing property here is not about merging at all:
 *
 *   **every line we did not edit comes back byte for byte.**
 *
 * The header, an unparseable line, a message with fields we have never heard
 * of, the exact JSON escaping ST happened to emit. Asserted directly, because
 * a JSON.parse/stringify round trip looks harmless and is not.
 *
 * Under that sit the three-way comparisons. We hold the version we imported and
 * the version the reader reads; the file holds ST's. That is enough to tell
 * "they re-swiped it" from "I rewrote it" from "my last push already landed"
 * with no sync state stored anywhere — and getting `pushed` wrong in particular
 * would make every previously-synced message a conflict on the next run.
 */
import {
  type OurMessage, type SyncRow,
  alignSync, looksLikeSameChat, mergeToFile, messageLines, parseStFile, patchLine, summarize,
} from './stSync';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* A file shaped like one ST actually writes, oddities included. */
const HEADER = '{"user_name":"You","character_name":"Mara","create_date":"2026-08-14@10h02m","chat_metadata":{"note":"keep"}}';
const line = (mes: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Mara', is_user: false, is_system: false, send_date: '2026-08-14@10h03m',
    mes, swipe_id: 0, swipes: [mes], extra: { api: 'koboldcpp', model: 'l3-8b', token_count: 42 },
    ...extra,
  });

const FILE = [
  HEADER,
  line('She reached Kelfor before dark.'),
  JSON.stringify({ name: 'You', is_user: true, mes: 'I take a room.', send_date: 'x' }),
  line('The innkeeper did not look up.'),
  'this line is not json at all',
  line('Rain started somewhere over the roof.'),
].join('\n');

const ours = (mes: string, current?: string, id = mes.slice(0, 6)): OurMessage =>
  ({ id, original: mes, current: current ?? mes, name: 'Mara' });

const OURS: OurMessage[] = [
  ours('She reached Kelfor before dark.'),
  ours('I take a room.'),
  ours('The innkeeper did not look up.'),
  ours('Rain started somewhere over the roof.'),
];

/* ------------------------------------------------------------------ */
/* Reading it without losing it                                        */
/* ------------------------------------------------------------------ */

{
  const lines = parseStFile(FILE);
  eq(lines.length, 6, 'every non-empty line is kept');
  ok(lines[0].isHeader, 'the first line is recognised as the header, not a message');
  eq(lines[0].mes, '', 'and carries no message text');
  eq(lines[4].obj, null, 'a line that is not JSON is kept with obj null');
  eq(lines[4].raw, 'this line is not json at all',
    'and its text is held exactly — it is somebody\'s data even if we cannot read it');
  eq(messageLines(lines).length, 4, 'the message lines are the ones an alignment can pair');

  // Must mirror parser.ts exactly, or every index after an empty entry is off
  // by one and the whole alignment walks a message behind.
  const withBlank = parseStFile([HEADER, line(''), line('real')].join('\n'));
  eq(messageLines(withBlank).length, 1, 'an empty message is not a message, exactly as on import');
  const withImage = parseStFile([HEADER,
    JSON.stringify({ name: 'Mara', mes: '', extra: { image: 'data:image/png;base64,AA' } })].join('\n'));
  eq(messageLines(withImage).length, 1, 'but an image-only message is one, also exactly as on import');
}

/* ------------------------------------------------------------------ */
/* The property everything else rests on                               */
/* ------------------------------------------------------------------ */

{
  const lines = parseStFile(FILE);
  const rows = alignSync(OURS, lines);
  const merged = mergeToFile(lines, rows);
  eq(merged.patched, 0, 'with nothing edited, nothing is rewritten');
  eq(merged.text, `${FILE}\n`,
    'AND THE FILE COMES BACK BYTE FOR BYTE — the whole basis for pointing this at a real chat');
}

{
  // One edit. Everything else must still be untouched, including the header,
  // the junk line, and the fields we have never heard of on the edited message.
  const edited = [...OURS];
  edited[2] = ours('The innkeeper did not look up.', 'The innkeeper never looked up.');
  const lines = parseStFile(FILE);
  const merged = mergeToFile(lines, alignSync(edited, lines));
  eq(merged.patched, 1, 'exactly one line is rewritten');

  const before = FILE.split('\n');
  const after = merged.text.trimEnd().split('\n');
  eq(after.length, before.length, 'no lines gained or lost');
  for (const i of [0, 1, 2, 4, 5]) {
    eq(after[i], before[i], `line ${i} is untouched, character for character`);
  }

  const patched = JSON.parse(after[3]);
  eq(patched.mes, 'The innkeeper never looked up.', 'the edit landed');
  eq(patched.send_date, '2026-08-14@10h03m', 'send_date survived');
  eq(patched.swipe_id, 0, 'swipe_id survived');
  eq(patched.extra.token_count, 42, 'and everything under extra survived');
  eq(Object.keys(patched).join(','), Object.keys(JSON.parse(before[3])).join(','),
    'in the order ST wrote them');
}

/* ------------------------------------------------------------------ */
/* Three-way status                                                    */
/* ------------------------------------------------------------------ */

{
  const lines = parseStFile(FILE);
  const status = (o: OurMessage[]) => alignSync(o, lines).map(r => r.status);

  eq(status(OURS).join(','), 'same,same,same,same', 'untouched on both sides');

  const mine = [...OURS];
  mine[0] = ours('She reached Kelfor before dark.', 'She reached Kelfor at dusk.');
  eq(status(mine)[0], 'ours', 'a Lens edit ST has not seen goes out');

  // ST re-swiped message 3. We have not touched it.
  const theirFile = parseStFile(FILE.replace('Rain started somewhere over the roof.', 'Rain came on hard.'));
  eq(alignSync(OURS, theirFile).map(r => r.status)[3], 'theirs',
    'a message ST changed comes in');

  // Both sides changed the same message, differently.
  const both = [...OURS];
  both[3] = ours('Rain started somewhere over the roof.', 'Rain began over the roof.');
  eq(alignSync(both, theirFile).map(r => r.status)[3], 'conflict',
    'and when both changed it, the reader decides');

  // The one that would poison every subsequent run: ST already has our edit
  // because we pushed last time. That is agreement, not a conflict.
  const pushedFile = parseStFile(FILE.replace('Rain started somewhere over the roof.', 'Rain began over the roof.'));
  eq(alignSync(both, pushedFile).map(r => r.status)[3], 'pushed',
    'an edit ST already has is recognised, not re-offered as a conflict');
}

/* ------------------------------------------------------------------ */
/* The story moved on in ST                                            */
/* ------------------------------------------------------------------ */

{
  const grown = parseStFile([FILE, line('She slept badly.'), line('Morning came grey.')].join('\n'));
  const rows = alignSync(OURS, grown);
  const s = summarize(rows);
  eq(s.addedThere, 2, 'messages ST gained since the import are found');
  eq(s.same, 4, 'and the ones we already had are still matched');
  eq(rows[4].theirs?.mes, 'She slept badly.', 'in order');

  // A rewind: ST no longer has the last two.
  const shortened = parseStFile([HEADER, line('She reached Kelfor before dark.')].join('\n'));
  const back = summarize(alignSync(OURS, shortened));
  eq(back.missingThere, 3, 'and a rewind is reported rather than silently re-added');
}

{
  // An insertion in the MIDDLE — the case a naive positional walk turns into a
  // file full of spurious conflicts from that point on.
  const spliced = parseStFile([
    HEADER,
    line('She reached Kelfor before dark.'),
    JSON.stringify({ name: 'You', is_user: true, mes: 'I take a room.', send_date: 'x' }),
    line('SOMETHING ST ADDED IN THE MIDDLE'),
    line('The innkeeper did not look up.'),
    'this line is not json at all',
    line('Rain started somewhere over the roof.'),
  ].join('\n'));
  const rows = alignSync(OURS, spliced);
  const s = summarize(rows);
  eq(s.addedThere, 1, 'the inserted message is the only thing reported as new');
  eq(s.conflict, 0, 'nothing after it is mistaken for a conflict');
  eq(s.same, 4, 'and the alignment picks itself back up');
}

{
  // A deletion in the middle, the mirror of the above.
  const cut = parseStFile([
    HEADER,
    line('She reached Kelfor before dark.'),
    line('The innkeeper did not look up.'),
    line('Rain started somewhere over the roof.'),
  ].join('\n'));
  const s = summarize(alignSync(OURS, cut));
  eq(s.missingThere, 1, 'one message is missing from ST');
  eq(s.same, 3, 'and the rest still line up');
  eq(s.conflict, 0, 'with nothing mistaken for an edit');
}

/* ------------------------------------------------------------------ */
/* Conflicts are the reader's, and a merge waits for them              */
/* ------------------------------------------------------------------ */

{
  const theirFile = parseStFile(FILE.replace('Rain started somewhere over the roof.', 'Rain came on hard.'));
  const both = [...OURS];
  both[3] = ours('Rain started somewhere over the roof.', 'Rain began over the roof.');
  const rows = alignSync(both, theirFile);

  const held = mergeToFile(theirFile, rows);
  eq(held.unresolved, 1, 'an undecided conflict is counted');
  eq(held.patched, 0, 'and nothing is written over while it stands');
  ok(held.text.includes('Rain came on hard.'), 'ST\'s version is left exactly as it was');

  const takeOurs: SyncRow[] = rows.map(r => (r.status === 'conflict' ? { ...r, resolution: 'ours' } : r));
  const mine = mergeToFile(theirFile, takeOurs);
  eq(mine.unresolved, 0, 'resolved, it stops blocking');
  eq(mine.patched, 1, 'and our version is written');
  ok(mine.text.includes('Rain began over the roof.'), 'into the file');

  const takeTheirs: SyncRow[] = rows.map(r => (r.status === 'conflict' ? { ...r, resolution: 'theirs' } : r));
  const yours = mergeToFile(theirFile, takeTheirs);
  eq(yours.patched, 0, 'keeping ST\'s version writes nothing out');
  eq(yours.incoming, 1, 'and is counted as something to pull in');
}

/* ------------------------------------------------------------------ */
/* The mistake with no undo                                            */
/* ------------------------------------------------------------------ */

{
  const rows = alignSync(OURS, parseStFile(FILE));
  ok(looksLikeSameChat(rows), 'the right file is recognised');

  const stranger = parseStFile([
    HEADER,
    line('A completely different story about a lighthouse.'),
    line('Nothing here has ever been in the other chat.'),
    line('Not one line of it.'),
  ].join('\n'));
  ok(!looksLikeSameChat(alignSync(OURS, stranger)),
    'and somebody else\'s chat is refused — syncing the wrong file is the one mistake with no undo');
  ok(!looksLikeSameChat(alignSync(OURS, parseStFile(HEADER))),
    'as is an empty one');
}

/*
 * Keeping a patched line self-consistent.
 *
 * ST stores the shown text TWICE — in `mes`, and in `swipes[swipe_id]`. It
 * loads from `mes` and re-reads from `swipes` the moment anyone swipes away
 * and back. So a patch that touches only `mes` looks perfect, and then the
 * reader presses the arrow twice and their edit is gone. Silent, delayed, and
 * indistinguishable from the sync never having run.
 *
 * It is also where the nicest thing this feature does lives: setting swipe_id
 * on a message that is not the last one in the chat is precisely the operation
 * SillyTavern refuses, and it is one assignment here.
 */
{
  const base = {
    name: 'Mara', is_user: false, mes: 'version B', send_date: 'd',
    swipes: ['version A', 'version B', 'version C'], swipe_id: 1,
    extra: { qvink_memory: 'keep me' },
  };

  // Choosing an existing alternate: swipe_id moves, nothing is destroyed.
  const chosen = patchLine(base, 'version C');
  eq(chosen.mes, 'version C', 'the chosen alternate becomes the shown text');
  eq(chosen.swipe_id, 2, 'and swipe_id follows it — the move ST will not make mid-chat');
  eq(JSON.stringify(chosen.swipes), JSON.stringify(base.swipes),
    'while every alternate survives untouched');

  // A Lens rewrite is not an alternate, so it must be written into the CURRENT
  // slot as well or ST serves the old text back on the next swipe.
  const rewritten = patchLine(base, 'something new');
  eq(rewritten.mes, 'something new', 'a rewrite shows');
  eq((rewritten.swipes as string[])[1], 'something new',
    'AND lands in swipes[swipe_id] — without this the edit vanishes on the next swipe');
  eq((rewritten.swipes as string[])[0], 'version A', 'the other alternates are left alone');
  eq((rewritten.swipes as string[])[2], 'version C', 'both of them');
  eq(rewritten.swipe_id, 1, 'and swipe_id does not move for a rewrite');
  eq((rewritten.extra as Record<string, unknown>).qvink_memory, 'keep me',
    'a third-party extension\'s data rides through');

  // Shapes that would throw if assumed.
  eq(patchLine({ mes: 'x' }, 'y').mes, 'y', 'a line with no swipes at all is fine');
  eq(JSON.stringify(patchLine({ mes: 'x', swipes: [] }, 'y').swipes), '[]',
    'and so is an empty swipes array');
  const oob = patchLine({ mes: 'x', swipes: ['a'], swipe_id: 7 }, 'y');
  eq((oob.swipes as string[])[0], 'y', 'an out-of-range swipe_id writes to the first slot rather than past the end');
  ok(!(base.swipes as string[]).includes('something new'),
    'and the original object is never mutated');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
