/** Run: npx tsx src/utils/sceneDirector.test.ts */
import { SceneDescriptor } from '../types';
import {
  DESCRIPTOR_VERSION, SCENE_SYSTEM_PROMPT as SYSTEM, applyBatchBudget, buildEnrichMessages,
  directorSamplers, hasReasoning, isStale, outputBudget, parseDescriptors, ScenePassage,
  stripReasoning, truncatedInReasoning,
} from './sceneDirector';
import { tasteBlock } from './tasteBlock';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const P = (id: string, content = 'text'): ScenePassage => ({ messageId: id, name: 'Elara', content });
const passages = [P('a'), P('b'), P('c'), P('d')];

// The model names a place once, then returns null — the null passages inherit it,
// so the scene never blanks out or jumps mid-thread.
const reply = JSON.stringify([
  { i: 1, mood: 'neutral', tension: 0.2, location: 'the tavern common room' },
  { i: 2, mood: 'tense', tension: 0.4, location: null },
  { i: 3, mood: 'tense', tension: 0.5, location: null },
  { i: 4, mood: 'ominous', tension: 0.7, location: 'the cellar stairs' },
]);
const ds = parseDescriptors(reply, passages);
ok(ds[0].location === 'the tavern common room', 'first names the location');
ok(ds[1].location === 'the tavern common room' && ds[2].location === 'the tavern common room', 'null passages carry the location forward');
ok(ds[3].location === 'the cellar stairs', 'a clear move updates the location');

// A batch seeded with the prior batch's location carries it into leading nulls.
const reply2 = JSON.stringify([{ i: 1, mood: 'neutral', tension: 0.2, location: null }]);
const seeded = parseDescriptors(reply2, [P('x')], Date.now(), 'the mountain pass');
ok(seeded[0].location === 'the mountain pass', 'seed carries into a batch that opens on null');
const unseeded = parseDescriptors(reply2, [P('x')]);
ok(unseeded[0].location === undefined, 'no seed + null → genuinely no location');

// The previous location is fed into the enrichment prompt for grounding.
const msgs = buildEnrichMessages([P('a')], undefined, 'the tavern common room');
ok(/PREVIOUS LOCATION: the tavern common room/.test(msgs[1].content), 'prompt carries the previous location');
ok(!/PREVIOUS LOCATION/.test(buildEnrichMessages([P('a')])[1].content), 'no previous-location line when none given');
ok(/LOCATION CONTINUITY/i.test(msgs[0].content), 'system prompt states the continuity rule');

// --- enrichment dialogue attribution ----------------------------------------
const dPassages = [P('m', 'He turned to Elara. "It is good to see you," he said, and she smiled.')];
const dReply = JSON.stringify([{
  i: 1, mood: 'tender', tension: 0.3,
  dialogue: [
    { text: 'It is good to see you', speaker: 'Kaelen' },      // verbatim → kept
    { text: 'a line not in the passage', speaker: 'Ghost' },   // not verbatim → dropped
    { text: 'It is good to see you', speaker: '' },            // no speaker → dropped
  ],
}]);
const dd = parseDescriptors(dReply, dPassages);
ok(!!dd[0].dialogue && dd[0].dialogue.length === 1, 'only verbatim, named dialogue entries survive');
ok(dd[0].dialogue![0].speaker === 'Kaelen' && /good to see you/i.test(dd[0].dialogue![0].text), 'the attributed speaker + line are kept');
ok(/DIALOGUE ATTRIBUTION/i.test(buildEnrichMessages([P('a')])[0].content), 'the system prompt asks for dialogue attribution');

// --- performance cues --------------------------------------------------------
const pText = 'He set the cup down. In. the. end. she never answered him at all.';
const pReply = JSON.stringify([{
  i: 1, mood: 'melancholy', tension: 0.4,
  perform: [
    { text: 'In. the. end.', kind: 'stagger', strength: 1.2 },   // kept
    { text: 'she never answered', kind: 'fade', strength: 9 },   // kept, strength clamped
    { text: 'not in the passage', kind: 'slow' },                // not verbatim → dropped
    { text: 'the cup', kind: 'wobble' },                         // unknown kind → dropped
    { text: 'In. the. end.', kind: 'drop' },                     // duplicate span → dropped
  ],
}]);
const pd = parseDescriptors(pReply, [P('p', pText)]);
ok(pd[0].perform?.length === 2, 'only valid, verbatim, non-duplicate cues survive');
ok(pd[0].perform?.[0].kind === 'stagger' && pd[0].perform?.[0].strength === 1.2, 'the cue kind + strength are kept');
ok(pd[0].perform?.[1].strength === 1.5, 'an out-of-range strength is clamped');
// A cue long enough to swallow the passage would drag the whole reveal.
const longReply = JSON.stringify([{ i: 1, mood: 'neutral', tension: 0.2, perform: [{ text: 'x'.repeat(200), kind: 'slow' }] }]);
ok(parseDescriptors(longReply, [P('q', 'x'.repeat(200))])[0].perform === undefined, 'an over-long cue span is rejected');
ok(/PERFORMANCE/i.test(buildEnrichMessages([P('a')])[0].content), 'the system prompt asks for the performance track');

