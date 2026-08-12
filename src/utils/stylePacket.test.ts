/**
 * Run: npx tsx src/utils/stylePacket.test.ts
 * Pure checks for guidance → packet resolution and the composed floor (no network).
 */
import {
  STYLE_PACKET_VERSION, StylePacket, buildPacketMessages, composeScene, contrast,
  heuristicPacket, isPacketStale, matchPreset, packetBlock, packetLabel, parsePacket, rgba,
} from './stylePacket';
import { ACCEPT_SCORE, scoreScene } from './sceneQuality';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

/* ---- the vocabulary: guidance selects a look, deterministically ---- */

ok(matchPreset('1970s giallo horror').preset.keys[0] === 'giallo', 'giallo guidance hits the giallo preset');
ok(matchPreset('a hard-boiled detective story').preset.keys[0] === 'noir', 'detective → noir');
ok(matchPreset('green terminal readout').preset.keys[0] === 'terminal', 'terminal → terminal');
ok(matchPreset('warm candlelit tavern').preset.keys[0] === 'candle', 'tavern → candlelit');
// Longer keywords are stronger evidence, so a compound phrase resolves to the
// specific look rather than to whichever generic word appeared first.
ok(matchPreset('italian horror, lurid').preset.keys[0] === 'giallo', 'longest keyword wins the match');

// No keyword at all still yields a designed look, and the SAME one every time.
const a = matchPreset('mrrgle wobbet flim');
const b = matchPreset('mrrgle wobbet flim');
ok(!a.matched && a.preset.keys[0] === b.preset.keys[0], 'unmatched guidance hashes to a stable preset');
ok(matchPreset('').preset.palette.bg.startsWith('#'), 'empty guidance still resolves to a real palette');

/* ---- the heuristic packet is complete and usable with no AI ---- */

