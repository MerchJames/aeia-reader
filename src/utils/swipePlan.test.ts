/**
 * Run: npx tsx src/utils/swipePlan.test.ts
 *
 * Choosing which alternate of a message an export carries.
 *
 * SillyTavern keeps every regeneration as a swipe and then only lets you move
 * between them on the LAST message in the chat. Wanting version 2 of message
 * twelve means branching and pasting by hand, so the alternates sit in the file
 * unreachable. A plan makes them reachable, and the property that makes it
 * worth having is the narrow one:
 *
 *   **choosing an alternate for message twelve changes message twelve.**
 *
 * Not the ones before it, not the ones after it, not the count, not the order.
 * That is the whole feature, and it is asserted directly rather than inferred
 * from a rendered document.
 *
 * The quiet failure underneath is a STALE plan. A plan outlives the story it
 * was made against — a re-import, a branch merge, an edited swipe list — and an
 * index past the end of `swipes` falls straight through `resolveSwipe`'s
 * fallback, so the panel shows version 4 and the export carries version 1 with
 * nothing anywhere saying so.
 */
import {
  activeIndex, alternates, applyPlan, clampPlan, planSummary, resolveSwipe,
  type SwipePlan,
} from './swipePlan';
import type { Message } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const msg = (id: string, content: string, swipes?: string[]): Message =>
  ({ id, role: 'ai', name: 'Mara', content, ...(swipes ? { swipes } : {}) });

/** Five messages; the third has five alternates, sitting on the fifth. */
const STORY: Message[] = [
  msg('m1', 'one'),
  msg('m2', 'two'),
  msg('m3', 'three-e', ['three-a', 'three-b', 'three-c', 'three-d', 'three-e']),
  msg('m4', 'four'),
  msg('m5', 'five'),
];

/* ------------------------------------------------------------------ */
/* The feature                                                         */
/* ------------------------------------------------------------------ */

{
  const plan: SwipePlan = { m3: 1 };
  const out = applyPlan(STORY, plan);
  eq(out[2].content, 'three-b', 'message three carries the alternate that was chosen');
  eq(out.length, STORY.length, 'the story is the same length');
  eq(out[0].content, 'one', 'the message before it is untouched');
  eq(out[1].content, 'two', 'and so is the one before that');
  eq(out[3].content, 'four', 'the message after it is untouched');
  eq(out[4].content, 'five', 'and so is the last');
  eq(out[0], STORY[0], 'untouched messages are not even re-created');
  eq(out[3], STORY[3], 'on either side of the change');
  eq(STORY[2].content, 'three-e', 'and the story itself is never mutated');
  ok(out[2].swipes === STORY[2].swipes, 'the alternates all survive the choice');
}

// Several at once, which is the case ST cannot express at all.
{
  const out = applyPlan(
    [...STORY, msg('m6', 'six-b', ['six-a', 'six-b'])],
    { m3: 0, m6: 0 },
  );
  eq(out[2].content, 'three-a', 'two messages can be moved independently');
  eq(out[5].content, 'six-a', 'both of them');
  eq(out[4].content, 'five', 'with everything between left alone');
}

// No plan must be provably the export it always was.
{
  ok(applyPlan(STORY, {}) === STORY, 'an empty plan returns the very same array');
  ok(applyPlan(STORY, { m3: 4 }) === STORY,
    'and so does one that only names the version already showing');
  ok(applyPlan(STORY, { m1: 2 }) === STORY, 'or one that names a message with no alternates');
}

/* ------------------------------------------------------------------ */
/* Where the current version comes from                                */
/* ------------------------------------------------------------------ */

{
  eq(activeIndex(STORY[2]), 4, 'with no plan, the alternate matching the content is the active one');
  eq(activeIndex(STORY[2], { m3: 2 }), 2, 'a plan overrides it');
  eq(activeIndex(STORY[0]), 0, 'a message with no alternates is on nothing');
  eq(resolveSwipe(STORY[2], { m3: 0 }), 'three-a', 'resolving follows the plan');
  eq(resolveSwipe(STORY[0], { m1: 3 }), 'one', 'and a message with no swipes ignores it');

  // ST last landed on version 5, so version 5 is not "a change".
  const alts = alternates(STORY);
  eq(alts.length, 1, 'one message in this story has alternates');
  eq(alts[0].index, 3, 'reported at its reading position, 1-based');
  eq(alts[0].active, 4, 'sitting on the version the file shows');
  eq(alts[0].moved, false,
    'which is NOT counted as moved — otherwise every chat opens looking edited');
  eq(alternates(STORY, { m3: 1 })[0].moved, true, 'choosing a different one is');
}

/* ------------------------------------------------------------------ */
/* Stale plans                                                         */
/* ------------------------------------------------------------------ */

{
  eq(Object.keys(clampPlan({ gone: 2 }, STORY)).length, 0, 'a plan for a message that no longer exists is dropped');
  eq(Object.keys(clampPlan({ m3: 9 }, STORY)).length, 0, 'so is an index past the end of the alternates');
  eq(Object.keys(clampPlan({ m3: -1 }, STORY)).length, 0, 'and a negative one');
  eq(Object.keys(clampPlan({ m1: 0 }, STORY)).length, 0, 'and one on a message with nothing to choose');
  eq(clampPlan({ m3: 2 }, STORY).m3, 2, 'a good entry survives');

  // The one that matters: a stale index must not quietly export the wrong
  // version through resolveSwipe's fallback.
  eq(applyPlan(STORY, { m3: 99 })[2].content, 'three-e',
    'a stale plan falls back to what the story shows, not to alternate zero');
}

{
  eq(planSummary(STORY, {}), '1 message has alternates; none changed.',
    'a summary with nothing moved says so, and agrees with itself grammatically');
  eq(planSummary([...STORY, msg('m6', 'b', ['a', 'b'])], {}),
    '2 messages have alternates; none changed.', 'in the plural too');
  eq(planSummary(STORY, { m3: 1 }), '1 of 1 changed.', 'and one with something moved counts it');
  ok(/no message/i.test(planSummary([msg('a', 'x')], {})), 'a story with no alternates says that instead');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
