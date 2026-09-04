/**
 * Run: npx tsx src/utils/promptPipeline.test.ts
 *
 * What may and may not be done to a prompt on its way to the model.
 *
 * This runs on every message the reader sends, on the real prompt SillyTavern
 * assembled, and a mistake here is not a bad suggestion — it is a story written
 * from the wrong context, or not written at all. Three properties carry that
 * weight:
 *
 * **Nothing is mutated.** In the browser path SillyTavern hands over the live
 * array it is about to send. Editing it in place would change the prompt even
 * on a run that decided to do nothing.
 *
 * **A block goes in whole or not at all.** A truncated fact is worse than a
 * missing one: a model given "her left arm is" finishes the sentence itself,
 * confidently, and the reader has no way to know why.
 *
 * **The reader's turn survives everything.** Filters exist to remove context.
 * The last user message is the instruction, and a prompt without it is not the
 * prompt they asked for.
 */
import {
  applyPlan, blockText, describePlan, type ChatMsg, type PromptBlock,
} from './promptPipeline';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const PROMPT: ChatMsg[] = [
  { role: 'system', content: 'You are Mara.' },
  { role: 'assistant', content: 'She set the lamp down.' },
  { role: 'user', content: 'I watched the door.' },
];

const block = (over: Partial<PromptBlock> = {}): PromptBlock => ({
  id: 'b1', title: 'Anatomy', text: 'Mara has no left arm.', slot: 'system', ...over,
});

/* ── Nothing is mutated ──────────────────────────────────────────────────── */
{
  const before = JSON.stringify(PROMPT);
  const out = applyPlan(PROMPT, { blocks: [block()], drop: ['lamp'], instructionLast: true });
  eq(JSON.stringify(PROMPT), before, 'the prompt handed in is the prompt handed in');
  ok(out.messages.every(m => !PROMPT.includes(m)), 'and every message out is a new object');
}

/* ── Doing nothing ───────────────────────────────────────────────────────── */
{
  const out = applyPlan(PROMPT, { blocks: [] });
  eq(out.messages, PROMPT, 'an empty plan passes the prompt through unchanged');
  eq(out.added, 0, 'adding nothing');
  eq(describePlan(out), 'passed through unchanged', 'and says so plainly');
}

/* ── Where material goes ─────────────────────────────────────────────────── */
{
  const sys = applyPlan(PROMPT, { blocks: [block({ slot: 'system' })] });
  eq(sys.messages.length, 3, 'a system block joins the system turn rather than making a new one');
  ok(sys.messages[0].content.startsWith('You are Mara.'), 'after what was already there');
  ok(sys.messages[0].content.includes('Mara has no left arm.'), 'carrying the material');
  ok(sys.messages[0].content.includes('[Anatomy]'), 'labelled, so the model can tell it from prose');

  // Several system turns in a row is a shape some backends collapse and others
  // refuse; neither is worth risking for a formatting choice.
  eq(sys.messages.filter(m => m.role === 'system').length, 1, 'and there is still only one');

  const none = applyPlan(
    [{ role: 'user', content: 'Hello.' }],
    { blocks: [block({ slot: 'system' })] },
  );
  eq(none.messages[0].role, 'system', 'with no system turn, one is made');
  eq(none.messages.length, 2, 'at the top');

  const near = applyPlan(PROMPT, { blocks: [block({ slot: 'before-last-user' })] });
  eq(near.messages[2].role, 'system', 'a near block sits immediately before the reader’s turn');
  eq(near.messages[3].content, 'I watched the door.', 'which still follows it');

  const end = applyPlan(PROMPT, { blocks: [block({ slot: 'end' })] });
  eq(end.messages.length, 4, 'an end block is appended');
  ok(end.messages[3].content.includes('no left arm'), 'in the highest-attention position there is');
}

