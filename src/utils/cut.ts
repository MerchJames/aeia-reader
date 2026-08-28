/**
 * The Cut — a story and the way it was directed, in one file.
 *
 * The oldest line in any of this repo's roadmaps: *people share their AI chats
 * for others to read, especially readers without powerful hardware or a
 * generation setup.* The self-contained HTML export answered half of it — that
 * file reads anywhere, needs nothing, and is where a Cut's ambitions stop for
 * anyone who just wants to read the words.
 *
 * This is the other half: a file Aeia itself re-opens, so the reader gets the
 * whole apparatus — five views, the weather, the performance, the Visual Novel
 * staging — with **no endpoint, no key, no hardware**, because the direction is
 * already baked. That is what makes it a medium rather than a feature.
 *
 * Three rules it is built on, none negotiable:
 *
 * 1. **A Cut carries the direction, not the diary.** Descriptors, Lens edits,
 *    hand marks and staging travel. Annotations, highlights, interviews, chat
 *    threads, companion reactions and the reader's taste log do NOT — those are
 *    somebody reading, not somebody directing, and shipping them by accident is
 *    a privacy failure, not a feature gap. `NEVER_IN_A_CUT` is the enforcement,
 *    and the test on it is the one that matters most in this file.
 *
 * 2. **It says what it contains before it writes.** `describeCut` exists so the
 *    export dialog can be specific — this many passages, this much direction,
 *    this many pictures, this many megabytes — rather than asking for trust.
 *
 * 3. **It is a file.** No account, no server, no telemetry, no phoning home on
 *    open. Local-first has to include the sharing story or it means nothing.
 *
 * Pure: no store, no IndexedDB, no React. The I/O lives with the callers.
 */

import type { Story } from '../types';

/** Recognises a Cut before anything is parsed out of it. */
export const CUT_MAGIC = 'aeia-cut';
/** Bump when the SHAPE changes. Readers refuse a version they postdate. */
export const CUT_VERSION = 1;
export const CUT_EXTENSION = '.cut.json';

/**
 * The direction layer, by v2 slice name.
 *
 * Deliberately an explicit list rather than "everything ending in ByStory":
  * that rule is exactly how a reader's private annotations would end up in a
 * file they meant to hand to a friend. Adding a slice here is a decision about
 * what is safe to SHARE, and it should read like one.
 */
export const CUT_SLICES: readonly string[] = [
  'sceneByStory',          // the Director's read — the expensive part
  'storyReadByStory',      // the whole-story read that grounds it
  'overridesByStory',      // Lens edits
  'lensOnByStory',         // …and whether they were switched on
  'performMarksByStory',   // hand-directed spans
  'emphasisMarksByStory',  // hand-set typography
  'sfxMarksByStory',       // hand-placed sound
  // Scene art metadata. The BYTES live in their own IndexedDB and do not travel
  // in v1 — a 1024² PNG per beat is not something to put in a text file without
  // the reader choosing it. A picture whose bytes are missing renders as
  // nothing (see SceneArtStrip), so this is safe; the export dialog says it
  // plainly rather than letting a recipient wonder where the art went.
  'artByStory',
  'directorEnabledByStory',
  'sandboxByStory',
  'sandboxEnabledByStory',
  'sandboxPaletteByStory',
  'sandboxCuesByStory',
  'sandboxSceneByStory',
  'sandboxGuidanceByStory',
  'sandboxPacketByStory',
  'sandboxConfigs',
  'sandboxActive',
  'appearanceByStory',
  'artSeedByStory',
  'statsByStory',
  'codexByStory',
  'scanProgress',
];

