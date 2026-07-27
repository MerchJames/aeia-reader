/** Run: npx tsx src/utils/audioMixer.test.ts */
import { audioMixer, CHANNEL_BASE, DUCK_FACTOR } from './audioMixer';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Hierarchy: at equal source level, voice > sfx > music > ambience.
audioMixer.setVoiceActive(false);
audioMixer.setMaster(1);
const v = audioMixer.volumeFor('voice');
const s = audioMixer.volumeFor('sfx');
const m = audioMixer.volumeFor('music');
const a = audioMixer.volumeFor('ambience');
ok(v > s && s > m && m > a, 'hierarchy voice > sfx > music > ambience');
ok(near(v, CHANNEL_BASE.voice) && near(a, CHANNEL_BASE.ambience), 'base gains applied at level 1');

// Ducking: while voice is active, beds (music+ambience) drop; voice+sfx do not.
audioMixer.setVoiceActive(true);
ok(near(audioMixer.volumeFor('ambience'), CHANNEL_BASE.ambience * DUCK_FACTOR), 'ambience ducks under voice');
ok(near(audioMixer.volumeFor('music'), CHANNEL_BASE.music * DUCK_FACTOR), 'music ducks under voice');
ok(near(audioMixer.volumeFor('voice'), CHANNEL_BASE.voice), 'voice is never ducked');
ok(near(audioMixer.volumeFor('sfx'), CHANNEL_BASE.sfx), 'sfx is never ducked');
audioMixer.setVoiceActive(false);
ok(near(audioMixer.volumeFor('ambience'), CHANNEL_BASE.ambience), 'ambience restores after voice ends');

// Source level + scale multiply in; result clamps to 0..1.
ok(near(audioMixer.volumeFor('ambience', 0.5), CHANNEL_BASE.ambience * 0.5), 'source level scales the gain');
ok(near(audioMixer.volumeFor('ambience', 1, 1.3), CHANNEL_BASE.ambience * 1.3), 'tension scale applies');
ok(audioMixer.volumeFor('voice', 5, 5) === 1, 'over-unity clamps to 1');

// Master scales everything and notifies subscribers.
let notified = 0;
const off = audioMixer.subscribe(() => { notified++; });
audioMixer.setMaster(0.5);
ok(near(audioMixer.volumeFor('sfx'), CHANNEL_BASE.sfx * 0.5), 'master scales the channel');
ok(notified >= 1, 'subscribers are notified on change');
audioMixer.setVoiceActive(true); // another change
ok(notified >= 2, 'subscribers notified on duck flip');
off();
audioMixer.setMaster(1); audioMixer.setVoiceActive(false); // clear leftover state first

// Narrative modulation scales the environment (not voice); reset restores.
audioMixer.rampModulation(0.4, 0); // instant ramp
ok(near(audioMixer.volumeFor('ambience'), CHANNEL_BASE.ambience * 0.4), 'modulation hushes ambience');
ok(near(audioMixer.volumeFor('music'), CHANNEL_BASE.music * 0.4), 'modulation hushes music');
ok(near(audioMixer.volumeFor('voice'), CHANNEL_BASE.voice), 'modulation never touches the voice');
audioMixer.resetModulation();
ok(near(audioMixer.volumeFor('ambience'), CHANNEL_BASE.ambience), 'resetModulation returns to neutral');

audioMixer.setMaster(1); audioMixer.setVoiceActive(false); // reset for other suites
ok(true, 'reset mixer state');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
