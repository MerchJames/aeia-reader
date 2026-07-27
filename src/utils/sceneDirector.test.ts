/** Run: npx tsx src/utils/sceneDirector.test.ts */
import { parseDescriptors, buildEnrichMessages, ScenePassage } from './sceneDirector';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
