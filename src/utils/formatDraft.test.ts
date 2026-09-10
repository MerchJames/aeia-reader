/**
 * Run: npx tsx src/utils/formatDraft.test.ts
 *
 * The cost of a wrong answer here is unusually high and unusually late. Whatever
 * comes out of this becomes the `format` of a long read, restated verbatim on
 * every one of twenty passes — so a paragraph that slips through is not a bad
 * template, it is twenty passes of a model being told to reproduce a paragraph.
 * The reader finds out at the end.
 *
 * So most of what is asserted below is what gets REFUSED.
 */

import {
  MAX_IDEA_CHARS, buildDraftPrompt, exampleValues, ideaProblem, looksLikeForm, readDraft,
} from './formatDraft';
import { MAX_TEMPLATE_CHARS } from './formatSpec';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++; else { fail++; console.error('✗', msg); }
};
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── The idea going in ───────────────────────────────────────────────────── */

ok(!!ideaProblem(''), 'an empty idea is refused');
ok(!!ideaProblem('   \n  '), 'and so is whitespace');
eq(ideaProblem('an anatomy chart with limbs and injuries'), null, 'a sentence is enough to work from');
ok(!!ideaProblem('x'.repeat(MAX_IDEA_CHARS + 1)), 'a whole document pasted in is refused');

/* ── The prompt ──────────────────────────────────────────────────────────── */

const prompt = buildDraftPrompt('an anatomy chart', 'json');
const flat = prompt.replace(/\s+/g, ' ');
ok(flat.includes('an anatomy chart'), 'the prompt carries the reader’s words');
ok(flat.includes('single JSON object'), 'and the shape they asked for');
ok(
  /Reply with the form itself and nothing else/.test(flat),
  // Last, deliberately: it is the instruction most often obeyed, and the one
  // whose failure is most expensive.
  'the no-prose rule is the last thing said',
);
ok(
  flat.includes('Never an example answer'),
  // Because the template is restated every pass, an example value is not a
  // harmless illustration — it is twenty repetitions of a steer.
  'and placeholders are required to be instructions, not example content',
);
ok(buildDraftPrompt('x').includes('Choose the simplest shape'), 'auto leaves the shape to the model');

/* ── Recognising a form ──────────────────────────────────────────────────── */

ok(looksLikeForm('{"name": "the character’s name"}'), 'JSON is a form');
ok(looksLikeForm('# Anatomy\n\n## Limbs\n'), 'markdown headings are a form');
ok(looksLikeForm('name: who they are\nage: how old they are'), 'labelled lines are a form');
ok(looksLikeForm('<chart><limb>which limb</limb></chart>'), 'XML is a form');
ok(
  !looksLikeForm('You could structure this as a chart with a section for each limb.'),
  'a sentence about a form is not a form',
);
ok(
  !looksLikeForm('Anatomy chart: a useful way to track injuries across a long story.'),
  // One colon in a sentence is not a labelled line. Two is the floor, because
  // one is what prose does.
  'and neither is one sentence that happens to contain a colon',
);

/* ── Reading the reply ───────────────────────────────────────────────────── */

const fenced = readDraft('```json\n{\n  "name": "the character’s name"\n}\n```');
eq(fenced.rejected, null, 'a fenced answer is accepted');
ok(fenced.text.startsWith('{'), 'with the fence taken off');

const preambled = readDraft('Here is the form:\n\nname: who they are\nage: how old they are');
eq(preambled.rejected, null, 'a one-line preamble is dropped');
ok(preambled.text.startsWith('name:'), 'leaving the form');

ok(
  !!readDraft('Sure! I think a good structure would be to have one section per limb, '
    + 'with a note about each injury underneath. That way you can see at a glance.').rejected,
  'an answer that explains instead of answering is refused',
);
ok(
  !!readDraft('').rejected && !!readDraft('   ').rejected,
  'and so is an empty one',
);
ok(
  !!readDraft(`{"a": "${'x'.repeat(MAX_TEMPLATE_CHARS)}"}`).rejected,
  'a form too long to restate every pass is refused',
);
ok(
  (readDraft('I could not do that.').rejected ?? '').includes('paste the shape you want'),
  // A dead end with no way out is worse than the feature not existing. The
  // refusal points back at the box that already worked before this was added.
  'and the refusal says what to do instead',
);

const prosyFence = readDraft('Here is one option:\n\n```\n{"a": "what goes here"}\n```\n\nLet me know!');
ok(
  prosyFence.rejected !== null || prosyFence.text.includes('what goes here'),
  'prose wrapped around a fence either reads out or is refused — never silently kept whole',
);

/* ── Example content ─────────────────────────────────────────────────────── */

const examples = exampleValues('{"name": "Marcus Vale", "eyes": "the colour of their eyes"}');
ok(examples.some(e => e.includes('Marcus Vale')), 'a placeholder that is a real name is flagged');
ok(!examples.some(e => e.includes('colour')), 'and an instruction is not');
eq(
  exampleValues('{"name": "The character’s name"}'), [],
  'a description that happens to start with a capital is not an example',
);

const warned = readDraft('{"name": "Marcus Vale"}');
eq(warned.rejected, null, 'example content is a warning, not a refusal');
ok(
  warned.examples.length > 0,
  // Refusing would send the reader round again over something that may be
  // fine; saying nothing would let twenty passes quietly write about Marcus.
  'but the reader is told before they commit to it',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
