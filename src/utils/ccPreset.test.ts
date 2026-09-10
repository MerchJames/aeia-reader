/**
 * Run: npx tsx src/utils/ccPreset.test.ts
 *
 * What is being protected here is mostly *silence*. Every way a preset import
 * can go wrong produces a preset that imports, looks plausible, and sends the
 * wrong thing:
 *
 *   - reading the decoy prompt order gives eleven built-in slots and none of
 *     the author's work;
 *   - reading `prompts[]` instead of the order gives all 326, including every
 *     draft the author switched off years ago;
 *   - dropping an unfillable marker without saying so sends a preset with no
 *     chat history in it, which still answers, just badly.
 *
 * None of those throw. So the assertions below are counts and names.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MARKER_SLOTS, MAX_PICKS, ST_LEGACY_ORDER_ID, ST_ORDER_ID,
  addPick, buildPrompt, describePreset, emptyCompletion, isFillableMarker,
  movePick, presetProblem, previewCompletion, readCcPreset, removePick,
  resolvePicks, samplersFor, sourcesSquash, squash,
  type CcPreset, type LensCompletion,
} from './ccPreset';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++; else { fail++; console.error('✗', msg); }
};
const eq = (a: unknown, b: unknown, msg: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── The id that decides whether an import means anything ────────────────── */

// A tripwire, not a tautology. SillyTavern's base PromptManager declares 100000
// and the chat-completion one overrides it to 100001; presets in the wild carry
// both lists, and the 100000 one is the eleven-slot decoy. If somebody ever
// "simplifies" this to the first list in the file, every import silently loses
// the author's entire preset and still reports success.
eq(ST_ORDER_ID, 100001, 'the global prompt order is read from character_id 100001');
eq(ST_LEGACY_ORDER_ID, 100000, 'and 100000 is only a fallback');

/* ── Refusals ────────────────────────────────────────────────────────────── */

ok(!!presetProblem(''), 'an empty file is refused');
ok(!!presetProblem('not json'), 'a non-JSON file is refused');
ok(!!presetProblem('[1,2,3]'), 'a JSON array is refused');
ok(!!presetProblem('{"temperature":1}'), 'an object with no prompts is refused');
ok(
  (presetProblem('{"temperature":1}') ?? '').includes('Text completion'),
  'and the refusal says which kind of preset this reads, because that is the likely mistake',
);
eq(presetProblem('{"prompts":[]}'), null, 'a preset with an empty prompt list is allowed through');

/* ── The order is the preset ─────────────────────────────────────────────── */

const twoOrders = JSON.stringify({
  temperature: 0.9,
  top_p: 0.95,
  openai_max_tokens: 700,
  openai_max_context: 32000,
  squash_system_messages: true,
  prompts: [
    { identifier: 'main', name: 'Main', content: 'Be good.', role: 'system', system_prompt: true },
    { identifier: 'a', name: 'Author A', content: 'Style rules.', role: 'system' },
    { identifier: 'b', name: 'Author B', content: 'Old draft.', role: 'system' },
    { identifier: 'chatHistory', name: 'Chat History', content: '', role: 'system', marker: true },
  ],
  prompt_order: [
    // The decoy: shorter, and first in the file.
    { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: 'a', enabled: true },
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'b', enabled: false },
      ],
    },
  ],
});

eq(presetProblem(twoOrders), null, 'a real-shaped preset reads');
const preset = readCcPreset(twoOrders, 'Test', 'p1');

eq(
  preset.prompts.map(p => p.identifier),
  ['a', 'main', 'chatHistory', 'b'],
  'the prompts come back in the ORDER’s order, not the file’s',
);
eq(
  preset.prompts.filter(p => p.enabled).map(p => p.identifier),
  ['a', 'main', 'chatHistory'],
  'and only what the order switched on is on',
);
eq(preset.samplers.temperature, 0.9, 'samplers are read');
eq(preset.samplers.max_tokens, 700, 'openai_max_tokens is the answer budget');
eq(preset.contextSize, 32000, 'and openai_max_context is kept apart from it');
ok(preset.squashSystem, 'squash_system_messages is carried');

/* ── Prompts the order forgot ────────────────────────────────────────────── */

