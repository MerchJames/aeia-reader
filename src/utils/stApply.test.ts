/**
 * Tests for the pull half of the SillyTavern sync.
 *
 * This module's job is almost entirely negative — it exists to NOT lose things
 * — so the tests are mostly about what survives rather than what changes. The
 * three that matter most:
 *
 * 1. A message ST no longer has is kept, with its id, so every highlight and
 *    note anchored to it survives a rewind in SillyTavern.
 * 2. A paired message keeps its id even when its every other field is replaced,
 *    for the same reason.
 * 3. Resolving a conflict as "theirs" reports the override to clear. Without
 *    that the Lens keeps showing the reader's own version and the button they
 *    pressed appears to do nothing — a bug that is invisible in the counts.
 *
 * Run: npx tsx src/utils/stApply.test.ts
 */

import type { Message } from '../types';
import { planPull, describePull } from './stApply';
import { alignSync, parseStFile, type OurMessage, type SyncRow } from './stSync';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const line = (mes: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'Vera', is_user: false, mes, ...extra });

const header = JSON.stringify({ character_name: 'Vera', user_name: 'You' });

const msg = (id: string, content: string, rest: Partial<Message> = {}): Message => ({
  id, role: 'ai', name: 'Vera', content, ...rest,
});

/** Ids that are stable across a run, so a failure prints something readable. */
const minter = () => { let n = 0; return () => `new-${n++}`; };

/** The `OurMessage` shape the aligner wants, from a real message. */
const ours = (m: Message, current = m.content): OurMessage =>
  ({ id: m.id, original: m.content, current, name: m.name });

/* ------------------------------------------------------------------ */
/* Nothing is deleted                                                  */
/* ------------------------------------------------------------------ */

{
  // ST rewound: it has the first message, we have three.
  const mine = [msg('a', 'One.'), msg('b', 'Two.'), msg('c', 'Three.')];
  const file = parseStFile([header, line('One.')].join('\n'));
  const rows = alignSync(mine.map(m => ours(m)), file);
  const plan = planPull(rows, mine, minter());

  eq(plan.messages.length, 3, 'a rewind in ST does not shorten the story here');
  eq(plan.messages.map(m => m.id), ['a', 'b', 'c'], 'and every id survives it');
  eq(plan.keptMissing, 2, 'the two ST dropped are reported as kept');
  eq(plan.added, 0, 'nothing was added');
  eq(plan.updated, 0, 'nothing was updated');
  ok(plan.empty, 'a pure rewind is an empty pull — there is nothing to bring in');
}

{
  // The counts are one thing; the reassurance is another. A reader looking at
  // "no longer in SillyTavern" needs to be told, in words, that we kept them.
  const plan = { messages: [], added: 0, updated: 0, keptMissing: 2, clearOverrides: [], empty: true };
  ok(describePull(plan).includes('Nothing to bring in'), 'an empty pull says so');

  const withAdds = { ...plan, added: 3, empty: false };
  ok(describePull(withAdds).includes('3 new messages'), 'additions are counted');
  ok(describePull(withAdds).includes('keeping them'), 'and the kept ones are promised, not just counted');
}

/* ------------------------------------------------------------------ */
/* New messages arrive where ST has them                               */
/* ------------------------------------------------------------------ */

{
  const mine = [msg('a', 'One.'), msg('b', 'Two.')];
  const file = parseStFile([header, line('One.'), line('Two.'), line('Three.')].join('\n'));
  const rows = alignSync(mine.map(m => ours(m)), file);
  const plan = planPull(rows, mine, minter());

  eq(plan.messages.map(m => m.content), ['One.', 'Two.', 'Three.'], 'an appended message comes in');
  eq(plan.messages.map(m => m.id), ['a', 'b', 'new-0'], 'existing ids are untouched; the new one is minted');
  eq(plan.added, 1, 'counted as an addition');
}

{
  /**
   * The reason the plan rebuilds the list rather than appending to it.
   *
   * ST mostly appends, but it does not only append — a message inserted in the
   * middle has to land in the middle, or the reader's story reads in an order
   * that matches neither side.
   */
  const mine = [msg('a', 'One.'), msg('b', 'Three.')];
  const file = parseStFile([header, line('One.'), line('Two.'), line('Three.')].join('\n'));
  const rows = alignSync(mine.map(m => ours(m)), file);
  const plan = planPull(rows, mine, minter());

  eq(plan.messages.map(m => m.content), ['One.', 'Two.', 'Three.'],
    'a message inserted in the middle lands in the middle');
  eq(plan.messages.map(m => m.id), ['a', 'new-0', 'b'], 'and does not disturb the ids around it');
}

/* ------------------------------------------------------------------ */
/* Identity survives an update                                         */
/* ------------------------------------------------------------------ */