// --- surviving a truncated reply ---------------------------------------------
// A reply cut off at the token limit used to lose the WHOLE batch: the array
// never closes, JSON.parse throws, and ten passages come back empty.
const cut = '[\n'
  + '{"i":1,"mood":"tense","tension":0.6,"location":"the bridge"},\n'
  + '{"i":2,"mood":"ominous","tension":0.7},\n'
  + '{"i":3,"mood":"action","tensio';   // ← stops mid-token
const salvaged = parseDescriptors(cut, [P('t1'), P('t2'), P('t3')]);
ok(salvaged.length === 2, 'the complete descriptors survive a truncated reply');
ok(salvaged[0].location === 'the bridge' && salvaged[1].mood === 'ominous', 'and they keep their values');

// Prose or a note around the array doesn't stop it either.
const chatty = 'Sure! Here are the descriptors:\n```json\n[{"i":1,"mood":"joyful","tension":0.2}]\n```\nHope that helps.';
ok(parseDescriptors(chatty, [P('c1')]).length === 1, 'fenced//chatty replies still parse');
// A brace inside a string must not confuse the salvage scanner.
const braces = '[{"i":1,"mood":"eerie","tension":0.5,"location":"a room with a { in the sign"}';
ok(parseDescriptors(braces, [P('b1')])[0]?.location?.includes('{'), 'braces inside strings are safe');
ok(parseDescriptors('total nonsense, no json here', [P('n1')]).length === 0, 'garbage yields nothing');

// --- the reply budget ---------------------------------------------------------
// A fully-populated descriptor is ~180 tokens; ten of them must fit.
ok(outputBudget(10) >= 1800, 'a full batch is given room to finish');
ok(outputBudget(1) >= 700, 'a single-passage retry still has a floor');
ok(outputBudget(10) > outputBudget(5), 'the budget scales with the batch');

// --- descriptor versioning ----------------------------------------------------
// A passage read by an older build must be picked up again, or none of the
// newer direction (performance cues, weather strength) ever reaches the story.
const content = 'The lantern guttered out.';
const fresh = parseDescriptors(JSON.stringify([{ i: 1, mood: 'eerie', tension: 0.6 }]), [P('v', content)])[0];
ok(fresh.v === DESCRIPTOR_VERSION, 'new reads are stamped with the current version');
ok(!isStale(fresh, content), 'a current descriptor is not stale');
ok(isStale({ ...fresh, v: undefined }, content), 'a descriptor from before versioning is stale');
ok(isStale({ ...fresh, v: DESCRIPTOR_VERSION - 1 }, content), 'an older generation is stale');
ok(isStale(fresh, 'different text'), 'edited text is still stale, as before');
ok(!isStale({ ...fresh, v: DESCRIPTOR_VERSION + 1 }, content),
  'a descriptor from a NEWER build is left alone, not thrown away');

// --- grounding on the whole-story read ---------------------------------------
// The read is weighting, not facts: it must reach the prompt, and the prompt
// must say plainly that doing nothing is a real answer.
const read = {
  v: 1, hash: 'h', count: 12, createdAt: 0,
  arc: 'A woman avoids the key she carries.',
  cast: [{ name: 'Mara', register: 'clipped' }],
  places: ['lantern room'],
  motifs: ['brass key'],
};
const grounded = buildEnrichMessages([P('a')], undefined, undefined, read as never);
ok(/STORY READ \(for weighting only\)/.test(grounded[1].content), 'the story read reaches the prompt');
ok(/brass key/.test(grounded[1].content), 'including its motifs');
ok(/Mara \(clipped\)/.test(grounded[1].content), 'and how the cast sounds');
ok(!/STORY READ/.test(buildEnrichMessages([P('a')])[1].content), 'no read means no empty heading');
ok(/RESTRAINT/i.test(SYSTEM), 'the system prompt licenses abstaining');
ok(/Doing nothing is a real answer/i.test(SYSTEM), 'and says so in as many words');
ok(/weight/i.test(SYSTEM), 'and explains the read is for weight, not facts');