/**
 * Slices that do not travel, for one of two reasons.
 *
 * Most are PRIVATE: a margin note is not direction, and neither is an
 * interview, a companion's reaction, a tracking sheet somebody built while
 * reading, or the log of what this reader's own marks taught the Director.
 * Visitors are worse than private — a borrowed character is a brief written
 * from somebody's OTHER chat, and it is not this story's to hand on.
 *
 * The last few are simply the RECEIVER'S: app-wide preferences that belong to
 * whoever is opening the file, not to whoever made it.
 *
 * Kept as its own list — rather than "anything not in CUT_SLICES" — so that a
 * new slice added to the store trips the test instead of silently defaulting
 * into either policy.
 */
export const NEVER_IN_A_CUT: readonly string[] = [
  'sheetsByStory',         // tracking sheets the reader built for themselves
  'annotationsByStory',    // margin notes
  'askByStory',            // interviews with the cast
  'reactionsByStory',      // who was watching, and what they said
  'chatThreadsByStory',    // the reader's conversations about the story
  'activeThreadByStory',
  'zonesByStory',          // hand-curated context selections
  'visitorsByStory',       // characters borrowed from OTHER private chats
  // The reader's own persona and the shape of their whole library — the titles
  // of every other story they keep and a written account of what happened to
  // them in each. Sending that with a Cut would leak a shelf, and land on the
  // receiver as an instruction about who THEY are playing.
  'throughlines',
  'tasteMarks',            // what the reader's own marks taught the Director
  'libraryTagsByStory',    // how they organise their own shelf
  'recapSeen',
  'pinsByStory',
  'pinSetsByStory',
  'activePinSetByStory',
  'summaryPinByStory',
  'cowritePresets',
  // The receiver's own preferences, not the sender's to set.
  'codexEnabled',
  'codexUseAI',
  'codexHighlight',
];

/** What a Cut looks like on disk. */
export interface Cut {
  magic: typeof CUT_MAGIC;
  version: number;
  exportedAt: number;
  /** Free text the sender can put on it. Never executed, never rendered as HTML. */
  note?: string;
  story: Story;
  /** Slice name → that story's share of it. */
  direction: Record<string, unknown>;
  /** How it was being read, so it opens the way it was meant to be seen. */
  presentation?: { readingMode?: string; viewMode?: string; theme?: string };
}

/** A count of what is actually in a Cut, for saying so before writing it. */
export interface CutSummary {
  title: string;
  passages: number;
  words: number;
  /** Passages the Director has read — the part that costs money to recreate. */
  directed: number;
  /** Spans the reader marked by hand. */
  marks: number;
  /** Lens rewrites travelling with it. */
  edits: number;
  /** Generated pictures on the sender's machine. Their BYTES do not travel yet
   *  — the metadata does, so the dialog has to say so rather than imply it. */
  art: number;
  bytes: number;
  /** Slice names carrying anything, for the dialog to list plainly. */
  carrying: string[];
}

const countBag = (v: unknown): number => {
  if (!v) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>)
      .reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : 1), 0);
  }
  return 1;
};

/**
 * Everything the sender's own library holds for this story, filtered to what a
 * Cut is allowed to carry.
 *
 * `slices` is the whole v2 bag; this reaches into each per-story slice and
 * takes only this story's share, so nothing about anyone else's reading can
 * ride along even by accident.
 */
export const collectDirection = (
  slices: Record<string, unknown>, storyId: string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const slice of CUT_SLICES) {
    const bag = slices[slice];
    if (!bag || typeof bag !== 'object') continue;
    const share = (bag as Record<string, unknown>)[storyId];
    if (share === undefined) continue;
    out[slice] = share;
  }
  return out;
};

/**
 * Build a Cut.
 *
 * The story is copied WITHOUT its highlights: those are notes in the margin of
 * somebody's private reading, and the fact that they are stored on the story
 * record rather than in a slice is an implementation detail, not permission.
 */
