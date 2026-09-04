/**
 * Run: npx tsx src/utils/toolArm.test.ts
 *
 * The strings in `toolArm.ts` are not decoration — they are the entire contract
 * with the model. A reader who clicks "Lens edit → #12" has said something very
 * specific, and the only thing that carries it to a 7B model running on their
 * own machine is the wording of the directive.
 *
 * So the tests assert the load-bearing phrases rather than the prose around
 * them: that the target is named by number (a model left to infer "this one"
 * from the conversation rewrites the wrong passage), that the instruction is an
 * order rather than a suggestion (a small model reading "you may wish to" will
 * consider it and then not do it), and that a proposal is never described as a
 * change already made.
 */
import {
  armDirective, armIncomplete, armLabel, armNeedsTools, armPlaceholder,
  armScopeLabel, clampTargets, MAX_ARM_TARGETS, type ArmedTool,
} from './toolArm';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const lens = (targets: number[]): ArmedTool => ({ tool: 'lens.propose', targets });
const newPin: ArmedTool = { tool: 'pins.create' };
const updatePin: ArmedTool = { tool: 'pins.newVersion', pinId: 'pin-4f2', title: 'Cast' };

/* ------------------------------------------------------------------ */
/* Naming the target                                                   */
/* ------------------------------------------------------------------ */

{
  const d = armDirective(lens([12]));
  ok(d.includes('#12'), 'the directive names the message by number');
  ok(/do not rewrite any other/i.test(d), 'and forbids touching anything else');
  ok(/do not ask which one/i.test(d),
    'and stops the model asking a question the reader already answered by clicking');
  ok(/story\.read/.test(d), 'it is told to read the passage before rewriting it');
  ok(/lens\.propose/.test(d), 'and which tool to call');
  ok(/COMPLETE/.test(d), 'and that the whole passage is required, not a fragment');
}

{
  const d = armDirective(lens([4, 12, 30]));
  ok(d.includes('#4') && d.includes('#12') && d.includes('#30'), 'every target is named');
  ok(/one at a time|One tool call per reply/i.test(d),
    'and a multi-target edit says to go one at a time — the loop reads one block per reply');
  ok(/messages/.test(d), 'the wording pluralises');
  ok(!/messages/.test(armDirective(lens([7]))), 'and stays singular for one');
}

/* ------------------------------------------------------------------ */
/* Never claiming the edit is done                                     */
/* ------------------------------------------------------------------ */

{
  // The failure this prevents: a reader is told "I've made her colder", believes
  // the story changed, and finds out an hour later that it did not — or worse,
  // does not find out.
  const d = armDirective(lens([12]));
  ok(/suggestion/i.test(d), 'a rewrite is described to the model as a suggestion');
  ok(/accepts or rejects/i.test(d), 'with a person deciding');
  ok(/Never claim the story has been changed/i.test(d), 'and saying otherwise is forbidden outright');
}

/* ------------------------------------------------------------------ */
/* Pins                                                                */
/* ------------------------------------------------------------------ */

{
  const d = armDirective(newPin);
  ok(/pins\.create/.test(d), 'the new-pin directive names the tool');
  ok(/do not answer in the chat instead/i.test(d),
    'and closes the most common failure — answering the question rather than making the pin');
  ok(/do not ask whether they want a pin/i.test(d), 'the reader already said so by arming it');
  ok(/pins\.list/.test(d), 'while still pointing at the existing pins first');
  ok(/pins\.newVersion/.test(d), 'so a duplicate becomes an update instead');
}

{
  const d = armDirective(updatePin);
  ok(d.includes('pin-4f2'), 'the update directive carries the id');
  ok(d.includes('Cast'), 'and the title, so the model can talk about it');
  ok(/pins\.read/.test(d), 'it must read the pin before rewriting it');
  ok(/replaces the pin/i.test(d), 'and is told the content is a whole replacement');
  ok(/never send a fragment or a diff/i.test(d), 'in as many words');
  ok(/previous version stays/i.test(d), 'and reassured nothing is destroyed, so it does not hedge');
}

/* ------------------------------------------------------------------ */
/* The composer's own labels                                           */
/* ------------------------------------------------------------------ */

{
  eq(armLabel(lens([12])), 'Lens edit → #12', 'one target reads as the message number');
  eq(armLabel(lens([3, 12])), 'Lens edit → 2 messages', 'several read as a count');
  eq(armLabel(newPin), 'New pin', 'a new pin says so');
  eq(armLabel(updatePin), 'Update pin — Cast', 'an update names the pin');

  ok(armPlaceholder(lens([1])).length > 10, 'every arm changes what the input asks for');
  ok(armPlaceholder(newPin) !== armPlaceholder(lens([1])), 'and asks for different things');
  ok(/e\.g\./.test(armPlaceholder(lens([1]))), 'with an example, since the ask is not obvious');

  eq(armScopeLabel(lens([12])), 'Lens → #12', 'the turn is labelled with what it was for');
  eq(armScopeLabel(lens([3, 12])), 'Lens → #3, #12', 'listing every target');
  eq(armScopeLabel(newPin), 'New pin', 'and pins likewise');
}

/* ------------------------------------------------------------------ */
/* Arming implies tools                                                */
/* ------------------------------------------------------------------ */

{
  // Without this, arming with the tool toggle off sends the directive and NO
  // catalogue: the model writes a fenced block, nothing parses it, and the
  // reader sees raw JSON where their rewrite should be.
  ok(armNeedsTools(lens([1])), 'a Lens arm turns tools on for the turn');
  ok(armNeedsTools(newPin), 'so does a pin arm');
  ok(!armNeedsTools(null), 'and nothing armed leaves the toggle alone');
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

{
  ok(armIncomplete(lens([])), 'a Lens edit with nothing selected cannot be sent');
  ok(!armIncomplete(lens([1])), 'one target is enough');
  ok(!armIncomplete(newPin), 'a pin needs no target');
}

{
  eq(clampTargets([12, 3, 12, 7]).join(','), '3,7,12', 'targets are deduped and put in reading order');
  eq(clampTargets([0, -4, 2.5, 6]).join(','), '6', 'and anything that is not a reading position is dropped');
  eq(clampTargets([]).length, 0, 'none is fine');

  // The cap tracks MAX_STEPS in the agent loop: each target costs a read and a
  // propose, so more than this runs the loop out mid-way and the reader gets
  // half their rewrites and no word about the rest.
  const many = Array.from({ length: 40 }, (_, i) => i + 1);
  eq(clampTargets(many).length, MAX_ARM_TARGETS, 'too many targets are capped');
  eq(clampTargets(many)[0], 1, 'keeping the earliest, so the cap is predictable');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
