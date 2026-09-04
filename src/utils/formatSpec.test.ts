/**
 * Run: npx tsx src/utils/formatSpec.test.ts
 *
 * A reader who uploads their anatomy chart wants THEIR anatomy chart back —
 * not a tidied one, not the model's idea of what an anatomy chart looks like,
 * and not one missing the four fields the model found least interesting.
 *
 * So the suite has one non-negotiable assertion, repeated on every input:
 *
 *   the reader's literal text appears, unmodified, inside the instruction.
 *
 * Everything else — detecting JSON, walking XML, listing fields — is an EXTRA.
 * It makes the model fill the form in reliably rather than write prose about
 * it. When parsing fails or the input is shapeless, the extra is simply absent
 * and the verbatim template still goes through, because "I could not parse
 * your form" is never a good enough reason to refuse it.
 */
import {
  MAX_TEMPLATE_CHARS, describeFormat, detectFormatKind, formatProblem, parseFormat,
  renderFormatInstruction,
} from './formatSpec';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** The promise, checked on everything. */
const keepsTemplate = (text: string, label: string) => {
  const out = renderFormatInstruction(parseFormat(text));
  ok(out.includes(text.trim()), `${label}: the reader's own form is in the instruction, verbatim`);
};

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

{
  eq(detectFormatKind('{"a": 1}'), 'json', 'an object is JSON');
  eq(detectFormatKind('[{"a": 1}]'), 'json', 'so is an array');
  eq(detectFormatKind('{not really json}'), 'plain',
    'but something that only LOOKS like JSON is not — a near-miss must not be parsed as one');
  eq(detectFormatKind('<sheet><name/></sheet>'), 'xml', 'a closed document is XML');
  eq(detectFormatKind('# Title\n\nbody'), 'markdown', 'headings are markdown');
  eq(detectFormatKind('Name:\nWeaknesses:\n'), 'outline',
    'and a hand-written form with bare labels is a form, syntax or no syntax');
  eq(detectFormatKind('just a sentence'), 'plain', 'prose is prose');
  eq(detectFormatKind(''), 'plain', 'and nothing is plain');
}

/* ------------------------------------------------------------------ */
/* JSON — the case the feature was asked for                           */
/* ------------------------------------------------------------------ */

{
  // The user's own example: an anatomy chart for a monster story.
  const chart = `{
  "anatomy": {
    "silhouette": "one line",
    "limbs": ["name and what it does"],
    "senses": ["which sense, how far"],
    "weaknesses": []
  }
}`;
  const spec = parseFormat(chart);
  eq(spec.kind, 'json', 'read as JSON');
  eq(spec.title, 'anatomy', 'a single wrapper key names the document');
  const paths = spec.fields.map(f => f.path);
  ok(paths.includes('anatomy.limbs'), 'nested fields are found by path');
  ok(paths.includes('anatomy.senses') && paths.includes('anatomy.weaknesses'),
    'every one of them, including the empty array');
  ok(spec.fields.find(f => f.path === 'anatomy.limbs')?.list === true,
    'an array field is marked as taking one entry per item');
  ok(spec.fields.find(f => f.path === 'anatomy.silhouette')?.list === false,
    'and a scalar is not');
  eq(spec.fields.find(f => f.path === 'anatomy.silhouette')?.hint, 'one line',
    'the value the reader wrote is kept as the instruction for that field');
  eq(spec.fields.find(f => f.path === 'anatomy.limbs')?.hint, 'name and what it does',
    'including the one inside an array');

  const out = renderFormatInstruction(spec);
  ok(out.includes(chart.trim()), 'the chart is reproduced in the instruction exactly');
  ok(/do not rename a field/i.test(out), 'with the rule stated');
  ok(/do not.*drop one/i.test(out), 'including the one that stops fields going missing');
  ok(out.includes('anatomy.weaknesses'), 'and every field is listed as a checklist');
  ok(/output is JSON/i.test(out), 'a JSON form says the output is JSON');

  // Order matters: the rule has to be read before the form, or a model starts
  // improving the form it just read.
  ok(out.indexOf('EXACTLY') < out.indexOf(chart.trim()),
    'the rule comes before the template, not after it');
  keepsTemplate(chart, 'anatomy chart');
}

{
  // Deep nesting is trimmed rather than followed forever.
  const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: 1 } } } } } });
  const spec = parseFormat(deep);
  ok(spec.fields.every(f => f.depth <= 4), 'the field list stops descending at a sensible depth');
  keepsTemplate(deep, 'deeply nested');
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

