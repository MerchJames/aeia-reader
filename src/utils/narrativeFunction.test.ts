/**
 * Run: npx tsx src/utils/narrativeFunction.test.ts
 *
 * The narrative-function axis.
 *
 * Three properties carry this file.
 *
 * **The round trip loses nothing.** Render → parse → render has to be a fixed
 * point, because everything the feature is FOR happens between those two steps:
 * reorder the sections, hand each one its own instruction, rewrite toward a
 * shape. `renderNarrativeBlocks` was one-way, which is exactly why none of that
 * could be built on it. A parser that silently drops an unlabelled paragraph
 * would lose the reader's prose, which is the one unrecoverable failure here.
 *
 * **The channel wins where the channel is the answer.** A quoted line is speech
 * because it is in quotes. The model is asked for a reading, not a veto, and
 * `labelFunctions` must not let it relabel the two kinds that are already
 * decided by punctuation.
 *
 * **A character is introduced once.** "First appearance" is a fact about the
 * story so far, not about the passage in hand, so it is carried in a set the
 * caller threads forward — and the second mention of somebody has to come back
 * as detail or action, never as a second introduction.
 */
import {
  FUNCTION_LABEL, NARRATIVE_FUNCTIONS, NarrativeFunction, buildFunctionMessages,
  floorFunction, floorFunctions, functionBudget, functionFromLabel, functionsPresent,
  labelFunctions, parseFunctionBlocks, parseFunctionLabels, renderFunctionBlocks,
  reorderByFunction,
} from './narrativeFunction';
import { NarrativeBlock } from './narrativeBlocks';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const block = (
  kind: NarrativeBlock['kind'], text: string, speaker = 'Mara',
): NarrativeBlock => ({ kind, speaker, text });

/* ── The taxonomy is internally consistent ───────────────────────────────── */
{
  ok(NARRATIVE_FUNCTIONS.length === new Set(NARRATIVE_FUNCTIONS).size,
    'no function is listed twice');
  ok(NARRATIVE_FUNCTIONS.every(f => !!FUNCTION_LABEL[f]),
    'every function has a label to write into a bracket');
  // Both spellings, because a model asked for "Character introduction" answers
  // "introduction" often enough that being strict would throw away good reads.
  eq(functionFromLabel('Character introduction'), 'introduction', 'the written label parses');
  eq(functionFromLabel('  INTRODUCTION '), 'introduction', 'and so does the bare key, any case');
  eq(functionFromLabel('Vibes'), null, 'anything else is not a function');
}

/* ── The channel decides, where the channel is the answer ────────────────── */
{
  eq(floorFunction(block('dialogue', 'Wait')), 'speech', 'a quoted line is speech');
  eq(floorFunction(block('thought', 'not again')), 'interiority', 'a thought is interiority');
}

/* ── A character is introduced exactly once ──────────────────────────────── */
{
  const introduced = new Set<string>();
  const ctx = { cast: ['Mara'], introduced };
  eq(floorFunction(block('narration', 'Mara stood in the doorway.'), ctx), 'introduction',
    'the first appearance of a cast name puts somebody on the page');
  eq(floorFunction(block('narration', 'Mara turned and walked to the window.'), ctx), 'action',
    'the second is whatever she is DOING, not another introduction');

  // Reading from the middle introduces nobody, which is the honest answer —
  // better than calling every passage an introduction.
  const seen = new Set(['mara']);
  eq(floorFunction(block('narration', 'Mara stood in the doorway.'), { cast: ['Mara'], introduced: seen }),
    'action', 'a name already met is never re-introduced');
}

/* ── World, action and detail are told apart by the verb ─────────────────── */
{
  const ctx = { cast: ['Mara'], introduced: new Set(['mara']) };
  eq(floorFunction(block('narration', 'The wind took the shutter and the rain came in.'), ctx),
    'world', 'nobody in it, and the subject is the weather');
  eq(floorFunction(block('narration', 'She pulled the door closed.'), ctx),
    'action', 'a person and a verb of motion');
  eq(floorFunction(block('narration', 'She was thin, and her hands were steady.'), ctx),
    'detail', 'a person and a verb of state');
}