const orphan = JSON.stringify({
  prompts: [
    { identifier: 'a', name: 'In the order', content: 'A', role: 'system' },
    { identifier: 'z', name: 'Not in the order', content: 'Z', role: 'system', enabled: true },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
});
const withOrphan = readCcPreset(orphan, 'Orphan', 'p2');
eq(withOrphan.prompts.length, 2, 'a prompt the order never mentions is still kept');
eq(
  withOrphan.prompts.find(p => p.identifier === 'z')?.enabled,
  false,
  // This is the difference between "importable" and "runnable". The pile is
  // there so a Lens Completion can pick out of it; it is not the preset.
  'but it is OFF, even though its own `enabled` said true — the order is the authority',
);

const noOrder = readCcPreset(
  JSON.stringify({ prompts: [{ identifier: 'a', name: 'A', content: 'A', enabled: true }] }),
  'No order', 'p3',
);
eq(
  noOrder.prompts[0].enabled, true,
  'with no order at all, the prompt’s own flag is all there is, so it is used',
);

const missing = readCcPreset(
  JSON.stringify({
    prompts: [{ identifier: 'a', name: 'A', content: 'A' }],
    prompt_order: [{
      character_id: 100001,
      order: [{ identifier: 'gone', enabled: true }, { identifier: 'a', enabled: true }],
    }],
  }),
  'Missing', 'p4',
);
eq(missing.prompts.map(p => p.identifier), ['a'], 'an order entry with no prompt behind it is dropped');

/* ── Markers ─────────────────────────────────────────────────────────────── */

// A count, so adding a slot is a decision. Each of these is a claim that Aeia
// has the reader's real material to put there; a slot added without the
// plumbing behind it sends an empty string into an author's careful position.
eq(Object.keys(MARKER_SLOTS).length, 6, 'six markers are claimed as fillable');
ok(isFillableMarker('chatHistory'), 'the story is one of them');
ok(!isFillableMarker('worldInfoBefore'),
  'world info is NOT: it is keyword-triggered lorebook text, and a pin set is not that');

const markerPrompts = [
  { identifier: 'main', name: 'Main', content: 'Be good.', role: 'system' as const, marker: false, builtin: true, absolute: false, depth: 4, order: 100, enabled: true },
  { identifier: 'chatHistory', name: 'Chat History', content: '', role: 'system' as const, marker: true, builtin: false, absolute: false, depth: 4, order: 100, enabled: true },
  { identifier: 'worldInfoBefore', name: 'World Info', content: '', role: 'system' as const, marker: true, builtin: false, absolute: false, depth: 4, order: 100, enabled: true },
];

const filled = buildPrompt(markerPrompts, { chatHistory: 'Once upon a time.' });
eq(filled.messages.length, 2, 'a filled marker becomes a message');
eq(filled.messages[1].content, 'Once upon a time.', 'holding what was given for it');
eq(filled.dropped.length, 1, 'and the one nothing can fill is dropped');
ok(
  filled.dropped[0].includes('worldInfoBefore'),
  // The failure this prevents: a preset that quietly sends no world info reads
  // as a preset that works, and the reader spends an evening wondering why the
  // model forgot their setting.
  'by name, so the reader is told what their preset wanted and did not get',
);

const unfilled = buildPrompt(markerPrompts, {});
eq(unfilled.messages.length, 1, 'a fillable marker with nothing in it is still dropped');
ok(unfilled.dropped.some(d => d.includes('Chat History')), 'and named too');

/* ── Absolute-position prompts ───────────────────────────────────────────── */

const depths = buildPrompt([
  { identifier: 'r', name: 'Relative', content: 'R', role: 'system', marker: false, builtin: false, absolute: false, depth: 0, order: 100, enabled: true },
  { identifier: 'a2', name: 'Deep second', content: 'A2', role: 'system', marker: false, builtin: false, absolute: true, depth: 4, order: 200, enabled: true },
  { identifier: 'a1', name: 'Deep first', content: 'A1', role: 'system', marker: false, builtin: false, absolute: true, depth: 4, order: 100, enabled: true },
], {});
eq(
  depths.messages.map(m => m.content), ['R', 'A1', 'A2'],
  'depth-injected prompts go after the ordered ones, sorted by their injection order',
);

/* ── Squashing ───────────────────────────────────────────────────────────── */

eq(
  squash([
    { role: 'system', content: 'one' },
    { role: 'system', content: 'two' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'three' },
  ]).map(m => m.content),
  ['one\n\ntwo', 'hi', 'three'],
  // Only CONSECUTIVE ones: a system note placed after the history is in a
  // different position on purpose, and folding it upward moves it.
  'only neighbouring system messages fold together',
);
eq(
  squash([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]).length, 2,
  'and user turns are never folded, whatever the setting says',
);

/* ── Assembling across presets ───────────────────────────────────────────── */

const presetB = readCcPreset(JSON.stringify({
  prompts: [{ identifier: 'jb', name: 'Jailbreak', content: 'JB', role: 'system' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'jb', enabled: false }] }],
  temperature: 0.4,
}), 'Preset B', 'pB');

let completion: LensCompletion = emptyCompletion('Mine');
completion = addPick(completion, { presetId: 'p1', identifier: 'main' });
completion = addPick(completion, { presetId: 'pB', identifier: 'jb' });
completion = addPick(completion, { presetId: 'p1', identifier: 'main' });
eq(completion.picks.length, 2, 'the same prompt cannot be picked twice');

