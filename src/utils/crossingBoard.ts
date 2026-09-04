/**
 * Which passages the Branching board actually draws, and where it puts them.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * The board used to be two scrolling columns holding every message in each
 * story, each one a full-width block of prose. Four stories of two hundred
 * messages is eight hundred paragraphs stacked in four narrow tubes, and the
 * only way to find the beat you meant was to read your way down to it. The
 * board was for LINKING two moments and it made finding a moment the hard part.
 *
 * So: a node graph, and nodes small enough to see the shape of a story in. That
 * only works if there are not eight hundred of them — a canvas with a thousand
 * nodes does not pan, and a reader cannot see a thousand things anyway.
 *
 * ── What gets drawn ────────────────────────────────────────────────────────
 *
 * A WINDOW, plus everything that must never be hidden. In priority order:
 *
 *   1. **Every linked passage.** An edge whose end is not drawn is an edge that
 *      cannot be drawn, and a link that silently vanishes reads as a link that
 *      was deleted. This is the rule the rest bends around.
 *   2. **Every search hit**, when the reader is searching — that is the
 *      question they just asked.
 *   3. **A run around the reader's position**, so opening the board lands on
 *      where they are rather than on message one of chapter one.
 *
 * Gaps between kept passages become one "n more" marker rather than nothing, so
 * a story never looks shorter than it is, and the reader can open a gap to see
 * what is inside it.
 *
 * Pure: no store, no React, no DOM. The layout is arithmetic on indices, which
 * is what makes it testable without a canvas.
 */

import type { Message } from '../types';
import type { Crossing } from './crossing';

/** Lane geometry, in canvas units. Node width is the readable-line constraint. */
export const LANE_WIDTH = 320;
export const LANE_GAP = 90;
export const NODE_HEIGHT = 62;
export const NODE_GAP = 14;
/** Room at the top of each lane for its header node. */
export const LANE_HEADER_HEIGHT = 96;

/** How many passages either side of the reader's position are kept. */
export const WINDOW_RADIUS = 18;
/**
 * The most nodes one lane will draw.
 *
 * Not a performance ceiling so much as a legibility one: past this the lane is
 * a stripe of identical rectangles and the reader is back to scrolling for the
 * beat they wanted. Search and the gap markers are how you get past it.
 */
export const MAX_LANE_NODES = 80;

export interface BoardEntry {
  /** Index of the message in its story. */
  index: number;
  message: Message;
  /** True when this passage is an end of at least one link. */
  linked: boolean;
  /** True when the reader's search matched it. */
  hit: boolean;
}

export interface BoardGap {
  /** First and last hidden index, inclusive. */
  from: number;
  to: number;
}

export type BoardRow =
  | { kind: 'entry'; at: number; entry: BoardEntry }
  | { kind: 'gap'; at: number; gap: BoardGap };

export interface LaneLayout {
  storyId: string;
  /** Canvas x of the lane's left edge. */
  x: number;
  rows: BoardRow[];
  /** How many of the story's messages this lane is not drawing. */
  hidden: number;
  total: number;
}

/** Does this message match what the reader typed? `#12` finds message twelve. */
export const matches = (msg: Message, index: number, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const asNumber = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : null;
  if (asNumber !== null) return index + 1 === asNumber;
  return msg.content.toLowerCase().includes(q) || msg.name.toLowerCase().includes(q);
};

/** Message ids of this story that are an end of some link. */
export const linkedIdsFor = (
  crossings: readonly Crossing[], storyId: string,
): Set<string> => {
  const out = new Set<string>();
  for (const c of crossings) {
    if (c.a.storyId === storyId) out.add(c.a.messageId);
    if (c.b.storyId === storyId) out.add(c.b.messageId);
  }
  return out;
};

/**
 * Which indices a lane keeps.
 *
 * Ordered by what would be worst to lose. The cap is applied LAST and never
 * takes a linked passage, because dropping one of those breaks an edge; when
 * even the linked ones exceed the cap, they all stay and the cap is exceeded.
 * A board that silently stops drawing your links is worse than a slow one.
 */
