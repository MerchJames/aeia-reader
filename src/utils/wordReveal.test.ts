/**
 * Run: npx tsx src/utils/wordReveal.test.ts
 *
 * Per-word reveal for the views that render their own text.
 *
 * Two properties carry this file.
 *
 * **The words come back exactly as they went in.** These pieces are re-emitted
 * as spans, so anything this drops is gone from the page — and the thing most
 * easily dropped is whitespace, because `.word-reveal` is `display:inline-block`
 * and an inline-block eats the space at its own edges. That bug shipped once:
 * every animating word in the Panels view ran into the next one and a caption
 * read as `thecaptainsaid,andtherewasnothingwarminit.` So `after` is carried on
 * the word, and the reconstruction is asserted character for character.
 *
 * **Only the tail animates.** A whole passage pulsing at once is a strobe, not a
 * reveal — and a settled word must carry NO class at all, because a span that
 * keeps its animation class replays the animation on every re-render.
 */
import { STREAM_EFFECTS } from '../types';
import { REVEAL_CAP, REVEAL_STAGGER, revealClass, revealWords } from './wordReveal';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** What the page would actually show, rebuilt from the pieces. */
const rebuild = (text: string) => revealWords(text).map(w => `${w.text}${w.after}`).join('');

/* ── Nothing is lost ─────────────────────────────────────────────────────── */
{
  for (const text of [
    'one two three',
    'a  b   c',                       // runs of spaces
    'line one\nline two',             // a single break
    'para one\n\npara two',           // a paragraph gap
    '  leading and trailing  ',
    'tabs\tand\tspaces',
    'punctuation, "quotes" — dashes…',
    'one',
    '',
  ]) {
    // Leading whitespace has nowhere to hang, so it is the one thing the split
    // legitimately drops; everything from the first word on must survive.
    const from = text.replace(/^\s+/, '');
    eq(rebuild(text), from, `rebuilt verbatim: ${JSON.stringify(text)}`);
  }
}

/* ── The split itself ────────────────────────────────────────────────────── */
{
  const w = revealWords('one two');
  eq(w.map(x => x.text), ['one', 'two'], 'words');
  eq(w[0].after, ' ', 'the gap rides on the word BEFORE it — never inside the animated span');
  eq(w[1].after, '', 'and the last word has none');

  eq(revealWords('').length, 0, 'no text, no words');
  eq(revealWords('   ').length, 0, 'whitespace alone is not a word');

  // Line structure is what tells a paragraph from a wrap.
  eq(revealWords('a\n\nb')[0].after, '\n\n', 'a paragraph gap is carried verbatim');
}

/* ── Only the tail animates ──────────────────────────────────────────────── */
{
  const long = revealWords(Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '));
  eq(long.length, 60, 'every word is present');
  eq(long.filter(w => w.fresh).length, REVEAL_CAP, 'exactly the cap animates');
  ok(long.slice(0, 60 - REVEAL_CAP).every(w => !w.fresh), 'and everything before it has settled');
  ok(long.slice(60 - REVEAL_CAP).every(w => w.fresh), 'the tail is the END, not the start');

  // The stagger runs along the tail, so a burst arrives in order.
  const tail = long.filter(w => w.fresh);
  eq(tail[0].delay, 0, 'the first tail word plays at once');
  eq(tail[1].delay, REVEAL_STAGGER, 'and the next one a stagger later');
  eq(tail[tail.length - 1].delay, (REVEAL_CAP - 1) * REVEAL_STAGGER, 'up to the last');
  ok(long.filter(w => !w.fresh).every(w => w.delay === 0), 'settled words have no delay to apply');

  // A short passage is all tail — which is right: nothing has settled yet.
  const short = revealWords('one two three');
  ok(short.every(w => w.fresh), 'a passage shorter than the cap animates entirely');
  eq(short[2].delay, 2 * REVEAL_STAGGER, 'still staggered in order');
}

/* ── The class ───────────────────────────────────────────────────────────── */
{
  const fresh = { text: 'x', after: ' ', fresh: true, delay: 0 };
  const settled = { text: 'x', after: ' ', fresh: false, delay: 0 };
  eq(revealClass(fresh, 'fade'), 'word-reveal word-reveal-fade', 'a tail word carries the effect');
  eq(revealClass(fresh, 'type'), 'word-reveal word-reveal-type', 'whichever effect it is');
  eq(revealClass(settled, 'fade'), '',
    'a settled word carries NOTHING — a class that stays replays on every render');
  eq(revealClass(fresh, null), '', 'no effect chosen, no class');
  eq(revealClass(fresh, 'none'), '', '"none" is not an effect either');

  /* Every effect the settings panel offers reaches these views too.
   *
   * Script, Panels and Atlas render their own text through this module rather
   * than through MessageBlock's tree-walker, and the two are only kept in step
   * by intent. An effect that works in Storybook and does nothing in Script is
   * exactly the kind of gap nobody reports — you would have to switch view
   * mid-stream to see it. */
  for (const fx of STREAM_EFFECTS) {
    if (fx === 'none') continue;
    eq(revealClass(fresh, fx), `word-reveal word-reveal-${fx}`,
      `"${fx}" reaches the views that render their own text`);
    eq(revealClass(settled, fx), '', `"${fx}" leaves a settled word alone`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