/* ── The round trip is a fixed point ─────────────────────────────────────── */
{
  const blocks = floorFunctions([
    block('narration', 'The hearth had burned down to embers.'),
    block('dialogue', 'You think I did not know.'),
    block('narration', 'She set the cup down and stood.'),
  ], { cast: ['Mara'], introduced: new Set(['mara']) });

  const rendered = renderFunctionBlocks(blocks);
  ok(rendered.includes('[World movement]'),
    'world movement is nobody’s line, so it carries no speaker');
  ok(rendered.includes(`[${FUNCTION_LABEL.speech} - Mara]`),
    'everything else names whose it is');

  const back = parseFunctionBlocks(rendered, 'Mara');
  eq(back.map(b => b.fn), blocks.map(b => b.fn), 'every function survives the round trip');
  eq(back.map(b => b.text), blocks.map(b => b.text), 'and so does every word');
  eq(renderFunctionBlocks(back), rendered, 'render → parse → render is a fixed point');
}

/* ── Parsing a model's answer never loses prose ──────────────────────────── */
{
  // A model that forgets to label its opening paragraph must not cost the
  // reader that paragraph.
  const stray = parseFunctionBlocks(
    'The candle guttered out.\n\n[Char action - Mara]\nShe stood up.', 'Mara',
  );
  eq(stray.length, 2, 'text before the first header is kept, not dropped');
  ok(stray[0].text.includes('candle'), 'and it is kept verbatim');
  eq(stray[1].fn, 'action', 'the labelled block still parses');

  const junk = parseFunctionBlocks('[Not A Function - Mara]\nsome words', 'Mara');
  ok(junk.length === 1 && junk[0].text.includes('[Not A Function - Mara]'),
    'an unrecognised header is prose, not a lost block');
}

/* ── Reorder moves sections without losing or shuffling any ──────────────── */
{
  const blocks = [
    { ...block('dialogue', 'one'), fn: 'speech' as NarrativeFunction },
    { ...block('narration', 'two'), fn: 'world' as NarrativeFunction },
    { ...block('dialogue', 'three'), fn: 'speech' as NarrativeFunction },
    { ...block('narration', 'four'), fn: 'action' as NarrativeFunction },
  ];
  const moved = reorderByFunction(blocks, ['world', 'speech']);
  eq(moved.map(b => b.text), ['two', 'one', 'three', 'four'],
    'listed functions lead, in the order given');
  ok(moved.length === blocks.length, 'nothing is dropped');
  eq(moved.filter(b => b.fn === 'speech').map(b => b.text), ['one', 'three'],
    'and within a function the writing keeps its own order');

  // A function the reader did not list keeps its place at the back rather than
  // vanishing — silently deleting a section would be unrecoverable.
  eq(reorderByFunction(blocks, ['speech']).map(b => b.text), ['one', 'three', 'two', 'four'],
    'unlisted functions are kept, not cut');

  eq(functionsPresent(blocks), ['world', 'action', 'speech'],
    'the functions actually present come back in canonical order');
}

/* ── The model's reply is read defensively ───────────────────────────────── */
{
  eq(parseFunctionLabels(['World movement', 'nonsense', 'Char action'], 3),
    ['world', null, 'action'], 'a bad entry is null and the good ones survive');
  eq(parseFunctionLabels(['World movement'], 3), ['world', null, null],
    'a short reply leaves the rest to the floor');
  eq(parseFunctionLabels('not an array', 2), [null, null], 'so does a reply that is not a list');
  eq(parseFunctionLabels(['a', 'b', 'c', 'd'], 2).length, 2, 'a long reply is clamped');

  ok(functionBudget(1) > 0 && functionBudget(20) > functionBudget(1),
    'the budget grows with the passage and is never zero');
  const msgs = buildFunctionMessages([block('narration', 'x'), block('dialogue', 'y')]);
  eq(msgs.length, 2, 'a system brief and one user turn');
  ok(msgs[0].content.includes('Character introduction'),
    'the brief names the labels it wants back');
  ok(msgs[1].content.includes('1.') && msgs[1].content.includes('2.'),
    'and the blocks are numbered so the array lines up');
}

/* ── With no endpoint it still labels the whole passage ──────────────────── */
{
  const blocks = [block('dialogue', 'Wait'), block('narration', 'The room was cold.')];
  labelFunctions(blocks, null, { cast: ['Mara'], introduced: new Set(['mara']) })
    .then(out => {
      eq(out.length, blocks.length, 'no endpoint still returns every block');
      eq(out[0].fn, 'speech', 'and the floor labels them');
      console.log(`${pass} passed, ${fail} failed`);
      if (fail) process.exit(1);
    })
    .catch(e => { console.error('✗ labelFunctions threw with no endpoint', e); process.exit(1); });
}