{
  // ST re-swiped the second message. We had not touched it, so it comes in.
  const mine = [msg('a', 'One.'), msg('b', 'Two.')];
  const file = parseStFile([header, line('One.'), line('Two, but better.')].join('\n'));
  const rows = alignSync(mine.map(m => ours(m)), file);
  const plan = planPull(rows, mine, minter());

  eq(plan.messages[1].content, 'Two, but better.', 'their edit is taken');
  eq(plan.messages[1].id, 'b',
    'and the message keeps its id — highlights and notes are keyed by it');
  eq(plan.updated, 1, 'counted as an update');
  eq(plan.clearOverrides, [], 'no override to clear: we had not edited it');
}

{
  // Everything else about the message is taken too, not just the text.
  const mine = [msg('a', 'One.', { startsChain: true })];
  const file = parseStFile([
    header,
    line('One, revised.', {
      is_user: true, name: 'You', is_system: true,
      swipes: ['One.', 'One, revised.'],
      extra: { image: 'data:image/png;base64,zzz' },
    }),
  ].join('\n'));
  const rows = alignSync(mine.map(m => ours(m)), file);
  const plan = planPull(rows, mine, minter());
  const got = plan.messages[0];

  eq(got.id, 'a', 'id kept');
  eq(got.role, 'user', 'role follows ST');
  eq(got.hidden, true, 'the hidden flag follows ST');
  eq(got.swipes, ['One.', 'One, revised.'], 'alternates come across');
  eq(got.images, ['data:image/png;base64,zzz'], 'so do images');
  eq(got.startsChain, true,
    'but startsChain is OURS — ST does not model it, so rebuilding must not drop it');
}

/* ------------------------------------------------------------------ */
/* Conflicts, and the override that has to go with them                */
/* ------------------------------------------------------------------ */

const conflictRows = (): { rows: SyncRow[]; mine: Message[] } => {
  const mine = [msg('a', 'One.')];
  const file = parseStFile([header, line('One, their way.')].join('\n'));
  // We rewrote it too — that is what makes it a conflict rather than an edit.
  const rows = alignSync([ours(mine[0], 'One, my way.')], file);
  eq(rows[0].status, 'conflict', 'both sides edited the same message');
  return { rows, mine };
};

{
  const { rows, mine } = conflictRows();
  const plan = planPull(rows, mine, minter());
  eq(plan.messages[0].content, 'One.', 'an UNRESOLVED conflict changes nothing');
  eq(plan.updated, 0, 'and is not counted as an update');
  eq(plan.clearOverrides, [], 'and clears no override');
}

{
  const { rows, mine } = conflictRows();
  rows[0].resolution = 'ours';
  const plan = planPull(rows, mine, minter());
  eq(plan.messages[0].content, 'One.',
    'resolving as OURS leaves the imported text alone — our version lives in the Lens');
  eq(plan.clearOverrides, [], 'and keeps the override, which is the version being kept');
}

{
  const { rows, mine } = conflictRows();
  rows[0].resolution = 'theirs';
  const plan = planPull(rows, mine, minter());
  eq(plan.messages[0].content, 'One, their way.', 'resolving as THEIRS takes their text');
  eq(plan.clearOverrides, ['a'],
    'and reports the override to clear — otherwise the Lens still shows ours '
    + 'and the button appears to have done nothing');
}

/* ------------------------------------------------------------------ */
/* Our own edits never come back at us                                 */
/* ------------------------------------------------------------------ */

{
  // We edited it, ST has not. That goes OUT, in mergeToFile — not in.
  const mine = [msg('a', 'One.')];
  const rows = alignSync([ours(mine[0], 'One, my way.')], parseStFile([header, line('One.')].join('\n')));
  eq(rows[0].status, 'ours', 'ours to push');
  const plan = planPull(rows, mine, minter());
  eq(plan.messages[0].content, 'One.', 'a pull does not touch a message we are pushing');
  ok(plan.empty, 'and has nothing to do at all');
}

{
  // An earlier push landed: ST holds our Lens text. Agreement, not a change.
  const mine = [msg('a', 'One.')];
  const rows = alignSync([ours(mine[0], 'One, my way.')],
    parseStFile([header, line('One, my way.')].join('\n')));
  eq(rows[0].status, 'pushed', 'already in sync');
  const plan = planPull(rows, mine, minter());
  eq(plan.messages[0].content, 'One.',
    'the imported text is NOT flattened to the pushed version — turning the '
    + 'Lens off must still show what was imported');
  ok(plan.empty, 'and a synced message is not work');
}

/* ------------------------------------------------------------------ */
/* Degenerate input                                                    */
/* ------------------------------------------------------------------ */

{
  const plan = planPull([], [], minter());
  eq(plan.messages, [], 'no rows, no messages');
  ok(plan.empty, 'and nothing to do');
}

{
  // A row whose message we no longer hold — the store moved on under us.
  // Skipping is right; inventing one would be worse.
  const rows: SyncRow[] = [{ status: 'same', ours: { id: 'gone', original: 'x', current: 'x', name: 'V' } }];
  const plan = planPull(rows, [], minter());
  eq(plan.messages, [], 'a row pointing at a message we no longer have is skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
