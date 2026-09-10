/**
 * Run: npx tsx src/utils/readingPace.test.ts
 *
 * What the reader is doing, as opposed to what is on the page.
 *
 * The rule this file is really about is the one that says NOTHING. A companion
 * who remarks on every ordinary step — "ah, onward" — is worse than one who
 * never notices anything, so `paceNote` returns undefined for the common case
 * and speaks only for the shapes a person would actually clock.
 */
import { notePassage, paceNote, resetPace } from './readingPace';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── Reading forward is not an event ─────────────────────────────────────── */
{
  resetPace();
  eq(notePassage('a', 0).visits, 1, 'a first read is one visit');
  const b = notePassage('b', 1);
  eq(b.wentBack, false, 'and going on to the next passage is not going back');
  eq(paceNote(b), undefined,
    'reading a story in order earns no remark — a companion who narrates that is a nuisance');
}

/* ── Re-reading ──────────────────────────────────────────────────────────── */
{
  resetPace();
  notePassage('a', 0);
  notePassage('b', 1);
  const again = notePassage('a', 0);
  eq(again.visits, 2, 'coming back to a passage counts');
  eq(again.wentBack, true, 'and arriving from a later passage IS going back');
  ok(/second time/.test(paceNote(again) ?? ''), 'which is worth saying once');
  ok(/went back/.test(paceNote(again) ?? ''), 'and so is the direction they came from');

  const third = notePassage('a', 0);
  ok(/3 times/.test(paceNote(third) ?? ''), 'a third pass says how many');
}

/* ── The size of the jump ────────────────────────────────────────────────── */
{
  resetPace();
  notePassage('far', 12);
  const back = notePassage('near', 2);
  eq(back.jump, -10, 'the distance is kept, not just the direction');
  ok(/much later/.test(paceNote(back) ?? ''),
    'jumping back ten passages reads differently from stepping back one');

  resetPace();
  notePassage('a', 5);
  const one = notePassage('b', 4);
  ok(/went back a passage/.test(paceNote(one) ?? ''), 'and one step back says so plainly');
}

/* ── Nothing carries between stories ─────────────────────────────────────── */
{
  resetPace();
  notePassage('a', 0);
  resetPace();
  eq(notePassage('a', 0).visits, 1,
    'a reset forgets — "you have read this before" across sessions is a different '
    + 'and much stranger claim than "you just read that twice"');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