/* ── The budget ──────────────────────────────────────────────────────────── */
{
  const big = block({ id: 'b2', title: 'Long', text: 'x'.repeat(500) });
  const out = applyPlan(PROMPT, { blocks: [block(), big], budget: 100 });
  eq(out.injected, ['Anatomy'], 'what fits goes in');
  eq(out.skipped.length, 1, 'and what does not is reported');
  eq(out.skipped[0].title, 'Long', 'by name');
  ok(!out.messages[0].content.includes('xxx'), 'with none of it present');
  // The whole reason for the rule: a model handed "her left arm is" will
  // finish the sentence itself, and the reader cannot tell why it went wrong.
  ok(!out.messages.some(m => m.content.includes('x'.repeat(50))),
    'a block is never cut in half to make it fit');

  const empty = applyPlan(PROMPT, { blocks: [block({ text: '   ' })] });
  eq(empty.injected.length, 0, 'an empty block is not material');
  eq(empty.skipped[0].reason, 'it is empty', 'and says why it was left out');
}

/* ── Dropping ────────────────────────────────────────────────────────────── */
{
  const out = applyPlan(PROMPT, { blocks: [], drop: ['lamp'] });
  eq(out.messages.length, 2, 'a matching context message is removed');
  eq(out.dropped, 1, 'and counted');

  const survives = applyPlan(PROMPT, { blocks: [], drop: ['watched the door'] });
  eq(survives.messages.length, 3, 'but the reader’s own turn is never dropped');
  eq(survives.dropped, 0, 'however well it matches');

  eq(applyPlan(PROMPT, { blocks: [], drop: ['LAMP'] }).dropped, 1, 'matching ignores case');
  eq(applyPlan(PROMPT, { blocks: [], drop: [''] }).dropped, 0, 'and an empty filter matches nothing');
}

/* ── Order of operations ─────────────────────────────────────────────────── */
{
  // Injecting before dropping would place a block relative to a message that
  // is about to disappear, and the reader would see it move for no reason.
  const out = applyPlan(
    [
      { role: 'system', content: 'System.' },
      { role: 'assistant', content: 'Drop me.' },
      { role: 'user', content: 'Keep me.' },
    ],
    { blocks: [block({ slot: 'before-last-user' })], drop: ['drop me'] },
  );
  eq(out.messages.map(m => m.role), ['system', 'system', 'user'],
    'the block lands beside the turn that is still there');
  eq(out.messages[2].content, 'Keep me.', 'and the instruction is last');
}

/* ── The instruction last ────────────────────────────────────────────────── */
{
  const out = applyPlan(PROMPT, {
    blocks: [block({ slot: 'end' })],
    instructionLast: true,
  });
  eq(out.messages[out.messages.length - 1].content, 'I watched the door.',
    'the reader’s turn is moved back to the end, after the material');
  eq(out.messages.length, 4, 'and nothing is lost doing it');

  const already = applyPlan(PROMPT, { blocks: [], instructionLast: true });
  eq(already.messages, PROMPT, 'a prompt already ending in the reader’s turn is untouched');

  const noUser = applyPlan(
    [{ role: 'system', content: 'S.' }, { role: 'assistant', content: 'A.' }],
    { blocks: [], instructionLast: true },
  );
  eq(noUser.messages.length, 2, 'and a prompt with no user turn is left alone rather than mangled');
}

/* ── What the reader is told ─────────────────────────────────────────────── */
{
  const out = applyPlan(PROMPT, {
    blocks: [block(), block({ id: 'b3', title: 'Too big', text: 'y'.repeat(9000) })],
    drop: ['lamp'],
  });
  const line = describePlan(out);
  ok(line.includes('added 1'), 'it says what went in');
  ok(line.includes('dropped 1'), 'and what came out');
  ok(line.includes('did not fit'), 'and what would not fit');
}

/* ── The wrapper ─────────────────────────────────────────────────────────── */
{
  eq(blockText(block({ text: '  padded  ' })), '[Anatomy]\npadded', 'a block is titled and trimmed');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
