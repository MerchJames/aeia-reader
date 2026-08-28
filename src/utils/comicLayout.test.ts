/**
 * Run: npx tsx src/utils/comicLayout.test.ts
 *
 * The comic page layout engine.
 *
 * Three properties carry this file.
 *
 * **One panel is one beat.** Nothing here may merge two beats into a panel or
 * split one across two — the first kills the pacing, the second invents a pause
 * the writer never wrote. Every beat that goes in comes out, in order.
 *
 * **The page shape follows the PASSAGE, not the scene.** A scene spans up to
 * fourteen passages under one mood label, and keying the layout to it produced
 * the same page forever — a quiet kitchen three passages before a chase drawn in
 * widescreen action tiers. This is the bug the whole `runsOf` machinery exists
 * to prevent, so it is asserted directly.
 *
 * **A grid is only worth keeping if it is kept.** Layout may not change for a
 * single panel, because breaking a grid means something only when the grid was
 * being held — so short runs are absorbed rather than given their own page.
 */
import {
  COLUMNS, MIN_RUN, SPLASH_TENSION, gridFor, layOut, pagesFor, runsOf, splitLong,
} from './comicLayout';
import type { Beat } from './comicLayout';
import type { Mood } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const beat = (text: string, over: Partial<Beat> = {}): Beat =>
  ({ kind: 'caption', text, messageId: 'm1', ...over });
const beats = (n: number, over: Partial<Beat> = {}): Beat[] =>
  Array.from({ length: n }, (_, i) => beat(`b${i}`, over));

/* ── Which grid a beat asks for ──────────────────────────────────────────── */
{
  eq(gridFor('action', 0.4, 3), 'tiers', 'a fast mood reads left to right, fast');
  eq(gridFor('tense', 0.1, 3), 'tiers', 'and so does a tense one, whatever the tension number says');
  eq(gridFor('melancholy', 0.4, 3), 'nine', 'a slow mood gets the strict grid');
  eq(gridFor('neutral', 0.4, 3), 'six', 'and everything else the ordinary page');

  /* Tension has exactly one job, and this is why: the heuristic read tops out
   * near 0.47 on ordinary prose while the Director returns a real 0..1, so a
   * grid keyed to tension would draw a different comic depending on whether the
   * reader had configured an endpoint. */
  eq(gridFor('neutral', 0.46, 3), 'six', 'a heuristic-range tension changes nothing');
  eq(gridFor('neutral', 0.99, 3), 'six', 'and neither does a high one, on its own');
  eq(gridFor('neutral', SPLASH_TENSION, 1), 'splash',
    'a lone beat that a model read at peak takes the page');
  eq(gridFor('neutral', SPLASH_TENSION, 2), 'six',
    'but a "splash" holding two beats is just a big box, and spends the page on nothing');
  eq(gridFor('action', SPLASH_TENSION, 1), 'splash', 'the splash outranks the mood');
}

/* ── Beats into panels ───────────────────────────────────────────────────── */
{
  const six = layOut(beats(6), 'six');
  eq(six.length, 6, 'every beat gets a panel');
  eq(six.map(p => p.span), [3, 3, 3, 3, 3, 3], 'two tiers of three');
  ok(six.every(p => p.rows === 1), 'and one row each');

  const nine = layOut(beats(9), 'nine');
  eq(nine.map(p => p.span), [2, 2, 2, 2, 2, 2, 2, 2, 2], 'three by three');

  const tiers = layOut(beats(3), 'tiers');
  eq(tiers.map(p => p.span), [COLUMNS, COLUMNS, COLUMNS], 'full-width bands');

  // A comic page has no ragged edge.
  const short = layOut(beats(2), 'nine');
  eq(short.map(p => p.span), [3, 3], 'a short final row shares the width out');
  eq(short.reduce((n, p) => n + p.span, 0), COLUMNS, 'and still totals six');
  const one = layOut(beats(1), 'six');
  eq(one[0].span, COLUMNS, 'one beat alone takes the width');
  const five = layOut(beats(5), 'nine');
  eq(five.map(p => p.span), [2, 2, 2, 3, 3], 'a full row, then the remainder shared');

  eq(layOut([], 'six'), [], 'no beats, no panels');
}

/* ── Establishing and splash shapes ──────────────────────────────────────── */
{
  const est = layOut([beat('open', { kind: 'establish' }), ...beats(2)], 'nine');
  eq(est[0].span, COLUMNS, 'an establishing beat takes the width in any grid');
  eq(est[0].rows, 1, 'and only one row when there is no picture to fill a second');

  const withArt = layOut([beat('open', { kind: 'establish', art: 'blob:x' })], 'nine');
  eq(withArt[0].rows, 2, 'with a picture it claims the height');

  const splash = layOut(beats(1), 'splash');
  eq(splash[0].rows, 3, 'a splash is the page');
  ok(splash[0].splash, 'and says so, for the heavier rule');
  ok(!layOut(beats(1), 'six')[0].splash, 'nothing else is marked as one');
}

