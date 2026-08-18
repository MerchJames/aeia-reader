/**
 * Run: npx tsx src/utils/imagePrompt.test.ts
 *
 * Turning a passage into an image prompt, and the two rules that make the
 * feature simple enough to be worth having.
 *
 *  1. The picture is of THIS beat. A prompt assembled from the whole story
 *     produces a generic portrait of the character instead of the moment you
 *     were reading, which is a worse result AND a bigger machine.
 *  2. What people LOOK like is not the model's to invent. The appearance sheet
 *     is prepended verbatim, outside the model's output, because asking a
 *     language model to remember a face across separate calls is precisely the
 *     thing it cannot do — and a face that changes every picture is the failure
 *     everyone who has tried this has hit.
 *
 * The dialects matter as much: SDXL wants comma tags and a negative, Flux wants
 * a sentence and DISCARDS negatives. Sending the wrong shape is most of why a
 * generated picture comes back wrong.
 */
import type { CardInfo, SceneDescriptor } from '../types';
import {
  appearanceFor, appearanceFromCard, buildPromptMessages, castFor, cleanPrompt, draftPrompt,
} from './imagePrompt';
import { IMAGE_PRESETS, composeNegative, composePrompt, presetById } from './imagePresets';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const base = {
  text: 'Mara set the lantern on the table and did not sit down. "You waited," she said.',
  speaker: 'Mara',
  characterName: 'Mara',
  userName: 'You',
  presetId: 'sdxl',
  appearance: { mara: 'red hair, green eyes, grey travelling coat' },
};

/* ---- the dialects ---- */

for (const p of IMAGE_PRESETS) {
  ok(p.instruction.length > 40, `${p.id}: says what shape it wants`);
  ok(p.size.width > 0 && p.size.height > 0, `${p.id}: has a native size`);
  ok(!p.usesNegative || p.negative.length > 0, `${p.id}: a dialect with negatives ships one`);
}

// Flux ignores the negative prompt. Sending one would read to the reader as
// "negatives don't work here" rather than "this model has none".
const flux = presetById('flux');
eq(flux.usesNegative, false, 'Flux declares that it has no use for a negative');
eq(composeNegative(flux, 'extra fingers'), '', 'so nothing is sent, not even what the reader typed');
eq(flux.negative, '', 'and none is kept around to look like it does something');

const sdxl = presetById('sdxl');
ok(composeNegative(sdxl, 'six fingers').includes('six fingers'), 'SDXL keeps the reader’s additions');
ok(composeNegative(sdxl, '').includes('watermark'), 'and its own defaults');

eq(presetById('nonsense').id, IMAGE_PRESETS[0].id, 'an unknown preset falls back rather than throwing');

/* ---- composition: appearance goes FIRST ---- */

const composed = composePrompt(sdxl, 'red hair, green eyes', 'a woman setting down a lantern');
ok(composed.startsWith(sdxl.prefix.trim()), 'the dialect prefix leads');
ok(composed.indexOf('red hair') < composed.indexOf('lantern'),
  'appearance is weighted ahead of the scene — the face must not vary between pictures');
ok(composed.includes(', '), 'a tag dialect joins on commas');

const prose = composePrompt(flux, 'She has red hair.', 'A woman sets down a lantern.');
ok(!/,\s*A woman/.test(prose), 'a prose dialect does not glue sentences with a comma');

eq(composePrompt(sdxl, '', 'a knight'), 'masterpiece, best quality, highly detailed, a knight',
  'an empty appearance sheet leaves no dangling separator');

/* ---- who is in frame ---- */

eq(JSON.stringify(castFor(base as never)), '["mara"]', 'the speaker is in frame');
ok(!castFor({ ...base, speaker: 'Narrator' } as never).includes('narrator'),
  'the narrator is not a person to draw');

// The lead counts only when the passage actually names them.
const withLead = castFor({ ...base, speaker: 'You', text: 'I watched Mara cross the room.' } as never);
ok(withLead.includes('mara') && withLead.includes('you'), 'a named lead joins the frame');
const without = castFor({ ...base, speaker: 'You', text: 'I watched the fire.' } as never);
ok(!without.includes('mara'), 'a lead who is not in the passage does not');

