/** Run: npx tsx src/utils/scenePerform.test.ts */
import {
  PERFORM_KINDS, PERFORM_VISUAL, derivePerformCues, mergePerformCues, nextPerformBoundary,
  nextPerformStart, performAudioAt, performEnterMs, performExitMs, performHoldMs, performRateAt,
  performWordKinds, resolvePerformRanges, scaleProfile,
} from './scenePerform';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// --- resolving cues to offsets -----------------------------------------------
const text = 'She stood at the door. In. the. end. it was nothing at all.';
const ranges = resolvePerformRanges(text, [{ text: 'In. the. end.', kind: 'stagger' }]);
ok(ranges.length === 1 && text.slice(ranges[0].start, ranges[0].end) === 'In. the. end.',
  'a cue resolves to the exact span it names');

// Case-insensitive, since the render pipeline may re-case or re-punctuate.
ok(resolvePerformRanges(text, [{ text: 'IN. THE. END.', kind: 'slow' }]).length === 1,
  'matching is case-insensitive');

// A cue that isn't in the passage is dropped rather than stalling the reveal.
ok(resolvePerformRanges(text, [{ text: 'not in the passage', kind: 'slow' }]).length === 0,
  'an unfindable cue is dropped');
ok(resolvePerformRanges(text, [{ text: 'door', kind: 'nonsense' as never }]).length === 0,
  'an unknown direction is rejected');

// Overlapping cues: first claim wins, results are ordered by position.
const overlap = resolvePerformRanges(text, [
  { text: 'it was nothing', kind: 'fade' },
  { text: 'was nothing at all', kind: 'drop' },
  { text: 'She stood', kind: 'hold' },
]);
ok(overlap.length === 2 && overlap[0].kind === 'hold' && overlap[1].kind === 'fade',
  'overlapping cues resolve first-come and sort by start');

// --- pacing ------------------------------------------------------------------
const start = ranges[0].start;
ok(performRateAt(ranges, start + 2) < 1, 'the reveal drags inside a stagger span');
ok(performRateAt(ranges, 0) === 1, 'outside any span the rate is untouched');
ok(performRateAt(resolvePerformRanges(text, [{ text: 'nothing at all', kind: 'rush' }]),
  text.indexOf('nothing') + 1) > 1, 'a rush span speeds the reveal up');

// Intensity scales the same cue from a nudge to a full performance.
ok(scaleProfile('slow', 'subtle').rate > scaleProfile('slow', 'cinematic').rate,
  'subtle drags less than cinematic');
ok(scaleProfile('hold', 'cinematic').enterHold > scaleProfile('hold', 'subtle').enterHold,
  'cinematic holds the pre-beat longer');
ok(scaleProfile('slow', 'expressive', 0.25).rate > scaleProfile('slow', 'expressive', 1).rate,
  'a weak strength pulls the effect back toward normal');

// The streamer stops ON a cue's first character so its entrance beat lands there.
ok(nextPerformStart(ranges, 0) === start, 'the next cue start is reported ahead of the reveal');
ok(nextPerformStart(ranges, start) === -1, 'no start is reported once inside the last cue');
ok(performEnterMs(ranges, start) > 0, 'a stagger span owes a beat before it begins');
ok(performEnterMs(ranges, start + 1) === 0, 'the entrance beat is owed only at the exact start');

// The per-word beat — what gives "In. the. end." its cadence.
const afterIn = text.indexOf('In.') + 3; // just revealed "In."
ok(performHoldMs(text, ranges, afterIn) > 0, 'a word boundary inside a stagger span holds');
ok(performHoldMs(text, ranges, afterIn - 1) === 0, 'mid-word, nothing is held');
const fadeRanges = resolvePerformRanges(text, [{ text: 'it was nothing', kind: 'fade' }]);
ok(performHoldMs(text, fadeRanges, text.indexOf('it was') + 2) === 0,
  'kinds without a word beat never hold');
ok(performHoldMs(text, ranges, 0) === 0 && performHoldMs(text, ranges, text.length + 9) === 0,
  'out-of-range positions are safe');

