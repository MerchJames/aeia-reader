/** Run: npx tsx src/utils/sceneMood.test.ts */
import { sceneSoundscapeIntent, sceneMusicIntent, locationLoudness } from './sceneMood';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// A recognizable location wins and yields a rich ambience prompt + tags.
const tav = sceneSoundscapeIntent('neutral', 'The Prancing Pony tavern');
ok(!!tav && tav.category === 'ambience' && /tavern/i.test(tav.prompt) && tav.tags.includes('tavern'),
  'a tavern location → tavern soundscape with tags');

const gorge = sceneSoundscapeIntent('eerie', 'Limestone Ridge above a River Gorge');
ok(!!gorge && (/mountain|ridge|wind/i.test(gorge.prompt)), 'a ridge/gorge location → windswept mountain bed');

// Location beats the mood default.
const rainCave = sceneSoundscapeIntent('tender', 'a dripping cave');
ok(!!rainCave && /cave|underground|drone/i.test(rainCave.prompt), 'location overrides mood');

// No location → mood fallback (ominous gets a drone bed).
const om = sceneSoundscapeIntent('ominous');
ok(!!om && /ominous|drone|foreboding/i.test(om.prompt) && om.tags.length > 0, 'ominous mood → fallback drone bed');

// A plain neutral scene with no setting → no bed (null), so we don't force a generic hum.
ok(sceneSoundscapeIntent('neutral') === null, 'neutral + no location → no soundscape');
ok(sceneSoundscapeIntent('joyful') === null, 'joyful + no location → no soundscape (silence)');

// Tags are always non-empty when a soundscape is returned (so it indexes/searches).
const all = ['tense', 'ominous', 'eerie', 'melancholy', 'tender', 'awe', 'action'] as const;
ok(all.every(m => { const s = sceneSoundscapeIntent(m); return !s || s.tags.length > 0; }),
  'every returned soundscape carries index tags');

// --- music: only when the scene earns it -------------------------------------
ok(sceneMusicIntent('neutral', 'a quiet road', 0.1) === null, 'low-tension neutral scene → no music');
const awe = sceneMusicIntent('awe', undefined, 0.2);
ok(!!awe && awe.category === 'music' && /orchestral|soaring|majestic/i.test(awe.prompt), 'awe mood earns a score even at low tension');
const highT = sceneMusicIntent('neutral', 'a plain field', 0.8);
ok(!!highT && highT.category === 'music', 'high tension earns a score in any mood');
const bard = sceneMusicIntent('neutral', 'a bard plays in the tavern', 0.1);
ok(!!bard && /lute|folk|fiddle/i.test(bard.prompt), 'a musical location earns music regardless of tension');
const forced = sceneMusicIntent('neutral', 'a quiet road', 0.1, true);
ok(!!forced, 'the Director can force a score with wantsScore');
ok((sceneMusicIntent('action', undefined, 0.3)?.tags.length ?? 0) > 0, 'music intents carry tags');

// --- romantic mood: its own warm bed + it earns a tender score --------------
const rAmb = sceneSoundscapeIntent('romantic');
ok(!!rAmb && /intimate|warm|hearth/i.test(rAmb.prompt) && rAmb.tags.includes('romantic'), 'romantic mood → a warm intimate ambience');
const rMus = sceneMusicIntent('romantic', undefined, 0.2);
ok(!!rMus && rMus.category === 'music' && /romantic|tender|yearning/i.test(rMus.prompt), 'romantic earns a tender score even at low tension');

// --- proximity: enclosed places are quieter than open/loud ones -------------
ok(locationLoudness('the roaring tavern') === 1, 'a tavern is full-loudness');
ok(locationLoudness('her small room') < locationLoudness('the tavern'), 'a room is quieter than a tavern (moved away from the din)');
ok(locationLoudness('a damp cellar') <= locationLoudness('her room'), 'a cellar/crypt is quietest');
ok(locationLoudness(undefined) > 0 && locationLoudness('somewhere vague') > 0, 'always a sane default loudness');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
