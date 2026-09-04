/**
 * Run: npx tsx src/utils/textDiff.test.ts
 *
 * The Lens preview shows a reader what an AI rewrite is about to do to their
 * story before it does it. That preview is only worth having if it is exact, so
 * the whole suite hangs off one property, asserted on every case:
 *
 *   dropping the additions rebuilds BEFORE, character for character.
 *   dropping the deletions rebuilds AFTER, character for character.
 *
 * If that holds, the highlighted text the reader approves is provably the text
 * that gets written. If it does not, the diff has invented or swallowed
 * something — a newline, a doubled space — and the reader approved a passage
 * they were never shown. Every other assertion here is about the diff being
 * USEFUL; this one is about it being honest.
 */
import {
  changeRatio, diffParagraphs, diffStats, diffWords, isNoopChange, rebuildAfter,
  rebuildBefore, tokenize,
  type DiffPart,
} from './textDiff';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};


/** Every case goes through here — the honesty property is not optional. */
const roundTrip = (before: string, after: string, label: string): DiffPart[] => {
  const parts = diffWords(before, after);
  eq(rebuildBefore(parts), before, `${label}: the deletions and matches rebuild BEFORE exactly`);
  eq(rebuildAfter(parts), after, `${label}: the additions and matches rebuild AFTER exactly`);
  return parts;
};

/* ------------------------------------------------------------------ */
/* Tokenising                                                          */
/* ------------------------------------------------------------------ */

{
  eq(tokenize('one two').join('|'), 'one |two', 'a word carries the space that follows it');
  eq(tokenize('').length, 0, 'nothing tokenises to nothing');
  eq(tokenize('   ').join(''), '   ', 'whitespace-only text survives whole');
  eq(tokenize('\n\nHe left.').join(''), '\n\nHe left.', 'a leading blank line is kept');
  eq(tokenize('a\n\nb').join('|'), 'a\n\n|b', 'a paragraph break rides with the word before it');

  // The reconstruction guarantee starts here: tokenising must be lossless.
  for (const s of ['hi', ' hi ', '\ta\n b \n', 'a  b   c', '\n', 'word']) {
    eq(tokenize(s).join(''), s, `tokenising is lossless for ${JSON.stringify(s)}`);
  }
}

/* ------------------------------------------------------------------ */
/* The shape of an ordinary revision                                   */
/* ------------------------------------------------------------------ */

{
  // What "make her colder" actually looks like coming back from a model.
  const before = 'She smiled warmly and said she would wait for him by the gate.';
  const after = 'She smiled thinly and said she would wait for him by the gate.';
  const parts = roundTrip(before, after, 'one word swapped');

  const changed = parts.filter(p => p.type !== 'same');
  eq(changed.length, 2, 'one swapped word is one deletion and one addition');
  ok(changed.some(p => p.type === 'del' && p.text.includes('warmly')), 'the old word is marked deleted');
  ok(changed.some(p => p.type === 'add' && p.text.includes('thinly')), 'the new word is marked added');
  ok(parts[0].type === 'same' && parts[0].text.startsWith('She smiled'),
    'and the untouched opening is one run, not one part per word');
  ok(changeRatio(parts) < 0.25, 'a one-word change reads as a small change');
}

{
  const parts = roundTrip('', 'A whole new passage.', 'written from nothing');
  eq(parts.length, 1, 'a passage added to an empty one is a single addition');
  eq(parts[0].type, 'add', 'marked as added');
  eq(changeRatio(parts), 1, 'and counts as entirely changed');

  const gone = roundTrip('Something was here.', '', 'emptied');
  eq(gone[0].type, 'del', 'the reverse is a single deletion');
}

{
  const same = roundTrip('Unchanged.', 'Unchanged.', 'identical');
  eq(same.length, 1, 'identical texts are one unchanged run');
  eq(same[0].type, 'same', 'marked as unchanged');
  eq(changeRatio(same), 0, 'and nothing moved');
  eq(diffWords('', '').length, 0, 'two empty texts have no parts at all');
}

/* ------------------------------------------------------------------ */
/* Whitespace, which is where a diff quietly lies                      */
/* ------------------------------------------------------------------ */

{
  // A model reflowing the paragraph must not read as a rewrite of every word.
  const before = 'He waited.\nShe did not come.';
  const after = 'He waited.\n\nShe did not come.';
  const parts = roundTrip(before, after, 'reflowed');
  eq(parts.filter(p => p.type !== 'same').length, 0,
    'changing only the spacing marks NO word as added or removed');
  eq(rebuildAfter(parts), after, 'and the new spacing is what would be written');
  ok(isNoopChange(before, after), 'a reflow is recognised as no change at all');
}

{
  ok(isNoopChange('a  b', ' a b '), 'as is any pure whitespace difference');
  ok(!isNoopChange('a b', 'a c'), 'but a real word change is not');
  ok(!isNoopChange('the cat', 'the cat sat'), 'nor an addition');
}