// --- the visual half ---------------------------------------------------------
const wk = performWordKinds([{ text: 'the sky burned', kind: 'swell' }, { text: 'quietly', kind: 'slow' }]);
ok(wk?.get('burned') === 'swell' && wk?.get('sky') === 'swell', 'cues map to their own words');
ok(wk?.get('quietly') === 'slow', 'a second cue keeps its own kind');
ok(performWordKinds([{ text: 'x', kind: 'slow' }]) === null, 'a one-character span maps to nothing');
ok(performWordKinds(undefined) === null && performWordKinds([]) === null, 'no cues → no map at all');

// --- the AI-free heuristic ---------------------------------------------------
const STACCATO_SRC = 'He looked at the ruined gate for a long moment before speaking. In. the. end. it changed nothing.';
const staccato = derivePerformCues(STACCATO_SRC);
ok(staccato.some(c => c.kind === 'stagger' && /In\. the\. end\./.test(c.text)),
  'a run of one-word sentences is heard as a stagger');

const ELL_SRC = 'She waited by the window for what felt like an hour, watching the road… Nobody came for her.';
const ell = derivePerformCues(ELL_SRC);
ok(ell.some(c => c.kind === 'hold' && /^Nobody/.test(c.text)),
  'an ellipsis holds a beat before what follows it');

const SHOUT_SRC = 'The whole hall went silent as the doors slammed shut behind them. GET OUT NOW he roared.';
const shout = derivePerformCues(SHOUT_SRC);
ok(shout.some(c => c.kind === 'slow' && /GET OUT NOW/.test(c.text)),
  'a shouted run gets room to land');

ok(derivePerformCues('Too short.').length === 0, 'a tiny passage gets no heuristic performance');
ok(derivePerformCues(
  'They walked the long road together and spoke of nothing in particular, and the afternoon passed.',
).length === 0, 'ordinary prose is left completely alone');
ok(derivePerformCues('In. the. end. '.repeat(20)).length <= 3, 'the heuristic is capped');

// Every heuristic cue must be a verbatim substring AND resolve back to a range —
// the whole pipeline (streamer included) depends on that contract holding.
for (const [src, cues] of [[STACCATO_SRC, staccato], [ELL_SRC, ell], [SHOUT_SRC, shout]] as const) {
  ok(cues.every(c => src.includes(c.text)), 'heuristic cues are verbatim substrings');
  ok(resolvePerformRanges(src, [...cues]).length === cues.length,
    'every heuristic cue resolves back to a range');
}

// --- cut: interrupted speech -------------------------------------------------
const cutText = 'She started to say “But I never meant—” and the door slammed.';
const cutRanges = resolvePerformRanges(cutText, [{ text: 'But I never meant—', kind: 'cut' }]);
ok(performRateAt(cutRanges, cutRanges[0].start + 2) > 2,
  'a cut races the words at the interruption');
ok(performExitMs(cutRanges, cutRanges[0].end) > 0, 'dead air is owed behind the cut');
ok(performExitMs(cutRanges, cutRanges[0].end - 1) === 0, 'the exit beat is owed only at the exact end');
ok(performExitMs(resolvePerformRanges(cutText, [{ text: 'the door slammed', kind: 'slow' }]),
  cutText.indexOf('the door slammed') + 'the door slammed'.length) === 0,
  'kinds with no exit beat owe nothing');

// The streamer must be able to stop on BOTH edges of a span.
ok(nextPerformBoundary(cutRanges, 0) === cutRanges[0].start, 'the next edge ahead is the span start');
ok(nextPerformBoundary(cutRanges, cutRanges[0].start + 1) === cutRanges[0].end,
  'inside a span, the next edge is its end');
ok(nextPerformBoundary(cutRanges, cutRanges[0].end) === -1, 'past the last span there is no edge left');