export const keptIndices = (
  messages: readonly Message[],
  opts: {
    linkedIds: ReadonlySet<string>;
    query?: string;
    /** Where the reader is in this story, if it is the one they are reading. */
    focusIndex?: number;
    expanded?: ReadonlySet<number>;
  },
): Set<number> => {
  const { linkedIds, query = '', focusIndex, expanded } = opts;
  const searching = query.trim().length > 0;

  const must = new Set<number>();
  messages.forEach((m, i) => { if (linkedIds.has(m.id)) must.add(i); });

  const wanted: number[] = [];
  messages.forEach((m, i) => {
    if (must.has(i)) return;
    if (expanded?.has(i)) { wanted.push(i); return; }
    if (searching) { if (matches(m, i, query)) wanted.push(i); return; }
    if (focusIndex !== undefined && Math.abs(i - focusIndex) <= WINDOW_RADIUS) wanted.push(i);
  });

  /*
   * With nothing to search and nowhere to focus, show the OPENING of the story.
   *
   * A lane that draws nothing looks like a story that failed to load, and the
   * beginning is the one place a reader can always orient themselves from.
   */
  if (!searching && focusIndex === undefined && !wanted.length && !must.size) {
    for (let i = 0; i < Math.min(messages.length, WINDOW_RADIUS * 2); i++) wanted.push(i);
  }

  const room = Math.max(0, MAX_LANE_NODES - must.size);
  return new Set([...must, ...wanted.slice(0, room)]);
};

/** Kept indices, with the runs between them collapsed into gap markers. */
export const rowsFor = (
  messages: readonly Message[],
  kept: ReadonlySet<number>,
  linkedIds: ReadonlySet<string>,
  query = '',
): BoardRow[] => {
  const rows: BoardRow[] = [];
  let at = 0;
  let gapFrom: number | null = null;

  const closeGap = (to: number) => {
    if (gapFrom === null) return;
    rows.push({ kind: 'gap', at: at++, gap: { from: gapFrom, to } });
    gapFrom = null;
  };

  messages.forEach((message, index) => {
    if (!kept.has(index)) {
      if (gapFrom === null) gapFrom = index;
      return;
    }
    closeGap(index - 1);
    rows.push({
      kind: 'entry',
      at: at++,
      entry: {
        index,
        message,
        linked: linkedIds.has(message.id),
        hit: matches(message, index, query),
      },
    });
  });
  closeGap(messages.length - 1);
  return rows;
};

/** Canvas y of the row at position `at` in a lane. */
export const rowY = (at: number): number =>
  LANE_HEADER_HEIGHT + at * (NODE_HEIGHT + NODE_GAP);

/** Canvas x of lane `index`. */
export const laneX = (index: number): number => index * (LANE_WIDTH + LANE_GAP);

/** The whole board's layout: one lane per story, in board order. */
export const layoutBoard = (
  lanes: readonly { storyId: string; messages: readonly Message[] }[],
  opts: {
    crossings: readonly Crossing[];
    query?: string;
    /** Story the reader currently has open, and where they are in it. */
    focus?: { storyId: string; index: number };
    expanded?: ReadonlyMap<string, ReadonlySet<number>>;
  },
): LaneLayout[] => lanes.map((lane, i) => {
  const linkedIds = linkedIdsFor(opts.crossings, lane.storyId);
  const kept = keptIndices(lane.messages, {
    linkedIds,
    query: opts.query,
    focusIndex: opts.focus?.storyId === lane.storyId ? opts.focus.index : undefined,
    expanded: opts.expanded?.get(lane.storyId),
  });
  return {
    storyId: lane.storyId,
    x: laneX(i),
    rows: rowsFor(lane.messages, kept, linkedIds, opts.query),
    hidden: lane.messages.length - kept.size,
    total: lane.messages.length,
  };
});

/** Every index a gap marker stands for, for "open this gap". */
export const gapIndices = (gap: BoardGap): number[] => {
  const out: number[] = [];
  for (let i = gap.from; i <= gap.to; i++) out.push(i);
  return out;
};
