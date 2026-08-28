/**
 * The Atlas view — the whole story at once, as a place.
 *
 * ── Why this view exists ───────────────────────────────────────────────────
 *
 * Every other view in Aeia is a TIMELINE: the story serialised, one passage
 * after another, however handsomely. That is the right shape for reading and
 * the wrong shape for one question, which is the question a 300k-token RP log
 * makes you ask constantly — *what is the shape of this thing?* Where are the
 * long stretches. Where does it get loud. How much of it is one location. How
 * far in is the part I remember.
 *
 * A timeline can only answer that by scrolling, which is to say by making you
 * hold the answer in your head. A TOPOGRAPHY answers it by being looked at.
 *
 * ── Semantic zoom, not scaling ─────────────────────────────────────────────
 *
 * Zooming out here does not shrink the text; it changes what a tile IS. Far
 * out, a scene is a coloured area — the story is a field of mood and you read
 * its shape. Mid, it is a card with where and when and who. Close, it is the
 * scene's opening line, readable.
 *
 * That is Perlin and Fox's semantic zoom, from Pad and then Pad++: the
 * representation changes with scale rather than merely its size, so detail
 * appears without context ever being lost — you can always find the context
 * again by zooming back out.
 *
 * ── What a tile's size means ───────────────────────────────────────────────
 *
 * Length. A tile is as big as the scene is long, so the field is honest about
 * proportion: the twelve-passage argument in the kitchen takes twelve
 * passages' worth of the page, and the one-line scene takes a sliver. Colour is
 * mood and the rim is tension. Nothing is sized by importance, because nothing
 * here knows what is important.
 *
 * Pure: no DOM, no store, no React.
 */

import { Message, Mood, SceneDescriptor } from '../types';
import { Scene } from './sceneSegment';
import { imagesOf } from './storyImages';

export type ZoomLevel = 'far' | 'mid' | 'near';

/**
 * The zoom steps, coarsest first.
 *
 * `tile` is the width of a one-unit tile in px, and it is what actually changes
 * — the LEVEL is derived from it, so the control is a single continuous
 * quantity and the representation changes at thresholds along it, rather than
 * the reader having to choose between three named modes.
 */
export const ZOOM_STEPS: readonly { tile: number; label: string; fit?: true }[] = [
  // The coarsest step is not a size, it is a PROMISE: the whole story, on the
  // screen, at once. A fixed 26px cannot keep that promise — for a short story
  // it leaves a ragged strip in the corner of an empty page, and for a long one
  // it overflows the very thing it claims to show. So this step measures the
  // space it has and sizes the tile to fill it (see `fitTile`).
  { tile: 26, label: 'The whole thing', fit: true },
  { tile: 46, label: 'Far' },
  { tile: 84, label: 'Scenes' },
  { tile: 130, label: 'Detail' },
  { tile: 200, label: 'Close' },
];

/** Total grid units the field occupies — the sum of every tile's area. */
export const fieldArea = (tiles: { span: number; rows: number }[]): number =>
  tiles.reduce((n, t) => n + t.span * t.rows, 0);

/** Smallest tile the far zoom will go to; below this it is a smear, not a map. */
export const MIN_FIT_TILE = 9;
/** Largest — past this, "the whole thing" is just the ordinary far view. */
export const MAX_FIT_TILE = 64;

/**
 * The tile size that fits `area` grid units into a `w`×`h` box.
 *
 * Solves for a square-ish packing: with `c` columns the field is `area / c`
 * rows tall, so `c` should be near `sqrt(area · w / h)` for the block to have
 * the box's proportions. The tile is then the column width, capped by the
 * height so a field taller than the box still fits.
 */
