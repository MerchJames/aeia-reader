/** Run: npx tsx src/utils/sceneWeather.test.ts */
import { isSceneFx, resolveWeather, weatherFromText } from './sceneWeather';
import { SCENE_FX, specForFx } from './livingBackground';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// --- reading the weather out of the prose ------------------------------------
const cases: [string, string][] = [
  ['Snow was falling over the dead fields.', 'snow'],
  ['Rain hammered the shutters all night.', 'rain'],
  ['Mist lay across the water in the early light.', 'fog'],
  ['Ash drifted down over the ruined street.', 'ash'],
  ['Embers rose from the bonfire into the dark.', 'embers'],
  ['Smoke poured from the shattered windows.', 'smoke'],
  ['Steam curled off the surface of the hot spring.', 'steam'],
  ['A sandstorm swallowed the caravan road.', 'sand'],
  ['They swam underwater through the flooded hall.', 'bubbles'],
  ['Fireflies rose out of the tall grass.', 'fireflies'],
  ['Autumn leaves blew across the courtyard.', 'leaves'],
  ['Cherry blossom drifted over the shrine steps.', 'petals'],
  ['Pollen hung gold in the meadow air.', 'pollen'],
  ['Dust lay thick on every long-abandoned shelf.', 'dust'],
  ['Stars wheeled overhead, cold and countless.', 'stars'],
];
for (const [text, fx] of cases) {
  ok(weatherFromText(text)?.fx === fx, `"${text.slice(0, 28)}…" → ${fx} (got ${weatherFromText(text)?.fx})`);
}

// Every kind the reader can name must be one the engine can actually render.
for (const [, fx] of cases) ok(isSceneFx(fx), `${fx} is a renderable effect`);
ok(SCENE_FX.every(fx => !!specForFx(fx)), 'every declared effect has a particle spec');

// --- how hard it's coming down ------------------------------------------------
const heavy = weatherFromText('A blinding blizzard tore across the pass.');
const light = weatherFromText('A faint mist clung to the hollow.');
ok((heavy?.level ?? 0) > 0.9, 'a blinding blizzard reads as heavy');
ok((light?.level ?? 1) < 0.4, 'a faint mist reads as light');
ok((weatherFromText('Rain fell on the road.')?.level ?? 0) > 0.4, 'plain weather sits in the middle');
// The qualifier has to be NEAR the weather, not anywhere in the passage.
const far = weatherFromText(
  'The heavy oak door had been barred from the inside for a hundred years, and no one alive '
  + 'remembered why it had been shut, nor what the builders feared. Outside, snow was falling.',
);
ok((far?.level ?? 0) < 0.9, 'a "heavy" far from the weather does not amplify it');

// Denser weather means more particles moving faster.
ok(specForFx('snow', 1).count > specForFx('snow', 0.3).count, 'level drives particle count');
ok(specForFx('snow', 1).speed > specForFx('snow', 0.3).speed, 'level drives speed');
ok((specForFx('snow', 1).wind ?? 0) > (specForFx('snow', 0.3).wind ?? 0), 'heavier weather blows harder');

// --- restraint: the failure mode that made this feel random -------------------
ok(weatherFromText('They talked for a long while about nothing in particular.') === undefined,
  'ordinary prose gets no weather');
ok(weatherFromText('Her eyes burned and she looked away.') === undefined,
  'a burning look is not an ember storm');
ok(weatherFromText('He was smoking hot with rage.') === undefined,
  'a figure of speech does not fill the room with smoke');
ok(weatherFromText('The argument left a bitter taste.') === undefined,
  'a metaphor about taste gets nothing');
ok(weatherFromText('') === undefined, 'empty text is safe');

// --- resolveWeather: who wins -------------------------------------------------
const d = { fx: 'fog' as const };
ok(resolveWeather(d, 'Snow was falling.')?.fx === 'fog', "the Director's call beats the prose");
ok(resolveWeather(undefined, 'Snow was falling.')?.fx === 'snow', 'with no read, the prose speaks');
ok(resolveWeather(undefined, 'They sat in silence.', 'fog')?.fx === 'fog',
  'established weather carries over a passage that never mentions it');
ok(resolveWeather(undefined, 'They sat in silence.') === undefined, 'nothing anywhere → no weather');
ok(resolveWeather({ fx: 'rain', fxLevel: 0.2 }, 'Torrential rain.')?.level === 0.2,
  'an explicit level from the Director is honoured');
// No level given: the prose fills it in when it's describing the same weather.
ok((resolveWeather({ fx: 'snow' }, 'A blinding blizzard tore across the pass.')?.level ?? 0) > 0.9,
  'the prose supplies the strength the Director left out');
ok(resolveWeather({ fx: 'snow' }, 'They walked on.')?.level === 0.7,
  'no level and no clue → a sane middle');
ok((resolveWeather(undefined, undefined, 'ash')?.level ?? 1) < 0.7,
  'carried-over weather is softer than freshly named weather');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
