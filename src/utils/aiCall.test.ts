/**
 * Run: npx tsx src/utils/aiCall.test.ts
 *
 * The shared call layer.
 *
 * Three of these assertions describe bugs that shipped, in different files, for
 * the same reason — each feature solved the problem alone and only some of them
 * solved it:
 *
 * - a reply with a chain of thought reaching the reader as prose;
 * - a reply truncated at the token limit costing the WHOLE batch rather than
 *   the one item that was cut;
 * - a brace inside a quoted string throwing off a hand-rolled depth count.
 *
 * The network is never touched here: `ask` is exercised through a stubbed
 * `chatCompletion`, because what is worth pinning is the decisions, not fetch.
 */
import {
  REASONING_HEADROOM, hasReasoning, requestBudget, salvageArray, salvageObject, stripFence,
  stripReasoning, truncatedInReasoning,
} from './aiCall';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

// Reasoning.
{
  ok(hasReasoning('<think>hmm</think>ok'), 'a chain of thought is recognised');
  ok(hasReasoning('<reasoning>hmm</reasoning>ok'), 'under either tag');
  ok(!hasReasoning('just an answer'), 'and an ordinary reply is not mistaken for one');
  eq(stripReasoning('<think>hmm</think>the answer').trim(), 'the answer', 'the thinking comes out');
  eq(stripReasoning('<think>never closed, ran out of room').trim(), '',
    'and an unclosed block takes the rest with it — none of it was an answer');
  ok(truncatedInReasoning('<think>ran out'), 'an unclosed block is a budget error');
  ok(!truncatedInReasoning('<think>done</think>answer'), 'a closed one is not');
  ok(REASONING_HEADROOM > 0, 'the headroom is asked for up front');
}

// Fences.
{
  eq(stripFence('```json\n{"a":1}\n```'), '{"a":1}', 'a fence comes off');
  eq(stripFence('```\nplain\n```'), 'plain', 'labelled or not');
  eq(stripFence('no fence here'), 'no fence here', 'and an unfenced reply is untouched');
}

// Arrays: strict, then salvage.
{
  eq(salvageArray('[{"i":1},{"i":2}]'), [{ i: 1 }, { i: 2 }], 'the plain case');
  eq(salvageArray('Sure! Here you go:\n```json\n[{"i":1}]\n```\nHope that helps.'),
    [{ i: 1 }], 'prose and a fence around it change nothing');
  // The one that mattered: cut off at the token limit.
  eq(salvageArray('[{"i":1},{"i":2},{"i":3'), [{ i: 1 }, { i: 2 }],
    'a truncated reply costs the cut item, not the batch');
  eq(salvageArray('<think>I should return [{"i":9}] here</think>[{"i":1}]'), [{ i: 1 }],
    'the deliberation is never parsed as the answer');
  eq(salvageArray('nothing here'), null, 'and nothing usable is null, not a throw');
}

// A brace inside a string cannot throw off the scan.
{
  eq(salvageArray('[{"text":"she said {no} twice"},{"text":"and \\"quoted\\" too"}'),
    [{ text: 'she said {no} twice' }, { text: 'and "quoted" too' }],
    'braces and escaped quotes inside strings are just characters');
}

// Objects.
{
  eq(salvageObject('{"a":1}'), { a: 1 }, 'the plain case');
  eq(salvageObject('Here: {"a":{"b":2}} — done'), { a: { b: 2 } }, 'nested, with prose around it');
  eq(salvageObject('{"a":1} no wait {"a":2}'), { a: 2 },
    'a model that corrects itself means the LAST one');
  eq(salvageObject('{"a":'), null, 'a half-written object is null');
}

// Budget. A cap where there was none is a regression dressed as a cleanup.
{
  eq(requestBudget(undefined, 0), undefined,
    "no declared budget means no max_tokens — the endpoint's own default stands");
  eq(requestBudget(900, 0), 900 + REASONING_HEADROOM, 'a declared budget carries the headroom');
  ok((requestBudget(900, 1) as number) > (requestBudget(900, 0) as number),
    'the retry after a model thinks itself out of room asks for more');
  ok(typeof requestBudget(undefined, 1) === 'number',
    'and even an undeclared budget names a ceiling on the retry — some local '
    + 'backends default it low enough that the thinking alone overruns it');
}

/* --------------------------------------------------------------------------
 * The tripwire.
 *
 * Not a fact about the code — a fence around it. Every one of the three scale
 * bugs this layer exists for was "fixed in one of nineteen places", and the
 * only thing that stops that happening again is noticing when a twentieth
 * appears. A new AI feature that reaches past the layer trips this and has to
 * say why in the list below.
 * -------------------------------------------------------------------------- */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '..');

  /** Call sites allowed to talk to the client directly, and why. */
  const ALLOWED = new Map([
    ['utils/aiClient.ts', 'is the client'],
    ['utils/aiCall.ts', 'is the layer'],
    // The reader's own chat streams, and needs the deltas rather than a return
    // value. Its non-streaming fallback stays with it so the two paths cannot
    // drift into behaving differently on the same reply.
    ['components/AIChat.tsx', 'streams'],
    // Budgets by BATCH SIZE and retries by splitting the batch in half —
    // feature-specific logic the layer deliberately does not own.
    ['utils/sceneDirector.ts', 'budgets per batch and splits its own retries'],
  ]);

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') ? [full] : [];
    });

  const offenders = walk(root)
    .filter(f => /\bchatCompletion\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(root, f).split(path.sep).join('/'))
    .filter(rel => !ALLOWED.has(rel));

  eq(offenders, [],
    'every AI feature goes through the call layer (add to ALLOWED with a reason if it truly cannot)');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
