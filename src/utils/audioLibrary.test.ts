/**
 * Run: npx tsx src/utils/audioLibrary.test.ts
 * Pure checks for the audio-library client — no network.
 */
import { audioAssetUrl, categoryForIntent, deriveAudioTags, pickBestMatch, AudioAsset } from './audioLibrary';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// Folk instrumentation routes to music (the panflute/lute/folk vocabulary).
ok(categoryForIntent('light medieval folk tune with a gentle panflute and lute') === 'music', 'panflute folk → music');

// deriveAudioTags pulls mood/setting/instrument keywords for indexing.
const t1 = deriveAudioTags('light medieval folk tune, gentle panflute over soft lute, pastoral');
ok(t1.includes('medieval') && t1.includes('panflute') && t1.includes('lute') && t1.includes('pastoral'), 'tags capture instruments + mood');
ok(deriveAudioTags('a nondescript noise').length === 0, 'no tags when nothing matches');
ok(deriveAudioTags('rain rain rain wind rain').length === 2, 'tags are de-duplicated');

// pickBestMatch prefers tag overlap, then prompt words; returns null on no match.
const lib: AudioAsset[] = [
  { id: 'a', file: 'a.wav', category: 'music', prompt: 'somber cello drone', description: '', tags: ['somber', 'strings'], seconds: 20, loop: true, model: '', sampleRate: 44100, createdAt: 0 },
  { id: 'b', file: 'b.wav', category: 'music', prompt: 'medieval folk panflute tune', description: 'pastoral', tags: ['medieval', 'panflute', 'pastoral'], seconds: 20, loop: true, model: '', sampleRate: 44100, createdAt: 0 },
];
const best = pickBestMatch(lib, 'gentle medieval panflute folk melody', ['medieval', 'panflute', 'folk']);
ok(best?.id === 'b', 'best match is the medieval panflute clip, not the cello one');
ok(pickBestMatch(lib, 'a submarine sonar ping', ['ocean']) === null, 'no meaningful match → null (caller generates)');

// categoryForIntent routes a free-text beat intent to the right library folder.
ok(categoryForIntent('a low cello drone under the scene') === 'music', 'cello drone → music');
ok(categoryForIntent('mournful orchestral theme swells') === 'music', 'orchestral theme → music');
ok(categoryForIntent('steady rain ambience, distant thunder bed') === 'ambience', 'rain bed → ambience');
ok(categoryForIntent('low room tone hum in the tavern') === 'ambience', 'room tone → ambience');
ok(categoryForIntent('a heavy iron door slams shut') === 'sfx', 'door slam → sfx');
ok(categoryForIntent('a single blade rings as it is drawn') === 'sfx', 'blade ring → sfx');
ok(categoryForIntent('') === 'sfx', 'empty intent defaults to sfx');

// audioAssetUrl builds the /v1 file endpoint and never doubles the version root.
ok(audioAssetUrl('http://localhost:8899', 'sfx__door__ab12') === 'http://localhost:8899/v1/audio/file/sfx__door__ab12',
  'asset url adds /v1 + encodes the id');
ok(audioAssetUrl('http://localhost:8899/', 'x') === 'http://localhost:8899/v1/audio/file/x',
  'trailing slash trimmed');
ok(audioAssetUrl('http://localhost:8899/v1', 'x') === 'http://localhost:8899/v1/audio/file/x',
  'existing /v1 not doubled');
ok(audioAssetUrl('http://localhost:8899', 'a b') === 'http://localhost:8899/v1/audio/file/a%20b',
  'id is url-encoded');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