export const buildCut = (
  story: Story,
  slices: Record<string, unknown>,
  opts: { note?: string; presentation?: Cut['presentation']; exportedAt?: number } = {},
): Cut => {
  const { highlights: _dropped, ...rest } = story;
  return {
    magic: CUT_MAGIC,
    version: CUT_VERSION,
    exportedAt: opts.exportedAt ?? Date.now(),
    note: opts.note?.trim() || undefined,
    story: { ...rest, highlights: [] } as Story,
    direction: collectDirection(slices, story.id),
    presentation: opts.presentation,
  };
};

/** Serialise. Compact on purpose — a Cut is a payload, not a document to read. */
export const cutToText = (cut: Cut): string => JSON.stringify(cut);

/** Count what is in one, for the dialog that has to say so. */
export const describeCut = (cut: Cut): CutSummary => {
  const messages = cut.story.messages ?? [];
  const scenes = cut.direction.sceneByStory;
  return {
    title: cut.story.title,
    passages: messages.length,
    words: messages.reduce((n, m) => n + (m.content.match(/\S+/g)?.length ?? 0), 0),
    directed: scenes && typeof scenes === 'object' ? Object.keys(scenes as object).length : 0,
    marks: countBag(cut.direction.performMarksByStory) + countBag(cut.direction.emphasisMarksByStory)
      + countBag(cut.direction.sfxMarksByStory),
    edits: countBag(cut.direction.overridesByStory),
    art: countBag(cut.direction.artByStory),
    bytes: cutToText(cut).length,
    carrying: CUT_SLICES.filter(s => countBag(cut.direction[s]) > 0),
  };
};

/**
 * Read a Cut, or say why not.
 *
 * Fails closed on every count: a file that is not a Cut, a Cut from a newer
 * build, a Cut with no story in it. And it STRIPS rather than trusting — a
 * hand-edited or malicious file cannot smuggle a slice past `CUT_SLICES` by
 * naming it in `direction`, because only known slice names are copied across.
 */
export const parseCut = (text: string): { cut?: Cut; error?: string } => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: 'That file is not a Cut.' }; }
  const o = raw as Partial<Cut> | null;
  if (!o || typeof o !== 'object' || o.magic !== CUT_MAGIC) {
    return { error: 'That file is not a Cut.' };
  }
  const version = typeof o.version === 'number' ? o.version : 0;
  if (version > CUT_VERSION) {
    return { error: `This Cut was made by a newer version of Aeia Reader (v${version}).` };
  }
  const story = o.story as Story | undefined;
  if (!story || !Array.isArray(story.messages) || story.messages.length === 0) {
    return { error: 'That Cut has no story in it.' };
  }
  const direction: Record<string, unknown> = {};
  const given = (o.direction ?? {}) as Record<string, unknown>;
  for (const slice of CUT_SLICES) {
    if (given[slice] !== undefined) direction[slice] = given[slice];
  }
  return {
    cut: {
      magic: CUT_MAGIC,
      version,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : Date.now(),
      note: typeof o.note === 'string' ? o.note.slice(0, 500) : undefined,
      // Highlights never travel; an incoming file claiming some is either an
      // older build or someone hand-editing, and neither earns the benefit of
      // the doubt.
      story: { ...story, highlights: [] },
      direction,
      presentation: o.presentation,
    },
  };
};

/**
 * The store writes a Cut's direction wants, re-keyed to the id the story is
 * given on THIS machine.
 *
 * A Cut cannot carry its original story id and have it mean anything: two
 * readers can hold the same Cut, and a library keyed by the sender's ids would
 * collide the moment either of them opened a second copy.
 */
export const directionFor = (
  cut: Cut, newStoryId: string,
): { slice: string; value: Record<string, unknown> }[] =>
  Object.entries(cut.direction).map(([slice, share]) => ({
    slice,
    value: { [newStoryId]: share },
  }));

/** A filename that survives every filesystem, ending in the Cut extension. */
export const cutFilename = (title: string): string => {
  const stem = (title || 'story')
    .replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60).toLowerCase();
  return `${stem || 'story'}${CUT_EXTENSION}`;
};