export const fitTile = (
  area: number, w: number, h: number, gap = 4,
): { tile: number; columns: number } => {
  if (area <= 0 || w <= 0 || h <= 0) return { tile: MIN_FIT_TILE, columns: 1 };
  const columns = Math.max(1, Math.round(Math.sqrt((area * w) / h)));
  const rows = Math.max(1, Math.ceil(area / columns));
  const byWidth = (w - gap * (columns - 1)) / columns;
  const byHeight = (h - gap * (rows - 1)) / rows;
  const tile = Math.max(MIN_FIT_TILE,
    Math.min(MAX_FIT_TILE, Math.floor(Math.min(byWidth, byHeight))));
  /* The column count is returned, not just implied by the tile size. Left to
   * `auto-fill`, a field that has been shrunk to fit is handed far more columns
   * than it has tiles for and spreads into a ragged strip with holes in it —
   * which is the opposite of the compact block this step exists to draw. */
  return { tile, columns };
};

export const DEFAULT_ZOOM = 2;

/** Below this a tile has no room for words; above it, it has room for prose. */
export const MID_AT = 70;
export const NEAR_AT = 120;

export const levelFor = (tile: number): ZoomLevel =>
  tile >= NEAR_AT ? 'near' : tile >= MID_AT ? 'mid' : 'far';

export interface AtlasTile {
  id: string;
  /** 1-based scene number, as the Script view numbers them. */
  index: number;
  mood: Mood;
  /** 0..1 — the scene's peak. */
  tension: number;
  location?: string;
  timeOfDay?: string;
  /** Words in the scene — what the tile's area is proportional to. */
  words: number;
  /** How many of the story's passages are in it. */
  passages: number;
  /** Everyone who has a passage in the scene, in order of first appearance. */
  cast: string[];
  /** The scene's first words, for the close zoom. */
  opening: string;
  /**
   * A picture from the scene, if it has one — the tile's cover.
   *
   * The first one in reading order rather than the last: a scene's opening
   * image is the establishing one, and that is what a map wants on a tile.
   */
  cover?: string;
  messageIds: string[];
  /** Grid columns this tile takes. */
  span: number;
  /** Grid rows. Area — span × rows — is what carries the scene's length. */
  rows: number;
}

/** Characters of the opening line kept for the close zoom. */
export const OPENING_CHARS = 220;

/**
 * The shapes a tile may take, smallest area first.
 *
 * Area is the encoding, so a tile has to grow in BOTH directions: a "long
 * scene" that is only four times wider than a short one, and exactly as tall,
 * reads as a wide short scene rather than as a big one.
 *
 * Two rows is the ceiling, and that is a packing decision, not an aesthetic
 * one. The field is laid out in chronological order — a map of a story whose
 * scenes appear out of sequence is not a map of anything — so the browser may
 * not reflow tiles to fill holes, and a three-row tile beside one-row
 * neighbours strands a column of empty cells beneath it that nothing later is
 * allowed to move into. Capping at two rows keeps the rows aligned and the
 * field close to solid while still giving the longest scene eight times the
 * area of the shortest.
 */
export const TILE_SHAPES: readonly { span: number; rows: number; area: number }[] = [
  { span: 1, rows: 1, area: 1 },
  { span: 2, rows: 1, area: 2 },
  { span: 2, rows: 2, area: 4 },
  { span: 3, rows: 2, area: 6 },
  { span: 4, rows: 2, area: 8 },
];

export const MAX_AREA = TILE_SHAPES[TILE_SHAPES.length - 1].area;

/**
 * A scene's size on the field.
 *
 * The square root, not the raw count. A story where one scene is forty times
 * longer than another is completely ordinary, and a linear map would give that
 * scene forty times the area — one tile filling the screen and everything else
 * a speck, which tells you nothing about either. The square root compresses the
 * long tail while keeping the order and the sense of proportion intact, which
 * is what area encoding is for.
 */
