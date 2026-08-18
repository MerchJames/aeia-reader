/**
 * Run: npx tsx src/services/image/workflow.test.ts
 *
 * Reading a ComfyUI workflow.
 *
 * A graph is a program the reader assembled and no two look alike, so filling
 * in the prompt means FINDING the node that holds it. The two text prompts are
 * the same node type (`CLIPTextEncode`) and nothing in either says which is
 * which — only the sampler that consumes them does, via its `positive` and
 * `negative` links.
 *
 * Which makes the important test the one that fails: a graph this cannot read
 * must SAY so, not pick. Generating from the negative prompt produces a picture
 * of everything you asked to avoid, and it looks like the feature being bad
 * rather than misconfigured.
 */
import { detectMapping, fillWorkflow, parseWorkflow, type Workflow } from './workflow';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** A normal SDXL text-to-image graph, in ComfyUI's API format. */
const SDXL: Workflow = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  // Deliberately NOT in positive/negative order, and the negative is the lower
  // node id — ordering heuristics get this backwards.
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'ugly, blurry', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'a knight', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 12345, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['7', 0], negative: ['6', 0], latent_image: ['5', 0],
    },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'AeiaScene' } },
};

/* ---- parsing ---- */

ok(parseWorkflow(JSON.stringify(SDXL)) !== null, 'an API-format workflow parses');
eq(parseWorkflow(''), null, 'empty text is not a workflow');
eq(parseWorkflow('not json'), null, 'nor is garbage');
eq(parseWorkflow('[]'), null, 'nor an array');
eq(parseWorkflow('{}'), null, 'nor an empty object');
eq(parseWorkflow('{"a":{"foo":1}}'), null, 'nor an object whose values are not nodes');

// The UI export is the wrong file and the mistake everyone makes once. It
// cannot be sent to /prompt at all, so catching it here beats a bare 400.
eq(parseWorkflow('{"last_node_id":9,"nodes":[{"id":1}],"links":[]}'), null,
  'the UI-format export is rejected rather than half-accepted');

/* ---- detection: the sampler is the authority ---- */

const d = detectMapping(SDXL);
eq(d.mapping.positive, '7', 'the POSITIVE prompt is the node the sampler calls positive');
eq(d.mapping.negative, '6', 'and the negative is the one it calls negative');
ok(d.usable, 'the graph is usable');
eq(d.mapping.seed, '3', 'the seed is on the sampler');
eq(d.mapping.size, '5', 'the size is the empty-latent node');
ok(d.notes.some(n => n.includes('node 7')), 'the notes name what was found, so it can be checked');

// Node id order must not decide it — '6' sorts before '7' and is the negative.
ok(d.mapping.positive !== '6', 'node ordering does not decide which prompt is which');

/* ---- detection: refusing to guess ---- */

const noSampler: Workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a knight' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'ugly' } },
};
const dn = detectMapping(noSampler);
eq(dn.mapping.positive, undefined, 'two text nodes and no sampler: it does NOT pick one');
ok(!dn.usable, 'and reports the workflow as unusable until the reader chooses');
ok(dn.notes.some(n => n.includes('1') && n.includes('2')),
  'naming both candidates, so choosing is possible');

const oneText: Workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a knight' } },
  '2': { class_type: 'SaveImage', inputs: {} },
};
eq(detectMapping(oneText).mapping.positive, '1', 'a single text node is unambiguous, so it is used');

const noText: Workflow = { '1': { class_type: 'LoadImage', inputs: {} } };
ok(!detectMapping(noText).usable, 'a graph with no text node is not a text-to-image workflow');
ok(detectMapping(noText).notes.some(n => /CLIPTextEncode/.test(n)), 'and says why');

// A positive-only graph is legal and must not be reported as broken.
const posOnly: Workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a knight' } },
  '2': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0], model: ['9', 0] } },
};
const dp = detectMapping(posOnly);
eq(dp.mapping.positive, '1', 'a graph with only a positive prompt still resolves it');
eq(dp.mapping.negative, undefined, 'and reports no negative');
ok(dp.notes.some(n => /negative/i.test(n)), 'saying so, since negatives will be dropped');

// KSamplerAdvanced names its seed differently — missing this silently loses
// character continuity, which is the one thing seeds are for.
const advanced: Workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  '2': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 99, positive: ['1', 0] } },
};
eq(detectMapping(advanced).mapping.seed, '2', 'KSamplerAdvanced’s noise_seed counts as a seed');

/* ---- filling ---- */

const filled = fillWorkflow(SDXL, detectMapping(SDXL).mapping, {
  prompt: 'a knight at dusk', negative: 'blurry', width: 832, height: 1216, seed: 42,
});
eq(filled['7'].inputs.text, 'a knight at dusk', 'the positive node gets the prompt');
eq(filled['6'].inputs.text, 'blurry', 'the negative node gets the negative');
eq(filled['3'].inputs.seed, 42, 'the sampler gets the seed');
eq(filled['5'].inputs.width, 832, 'the latent gets the width');
eq(filled['5'].inputs.height, 1216, 'and the height');
eq(filled['3'].inputs.steps, 20, 'everything else is left exactly as the reader built it');
eq(filled['9'].inputs.filename_prefix, 'AeiaScene', 'including nodes it does not touch');

// The stored workflow is the reader's configuration and must survive a run —
// mutating it would bake the last prompt into every future generation.
eq(SDXL['7'].inputs.text, 'a knight', 'the ORIGINAL workflow is not mutated');
eq(SDXL['3'].inputs.seed, 12345, 'not even its seed');

// SDXL's dual encoder carries the same string twice; writing only `text`
// leaves half the prompt as whatever was saved with the graph.
const dual: Workflow = {
  '1': { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'old', text_l: 'old', width: 1024 } },
  '2': { class_type: 'KSampler', inputs: { seed: 0, positive: ['1', 0] } },
};
const dualFilled = fillWorkflow(dual, detectMapping(dual).mapping, { prompt: 'new', seed: 7 });
eq(dualFilled['1'].inputs.text_g, 'new', 'both halves of a dual encoder are written (g)');
eq(dualFilled['1'].inputs.text_l, 'new', 'both halves of a dual encoder are written (l)');

eq(fillWorkflow(advanced, detectMapping(advanced).mapping, { prompt: 'x', seed: 5 })['2'].inputs.noise_seed, 5,
  'noise_seed is written where that is the field name');

// A partial request must not blank out what it did not ask about.
const partial = fillWorkflow(SDXL, detectMapping(SDXL).mapping, { prompt: 'only the prompt' });
eq(partial['3'].inputs.seed, 12345, 'no seed given leaves the workflow’s own');
eq(partial['5'].inputs.width, 512, 'no size given leaves the workflow’s own');
eq(partial['6'].inputs.text, '', 'a negative node with nothing to say is cleared, not left stale');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