{
  // Multi-line passages are the normal case for a story message.
  const before = 'First line.\n\nSecond line.\n\nThird line.';
  const after = 'First line.\n\nA different second line.\n\nThird line.';
  const parts = roundTrip(before, after, 'middle paragraph replaced');
  ok(parts[0].type === 'same' && parts[0].text.includes('First line.'), 'the first paragraph is untouched');
  ok(parts[parts.length - 1].type === 'same' && parts[parts.length - 1].text.includes('Third line.'),
    'and so is the last');
}

/* ------------------------------------------------------------------ */
/* Insertions, deletions, and moved text                               */
/* ------------------------------------------------------------------ */

{
  const parts = roundTrip('the cat sat', 'the big black cat sat', 'words inserted');
  const added = parts.filter(p => p.type === 'add').map(p => p.text).join('');
  ok(/big/.test(added) && /black/.test(added), 'both inserted words are marked added');
  eq(parts.filter(p => p.type === 'del').length, 0, 'and nothing is marked deleted');
}

{
  const parts = roundTrip('the big black cat sat', 'the cat sat', 'words removed');
  eq(parts.filter(p => p.type === 'add').length, 0, 'a pure deletion adds nothing');
  ok(/big/.test(parts.filter(p => p.type === 'del').map(p => p.text).join('')), 'the removed words are marked');
}

{
  // A sentence moved to the other end. A word diff cannot show "moved", but it
  // must still round-trip, which is the only thing it promises.
  roundTrip('A. B. C.', 'C. A. B.', 'reordered');
}

{
  // Nothing in common at all — the total-rewrite case.
  const parts = roundTrip('alpha beta gamma', 'delta epsilon zeta', 'total rewrite');
  eq(parts.filter(p => p.type === 'same').length, 0, 'a total rewrite shares no run');
  eq(changeRatio(parts), 1, 'and reads as fully changed');
}

/* ------------------------------------------------------------------ */
/* Counting, for the review header                                     */
/* ------------------------------------------------------------------ */

{
  const parts = diffWords('the cat sat', 'the big black cat sat');
  const { added, removed } = diffStats(parts);
  eq(added, 2, 'two words added');
  eq(removed, 0, 'none removed');

  const swap = diffStats(diffWords('she smiled warmly', 'she smiled thinly'));
  eq(swap.added, 1, 'a swap adds one');
  eq(swap.removed, 1, 'and removes one');
  eq(diffStats(diffWords('same', 'same')).added, 0, 'an unchanged passage counts nothing');
}

/* ------------------------------------------------------------------ */
/* Size — the preview must not lock the tab                            */
/* ------------------------------------------------------------------ */

{
  // A long message with a small edit: the prefix/suffix trim is what keeps this
  // out of the quadratic table, so it should be fast AND exact.
  const body = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
  const started = Date.now();
  const parts = roundTrip(`${body} end`, `${body} finish`, 'long passage, tiny edit');
  const took = Date.now() - started;
  ok(took < 1500, `a 4000-word passage with a one-word edit diffs quickly (took ${took}ms)`);
  eq(parts.filter(p => p.type !== 'same').length, 2, 'and still finds exactly the one edit');
}

{
  // Two large and entirely different texts: past MAX_CELLS the exact diff is
  // abandoned. What must NOT happen is a hang, or a lost character.
  const a = Array.from({ length: 2000 }, (_, i) => `alpha${i}`).join(' ');
  const b = Array.from({ length: 2000 }, (_, i) => `beta${i}`).join(' ');
  const started = Date.now();
  const parts = roundTrip(a, b, 'two large unrelated texts');
  ok(Date.now() - started < 4000, 'the oversized case still returns promptly');
  ok(parts.length > 0, 'and returns something');
}

{
  // The paragraph fallback on its own terms.
  const parts = diffParagraphs('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  eq(rebuildBefore(parts), 'one\ntwo\nthree\n',
    'the paragraph diff rebuilds BEFORE too');
  eq(rebuildAfter(parts), 'one\nTWO\nthree\n',
    'and AFTER');
}

/* ------------------------------------------------------------------ */
/* Real-shaped prose                                                   */
/* ------------------------------------------------------------------ */

{
  const before = `*She leans against the doorframe, arms crossed.*

"You're late," she says. There's no heat in it — just the flat statement of a fact she'd already accepted an hour ago.`;
  const after = `*She leans against the doorframe, arms crossed.*

"You're late." No heat in it — just the flat statement of a fact she'd accepted an hour ago.`;
  const parts = roundTrip(before, after, 'a real message rewrite');
  ok(parts[0].type === 'same' && parts[0].text.includes('doorframe'),
    'the untouched action line stays one unchanged run');
  ok(changeRatio(parts) > 0 && changeRatio(parts) < 0.5,
    'and a tightening pass reads as a partial change, not a total one');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