{
  const sheet = `<creature>
  <name>the name</name>
  <limb>one per limb</limb>
  <limb/>
  <habitat><region/><climate/></habitat>
</creature>`;
  const spec = parseFormat(sheet);
  eq(spec.kind, 'xml', 'read as XML');
  eq(spec.title, 'creature', 'the document element names it');
  const paths = spec.fields.map(f => f.path);
  ok(paths.includes('name'), 'the wrapper is stripped — its children are the fields');
  ok(!paths.includes('creature'), 'the document element is not itself a field');
  ok(paths.includes('habitat.region'), 'nested elements keep their path');
  ok(spec.fields.find(f => f.path === 'limb')?.list === true,
    'a repeated sibling means "one per item"');
  eq(spec.fields.find(f => f.path === 'name')?.hint, 'the name',
    'and the text inside an element is that field\'s instruction');

  const out = renderFormatInstruction(spec);
  ok(/output is XML/i.test(out), 'an XML form says so');
  keepsTemplate(sheet, 'creature sheet');
}

/* ------------------------------------------------------------------ */
/* Markdown and hand-written forms                                     */
/* ------------------------------------------------------------------ */

{
  const doc = `# Location sheet

## Name
## What it looks like
### At night
## Who is there`;
  const spec = parseFormat(doc);
  eq(spec.kind, 'markdown', 'read as markdown');
  eq(spec.title, 'Location sheet', 'the single top heading is the title');
  const paths = spec.fields.map(f => f.path);
  ok(!paths.includes('Location sheet'), 'and is not also listed as a field');
  ok(paths.includes('Name'), 'the second-level headings are the fields');
  ok(paths.some(p => p.includes('At night')), 'and a third-level one nests under its parent');
  keepsTemplate(doc, 'location sheet');
}

{
  // Somebody pasting out of a notes app. No syntax at all, still a shape.
  const scrawl = `Name:
Appearance:
Weaknesses:
Notes: anything odd`;
  const spec = parseFormat(scrawl);
  eq(spec.kind, 'outline', 'a bare list of labels is recognised as a form');
  eq(spec.fields.length, 4, 'every label becomes a field');
  eq(spec.fields.find(f => f.path === 'Notes')?.hint, 'anything odd',
    'and text after the colon is that field\'s instruction');
  keepsTemplate(scrawl, 'hand-written form');
}

/* ------------------------------------------------------------------ */
/* The failures that must NOT be failures                              */
/* ------------------------------------------------------------------ */

{
  // Unparseable is not unusable. This is the important one: refusing a form
  // because it has no recognisable syntax would reject the most likely paste.
  const prose = 'A paragraph on what the thing is, then a paragraph on where it lives.';
  const spec = parseFormat(prose);
  eq(spec.kind, 'plain', 'shapeless text is plain');
  eq(spec.fields.length, 0, 'with no fields to list');
  const out = renderFormatInstruction(spec);
  ok(out.includes(prose), 'and it is STILL used, verbatim, as the form');
  ok(!/Every field must appear/.test(out), 'with the checklist simply absent rather than empty');
  ok(/no named fields/i.test(describeFormat(spec)), 'and the panel says as much, plainly');
}

{
  // Broken JSON: detected as plain, so it goes through as literal text rather
  // than being thrown away.
  const broken = '{"anatomy": {"limbs": [,,]}}';
  const out = renderFormatInstruction(parseFormat(broken));
  ok(out.includes(broken), 'a malformed form is passed through rather than rejected');
  keepsTemplate(broken, 'broken JSON');
}

{
  eq(formatProblem('   '), 'Paste or drop a form first.', 'an empty paste is refused, with a reason');
  eq(formatProblem('{"a":1}'), null, 'an ordinary form is fine');
  const huge = 'x'.repeat(MAX_TEMPLATE_CHARS + 1);
  ok(formatProblem(huge) !== null, 'an enormous one is refused');
  ok(/every pass/i.test(formatProblem(huge) ?? ''),
    'and the reason is the real one — it is restated on every pass, so it costs every pass');
  ok(/trim it to the shape/i.test(formatProblem(huge) ?? ''), 'with something to do about it');
}

{
  eq(renderFormatInstruction(parseFormat('')), '', 'no form means no instruction at all');
  eq(renderFormatInstruction(parseFormat('   \n ')), '', 'and whitespace is no form');
}

/* ------------------------------------------------------------------ */
/* Describing it back                                                  */
/* ------------------------------------------------------------------ */

{
  ok(/4 fields/.test(describeFormat(parseFormat('a:\nb:\nc:\nd:\n'))), 'the panel counts the fields');
  ok(/1 field\b/.test(describeFormat(parseFormat('only:'))), 'in the singular when there is one');
  ok(/anatomy/.test(describeFormat(parseFormat('{"anatomy":{"x":"y"}}'))),
    'and names the form when it found a name');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
