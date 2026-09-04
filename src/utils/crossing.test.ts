/**
 * Run: npx tsx src/utils/crossing.test.ts
 *
 * Crossings are the first thing in this app that spans two stories without
 * merging them, and almost every test here is about that "without".
 *
 * The failure it guards is subtle and would look like a feature: a model handed
 * two passages with no frame blends them into one continuity and answers about
 * the blend. That reads perfectly plausible — and it is useless, because the
 * entire question a crossing asks is *what happens at the boundary*. So the
 * prompt tests assert the frame is there, in the wording, every time.
 *
 * The other half is the same-story rule. Two points in one chat already have a
 * relationship (the story between them); allowing a crossing there would turn
 * the board into a second, worse annotation layer over one transcript.
 */
import {
  CROSSING_KINDS, EXCERPT_CHARS, addCrossing, buildCrossingMessages, crossingProblem,
  crossingSummary, crossingsBetween, crossingsFor, excerptOf, isDuplicate, kindDef,
  makeCrossing, otherEnd, removeCrossing, suggestedStories, updateCrossing,
  type CrossPoint, type Crossing,
} from './crossing';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const point = (over: Partial<CrossPoint> = {}): CrossPoint => ({
  storyId: 'story-a', storyTitle: 'The Inn', messageId: 'm12', index: 12,
  name: 'Mara', excerpt: 'She set the lamp down without looking at him.',
  ...over,
});

const A = point();
const B = point({
  storyId: 'story-b', storyTitle: 'The Courier', messageId: 'm40', index: 40,
  name: 'Vess', excerpt: 'The road had been empty for two days.',
});

/* ------------------------------------------------------------------ */
/* What may be crossed                                                 */
/* ------------------------------------------------------------------ */

{
  eq(crossingProblem(A, B), null, 'two points in two stories cross');

  const same = crossingProblem(A, point({ messageId: 'm40', index: 40 }));
  ok(same !== null, 'two points in the SAME story do not');
  ok(/same story/i.test(same ?? ''), 'and the reason says why');
  ok(/already/i.test(same ?? ''),
    'in terms of what is already true, not as a rule handed down');

  ok(crossingProblem(A, point({ storyId: 'story-b', messageId: '' })) !== null,
    'an end with no message is not an end');
}

/* ------------------------------------------------------------------ */
/* A crossing has no direction                                         */
/* ------------------------------------------------------------------ */

{
  // Drawn A→B or B→A, it is the same observation. If the two produced different
  // records, a reader would be able to make the same link twice by dragging it
  // the other way, and deleting one would leave the other.
  const one = makeCrossing(A, B);
  const two = makeCrossing(B, A);
  eq(one.a.messageId, two.a.messageId, 'the ends are stored in a stable order');
  eq(one.b.messageId, two.b.messageId, 'both of them');

  ok(isDuplicate([one], A, B), 'a pair already crossed is recognised');
  ok(isDuplicate([one], B, A), 'drawn the other way round too — this is the whole point');
  ok(!isDuplicate([one], A, point({ storyId: 'story-c', messageId: 'm1' })),
    'a different pair is not');

  const list = addCrossing([one], makeCrossing(B, A));
  eq(list.length, 1, 'so dragging the same link backwards does not make a second one');
  eq(addCrossing([], makeCrossing(A, B)).length, 1, 'while a genuinely new one is added');
}

