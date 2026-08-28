/**
 * Run: npx tsx src/utils/tasteBlock.test.ts
 *
 * What the reader's own marks teach the Director.
 *
 * The failure this guards against is subtle and silent: a block that LOOKS
 * right and teaches the wrong lesson. Three ways that happens —
 *
 * - a span the reader took OFF is rendered as one they wanted, so the clear
 *   teaches the exact opposite of what they meant;
 * - a tidying session (ten clears in a row) crowds every positive out by pure
 *   recency, and the model reads it as "this reader hates cues";
 * - a reader-only kind (`sfx`, which marks a span for a SOUND) reaches a
 *   prompt that forbids it, and the model returns a kind the parser drops —
 *   or worse, invalid JSON for the whole batch.
 *
 * None of those break another test. All three are asserted here.
 */
import {
  MAX_TASTE_MARKS, MAX_TASTE_TEXT, TASTE_BUDGET, TASTE_LOG_CAP,
  recordTaste, selectTaste, tasteBlock, type TasteEntry,
} from './tasteBlock';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

let clock = 1_000;
const mark = (text: string, kind: string, extra: Partial<TasteEntry> = {}): TasteEntry =>
  ({ text, kind, track: 'perform', at: clock++, ...extra });

// Nothing marked yet: no block at all, not an empty heading.
{
  eq(tasteBlock([]), '', 'a reader who has said nothing sends nothing');
  eq(tasteBlock([mark('x', 'sfx', { track: 'emphasis' })]), '',
    'and neither does one whose only mark is a kind the Director cannot emit');
}

// The shape of the thing.
{
  const block = tasteBlock([
    mark('he never came back', 'fade'),
    mark('In. the. end.', 'stagger'),
    mark('Elara', 'color', { track: 'emphasis' }),
  ]);
  ok(block.includes('"he never came back" → fade'), 'the span and the verb it earned');
  ok(block.includes('"In. the. end." → stagger'), 'both tracks render the same way');
  ok(block.includes('"Elara" → color'), 'emphasis marks reach it too');
  ok(/never copy a span/i.test(block), 'the header forbids copying the examples');
  ok(block.indexOf('he never came back') < block.indexOf('Elara'),
    'oldest first, so the newest lesson sits closest to the task');
}

// A cleared mark is rendered AS a clear. Getting this wrong teaches the
// opposite of what the reader did.
{
  const block = tasteBlock([mark('the door slammed', 'drop', { cleared: true })]);
  ok(block.includes('they took OFF: "the door slammed" → drop'), 'a clear reads as a clear');
  ok(/strongest signal/i.test(block), 'and the header says why it matters');
}

// Mark it, then clear it: the last word wins, and only one line survives.
{
  const log = [mark('a quiet sigh', 'fade'), mark('a quiet sigh', 'fade', { cleared: true })];
  const picked = selectTaste(log);
  eq(picked.length, 1, 'one line per span, not a contradiction');
  ok(!!picked[0].cleared, 'and it is the clear that survives');
}

// Whitespace and case are the same span.
{
  const picked = selectTaste([mark('the  Door\nslammed', 'drop'), mark('the door slammed', 'drop')]);
  eq(picked.length, 1, 'a re-mark of the same words is one entry');
  eq(picked[0].text, 'the door slammed', 'stored with its whitespace collapsed');
}

// A tidying session cannot silence the positives.
{
  const positives = [mark('a', 'fade'), mark('b', 'swell')];
  const clears = Array.from({ length: 12 }, (_, i) => mark(`clear${i}`, 'drop', { cleared: true }));
  const picked = selectTaste([...positives, ...clears]);
  eq(picked.length, MAX_TASTE_MARKS, 'the sample is full');
  ok(picked.some(p => !p.cleared), 'and both voices are in it');
  ok(picked.filter(p => p.cleared).length >= 2, 'clears still dominate, as they should');
}
// …and the reverse, for a reader who only ever adds.
{
  const clears = [mark('gone', 'drop', { cleared: true })];
  const adds = Array.from({ length: 12 }, (_, i) => mark(`add${i}`, 'fade'));
  ok(selectTaste([...clears, ...adds]).some(p => p.cleared),
    'one clear among many adds is still worth a slot');
}

// Deterministic: same log, same bytes, so an unchanged reader keeps a cacheable prompt.
{
  const log = [mark('a', 'fade'), mark('b', 'drop', { cleared: true }), mark('c', 'swell')];
  eq(tasteBlock(log), tasteBlock([...log]), 'same log, same block');
  const tied = [
    { text: 'zebra', kind: 'fade', track: 'perform' as const, at: 5 },
    { text: 'apple', kind: 'fade', track: 'perform' as const, at: 5 },
  ];
  eq(tasteBlock(tied), tasteBlock([...tied].reverse()),
    'and two marks made in the same millisecond cannot swap places');
}

// Hard caps.
{
  const many = Array.from({ length: 40 }, (_, i) => mark(`span number ${i}`, 'fade'));
  ok(selectTaste(many).length <= MAX_TASTE_MARKS, 'at most ten reach the prompt');
  const long = mark('x'.repeat(400), 'slow');
  const block = tasteBlock([long]);
  ok(block.includes('…'), 'a dragged-over paragraph is clipped');
  ok(!block.includes('x'.repeat(MAX_TASTE_TEXT + 1)), 'to the cap');
  const fat = Array.from({ length: 20 }, (_, i) => mark(`${'w'.repeat(60)}${i}`, 'tremble'));
  ok(tasteBlock(fat).length <= TASTE_BUDGET, 'and the whole block has a ceiling');
  ok(tasteBlock(fat).includes('w'.repeat(20)), 'which still leaves at least one example');
}

// The log itself is bounded, and keeps the recent end.
{
  let log: TasteEntry[] = [];
  for (let i = 0; i < TASTE_LOG_CAP + 15; i++) log = recordTaste(log, mark(`m${i}`, 'fade'));
  eq(log.length, TASTE_LOG_CAP, 'the log stops growing');
  eq(log[log.length - 1].text, `m${TASTE_LOG_CAP + 14}`, 'and it is the OLD end that falls off');
  eq(recordTaste([], mark('   ', 'fade')).length, 0, 'an empty span is not a lesson');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