// --- sampling: a reading, not a writing ---------------------------------------
// Left to backend defaults this was 8/9/10 perform cues on the SAME batch.
const local = directorSamplers('http://localhost:5001/v1');
ok(local.temperature === 0, 'the Director decodes greedily');
ok(local.top_k === 1 && local.repetition_penalty === 1, 'local backends get the extended knobs pinned');
// repetition_penalty on a JSON array penalises the field names it must repeat.
ok(local.repetition_penalty === 1, 'no repetition penalty on structured output');
const remote = directorSamplers('https://api.openai.com/v1');
ok(remote.temperature === 0 && remote.top_p === 1, 'remote endpoints still decode greedily');
ok(remote.top_k === undefined && remote.repetition_penalty === undefined,
  'but never receive non-OpenAI params — a strict endpoint 400s on them');

// --- the batch budget ---------------------------------------------------------
// Measured: a 10-passage batch came back with a perform cue on all ten and only
// one passage left alone, greedily and reproducibly. The prompt asks for
// restraint; the validator has to enforce it.
const D = (id: string, tension: number): SceneDescriptor => ({
  messageId: id, hash: 'h', v: 3, mood: 'neutral', tension, createdAt: 0,
  perform: [{ text: 'x', kind: 'slow' }],
  emphasis: [{ text: 'x', kind: 'beat' }],
  fx: 'rain', fxLevel: 0.6, vfx: 'flash',
});
const batch = Array.from({ length: 10 }, (_, i) => D(`p${i}`, i / 10));
const budgeted = applyBatchBudget(batch.map(d => ({ ...d })));
const count = (k: 'perform' | 'emphasis' | 'fx' | 'vfx') =>
  budgeted.filter(d => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : !!d[k])).length;
ok(count('perform') === 4, 'perform is capped at its share of the batch');
ok(count('emphasis') === 3, 'so is emphasis');
ok(count('fx') === 3, 'so is weather');
ok(count('vfx') === 3, 'so is screen vfx');
ok(budgeted.filter(d => !d.perform && !d.emphasis && !d.fx && !d.vfx).length >= 5,
  'most of the batch is now genuinely left alone');
// The budget spends the Director's own judgement, not ours.
ok(budgeted[9].perform !== undefined, 'the highest-tension passage keeps its cue');
ok(budgeted[0].perform === undefined, 'the flattest passage loses it first');
ok(budgeted.every(d => d.fx || d.fxLevel === undefined), 'weather strength never outlives its weather');
// Determinism: the same input must always drop the same cues, or a re-read
// silently reshuffles the performance.
const again = applyBatchBudget(batch.map(d => ({ ...d })));
ok(JSON.stringify(again) === JSON.stringify(budgeted), 'the budget is deterministic');
// Ties keep the earlier passage rather than an arbitrary one.
const flat = applyBatchBudget(Array.from({ length: 8 }, (_, i) => D(`f${i}`, 0.5)));
ok(flat[0].perform !== undefined && flat[7].perform === undefined, 'ties resolve by story order');
// A short batch is proportion-free: quotas there would silence a real moment.
const tiny = applyBatchBudget([D('a', 0.9), D('b', 0.8)]);
ok(tiny.every(d => !!d.perform), 'a batch of two is left alone entirely');
// Nothing is invented: a budget can only take away.
ok(applyBatchBudget([]).length === 0, 'an empty batch is fine');

/* ---- reasoning models -------------------------------------------------------
 *
 * A thinking model spends its OUTPUT budget before it answers. The Director's
 * budget was sized against the JSON alone, so the chain of thought consumed the
 * whole allowance, the array never arrived, the reply parsed to nothing, the
 * batch was split, and both halves failed the same way. The reader saw
 * "unreadable" on a model that reads perfectly well.
 *
 * The Director was also the only module in the app that never stripped
 * reasoning — and it is the one where that matters most, because the salvage
 * parser scans for balanced braces and deliberation ABOUT a JSON schema is full
 * of them.
 * -------------------------------------------------------------------------- */

ok(hasReasoning('<think>let me see</think>[]'), 'a chain of thought is recognised');
ok(hasReasoning('<reasoning>hmm'), 'and so is the other tag');
ok(!hasReasoning('[{"i":1,"mood":"calm"}]'), 'a plain answer is not mistaken for one');

ok(truncatedInReasoning('<think>I should look at'), 'an unclosed block is a truncated reply');
ok(!truncatedInReasoning('<think>done</think>[]'), 'a closed one is not');
ok(!truncatedInReasoning('[]'), 'and neither is a reply with no thinking at all');

eq(stripReasoning('<think>plan</think>[{"i":1}]'), '[{"i":1}]', 'the block is removed');
eq(stripReasoning('<reasoning>x</reasoning>[]'), '[]', 'both tag spellings are removed');
eq(stripReasoning('<think>cut off here'), '', 'an unclosed block takes the rest with it');
eq(stripReasoning('[{"i":1}]'), '[{"i":1}]', 'a plain answer is untouched');

// THE reason this matters: deliberation about the schema parses as descriptors.
const deliberating = '<think>I will return [{"i": 1, "mood": "dread"}] for the first one'
  + ' and {"i": 2, "mood": "awe"} for the second</think>\n[{"i":1,"mood":"tense","tension":0.2}]';
