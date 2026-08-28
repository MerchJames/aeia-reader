/**
 * Run: npx tsx src/utils/atlas.test.ts
 *
 * The Atlas — the story as a field you can look at.
 *
 * Three properties carry this file.
 *
 * **Area is honest.** A tile is as big as its scene is long, so the field can be
 * read as proportion. Two things break that quietly: a linear map, which gives
 * one scene the whole screen and everything else a speck, and growing a tile in
 * one direction only, which makes a long scene read as a wide short one.
 *
 * **The map never invents.** A tile prints a place only where the story
 * established one, the same rule the RPG HUD and the Script view live by.
 *
 * **"The whole thing" means the whole thing.** The coarsest zoom is a promise
 * about fitting on a screen, not a fixed tile size — and it has to keep that
 * promise for a fourteen-scene story and a four-hundred-scene one.
 */
import {
  MAX_AREA, MID_AT, MIN_FIT_TILE, NEAR_AT, OPENING_CHARS, TILE_SHAPES, ZOOM_STEPS,
  atlasStats, buildAtlas, fieldArea, fitTile, levelFor, progressOf, shapeFor, wordLabel,
} from './atlas';
import type { Scene } from './sceneSegment';
import type { Message, SceneDescriptor } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1', index: 0, messageIds: ['m1'], startId: 'm1', endId: 'm1',
  mood: 'neutral', peakTension: 0.3, tensionById: {}, ...over,
});
const msg = (id: string, content: string, name = 'Mara'): Pick<Message, 'id' | 'name' | 'content'> =>
  ({ id, name, content } as never);
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

/* ── Zoom is a size, and the level follows it ────────────────────────────── */
{
  ok(ZOOM_STEPS.length >= 3, 'there are enough steps for a representation to change along them');
  ok(ZOOM_STEPS.every((s, i) => i === 0 || s.tile > ZOOM_STEPS[i - 1].tile),
    'the steps only ever get bigger — a zoom slider that goes backwards is a broken control');
  ok(ZOOM_STEPS.every(s => !!s.label), 'every step says what it is');
  ok(!!ZOOM_STEPS[0].fit, 'the coarsest step is the one that fits the story to the screen');

  eq(levelFor(10), 'far', 'a tiny tile holds no words');
  eq(levelFor(MID_AT - 1), 'far', 'right up to the threshold');
  eq(levelFor(MID_AT), 'mid', 'and then it can carry a label');
  eq(levelFor(NEAR_AT), 'near', 'and further in, prose');
  ok(MID_AT < NEAR_AT, 'the thresholds are in order');
}

/* ── A tile's size is its scene's length ─────────────────────────────────── */
{
  eq(shapeFor(100, 100), { span: 4, rows: 2 }, 'the longest scene gets the largest shape');
  eq(shapeFor(1, 100), { span: 1, rows: 1 }, 'and the shortest the smallest');
  eq(shapeFor(0, 0), { span: 1, rows: 1 }, 'an empty field does not divide by zero');

  // The square root is the point: a 40:1 length ratio must not become a 40:1
  // area ratio, or the page is one tile and a row of specks.
  const big = shapeFor(4000, 4000);
  const small = shapeFor(100, 4000);
  const ratio = (big.span * big.rows) / (small.span * small.rows);
  ok(ratio <= MAX_AREA, 'a 40:1 length ratio is compressed, not reproduced');
  ok(ratio > 1, 'but the longer scene is still visibly longer');

  // Monotonic: a longer scene is never given a smaller tile.
  let last = 0;
  for (const w of [1, 10, 50, 200, 800, 3000, 9000]) {
    const sh = shapeFor(w, 9000);
    const area = sh.span * sh.rows;
    ok(area >= last, `area never shrinks as a scene grows (${w} words)`);
    last = area;
  }

  // Both directions, and no shape that leaves holes in a grid.
  ok(TILE_SHAPES.some(s => s.rows > 1), 'tiles grow in height as well as width');
  ok(TILE_SHAPES.every(s => s.rows <= 2),
    'and never past two rows — a taller tile strands empty cells beneath it that '
    + 'nothing later may move into, because the field is in chronological order');
  ok(TILE_SHAPES.every(s => s.span >= 1 && s.span <= 4), 'every shape fits the six-column grid');
  ok(TILE_SHAPES.every((s, i) => i === 0 || s.area >= TILE_SHAPES[i - 1].area),
    'the table is ordered by area, which is what shapeFor walks');
}