eq(appearanceFor(base as never).text, 'red hair, green eyes, grey travelling coat',
  'the sheet for whoever is in frame is used');
eq(appearanceFor({ ...base, appearance: {} } as never).text, '',
  'and nothing is invented when there is no sheet');

/* ---- the prompt sent to the model ---- */

const scene: SceneDescriptor = {
  messageId: 'm1', hash: 'h', mood: 'tense', tension: 0.7,
  location: 'a cold kitchen', timeOfDay: 'night', fx: 'smoke',
} as SceneDescriptor;

const msgs = buildPromptMessages({ ...base, scene } as never);
eq(msgs.length, 2, 'one system turn and one user turn');
ok(msgs[0].content.includes(sdxl.instruction), 'the dialect instruction is the system prompt');
ok(msgs[1].content.includes('cold kitchen'), 'the Director’s location reaches the model');
ok(msgs[1].content.includes('smoke'), 'and what is in the air, which a still can show');
ok(msgs[1].content.includes('lantern'), 'the passage itself is there');

// The model must not invent a face — that is the sheet's job, and two sources
// for one fact is how a character stops being the same person.
ok(/do not describe hair colour/i.test(msgs[0].content),
  'the model is told not to invent appearance');
ok(/only what a camera could see/i.test(msgs[0].content), 'and to stay visual');

// One moment, not the whole story: a 40k-character passage must not be sent.
const huge = buildPromptMessages({ ...base, text: 'x'.repeat(40_000) } as never);
ok(huge[1].content.length < 4000, 'a long passage is clamped');

/* ---- cleaning a chatty answer ---- */

eq(cleanPrompt('```\na knight, dusk\n```'), 'a knight, dusk', 'code fences are stripped');
eq(cleanPrompt('Prompt: a knight'), 'a knight', 'a "Prompt:" label is stripped');
eq(cleanPrompt('"a knight"'), 'a knight', 'and surrounding quotes');
eq(cleanPrompt('  a   knight \n dusk '), 'a knight dusk', 'whitespace is collapsed');

/* ---- the whole draft ---- */

const drafted = await draftPrompt(
  { ...base, scene } as never,
  async () => 'woman standing, lantern on table, dim kitchen, night',
);
ok(drafted.prompt.includes('red hair'), 'the sheet is in the final prompt');
ok(drafted.prompt.includes('lantern on table'), 'and so is what the model wrote');
ok(drafted.prompt.indexOf('red hair') < drafted.prompt.indexOf('lantern'), 'in that order');
ok(drafted.negative.includes('watermark'), 'the negative comes from the dialect');
eq(JSON.stringify(drafted.characters), '["mara"]', 'and it reports whose sheets it used');

let threw = '';
try { await draftPrompt(base as never, async () => '   '); } catch (e) { threw = (e as Error).message; }
ok(/nothing usable/.test(threw), 'an empty answer is an error, not an empty prompt sent to a GPU');

/* ---- seeding a sheet from the card ---- */

const card = {
  name: 'Mara',
  description: 'Mara runs the inn at the crossroads. She has red hair kept in a short braid and '
    + 'a long grey coat she never takes off. She distrusts strangers and counts every coin twice.',
} as CardInfo;
const sheet = appearanceFromCard(card);
ok(sheet.includes('red hair'), 'physical sentences are lifted from the card');
ok(sheet.includes('grey coat'), 'including clothing');
ok(!sheet.includes('distrusts strangers'), 'personality is left out — it is not visual');
eq(appearanceFromCard({ name: 'X', description: 'A quiet person who likes tea.' } as CardInfo), '',
  'a card that says nothing about appearance yields nothing, rather than guessing');
eq(appearanceFromCard(undefined), '', 'and no card yields nothing');
ok(!appearanceFromCard({ name: 'Mara', description: '{{char}} has red hair.' } as CardInfo).includes('{{char}}'),
  'placeholders are resolved, not leaked into a prompt');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
