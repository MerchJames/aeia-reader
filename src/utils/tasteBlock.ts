/**
 * The taste block — what this reader's own marks teach the Director.
 *
 * `performMarksByStory` and `emphasisMarksByStory` are the highest-signal data
 * in the app: a human saying *this span, this way*, by hand, with the passage
 * in front of them. Until now exactly one function read them (the render-time
 * merge) and then they died. This turns them into few-shot examples in the
 * Director's prompt, so a model that has never met this reader starts guessing
 * the way they would.
 *
 * Three decisions worth keeping:
 *
 * 1. **Global, not per-story.** Taste transfers between stories — someone who
 *    marks endings rather than shocks does it everywhere. That is the whole
 *    point, and it is why this is its own flat log rather than something
 *    derived from the per-story slices (which are loaded lazily, one story at
 *    a time, so a derivation would only ever see the story already open).
 *
 * 2. **A cleared mark counts, and counts louder.** Taking a cue OFF is a reader
 *    saying "not here, not this" about a span the Director chose, which is a
 *    sharper instruction than adding one. Both polarities are kept, and the
 *    selection guarantees room for each.
 *
 * 3. **Judgement, not spans.** The examples come from OTHER passages, so
 *    copying one is always wrong. The header says so, and the Director's own
 *    parser is the backstop: `cleanEmphasis`/`cleanPerform` drop any span that
 *    is not a verbatim substring of the passage in hand, so a copied example
 *    fails closed rather than landing on the page.
 *
 * Pure: no store, no React, no I/O. Deterministic for a given log, so an
 * unchanged reader keeps sending a byte-identical prompt prefix.
 */

import { PERFORM_KINDS } from './scenePerform';

export type TasteTrack = 'perform' | 'emphasis';

/** One thing the reader did to one span, at one moment. */
export interface TasteEntry {
  /** The words they picked, verbatim. */
  text: string;
  /** A ScenePerformKind or a SceneEmphasisKind, depending on `track`. */
  kind: string;
  track: TasteTrack;
  /** When. Recency chooses the sample. */
  at: number;
  /** They took this one off. See §2 above. */
  cleared?: boolean;
}

/** How many marks the log keeps. Beyond this the oldest fall off the end. */
export const TASTE_LOG_CAP = 60;
/** How many reach the prompt. Ten is where it starts sounding like a person. */
export const MAX_TASTE_MARKS = 10;
/** Longest example span. A cue is a few words; anything longer is a paragraph
 *  the reader dragged over, and it teaches length rather than judgement. */
export const MAX_TASTE_TEXT = 64;
/** Hard ceiling on the whole block, in characters (~180 tokens). */
export const TASTE_BUDGET = 700;
/** Slots held for each polarity, so ten clears in a row can't silence the
 *  positives (or the other way round). */
const RESERVE_EACH = 2;

/**
 * Kinds the Director can actually emit. The reader's own vocabulary is wider —
 * `sfx` marks a span for a SOUND, which is the audio track's business and not
 * something the Director has a slot for — and teaching a model a kind it is
 * forbidden to return produces exactly one thing: invalid JSON.
 */
const DIRECTABLE_EMPHASIS: ReadonlySet<string> =
  new Set(['whisper', 'shout', 'beat', 'underline', 'strike', 'color']);
const DIRECTABLE_PERFORM: ReadonlySet<string> = new Set<string>(PERFORM_KINDS);

const directable = (e: TasteEntry): boolean =>
  e.track === 'perform' ? DIRECTABLE_PERFORM.has(e.kind) : DIRECTABLE_EMPHASIS.has(e.kind);

/** Collapse whitespace so the same span marked twice reads as one entry. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const clip = (s: string): string =>
  s.length <= MAX_TASTE_TEXT ? s : `${s.slice(0, MAX_TASTE_TEXT - 1).trimEnd()}…`;

/**
 * Append to the log, newest last, capped.
 *
 * Deliberately not deduping here: the log is a record of what happened, and an
 * add-then-clear pair on the same span is the interesting case. `tasteBlock`
 * resolves it at render time, where the LAST word wins.
 */
export const recordTaste = (log: readonly TasteEntry[], entry: TasteEntry): TasteEntry[] => {
  const text = norm(entry.text);
  if (!text) return [...log];
  const next = [...log, { ...entry, text }];
  return next.length > TASTE_LOG_CAP ? next.slice(next.length - TASTE_LOG_CAP) : next;
};

/**
 * One entry per (track, kind, span) — the newest, so marking a span and then
 * clearing it teaches the clear, not both. Ordering is by time, then by text
 * and kind, so two marks made in the same millisecond can never swap places
 * between two builds of the same block.
 */
const resolve = (log: readonly TasteEntry[]): TasteEntry[] => {
  const seen = new Map<string, TasteEntry>();
  for (const e of log) {
    if (!directable(e)) continue;
    const text = norm(e.text);
    if (!text) continue;
    const key = `${e.track}|${e.kind}|${text.toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || e.at >= prev.at) seen.set(key, { ...e, text });
  }
  return [...seen.values()].sort((a, b) =>
    a.at - b.at || a.text.localeCompare(b.text) || a.kind.localeCompare(b.kind));
};

/**
 * The most recent marks, with both polarities represented.
 *
 * Straight recency would let a tidying session — ten clears in a row — send a
 * block that reads as "this reader hates cues", which is a different lesson
 * from the one they were teaching.
 */
export const selectTaste = (log: readonly TasteEntry[], limit = MAX_TASTE_MARKS): TasteEntry[] => {
  const all = resolve(log);
  if (all.length <= limit) return all;
  const newestFirst = [...all].reverse();
  const picked = new Set<TasteEntry>();
  const take = (want: (e: TasteEntry) => boolean, n: number): void => {
    for (const e of newestFirst) {
      if (picked.size >= limit || n <= 0) return;
      if (picked.has(e) || !want(e)) continue;
      picked.add(e);
      n--;
    }
  };
  take(e => !!e.cleared, RESERVE_EACH);
  take(e => !e.cleared, RESERVE_EACH);
  take(() => true, limit);
  return all.filter(e => picked.has(e));
};

const line = (e: TasteEntry): string =>
  `${e.cleared ? '  they took OFF: ' : '  '}"${clip(e.text)}" → ${e.kind}`;

/**
 * Render the block, or '' when this reader has marked nothing.
 *
 * Empty is a real answer: an empty section headed "THIS READER'S MARKS" is
 * noise the model still has to read, and worse, it implies a reader with no
 * taste rather than one who has not spoken yet.
 */
export const tasteBlock = (log: readonly TasteEntry[], limit = MAX_TASTE_MARKS): string => {
  let picked = selectTaste(log, limit);
  if (!picked.length) return '';
  const head = [
    "THIS READER'S OWN MARKS — spans they directed by hand, oldest first.",
    'Match the JUDGEMENT: what kind of moment they think earns a cue, which',
    'verbs they reach for, and how OFTEN they mark at all. The words below are',
    'from other passages — never copy a span from this list into your answer.',
    'A "took OFF" line is one they removed: that kind of moment does not earn a',
    'cue for this reader, and it is the strongest signal here.',
  ].join('\n');
  // Trim from the OLDEST end, so what survives a tight budget is the most
  // recent thing the reader taught us.
  let body = picked.map(line).join('\n');
  while (picked.length > 1 && `${head}\n${body}`.length > TASTE_BUDGET) {
    picked = picked.slice(1);
    body = picked.map(line).join('\n');
  }
  return `${head}\n${body}`;
};