/* ── Building the field ──────────────────────────────────────────────────── */
{
  const messages = [
    msg('m1', words(20)),
    msg('m2', words(10), 'You'),
    msg('m3', words(60)),
  ];
  const scenes = [
    scene({ id: 's1', messageIds: ['m1', 'm2'], location: 'the gate', timeOfDay: 'dusk' }),
    scene({ id: 's2', index: 1, messageIds: ['m3'], mood: 'action', peakTension: 0.8 }),
  ];
  const tiles = buildAtlas(scenes, messages);

  eq(tiles.length, 2, 'one tile per scene');
  eq(tiles[0].index, 1, 'numbered from one, like the script');
  eq(tiles[0].words, 30, 'words are counted across the whole scene');
  eq(tiles[0].passages, 2, 'as are passages');
  eq(tiles[0].cast, ['Mara', 'You'], 'the cast, in order of first appearance');
  eq(tiles[0].location, 'the gate', 'the place, where the story established one');
  eq(tiles[1].location, undefined, 'and nothing at all where it did not');
  eq(tiles[1].timeOfDay, undefined, 'same for the hour');
  ok(tiles[1].span * tiles[1].rows >= tiles[0].span * tiles[0].rows,
    'the longer scene has the larger tile');

  // A scene whose passages are all missing is not a scene.
  const ghost = buildAtlas([...scenes, scene({ id: 's3', index: 2, messageIds: ['gone'] })], messages);
  eq(ghost.length, 2, 'a scene with nothing in it is not put on the map');

  // The Director's read fills in a place the segmenter did not have.
  const directed: Record<string, SceneDescriptor> = {
    m3: { messageId: 'm3', hash: 'h', mood: 'action', tension: 0.8, location: 'the north road', createdAt: 0 } as SceneDescriptor,
  };
  eq(buildAtlas(scenes, messages, directed)[1].location, 'the north road',
    'a Director read supplies a place the heuristic could not');

  // An explicit "unknown" hour is still unknown.
  eq(buildAtlas([scene({ timeOfDay: 'unknown' })], [msg('m1', 'x')])[0].timeOfDay, undefined,
    'an explicit unknown prints nothing rather than the word "unknown"');

  ok(tiles[0].opening.length <= OPENING_CHARS + 1, 'the opening line is clipped for the close zoom');
  eq(buildAtlas([], messages), [], 'no scenes, no map');
}

/* ── Markdown never reaches a tile ───────────────────────────────────────── */
{
  const t = buildAtlas([scene()], [msg('m1', '## Head\n\nShe **did** not *move*.')])[0];
  ok(!/[*#]/.test(t.opening), 'markers are stripped from the opening line');
  ok(t.opening.startsWith('Head'), 'and the words survive');
}

/* ── The stats bar ───────────────────────────────────────────────────────── */
{
  const tiles = buildAtlas(
    [scene({ id: 's1', messageIds: ['m1'], location: 'the gate' }),
      scene({ id: 's2', index: 1, messageIds: ['m2'], mood: 'action', location: 'the gate' }),
      scene({ id: 's3', index: 2, messageIds: ['m3'] })],
    [msg('m1', words(10)), msg('m2', words(20)), msg('m3', words(30))],
  );
  const stats = atlasStats(tiles);
  eq(stats.scenes, 3, 'scenes counted');
  eq(stats.words, 60, 'words summed');
  eq(stats.passages, 3, 'passages summed');
  eq(stats.places, ['the gate'], 'a place named twice is one place');
  eq(stats.moods, ['neutral', 'action'],
    'the legend lists only the moods present — a key nobody needs is a key nobody reads');
}

/* ── How far in, by words rather than by scene count ─────────────────────── */
{
  const tiles = buildAtlas(
    [scene({ id: 'a', messageIds: ['m1'] }),
      scene({ id: 'b', index: 1, messageIds: ['m2'] })],
    [msg('m1', words(90)), msg('m2', words(10))],
  );
  const first = progressOf(tiles, 'a');
  const second = progressOf(tiles, 'b');
  ok(first < second, 'later is further in');
  ok(second > 0.9, 'the short final scene is near the END, not halfway — length is what counts');
  eq(progressOf(tiles, undefined), 0, 'nowhere in particular is the start');
  eq(progressOf(tiles, 'nope'), 0, 'and so is a scene that is not on the map');
  eq(progressOf([], 'a'), 0, 'an empty map has no progress');
}

/* ── Fitting the whole thing on a screen ─────────────────────────────────── */
{
  const tiles = buildAtlas(
    Array.from({ length: 14 }, (_, i) => scene({ id: `s${i}`, index: i, messageIds: [`m${i}`] })),
    Array.from({ length: 14 }, (_, i) => msg(`m${i}`, words(20 + i * 10))),
  );
  eq(fieldArea(tiles), tiles.reduce((n, t) => n + t.span * t.rows, 0), 'area is the sum of the tiles');

  const wide = fitTile(fieldArea(tiles), 1240, 740);
  ok(wide.tile >= MIN_FIT_TILE, 'never smaller than legible');
  ok(wide.columns >= 1, 'and always at least one column');
  ok(wide.columns * wide.tile <= 1240 + wide.columns * 4,
    'the block fits the width it was given');

  // A column count is RETURNED rather than left to auto-fill, which would hand a
  // shrunken field far more columns than it has tiles for and spread it into a
  // ragged strip.
  const tall = fitTile(fieldArea(tiles), 500, 1400);
  ok(tall.columns < wide.columns, 'a narrow tall box gets fewer columns');

  // The promise has to hold at both extremes.
  const huge = fitTile(4000, 1240, 740);
  const tiny = fitTile(2, 1240, 740);
  ok(huge.tile >= MIN_FIT_TILE, 'a four-hundred-scene story still gets a floor');
  ok(huge.tile < tiny.tile, 'and a bigger story gets smaller tiles');
  ok(levelFor(huge.tile) === 'far', 'a story that large is a field of colour, with no room for words');

  eq(fitTile(0, 1240, 740), { tile: MIN_FIT_TILE, columns: 1 }, 'an empty field does not divide by zero');
  eq(fitTile(30, 0, 0), { tile: MIN_FIT_TILE, columns: 1 }, 'nor an unmeasured box');
}

/* ── Labels ──────────────────────────────────────────────────────────────── */
{
  eq(wordLabel(420), '420 words', 'a small count is exact');
  eq(wordLabel(12_400), '12k words', 'a large one is rounded — nobody reads the last three digits');
  eq(wordLabel(0), '0 words', 'and zero is zero');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
