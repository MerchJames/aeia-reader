/**
 * The Panels view — an RP log laid out as comic pages.
 *
 * ── The rule everything here follows ───────────────────────────────────────
 *
 * **One panel is one beat.** That is the whole craft of comics pacing, and it is
 * the one rule a naive "put the paragraphs in boxes" layout breaks: cramming two
 * beats into a panel kills the rhythm, and splitting one beat across two panels
 * invents a pause the writer never wrote.
 *
 * So a beat here is a real unit — a paragraph of narration, or a run of speech
 * by one person — and it gets exactly one panel.
 *
 * ── Why the layout changes, and what changes it ────────────────────────────
 *
 * Comics pacing is carried by panel SIZE and gutter WIDTH, not by panel content:
 *
 *   · a strict grid reads calm, formal, inevitable — nine panels to a page is
 *     the classic "nothing is going to save you" layout
 *   · six panels (two tiers of three) is the ordinary storytelling page
 *   · wide horizontal tiers read fast, left to right — action, and establishing
 *   · a splash — one panel, whole page — is maximum impact, and is only earned
 *     by breaking a grid the page was otherwise keeping
 *   · a tight gutter speeds the eye up; a wide one lets a beat hang
 *
 * Aeia already reads exactly the two things that choose between those: a
 * passage's MOOD and its TENSION. So the layout is not decoration on top of the
 * prose — it is the Director's read, expressed as a page.
 *
 * A story with no Director read still lays out: `sceneSegment`'s heuristic gives
 * a mood and a tension for every passage without an endpoint anywhere.
 *
 * Pure: no DOM, no store, no React.
 */

import { Mood } from '../types';

/** What a panel holds. */
export type BeatKind =
  /** Narration — a caption box. */
  | 'caption'
  /** One person speaking — a balloon. */
  | 'speech'
  /** The first beat of a scene: where we are. Always the widest panel. */
  | 'establish';

export interface Beat {
  kind: BeatKind;
  text: string;
  /** Who is speaking, for a speech beat. */
  speaker?: string;
  messageId: string;
  /** A generated scene image belonging to this beat, if there is one. */
  art?: string;
  /**
   * The read of the PASSAGE this beat came from — not of its scene.
   *
   * This is the whole difference between an engine that works and one that
   * produces the same page forever. A scene spans up to fourteen passages and
   * carries a single mood label, so keying the layout to the scene meant a quiet
   * kitchen three passages before a chase was drawn in widescreen action tiers,
   * and every page in the story came out identical. Both the heuristic and the
   * Director read every passage individually; the scene is only an aggregate of
   * those, and the aggregate is the wrong grain for a page.
   */
  mood?: Mood;
  tension?: number;
}

/** A beat placed on a page. Spans are in a 6-column grid. */
export interface Panel extends Beat {
  /** 1..6 — how many of the six columns this panel takes. */
  span: number;
  /** 1..3 — how many row units tall. */
  rows: number;
  /** Marks the panel as the page's one big moment, for the border treatment. */
  splash?: boolean;
}

export interface ComicPage {
  id: string;
  panels: Panel[];
  /** Which layout the page is keeping, for the reader-facing label. */
  grid: GridName;
  /** Gutter width in rem — narrow reads fast, wide lets a beat hang. */
  gutter: number;
  mood: Mood;
  /** The scene these panels came from. */
  sceneId: string;
  sceneIndex: number;
}

export type GridName = 'nine' | 'six' | 'tiers' | 'splash';

/** The six-column grid every layout is expressed in. */
export const COLUMNS = 6;

/**
 * Column spans for each layout, cycled across the page.
 *
 * Written out rather than computed so the page shapes are readable here and can
 * be checked against a real comic page. Every row must total six.
 */
const GRID_SPANS: Record<GridName, number[]> = {
  nine: [2, 2, 2],          // 3×3 — the strict grid
  six: [3, 3],              // 2×3 — the ordinary page
  tiers: [6],               // full-width bands — widescreen
  splash: [6],              // one panel, and it is the page
};

/** How many panels each layout wants before the page turns. */
const GRID_CAPACITY: Record<GridName, number> = {
  nine: 9, six: 6, tiers: 3, splash: 1,
};

/**
 * Gutter, in rem.
 *
 * The real numbers: comics default to an eighth to a quarter of an inch, tighten
 * to about a twentieth for a beat that should read fast, and open to four tenths
 * for one that should hang. Scaled to a screen, that is roughly 0.2 to 1.1rem.
 */