const presets: CcPreset[] = [preset, presetB];
const resolved = resolvePicks(completion, presets);
eq(resolved.picks.length, 2, 'both picks resolve');
eq(resolved.picks[1].presetName, 'Preset B', 'and each knows which preset it came from');
ok(
  resolved.picks[1].prompt.content === 'JB',
  // The point of the whole feature: an author left 300 prompts switched off,
  // and the reader wants one of them.
  'a prompt that was OFF in its own preset is still usable when picked',
);

const dangling = resolvePicks(
  { ...completion, picks: [...completion.picks, { presetId: 'gone', identifier: 'x' }] },
  presets,
);
eq(dangling.picks.length, 2, 'a pick whose preset is gone does not resolve');
eq(dangling.stale.length, 1, 'and is reported rather than dropped in silence');

const staleName = resolvePicks({ ...completion, picks: [{ presetId: 'p1', identifier: 'vanished' }] }, presets);
ok(staleName.stale[0].includes('Test'), 'a pick whose prompt is gone names the preset it was in');

/* ── Order of picks ──────────────────────────────────────────────────────── */

eq(movePick(completion, 0, 1).picks.map(p => p.identifier), ['jb', 'main'], 'picks can be reordered');
eq(movePick(completion, 0, 9).picks.map(p => p.identifier), ['main', 'jb'], 'a move off the end does nothing');
eq(movePick(completion, -1, 0), completion, 'and so does a move from nowhere');
eq(removePick(completion, 0).picks.length, 1, 'a pick can be removed');
eq(removePick(completion, 5), completion, 'removing one that is not there is a no-op');

let full = emptyCompletion('Full');
for (let i = 0; i < MAX_PICKS + 5; i++) full = addPick(full, { presetId: 'p1', identifier: `x${i}` });
eq(full.picks.length, MAX_PICKS, 'picks are capped');

/* ── Samplers ────────────────────────────────────────────────────────────── */

eq(samplersFor({ ...completion, samplerFrom: 'pB' }, presets).temperature, 0.4,
  'a completion borrows a preset’s samplers');
eq(
  samplersFor({ ...completion, samplerFrom: 'pB', samplerOverrides: { temperature: 1.1 } }, presets).temperature,
  1.1, 'and the reader’s own setting wins');
eq(
  samplersFor({ ...completion, samplerFrom: 'pB', samplerOverrides: { temperature: null } }, presets).temperature,
  0.4,
  // The same rule as mergeSamplers, for the same reason: an empty box in a form
  // means "I did not say", not "send no temperature".
  'but an empty override is not an override',
);
eq(samplersFor({ ...completion, samplerFrom: null }, presets), {},
  'and borrowing from nothing borrows nothing');

/* ── The preview ─────────────────────────────────────────────────────────── */

const preview = previewCompletion(completion, presets, {});
eq(preview.messages.map(m => m.content), ['Be good.', 'JB'], 'the preview is what would be sent');
eq(preview.stale, [], 'with nothing stale in it');

// The setting belongs to the assembly, not to whichever preset a prompt came
// out of. Preset "Test" squashes; picking one prompt from it must not quietly
// fold an assembly the reader never asked to have folded.
ok(sourcesSquash(completion, presets), 'a source preset that squashed is reported');
eq(
  previewCompletion({ ...completion, squashSystem: true }, presets, {}).messages.length, 1,
  'and squashing happens only when the completion itself says so',
);

ok(describePreset(preset).includes('Test'), 'the description names the preset');
ok(/\d+ prompts on/.test(describePreset(preset)), 'and counts what is on');

/* ── Against a real preset, when one is here ─────────────────────────────── */

const REAL = join(
  process.cwd(), 'gut', 'Lucid Loom v3.4 Beta 1 Prolix Preferred.json',
);
if (existsSync(REAL)) {
  const text = readFileSync(REAL, 'utf8');
  eq(presetProblem(text), null, 'a real published preset reads without complaint');
  const loom = readCcPreset(text, 'Lucid Loom', 'real');
  const on = loom.prompts.filter(p => p.enabled).length;
  ok(loom.prompts.length > 300, `it has all ${loom.prompts.length} prompts in the file`);
  ok(
    on > 0 && on < loom.prompts.length,
    // The two failures this catches at once: reading the decoy order (on would
    // be ~10 with none of the author's own), and ignoring the order entirely
    // (on would equal the full 326).
    `and ${on} of them switched on — neither the decoy’s handful nor all of them`,
  );
  ok(
    loom.prompts.some(p => p.enabled && p.marker && p.identifier === 'chatHistory'),
    'the history marker survives the read',
  );
  ok(loom.ignored.length > 0, 'and what is not carried over is named');
} else {
  console.log('  (no real preset in gut/ — skipped that section)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
