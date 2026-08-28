/**
 * Run: npx tsx src/utils/rpgHud.test.ts
 *
 * The RPG view's HUD.
 *
 * One property carries this file: **the HUD never invents.** A game interface
 * is a promise that the numbers mean something, and the easy way to make a
 * reader look like a game is to fake them — everyone at 340/500 HP, a level
 * nobody earned, a condition rolled at random. It would look right immediately
 * and it would be a lie about somebody's story.
 *
 * So: where the Director has read a passage, the panels say what it read; where
 * it has not, they say nothing. Both directions are asserted here, because the
 * failure mode is a HUD that looks perfectly plausible while meaning nothing.
 */
import {
  CONDITION, PARTY_SIZE, conditionFor, gauge, hourOf, partyFrom, placeOf, progressLabel,
} from './rpgHud';
import type { Message, SceneDescriptor } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const m = (name: string): Pick<Message, 'name' | 'role'> =>
  ({ name, role: name === 'You' ? 'user' : 'ai' });

const scene = (over: Partial<SceneDescriptor> = {}): SceneDescriptor => ({
  messageId: 'x', hash: 'h', mood: 'tense', tension: 0.5, ...over,
} as SceneDescriptor);

// Nothing known: the HUD says nothing rather than guessing.
{
  eq(conditionFor(undefined, undefined), '—', 'an unread passage has no condition');
  eq(placeOf(undefined), '', 'and no place');
  eq(hourOf(undefined), '', 'and no hour');
  eq(hourOf(scene({ timeOfDay: 'unknown' })), '',
    '"unknown" is the Director saying it could not tell — the HUD must not fill it in');
  eq(gauge(undefined), 0, 'and the gauge sits empty rather than at a plausible middle');
}

// What it does know, it shows.
{
  eq(conditionFor('ominous'), CONDITION.ominous, 'the mood, in a game’s words');
  eq(conditionFor('tense', 'delighted'), 'Delighted',
    'the speaker’s own emotion beats the room’s mood — a scene can be tense while they are not');
  eq(hourOf(scene({ timeOfDay: 'dusk' })), 'Dusk', 'the hour it read');
  eq(placeOf(scene({ location: 'the crossroads inn' })), 'the crossroads inn', 'the place it read');
  eq(placeOf(scene(), 'the old road'), 'the old road',
    'and the place carried forward when this passage did not move');
}

// The gauge is the Director's own tension, segmented.
{
  eq(gauge(0, 8), 0, 'empty');
  eq(gauge(1, 8), 8, 'full');
  eq(gauge(0.5, 8), 4, 'and honest in between');
  ok(gauge(2, 8) === 8 && gauge(-1, 8) === 0, 'nonsense is clamped, not rendered');
}

// The party is who is actually here.
{
  const party = partyFrom({
    recent: [m('Mara'), m('You'), m('Sable'), m('Mara')],
    scene: scene({ mood: 'tender', speaker: { name: 'Mara', emotion: 'wary' } }),
    userName: 'You',
    characterName: 'Mara',
  });
  eq(party.map(p => p.name), ['Mara', 'Sable', 'You'], 'most recent speaker first, deduped');
  ok(party[0].speaking, 'the one talking is marked');
  ok(!party[1].speaking, 'and the others are not');
  eq(party[0].condition, 'Wary', 'the speaker carries their own emotion');
  eq(party[1].condition, CONDITION.tender, 'everyone else carries the room’s');
  ok(party.find(p => p.name === 'You')?.you, 'the reader is marked as themselves');
}

// Depth: the speaker is at the front, everyone else falls back behind them.
{
  const party = partyFrom({
    recent: [m('Sable'), m('You'), m('Mara')],
    scene: scene(),
  });
  eq(party[0].depth, 0, 'whoever is talking stands at the front');
  ok(party.slice(1).every(p => p.depth > 0), 'and the rest stand behind');
  ok(party[1].depth <= party[2].depth,
    'in the order they last held the scene — a flat row reads as a group photo, '
    + 'a receding one reads as a stage');
  // The one that would be invisible in a screenshot and wrong in motion: a
  // silent party must not all pile onto the front mark.
  const silent = partyFrom({ recent: [m('Narrator')], scene: scene(), characterName: 'Mara' });
  eq(new Set(silent.map(p => p.depth)).size, silent.length,
    'no two people stand on the same mark');
}

// A quiet stretch does not empty the party.
{
  const narrated = partyFrom({
    recent: [m('Mara'), m('You'), m('Narrator'), m('Narrator')],
    scene: scene(),
    characterName: 'Mara',
  });
  ok(narrated.some(p => p.name === 'Mara'),
    'a character who spoke a moment ago is still in the room — a panel that empties on every '
    + 'narration paragraph reads as a bug even when the data is right');
}

// Quoted dialogue is presence.
{
  const quoted = partyFrom({
    recent: [m('Narrator')],
    scene: scene({ dialogue: [{ text: 'Nobody takes the east road', speaker: 'Sable' }] }),
  });
  ok(quoted.some(p => p.name === 'Sable'),
    'someone the narrator quotes is in the scene, even with no passage of their own');
}

// The panel has a ceiling, like a party does.
{
  const crowd = partyFrom({
    recent: ['A', 'B', 'C', 'D', 'E', 'F'].map(m),
    scene: scene(),
  });
  eq(crowd.length, PARTY_SIZE, 'a crowd scene does not become a list');
}

// Position is real position.
{
  eq(progressLabel(3, 9, 12, 40), 'Chapter 3 · 12/40', 'chapter and place in it');
  eq(progressLabel(1, 1, 5, 20), 'The story · 5/20', 'a one-chapter story is not called Chapter 1');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