const GRID_GUTTER: Record<GridName, number> = {
  nine: 0.35, six: 0.55, tiers: 0.25, splash: 0.9,
};

/** Moods that want the page to move, and moods that want it to sit still. */
const FAST: ReadonlySet<Mood> = new Set<Mood>(['action', 'tense', 'ominous']);
const SLOW: ReadonlySet<Mood> = new Set<Mood>(['melancholy', 'tender', 'awe', 'romantic']);

/** Tension at which a single beat has earned the whole page. */
export const SPLASH_TENSION = 0.9;

/**
 * Which layout a run of beats gets.
 *
 * ── Why MOOD decides this and tension almost never does ────────────────────
 *
 * The two are not on the same scale, and that is not a bug to fix here.
 * `sceneSegment`'s heuristic derives tension from a mood baseline scaled by
 * punctuation, which tops out near 0.47 on ordinary prose; the Scene Director,
 * reading the passage with a model, returns a real 0..1. A threshold tuned to
 * one is unreachable on the other — so a layout keyed to tension would produce
 * a different comic depending on whether the reader happened to have configured
 * an endpoint, which is the worst possible reason for a page to change shape.
 *
 * Mood is the signal both paths emit on the same scale: it is an enum, and both
 * of them pick from it. So mood picks the grid.
 *
 * Tension gets exactly one job, and it is the right one: the SPLASH. A splash is
 * the loudest thing a page can do and it should be earned by something that
 * actually read the passage. A word-count heuristic cannot reach 0.9 and should
 * not be able to — the quiet default is to keep the grid.
 */
export const gridFor = (mood: Mood, tension: number, beats: number): GridName => {
  // A splash is only a splash if there is one beat to give it to. A "splash"
  // holding four beats is just a big box, and it spends the page's one loud
  // moment on nothing.
  if (tension >= SPLASH_TENSION && beats === 1) return 'splash';
  if (FAST.has(mood)) return 'tiers';
  if (SLOW.has(mood)) return 'nine';
  return 'six';
};

/**
 * Beats into panels, in one grid.
 *
 * The last row of a page is stretched to fill the width rather than left ragged:
 * a comic page has no ragged edge, and a half-empty final tier reads as a
 * mistake rather than as a pause.
 */
export const layOut = (beats: Beat[], grid: GridName): Panel[] => {
  const spans = GRID_SPANS[grid];
  const out: Panel[] = [];
  let i = 0;
  while (i < beats.length) {
    const rowSpans = [...spans];
    const left = beats.length - i;
    // A short final row: share the six columns out between what is left.
    if (left < rowSpans.length) {
      const each = Math.floor(COLUMNS / left);
      const rem = COLUMNS - each * left;
      rowSpans.length = 0;
      for (let k = 0; k < left; k++) rowSpans.push(each + (k < rem ? 1 : 0));
    }
    for (const span of rowSpans) {
      const beat = beats[i];
      if (!beat) break;
      i++;
      out.push({
        ...beat,
        // An establishing beat always takes the full width, whatever grid it
        // lands in — that is what "establishing" means on a page.
        span: beat.kind === 'establish' ? COLUMNS : span,
        /* Height is claimed by what is IN the panel. A splash is the page, so
         * it takes three row units. An establishing panel takes two only when
         * there is a picture to fill them — an establishing shot of nothing is
         * just a taller empty box, and the reader reads the emptiness as a
         * failure to load rather than as a wide open space. */
        rows: grid === 'splash' ? 3 : (beat.kind === 'establish' && beat.art) ? 2 : 1,
        splash: grid === 'splash',
      });
    }
  }
  return out;
};

export interface PageInput {
  sceneId: string;
  sceneIndex: number;
  mood: Mood;
  tension: number;
  beats: Beat[];
}

/**
 * A run shorter than this is not a change of layout, it is a hiccup.
 *
 * One quiet caption between two loud ones does not get its own page in a
 * different grid — a comic that re-gridded every second panel would have no
 * grid, and breaking a grid only means something when the grid was being kept.
 * The exception is a splash, which is exactly one panel by definition.
 */
export const MIN_RUN = 2;

export interface Run { grid: GridName; beats: Beat[] }

/**
 * Consecutive beats that want the same treatment.
 *
 * Grouping asks `gridFor` with a beat count of two on purpose: a splash is a
 * property of a run that turned out to be one beat long, not of a beat, and
 * letting the splash clause fire during grouping would cut a run in half
 * wherever a loud beat happened to sit inside it.
 */