// Speech broken off on a dash is heard without the AI.
const broken = derivePerformCues(
  'He caught her wrist before she could turn away from the table. “But I never meant—” The door slammed.',
);
ok(broken.some(c => c.kind === 'cut' && /never meant/.test(c.text)),
  'a dash against the closing quote is heard as an interruption');
ok(broken.every(c => c.kind !== 'cut' || !c.text.includes('”')),
  'the cut covers the words running into the break, not the quote mark');

// --- unwrite: written, then dissolved ---------------------------------------
const unw = resolvePerformRanges('He wrote her name and then thought better of it.', [
  { text: 'her name', kind: 'unwrite' },
]);
ok(performRateAt(unw, unw[0].start + 1) < 1, 'an unwrite is written slowly');
ok(performExitMs(unw, unw[0].end) > 0, 'the reveal waits for the erasure to finish');
ok(performWordKinds([{ text: 'her name', kind: 'unwrite' }])?.get('name') === 'unwrite',
  'unwrite carries a visual treatment');

// --- merging reader + Director cues ------------------------------------------
const readerCues = [{ text: 'her name', kind: 'unwrite' as const }];
const aiCues = [{ text: 'thought better', kind: 'slow' as const }];
ok(mergePerformCues(readerCues, aiCues)?.[0].kind === 'unwrite', 'reader cues are offered first');
ok(mergePerformCues(undefined, aiCues) === aiCues, 'only-AI merges to the same array (stable identity)');
ok(mergePerformCues(readerCues, undefined) === readerCues, 'only-reader merges to the same array');
ok(mergePerformCues(undefined, undefined) === undefined && mergePerformCues([], []) === undefined,
  'no cues at all merges to nothing');
// A reader's call wins the words when both mark the same span.
const contested = resolvePerformRanges(
  'He wrote her name and then thought better of it.',
  mergePerformCues([{ text: 'her name', kind: 'unwrite' }], [{ text: 'her name', kind: 'swell' }]),
);
ok(contested.length === 1 && contested[0].kind === 'unwrite',
  'a hand-marked span beats the Director on the same words');

// --- the bed envelope --------------------------------------------------------
const audioRanges = resolvePerformRanges('He waited. Then the door opened.', [
  { text: 'Then the door', kind: 'hold' },
]);
const inHold = performAudioAt(audioRanges, audioRanges[0].start + 1);
ok(inHold.gain < 0.5, 'a hold hushes the room before the line lands');
ok(performAudioAt(audioRanges, 0).gain === 1 && performAudioAt(audioRanges, 0).rate === 1,
  'outside every cue the mix is untouched');
ok(performAudioAt(resolvePerformRanges('the words dragged on', [{ text: 'dragged on', kind: 'slow' }]),
  'the words '.length + 1).rate < 1, 'a slowed line drags the beds with it');
ok(performAudioAt(resolvePerformRanges('and then it all rushed past', [{ text: 'rushed past', kind: 'rush' }]),
  'and then it all '.length + 1).rate > 1, 'a rush pushes them forward');
// Intensity scales the mix move, and every kind stays inside a sane range.
ok(performAudioAt(audioRanges, audioRanges[0].start + 1, 'subtle').gain
  > performAudioAt(audioRanges, audioRanges[0].start + 1, 'cinematic').gain,
  'subtle moves the mix less than cinematic');
for (const kind of PERFORM_KINDS) {
  const r = resolvePerformRanges('one two three four', [{ text: 'two three', kind }]);
  const a = performAudioAt(r, r[0].start + 1, 'cinematic');
  ok(a.gain >= 0.1 && a.gain <= 1.5 && a.rate >= 0.6 && a.rate <= 1.5,
    `${kind} keeps the beds in a sane range even at cinematic`);
}

// Every verb now has a visible treatment — pacing alone doesn't read.
ok(PERFORM_KINDS.every(k => PERFORM_VISUAL.has(k)), 'every verb carries a visual signature');
ok(performWordKinds([{ text: 'stop right there', kind: 'stagger' }])?.get('right') === 'stagger',
  'a pacing verb now reaches the render layer too');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);