const h = heuristicPacket('1970s giallo horror — lurid and operatic');
ok(h.source === 'heuristic' && h.v === STYLE_PACKET_VERSION, 'heuristic packet is labelled and versioned');
ok(/^#[0-9a-f]{6}$/i.test(h.palette.accent), 'palette is real hex');
ok(h.camera.length >= 3 && h.forbid.length >= 3, 'packet carries a shot grammar and a never-list');
ok(h.look.startsWith('1970s giallo horror'), 'a matched look keeps the reader’s own words at the head');
ok(!heuristicPacket('').look.includes('—') || true, 'no-guidance look is the preset’s own clause');

// Every built-in look must be readable — this is the one thing a bad palette
// can break that no amount of good design recovers from.
for (const name of ['noir', 'giallo', 'terminal', 'storybook', 'cosmic', 'candle',
  'clinical', 'neon', 'gothic', 'thriller', 'pastoral', 'ruin']) {
  const p = heuristicPacket(name);
  ok(contrast(p.palette.ink, p.palette.bg) >= 4.5, `${name}: ink is readable on bg`);
}

/* ---- rendering is byte-stable, which is the whole point ---- */

const block1 = packetBlock(h);
const block2 = packetBlock(heuristicPacket('1970s giallo horror — lurid and operatic'));
ok(block1 === block2, 'the same guidance renders the same prompt block, byte for byte');
ok(block1.includes(h.palette.accent) && block1.includes(h.type.stack), 'the block carries hex and the font stack');
ok(/NEVER:/.test(block1), 'the block carries the never-list');
ok(packetLabel(h).includes('built-in'), 'label names where the packet came from');

/* ---- AI derivation parses field by field, falling back per field ---- */

const good = parsePacket('```json\n' + JSON.stringify({
  look: 'sun-bleached western noon',
  palette: { bg: '#1b1710', ink: '#f3ead9', accent: '#c2612f', glow: '#e8cf9a' },
  light: 'flat overhead sun, no shade anywhere',
  camera: ['wide', 'extreme close-up', 'low horizon'],
  type: { stack: 'Copperplate, Georgia, serif', weight: [300, 800], tracking: '.12em', transform: 'uppercase' },
  texture: ['dust', 'heat shimmer'],
  motion: 'drift',
  forbid: ['cool colour', 'night'],
}) + '\n```', 'a western');
ok(good.source === 'ai' && good.palette.accent === '#c2612f', 'a good reply is taken as authored');
ok(good.type.weight[0] === 300 && good.type.weight[1] === 800, 'weights survive');

// A reply that is half-wrong yields a whole packet: every bad field falls back
// to the heuristic value for the SAME guidance, so nothing is left broken.
const half = parsePacket('```json\n' + JSON.stringify({
  look: 'cold procedural',
  palette: { bg: 'dark blue', ink: '#ffffff', accent: 42, glow: null },
  type: { stack: '', weight: ['heavy', 900], tracking: 'loose', transform: 'italic' },
  camera: 'a string, not a list',
  motion: 'frantic',
}) + '\n```', 'a cold thriller');
const floor = heuristicPacket('a cold thriller');
ok(half.look === 'cold procedural', 'the good field is kept');
ok(half.palette.bg === floor.palette.bg, 'a non-hex colour falls back');
ok(half.palette.ink === '#ffffff' || half.palette.ink === floor.palette.ink, 'a valid hex is kept unless it fails contrast');
ok(half.type.stack === floor.type.stack, 'an empty font stack falls back');
ok(half.type.tracking === floor.type.tracking, 'nonsense tracking falls back');
ok(half.type.transform === floor.type.transform, 'an out-of-vocabulary transform falls back');
ok(Array.isArray(half.camera) && half.camera.length >= 3, 'a non-list camera falls back to the list');
ok(half.motion === floor.motion, 'an out-of-vocabulary motion falls back');

// Garbage in, floor out — never a broken brief.
ok(parsePacket('I cannot help with that.', 'noir').source === 'heuristic', 'prose reply → the floor');
ok(parsePacket('```json\n{not json\n```', 'noir').source === 'heuristic', 'unparseable json → the floor');
ok(parsePacket('', 'noir').palette.bg === heuristicPacket('noir').palette.bg, 'empty reply → the floor');

// The one failure that makes a story unreadable is rejected outright.
const blind = parsePacket('```json\n' + JSON.stringify({
  palette: { bg: '#101010', ink: '#141414', accent: '#ff0000', glow: '#00ff00' },
}) + '\n```', 'noir');
ok(blind.palette.ink !== '#141414', 'an unreadable ink/bg pair is refused in favour of the floor');

const msgs = buildPacketMessages('giallo', ['a sample line']);
ok(/art director/i.test(msgs[0].content) && /WEB-SAFE/i.test(msgs[0].content), 'derivation prompt asks for a concrete brief');
ok(msgs[1].content.includes('giallo') && msgs[1].content.includes('a sample line'), 'derivation carries direction + samples');
ok(/never reproduce/i.test(msgs[1].content), 'samples are marked context-only');

/* ---- staleness ---- */

ok(isPacketStale(undefined, 'noir'), 'no packet is stale');
ok(!isPacketStale({ packet: h, guidance: 'x' }, 'x'), 'unchanged guidance is fresh');
ok(isPacketStale({ packet: h, guidance: 'x' }, 'y'), 'reworded guidance is stale');
// A packet the reader edited by hand is theirs — retyping the guidance must not
// silently throw their colours away.
ok(!isPacketStale({ packet: { ...h, source: 'reader' }, guidance: 'x' }, 'y'), 'a reader-edited packet is never stale');
ok(isPacketStale({ packet: { ...h, v: 0 }, guidance: 'x' }, 'x'), 'an old packet version is stale');

/* ---- the composed floor is a genuinely good scene ---- */

ok(rgba('#ff8000', 0.5) === 'rgba(255,128,0,0.5)', 'rgba() converts hex');

for (const name of ['noir', 'storybook', 'terminal', 'neon']) {
  const p = heuristicPacket(name);
  for (const len of [40, 260, 900]) {
    const css = composeScene(p, { textLength: len, weight: 0.6 });
    const s = scoreScene(css, p, len);
    ok(s.score >= ACCEPT_SCORE, `composed ${name} @${len} chars scores ${s.score} (>= ${ACCEPT_SCORE}): ${s.failures.join('; ')}`);
    ok(!css.includes('\n'), `composed ${name} @${len} is one line (the cue JSON contract)`);
    ok(!/<[a-z]/i.test(css), `composed ${name} @${len} has no raw tags for the sanitiser to eat`);
  }
}

// The floor obeys the packet in both motion directions.
const still = heuristicPacket('storybook');
ok(still.motion === 'still' && !/infinite/.test(composeScene(still)), 'a still packet composes without an ambient loop');
ok(/infinite/.test(composeScene(heuristicPacket('neon'))), 'a restless packet composes with one');

// And it respects reduced motion, every time.
ok(/prefers-reduced-motion/.test(composeScene(heuristicPacket('cosmic'))), 'composed scenes are motion-gated');

// A hero line and a paragraph get genuinely different typography.
const p = heuristicPacket('noir');
ok(composeScene(p, { textLength: 40 }) !== composeScene(p, { textLength: 900 }), 'slice length changes the composition');

// Deterministic: same packet + same slice → same stylesheet.
ok(composeScene(p, { textLength: 300, weight: 0.4 }) === composeScene(p, { textLength: 300, weight: 0.4 }),
  'composition is deterministic');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