/* ── Runs: the page shape follows the passage ────────────────────────────── */
{
  // THE regression this machinery exists for.
  const mixed: Beat[] = [
    ...beats(3, { mood: 'action' as Mood, tension: 0.8 }),
    ...beats(4, { mood: 'melancholy' as Mood, tension: 0.2 }),
    ...beats(3, { mood: 'action' as Mood, tension: 0.8 }),
  ];
  const runs = runsOf(mixed, 'action', 0.8);
  eq(runs.map(r => r.grid), ['tiers', 'nine', 'tiers'],
    'a quiet stretch inside a loud scene gets its own page shape');
  eq(runs.map(r => r.beats.length), [3, 4, 3], 'and every beat is still there');

  // Nothing is ever dropped, whatever the regrouping does.
  const total = (rs: { beats: Beat[] }[]) => rs.reduce((n, r) => n + r.beats.length, 0);
  eq(total(runs), mixed.length, 'no beat is lost to grouping');

  // A run of one is a hiccup, not a change of layout.
  const hiccup: Beat[] = [
    ...beats(3, { mood: 'action' as Mood, tension: 0.3 }),
    beat('quiet', { mood: 'tender' as Mood, tension: 0.2 }),
    ...beats(3, { mood: 'action' as Mood, tension: 0.3 }),
  ];
  const absorbed = runsOf(hiccup, 'action', 0.3);
  eq(absorbed.length, 1, 'one quiet panel does not re-grid the page');
  eq(total(absorbed), hiccup.length, 'and it is absorbed, not discarded');
  ok(MIN_RUN >= 2, 'the minimum run is at least two — one panel is not a grid');

  // A lone PEAK beat is the exception: that is what a splash is.
  const peak: Beat[] = [
    ...beats(2, { mood: 'neutral' as Mood, tension: 0.3 }),
    beat('THE MOMENT', { mood: 'neutral' as Mood, tension: 0.95 }),
    ...beats(2, { mood: 'neutral' as Mood, tension: 0.3 }),
  ];
  const withSplash = runsOf(peak, 'neutral', 0.3);
  ok(withSplash.some(r => r.grid === 'splash'), 'a lone peak beat is promoted, not absorbed');
  eq(total(withSplash), peak.length, 'and nothing is lost promoting it');

  // Beats with no read of their own fall back to the scene's.
  eq(runsOf(beats(3), 'melancholy', 0.2).map(r => r.grid), ['nine'],
    'a beat with no mood of its own uses the scene’s');

  eq(runsOf([], 'neutral', 0.5), [], 'no beats, no runs');
  eq(runsOf(beats(1), 'neutral', 0.3).length, 1,
    'a single beat that is the ONLY run stays — there is nothing to absorb it into');
}

/* ── Pages ───────────────────────────────────────────────────────────────── */
{
  const page = (bs: Beat[], mood: Mood = 'neutral', tension = 0.3) =>
    pagesFor({ sceneId: 's1', sceneIndex: 1, mood, tension, beats: bs });

  eq(page([]).length, 0, 'an empty scene makes no page');

  const one = page(beats(4));
  eq(one.length, 1, 'four beats fit a six-panel page');
  eq(one[0].grid, 'six', 'in the ordinary grid');
  eq(one[0].sceneIndex, 1, 'labelled with its scene');

  // A run longer than its grid's capacity becomes more pages of the SAME grid.
  const many = page(beats(14));
  ok(many.length > 1, 'a long scene becomes several pages');
  ok(many.every(p => p.grid === many[0].grid),
    'and they all keep the same grid — a page that changes layout halfway is not a grid');
  eq(many.reduce((n, p) => n + p.panels.length, 0), 14, 'every beat is on a page');
  eq(new Set(many.map(p => p.id)).size, many.length, 'page ids are unique');

  // The gutter is part of the layout, not decoration: tight reads fast.
  const fast = page(beats(3), 'action')[0];
  const slow = page(beats(9), 'melancholy')[0];
  ok(fast.gutter < slow.gutter, 'an action page reads faster than a contemplative one');
}

/* ── A caption that is too long stops being a caption ────────────────────── */
{
  eq(splitLong('short'), ['short'], 'a short paragraph is one beat');
  const long = `${'x'.repeat(200)}. ${'y'.repeat(200)}.`;
  const parts = splitLong(long);
  ok(parts.length > 1, 'a wall of text becomes more than one beat');
  eq(parts.join(' ').replace(/\s+/g, ''), long.replace(/\s+/g, ''),
    'and every character survives the split');
  ok(parts.every(p => p.trim()), 'with no empty beats');

  // It prefers a sentence end, so a caption does not break mid-clause.
  const sentences = `${'a'.repeat(100)}. ${'b'.repeat(100)}. ${'c'.repeat(100)}.`;
  ok(splitLong(sentences)[0].endsWith('.'), 'the break lands at a sentence end where it can');

  // A single unbroken token cannot be split at a sentence or a space.
  const wall = 'z'.repeat(700);
  const cut = splitLong(wall);
  ok(cut.length > 1, 'and a hard cut is still made when there is nowhere better');
  eq(cut.join(''), wall, 'losing nothing');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
