/** Run: npx tsx src/utils/sfxPlanner.test.ts */
import { planSfxAnchors, planVolumeCues, planTransition } from './sfxPlanner';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const text = 'She gave a knock on the heavy door. Footsteps approached. '
  + 'Then the window shattered as he fell into the ravine, and she let out a scream '
  + 'while thunder rolled overhead.';

// off → nothing.
ok(planSfxAnchors(text, 'off').length === 0, 'off yields no SFX');

// light → only pivotal (weight>=4), capped at 2.
const light = planSfxAnchors(text, 'light');
ok(light.length <= 2, 'light caps at 2');
ok(light.every(s => s.weight >= 4), 'light keeps only pivotal cues');
ok(!light.some(s => /knock|footsteps/i.test(s.anchor)), 'light drops minor cues (knock/footsteps)');

// medium → more, but excludes the weakest (weight>=2), capped at 5.
const medium = planSfxAnchors(text, 'medium');
ok(medium.length <= 5 && medium.length >= light.length, 'medium is a superset-ish, capped at 5');
ok(!medium.some(s => /footsteps/i.test(s.anchor)), 'medium still drops weight-1 footsteps');

// immersive → picks up the minor cues too (footsteps, knock-on-door).
const imm = planSfxAnchors(text, 'immersive');
ok(imm.some(s => /footsteps/i.test(s.anchor)) && imm.some(s => /knock/i.test(s.anchor)), 'immersive includes minor cues');
ok(imm.length <= 20, 'immersive respects the hard cap of 20');

// Anchors are verbatim and carry a concrete intent+tags, in reading order.
ok(imm.every(s => text.toLowerCase().includes(s.anchor.toLowerCase())), 'every anchor is verbatim in the text');
ok(imm.every(s => s.intent.length > 0 && s.tags.length > 0), 'every anchor has an intent + tags');
const idx = imm.map(s => text.toLowerCase().indexOf(s.anchor.toLowerCase()));
ok(idx.every((n, i) => i === 0 || n >= idx[i - 1]), 'anchors returned in reading order');

// --- metaphor guards: charged words used figuratively fire NOTHING ----------
ok(planSfxAnchors('The betrayal shattered her hopes.', 'immersive').length === 0, 'shattered her hopes → no SFX');
ok(planSfxAnchors('She fell into despair and a familiar routine.', 'immersive').length === 0, 'fell into despair/routine → no SFX');
ok(planSfxAnchors('An explosion of colour lit the canvas.', 'immersive').length === 0, 'explosion of colour → no SFX');
ok(planSfxAnchors('He collapsed into a chair, crashing from exhaustion.', 'immersive').length === 0, 'collapsed into a chair → no SFX');
ok(planSfxAnchors('Thunderous applause filled the hall.', 'immersive').length === 0, 'thunderous applause → no SFX');
// …but the literal, physical versions still fire.
ok(planSfxAnchors('He fell into the ravine.', 'light').some(s => /fell into/i.test(s.anchor)), 'fell into the ravine → fires');
ok(planSfxAnchors('The window shattered.', 'light').some(s => /shatter/i.test(s.anchor)), 'a literal shatter → fires');
ok(planSfxAnchors('She let out a scream.', 'light').length === 1, 'a literal scream → fires');
ok(planSfxAnchors('She screamed silently inside.', 'immersive').length === 0, 'screamed silently inside → no SFX');

// --- volume modulation cues --------------------------------------------------
const vd = planVolumeCues('He froze. The whole room fell silent, and stillness settled over them.');
ok(vd.some(c => c.dir === 'down' && c.target < 1), 'a hush cue reads as a down modulation');
const vu = planVolumeCues('The crowd grew louder until the din of the hall was deafening.');
ok(vu.some(c => c.dir === 'up' && c.target > 1), 'a swell cue reads as an up modulation');
ok(planVolumeCues('She walked calmly across the room.').length === 0, 'ordinary prose yields no modulation');
const vseq = planVolumeCues('Silence fell. Then the noise swelled to a roar.');
ok(vseq.length === 2 && vseq[0].dir === 'down' && vseq[1].dir === 'up', 'cues returned in reading order');

// --- mid-message transition (bridging) ---------------------------------------
const tr = planTransition('She left the roaring tavern and stepped into her room, closing the door behind her.');
ok(!!tr && tr.location === 'room', 'names the destination room for a mid-message move');
const doorOnly = planTransition('He shut the door behind him and exhaled.');
ok(!!doorOnly && doorOnly.location === null, 'a bare door close is a transition with no rename');
ok(planTransition('She stepped into the light.') === null, 'an abstract "into the light" is not a transition');
ok(planTransition('They talked quietly for a while.') === null, 'ordinary prose has no transition');
ok(!!planTransition('He entered the cellar.') && planTransition('He entered the cellar.')!.location === 'cellar', 'entered the cellar → cellar');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