export const shapeFor = (words: number, longest: number): { span: number; rows: number } => {
  if (longest <= 0) return { span: 1, rows: 1 };
  const ratio = Math.sqrt(Math.max(1, words) / Math.max(1, longest));
  const target = Math.max(1, ratio * MAX_AREA);
  // The largest shape that still fits inside what this scene has earned.
  let best = TILE_SHAPES[0];
  for (const shape of TILE_SHAPES) if (shape.area <= target) best = shape;
  return { span: best.span, rows: best.rows };
};

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${at > max * 0.5 ? cut.slice(0, at) : cut}…`;
};

/** Markdown out, for a tile's opening line. */
const bare = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .trim();

export const buildAtlas = (
  scenes: Scene[],
  messages: Pick<Message, 'id' | 'name' | 'content' | 'images'>[],
  descriptors?: Record<string, SceneDescriptor>,
  /** Generated art per passage, already resolved to URLs. */
  art?: Record<string, string[]>,
): AtlasTile[] => {
  const byId = new Map(messages.map(m => [m.id, m]));
  const raw = scenes.map((scene, i) => {
    const cast: string[] = [];
    let words = 0;
    let opening = '';
    /* Passages actually FOUND, not ids listed.
     *
     * A scene span can name a passage that is not in the stream — a hidden
     * message, a chain the reader has switched away from — and counting the ids
     * put a tile on the map with nothing behind it: no words, no cast, and a
     * click that went nowhere. The Script view already counts what it found;
     * this now agrees with it, so the two never disagree about how many scenes
     * a story has. */
    const found: string[] = [];
    let cover: string | undefined;
    for (const id of scene.messageIds) {
      const msg = byId.get(id);
      if (!msg) continue;
      found.push(id);
      const name = (msg.name || '').trim();
      if (name && !cast.includes(name)) cast.push(name);
      words += countWords(msg.content);
      if (!opening) opening = clip(bare(msg.content), OPENING_CHARS);
      if (!cover) cover = imagesOf(msg, art?.[id])[0];
    }
    // The Director's location for the scene's first passage, where it read one;
    // the segmenter's otherwise. Never invented — a tile with no place says so.
    const first = scene.messageIds[0];
    return {
      id: scene.id,
      index: i + 1,
      mood: scene.mood,
      tension: scene.peakTension,
      location: scene.location ?? descriptors?.[first]?.location,
      timeOfDay: scene.timeOfDay && scene.timeOfDay !== 'unknown' ? scene.timeOfDay : undefined,
      words,
      passages: found.length,
      cast,
      opening,
      cover,
      messageIds: found,
    };
  }).filter(t => t.passages > 0);

  const longest = raw.reduce((n, t) => Math.max(n, t.words), 0);
  return raw.map(t => ({ ...t, ...shapeFor(t.words, longest) }));
};

export interface AtlasStats {
  scenes: number;
  words: number;
  passages: number;
  /** Distinct named places, for the legend. */
  places: string[];
  /** The moods actually present, so the legend never lists ten unused colours. */
  moods: Mood[];
}

export const atlasStats = (tiles: AtlasTile[]): AtlasStats => {
  const places: string[] = [];
  const moods: Mood[] = [];
  let words = 0;
  let passages = 0;
  for (const t of tiles) {
    words += t.words;
    passages += t.passages;
    if (t.location && !places.includes(t.location)) places.push(t.location);
    if (!moods.includes(t.mood)) moods.push(t.mood);
  }
  return { scenes: tiles.length, words, passages, places, moods };
};

/**
 * How far into the story a scene sits, 0..1, by WORDS rather than by scene
 * count — which is the honest answer to "how far in am I" when scenes differ in
 * length by an order of magnitude.
 */
export const progressOf = (tiles: AtlasTile[], sceneId?: string): number => {
  if (!sceneId) return 0;
  const total = tiles.reduce((n, t) => n + t.words, 0);
  if (!total) return 0;
  let before = 0;
  for (const t of tiles) {
    if (t.id === sceneId) return (before + t.words / 2) / total;
    before += t.words;
  }
  return 0;
};

/** `12,400 words` — a count somebody can read at a glance. */
export const wordLabel = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k words` : `${n.toLocaleString()} words`;