export const runsOf = (beats: Beat[], mood: Mood, fallback: number): Run[] => {
  const out: Run[] = [];
  for (const b of beats) {
    const tension = b.tension ?? fallback;
    /* A beat a model read at PEAK does not join the run beside it.
     *
     * Grouping by grid alone could never produce a splash: a peak beat sitting
     * inside a stretch of the same mood asks for the same grid as its
     * neighbours, joins their run, and the promotion below never sees it. A
     * splash is a page on its own by definition, so it has to be cut out of the
     * sequence here, before anything else gets a say. */
    if (tension >= SPLASH_TENSION) {
      const last = out[out.length - 1];
      if (last?.grid === 'splash') last.beats.push(b);
      else out.push({ grid: 'splash', beats: [b] });
      continue;
    }
    const grid = gridFor(b.mood ?? mood, tension, 2);
    const last = out[out.length - 1];
    if (last && last.grid === grid) last.beats.push(b);
    else out.push({ grid, beats: [b] });
  }

  /* A stretch of peak beats is loud, but it is not a page each. Three splashes
   * in a row is not three times the impact — it is a comic with no impact left,
   * because a splash means something only against a grid it broke. */
  for (const run of out) if (run.grid === 'splash' && run.beats.length > 1) run.grid = 'tiers';

  // Absorb the hiccups, keeping the beats — nothing is ever dropped, only
  // re-grouped. Backwards, so a run that grows past the minimum by absorbing its
  // neighbour is not then absorbed itself.
  for (let i = out.length - 1; i >= 0; i--) {
    const run = out[i];
    if (run.grid === 'splash' || run.beats.length >= MIN_RUN) continue;
    const into = out[i - 1] ?? out[i + 1];
    // Never dissolve a splash by pouring an ordinary beat into it, and never
    // absorb the only run there is.
    if (!into || into.grid === 'splash') continue;
    if (into === out[i - 1]) into.beats.push(...run.beats);
    else into.beats.unshift(...run.beats);
    out.splice(i, 1);
  }

  /* Absorbing can leave two neighbours asking for the same grid — the quiet
   * beat between two action runs joins the first, and the second is then an
   * identical run sitting next to it. Two pages of the same grid where one was
   * meant is a page break the story never asked for. */
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].grid !== 'splash' && out[i].grid === out[i - 1].grid) {
      out[i - 1].beats.push(...out[i].beats);
      out.splice(i, 1);
    }
  }
  return out;
};

/**
 * A scene's beats, broken into pages.
 *
 * A run longer than its grid's capacity becomes several pages of the SAME grid,
 * because a page that changes layout halfway through has stopped being a grid at
 * all — and the whole reason a grid is worth keeping is that breaking it later
 * means something.
 */
export const pagesFor = (input: PageInput): ComicPage[] => {
  const { beats } = input;
  if (!beats.length) return [];
  const pages: ComicPage[] = [];
  for (const run of runsOf(beats, input.mood, input.tension)) {
    const capacity = GRID_CAPACITY[run.grid];
    for (let i = 0; i < run.beats.length; i += capacity) {
      const slice = run.beats.slice(i, i + capacity);
      pages.push({
        id: `${input.sceneId}-p${pages.length + 1}`,
        panels: layOut(slice, run.grid),
        grid: run.grid,
        gutter: GRID_GUTTER[run.grid],
        mood: input.mood,
        sceneId: input.sceneId,
        sceneIndex: input.sceneIndex,
      });
    }
  }
  return pages;
};

/** Reader-facing name for a layout, shown on the page's gutter label. */
export const GRID_LABEL: Record<GridName, string> = {
  nine: 'Nine-panel grid',
  six: 'Six-panel page',
  tiers: 'Widescreen tiers',
  splash: 'Splash',
};

/* ── Turning a passage into beats ──────────────────────────────────────────
 *
 * A caption box that runs longer than a couple of sentences stops being a
 * caption and becomes a wall of text with a border round it. Real comics break
 * there; so does this. The cap is on the BEAT, not the panel, so a long
 * paragraph becomes two beats — two panels — which is the honest reading: it
 * was two beats.
 */
export const CAPTION_CHARS = 240;

/** Split an over-long paragraph at a sentence end, near the cap. */
export const splitLong = (text: string, cap = CAPTION_CHARS): string[] => {
  if (text.length <= cap) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    // Prefer a sentence end in the back half of the allowance; a break at a word
    // boundary is the fallback, and a hard cut is the last resort.
    const window = rest.slice(0, cap);
    const sentence = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    const at = sentence > cap * 0.4 ? sentence + 1 : window.lastIndexOf(' ');
    const cut = at > 0 ? at : cap;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
};