const fromRaw = parseDescriptors(deliberating, [P('r1'), P('r2')]);
const fromClean = parseDescriptors(stripReasoning(deliberating), [P('r1'), P('r2')]);
eq(fromClean.length, 1, 'stripped, exactly the one real descriptor is read');
eq(fromClean[0].mood, 'tense', 'and it is the one the model actually answered with');
// This used to be the reason the caller HAD to strip first: the salvage parser
// hunts for balanced braces, and a model reasoning about a JSON schema is full
// of them, so the deliberation came back as three descriptors — one of them a
// mood the model had only been considering. The shared salvage in `aiCall`
// strips before it scans, so the parser is now safe whether or not its caller
// remembered. Asserted from the RAW reply, because that is the version a new
// call site will pass in by accident.
eq(fromRaw.length, 1, 'the parser refuses to read deliberation, stripped or not');
eq(fromRaw[0].mood, 'tense', 'and gives back only what the model actually answered');
ok(!fromRaw.some(d => d.mood === 'awe'),
  'never a mood the model was only considering');

// The headroom is only asked for once thinking has been seen, and it is a
// CEILING, not a spend — so a model that never thinks never pays for it.
ok(outputBudget(4, true) > outputBudget(4, false), 'a reasoning run is budgeted more');
eq(outputBudget(4), outputBudget(4, false), 'and the default is the lean budget');
ok(outputBudget(1, true) >= 4000, 'enough room for a chain of thought on a single passage');
// Asked for UP FRONT: a ceiling costs a non-thinking model nothing, and waiting
// to be caught mid-thought cost two failed batches on a slow local model.
ok(outputBudget(1) >= 4000, 'and the room is there before anyone has thought at all');
ok(outputBudget(10, true) > outputBudget(10), 'a model that thinks long still gets more');


/* --- the typographic emphasis kinds --------------------------------------- */

const eText = 'She read the letter twice. "I am not coming back," it said, and that was all.';
{
  const reply = JSON.stringify([{
    i: 1, mood: 'melancholy', tension: 0.5,
    emphasis: [
      { text: 'not coming back', kind: 'color', color: 'blue' },
      { text: 'twice', kind: 'underline' },
      { text: 'that was all', kind: 'strike' },
    ],
  }]);
  const d = parseDescriptors(reply, [P('e1', eText)])[0];
  eq(d.emphasis?.length, 3, 'all three typographic kinds are accepted');
  eq(d.emphasis?.[0].color, 'blue', 'and a palette colour is kept');
}

// The colour is a label on a judgement the model already made. Getting the label
// wrong is not a reason to throw the judgement away.
{
  const reply = JSON.stringify([{
    i: 1, mood: 'melancholy', tension: 0.5,
    emphasis: [{ text: 'twice', kind: 'color', color: 'chartreuse' }],
  }]);
  const d = parseDescriptors(reply, [P('e2', eText)])[0];
  eq(d.emphasis?.length, 1, 'an invented colour still leaves the span marked');
  eq(d.emphasis?.[0].color, undefined, 'it just falls back to the accent');
}

// The old rules have to survive the new vocabulary.
{
  const reply = JSON.stringify([{
    i: 1, mood: 'melancholy', tension: 0.5,
    emphasis: [
      { text: 'never written here', kind: 'underline' },
      { text: 'twice', kind: 'sparkle' },
    ],
  }]);
  const d = parseDescriptors(reply, [P('e3', eText)])[0];
  eq(d.emphasis, undefined, 'a span that is not in the passage, and a kind that does not exist, are both dropped');
}

// The taste block reaches the prompt, and sits where it was meant to sit.
{
  const taste = tasteBlock([
    { text: 'he never came back', kind: 'fade', track: 'perform', at: 1 },
  ]);
  const user = buildEnrichMessages([P('a')], undefined, undefined, undefined, taste)[1].content;
  ok(user.includes('he never came back'), "the reader's own marks reach the Director");
  ok(user.indexOf('PASSAGES:') < user.indexOf("THIS READER'S OWN MARKS"),
    'after the passages — it shapes HOW to choose, so it wants the tail of the U');
  ok(user.lastIndexOf('Return the JSON array') > user.indexOf("THIS READER'S OWN MARKS"),
    'but never after the task itself');
  const bare = buildEnrichMessages([P('a')], undefined, undefined, undefined, '')[1].content;
  ok(!/THIS READER/.test(bare), 'a reader who has marked nothing changes nothing about the prompt');
}

for (const k of ['underline', 'strike', 'color']) {
  ok(SYSTEM.includes(`"${k}"`), `the prompt teaches "${k}"`);
}
ok(SYSTEM.includes('ransom note'), 'and says plainly what overusing them looks like');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