{
  const c = makeCrossing(A, B, 'contrast', 'she says the bridge burned, he crosses it');
  eq(c.kind, 'contrast', 'the kind is kept');
  eq(c.note, 'she says the bridge burned, he crosses it', 'and the reader\'s note');
  ok(c.id.length > 2 && makeCrossing(A, B).id !== c.id, 'every crossing gets its own id');
  eq(makeCrossing(A, B).kind, 'introduce', 'with a sensible default kind');
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

{
  const c1 = makeCrossing(A, B);
  const c2 = makeCrossing(A, point({ storyId: 'story-c', storyTitle: 'The Siege', messageId: 'm3', index: 3 }));
  const list = [c1, c2];

  eq(crossingsFor(list, 'story-a').length, 2, 'a story sees every crossing that touches it');
  eq(crossingsFor(list, 'story-b').length, 1, 'from either end');
  eq(crossingsFor(list, 'nobody').length, 0, 'and a story with none sees none');

  eq(crossingsBetween(list, 'story-a', 'story-b').length, 1, 'a pair of stories sees only its own');
  eq(crossingsBetween(list, 'story-b', 'story-a').length, 1, 'whichever way it is asked');
  eq(crossingsBetween(list, 'story-b', 'story-c').length, 0, 'and two unconnected stories see none');

  eq(otherEnd(c1, 'story-a').storyId, 'story-b', 'the far end of a crossing is the other one');
  eq(otherEnd(c1, 'story-b').storyId, 'story-a', 'from either side');

  eq(removeCrossing(list, c1.id).length, 1, 'one can be removed');
  eq(removeCrossing(list, c1.id)[0].id, c2.id, 'leaving the rest');
  eq(updateCrossing(list, c1.id, { note: 'new' }).find(c => c.id === c1.id)?.note, 'new',
    'and one can be edited');
  eq(updateCrossing(list, c1.id, { note: 'new' }).find(c => c.id === c2.id)?.note, undefined,
    'without touching its neighbours');
}

{
  // The board opens on the work, not on the library.
  const list = [
    makeCrossing(A, B),
    makeCrossing(A, point({ storyId: 'story-c', messageId: 'm3' })),
  ];
  const stories = [
    { id: 'story-c', title: 'The Siege' },
    { id: 'story-a', title: 'The Inn' },
    { id: 'story-z', title: 'Unconnected' },
    { id: 'story-b', title: 'The Courier' },
  ];
  const ranked = suggestedStories(list, stories);
  eq(ranked[0].id, 'story-a', 'the most-crossed story comes first');
  eq(ranked[0].crossings, 2, 'with its count');
  eq(ranked[3].id, 'story-z', 'and one with no crossings comes last');
  // Ties break on title so the columns do not reshuffle between opens.
  eq(ranked[1].title, 'The Courier', 'ties break alphabetically, so the board is stable');
  eq(ranked[2].title, 'The Siege', 'in both directions');
}

/* ------------------------------------------------------------------ */
/* Excerpts                                                            */
/* ------------------------------------------------------------------ */

{
  eq(excerptOf('  a\n\n  b  '), 'a b', 'an excerpt is flattened to one line');
  const long = 'x'.repeat(EXCERPT_CHARS + 100);
  ok(excerptOf(long).length <= EXCERPT_CHARS, 'and capped');
  ok(excerptOf(long).endsWith('…'), 'with an ellipsis so the cut is visible');
  eq(excerptOf('short'), 'short', 'a short one is left alone');
}

/* ------------------------------------------------------------------ */
/* The kinds — each one asks a different question                      */
/* ------------------------------------------------------------------ */

{
  ok(CROSSING_KINDS.length >= 4, 'there are several kinds of connection');
  const asks = new Set(CROSSING_KINDS.map(k => k.ask));
  eq(asks.size, CROSSING_KINDS.length,
    'and every one asks a DIFFERENT question — a shared question would make the kinds decoration');
  for (const k of CROSSING_KINDS) {
    ok(k.ask.length > 80, `${k.kind}: the question is specific enough to steer an answer`);
    ok(!!k.hint.trim(), `${k.kind}: has a hint for the reader choosing it`);
    ok(!!k.label.trim(), `${k.kind}: has a label`);
  }
  eq(kindDef('contrast').kind, 'contrast', 'a kind can be looked up');
  eq(kindDef('nonsense' as never).kind, CROSSING_KINDS[0].kind, 'and an unknown one falls back');

  // The contrast question must allow the honest answer. A model pushed to
  // reconcile everything will invent a reconciliation, and the writer will
  // believe it.
  ok(/different worlds/i.test(kindDef('contrast').ask),
    'the contradiction question permits "they are simply different worlds"');
}

/* ------------------------------------------------------------------ */
/* The prompt — where blending would ruin it                           */
/* ------------------------------------------------------------------ */

{
  const c = makeCrossing(A, B, 'introduce');
  const msgs = buildCrossingMessages({ crossing: c });
  eq(msgs.length, 2, 'a self-contained system + user pair');
  eq(msgs[0].role, 'system', 'system first');

  const sys = msgs[0].content;
  ok(/separate stories/i.test(sys), 'the model is told these are separate stories');
  ok(/share no continuity/i.test(sys), 'and share no continuity');
  ok(/never write as though|do not assume/i.test(sys),
    'and is forbidden from writing them as already one — the failure this exists to stop');

  const user = msgs[1].content;
  ok(/STORY A/.test(user) && /STORY B/.test(user), 'the two ends are labelled and kept apart');
  ok(user.indexOf('STORY A') < user.indexOf('STORY B'), 'in a fixed order');
  ok(user.includes('The Inn') && user.includes('The Courier'), 'each named by its story');
  ok(user.includes('12') && user.includes('40'), 'and located by message number');
  ok(user.includes(A.excerpt) && user.includes(B.excerpt), 'with both passages present');
  ok(user.includes(kindDef('introduce').ask), 'and the kind\'s own question asked at the end');
  ok(user.lastIndexOf('THE QUESTION') > user.indexOf(B.excerpt),
    'the question comes after both passages, so it is the last thing read');
}

{
  // Fuller context replaces the excerpt when the caller has it — the excerpt is
  // a fallback for a crossing whose story is not loaded, not the intended input.
  const c = makeCrossing(A, B);
  const user = buildCrossingMessages({
    crossing: c,
    aContext: 'A much longer passage from the inn, several messages of it.',
    bContext: 'And a longer one from the road.',
  })[1].content;
  ok(user.includes('several messages of it'), 'given context, the context is used');
  ok(!user.includes(A.excerpt), 'and the excerpt is not also pasted in beside it');
}

{
  const c = makeCrossing(A, B, 'contrast', 'she says the bridge burned, he crosses it');
  const user = buildCrossingMessages({ crossing: c })[1].content;
  ok(user.includes('the bridge burned'), 'the reader\'s own note is passed through');
  ok(/WRITER'S NOTE/.test(user), 'labelled as theirs, not as a fact about the stories');

  const noNote = buildCrossingMessages({ crossing: makeCrossing(A, B) })[1].content;
  ok(!/WRITER'S NOTE/.test(noNote), 'and the label is absent when there is no note');
}

{
  const c = makeCrossing(A, B, 'parallel');
  const user = buildCrossingMessages({ crossing: c, question: 'Which one opens better?' })[1].content;
  ok(user.includes('Which one opens better?'), 'a reader\'s own question replaces the kind\'s');
  ok(!user.includes(kindDef('parallel').ask), 'rather than being asked alongside it');
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

{
  const c = makeCrossing(A, B, 'shared');
  ok(crossingSummary(c).includes('The Inn') && crossingSummary(c).includes('The Courier'),
    'a summary names both stories');
  ok(crossingSummary(c).includes('#12') && crossingSummary(c).includes('#40'),
    'and where in each');
  ok(crossingSummary(c).startsWith(kindDef('shared').label), 'led by what kind it is');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
