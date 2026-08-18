/**
 * Scene performance — the Director's TEXT-PERFORMANCE track.
 *
 * The emphasis track says which words are loud or quiet; this one says how the
 * reveal *behaves* over a span: drag the words out one at a time ("In. the.
 * end."), rush a panicked sentence, hold a beat of silence before a line lands,
 * swell a word larger before it settles back. Each cue is a verbatim substring
 * plus a direction verb; the reader resolves it to character offsets and the
 * streamer paces itself through them, so the effect is SYNCED to the reveal
 * rather than being a decoration applied afterwards.
 *
 * Pure module — no store, no React. Source text is never rewritten: cues only
 * mark spans that already exist. Works with the AI off, too: `derivePerformCues`
 * reads staccato punctuation, ellipses, and shouting straight from the prose.
 */

import { ExpressiveIntensity, ScenePerformCue, ScenePerformKind } from '../types';

export type PerformKind = ScenePerformKind;

export const PERFORM_KINDS: readonly PerformKind[] = [
  'slow', 'rush', 'stagger', 'hold', 'swell', 'tremble', 'drop', 'fade',
  'cut', 'unwrite',
];

/**
 * Every verb now carries a typographic treatment as well as its pacing. Pacing
 * alone is felt but not SEEN — a slowed reveal just reads as lag unless the
 * words visibly change with it — so the loud verbs get loud type and the
 * pacing verbs get a quiet signature that says "this is deliberate".
 */
export const PERFORM_VISUAL: ReadonlySet<PerformKind> = new Set(PERFORM_KINDS);

/** What a direction verb does to the reveal. */
export interface PerformProfile {
  /** Reveal-rate multiplier inside the span (<1 drags, >1 rushes). */
  rate: number;
  /** Extra hold (ms) at the end of every word inside the span. */
  wordHold: number;
  /** Beat of silence (ms) held just BEFORE the span's first character. */
  enterHold: number;
  /** Beat of silence (ms) held just AFTER the span's last character — the dead
   *  air behind an interruption, or the time an erasure needs to finish. */
  exitHold: number;
}

/**
 * The performance vocabulary, at "expressive" strength. Deliberately small —
 * a director works with a handful of verbs, and every extra kind is one more
 * thing the model can misuse.
 */
export const PERFORM_PROFILES: Record<PerformKind, PerformProfile> = {
  /** Drag: dread, revelation, a line that must be read slowly. */
  slow: { rate: 0.34, wordHold: 0, enterHold: 0, exitHold: 0 },
  /** Rush: panic, a tumbling list, words falling over each other. */
  rush: { rate: 2.3, wordHold: 0, enterHold: 0, exitHold: 0 },
  /** One. Word. At. A. Time. — the hard-stop cadence. */
  stagger: { rate: 0.45, wordHold: 260, enterHold: 120, exitHold: 0 },
  /** A held beat of silence before the span lands. */
  hold: { rate: 0.8, wordHold: 0, enterHold: 900, exitHold: 0 },
  /** The word blooms larger, then settles back to normal. */
  swell: { rate: 0.5, wordHold: 90, enterHold: 60, exitHold: 0 },
  /** Unsteady, shaking — fear, rage, a voice about to break. */
  tremble: { rate: 0.7, wordHold: 0, enterHold: 0, exitHold: 0 },
  /** Heavy: each word thuds into place. */
  drop: { rate: 0.4, wordHold: 200, enterHold: 150, exitHold: 0 },
  /** Faint, receding — a whisper dying out, a memory going. */
  fade: { rate: 0.72, wordHold: 0, enterHold: 0, exitHold: 0 },
  /**
   * Interrupted — the words tumble out and stop dead. The one place a FASTER
   * reveal reads as more dramatic: the line races to its cut-off, and the
   * silence behind it does the rest of the work.
   */
  cut: { rate: 5, wordHold: 0, enterHold: 0, exitHold: 700 },
  /**
   * Unwritten — the words are set down, then dissolve off the page: a
   * retraction, a memory going, a truth taken back. The reveal writes them
   * slowly and waits for the erasure before moving on. The words are never
   * removed from the passage — the source stays whole, the ghost stays
   * selectable, and looking straight at it brings it back.
   */
  unwrite: { rate: 0.5, wordHold: 140, enterHold: 0, exitHold: 900 },
};

/** How hard the intensity preset leans on the profile above. */
const INTENSITY_SCALE: Record<ExpressiveIntensity, number> = {
  subtle: 0.55,
  expressive: 1,
  cinematic: 1.5,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The profile for a cue at a given intensity, optionally weighted by the
 * Director's own `strength`. Rates are pulled toward 1 (and holds toward 0) at
 * "subtle" so the same descriptor reads as a nudge or as a full performance
 * depending on the reader's taste.
 *
 * Holds are additive milliseconds, so they scale LINEARLY. Rates are
 * multipliers, so they scale GEOMETRICALLY (`base ** k`) — the two agree
 * exactly at k=1, which is where the profiles above were tuned, but the linear
 * form runs off the end of its own range above it: `slow` computed 0.01 at
 * cinematic and `drop` 0.10, both slammed into the 0.15 floor. That made the
 * only intensity `scenePerformance` actually ships at (Performance mode is
 * "cinematic") the one where slow, drop and stagger were indistinguishable and
 * all pinned at the heaviest drag the clamp allows — which is what a stall with
 * no apparent cause looks like from the reader's chair. `base ** k` keeps the
 * ordering and the character of each verb at every intensity.
 */
export const scaleProfile = (
  kind: PerformKind,
  intensity: ExpressiveIntensity = 'expressive',
  strength = 1,
): PerformProfile => {
  const base = PERFORM_PROFILES[kind] ?? PERFORM_PROFILES.slow;
  const k = (INTENSITY_SCALE[intensity] ?? 1) * clamp(strength, 0.25, 1.5);
  return {
    rate: clamp(base.rate ** k, 0.15, 8),
    wordHold: base.wordHold * k,
    enterHold: base.enterHold * k,
    exitHold: base.exitHold * k,
  };
};

/**
 * Reader-authored cues first, then the Director's — the resolver claims spans
 * first-come, so a hand-marked span always wins the words it covers. Returns
 * the SAME array when only one side has cues, so memoized renderers don't see
 * a new object every pass.
 */
export const mergePerformCues = (
  reader: ScenePerformCue[] | undefined,
  director: ScenePerformCue[] | undefined,
): ScenePerformCue[] | undefined => {
  if (!reader?.length) return director?.length ? director : undefined;
  if (!director?.length) return reader;
  return [...reader, ...director];
};

/**
 * What each verb does to the SOUND while its span is on the reveal — the beds
 * (music + ambience) only, never the voice. `gain` scales their volume and
 * `rate` drags or pushes their playback speed (pitch follows, which is what
 * makes a slowed line feel slowed instead of merely looking it).
 *
 * These are deliberately small: a bed that lurches announces the machinery.
 * The exception is `hold`, where the near-silence IS the effect.
 */
export interface PerformAudio { gain: number; rate: number }

export const PERFORM_AUDIO: Record<PerformKind, PerformAudio> = {
  slow: { gain: 0.86, rate: 0.93 },      // the room drags with the words
  rush: { gain: 1.12, rate: 1.07 },      // everything tips forward
  stagger: { gain: 0.74, rate: 0.95 },   // space opens around each word
  hold: { gain: 0.3, rate: 0.9 },        // the breath before — near silence
  swell: { gain: 1.18, rate: 1 },        // the room opens up with the word
  tremble: { gain: 0.9, rate: 0.97 },
  drop: { gain: 0.82, rate: 0.94 },      // weight, not volume
  fade: { gain: 0.62, rate: 0.95 },
  cut: { gain: 0.22, rate: 1 },          // the sound is cut off with the line
  unwrite: { gain: 0.5, rate: 0.88 },    // the world recedes with the words
};

/**
 * The bed envelope owed at reveal position `pos`, scaled by intensity so
 * "subtle" barely moves the mix. Neutral (1, 1) outside every span.
 */
export const performAudioAt = (
  ranges: PerformRange[],
  pos: number,
  intensity: ExpressiveIntensity = 'expressive',
): PerformAudio => {
  const r = rangeAt(ranges, pos);
  if (!r) return { gain: 1, rate: 1 };
  const base = PERFORM_AUDIO[r.kind] ?? { gain: 1, rate: 1 };
  const k = (INTENSITY_SCALE[intensity] ?? 1) * clamp(r.strength, 0.25, 1.5);
  return {
    gain: clamp(1 + (base.gain - 1) * k, 0.1, 1.5),
    rate: clamp(1 + (base.rate - 1) * k, 0.6, 1.5),
  };
};

/** A cue located in the passage, as character offsets into the revealed text. */
export interface PerformRange {
  start: number;
  end: number;
  kind: PerformKind;
  strength: number;
}

/** First occurrence of `needle` that doesn't collide with a claimed range. */
const locate = (hay: string, needle: string, taken: PerformRange[]): number => {
  let i = hay.indexOf(needle);
  while (i >= 0) {
    if (!taken.some(r => i < r.end && i + needle.length > r.start)) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
};

/**
 * Resolve cues to offsets in the text actually on screen. Matching is
 * case-insensitive (the render pipeline may have re-cased nothing, but smart
 * typography can rewrite quotes/dashes, so we stay lenient) and a cue that
 * can't be found is silently dropped — a stale descriptor must never stall the
 * reveal. Overlaps resolve first-come, and the result is sorted by start.
 */
export const resolvePerformRanges = (
  text: string,
  cues: ScenePerformCue[] | undefined,
): PerformRange[] => {
  if (!cues?.length || !text) return [];
  const hay = text.toLowerCase();
  const out: PerformRange[] = [];
  for (const c of cues) {
    const needle = (c?.text ?? '').trim().toLowerCase();
    if (needle.length < 2) continue;
    if (!PERFORM_KINDS.includes(c.kind)) continue;
    const i = locate(hay, needle, out);
    if (i < 0) continue;
    out.push({
      start: i,
      end: i + needle.length,
      kind: c.kind,
      strength: typeof c.strength === 'number' && Number.isFinite(c.strength)
        ? clamp(c.strength, 0.25, 1.5)
        : 1,
    });
  }
  return out.sort((a, b) => a.start - b.start);
};

/** The range containing `pos`, if any. */
export const rangeAt = (ranges: PerformRange[], pos: number): PerformRange | undefined =>
  ranges.find(r => pos >= r.start && pos < r.end);

/** Reveal-rate multiplier for the character about to be revealed at `pos`. */
export const performRateAt = (
  ranges: PerformRange[],
  pos: number,
  intensity: ExpressiveIntensity = 'expressive',
): number => {
  const r = rangeAt(ranges, pos);
  return r ? scaleProfile(r.kind, intensity, r.strength).rate : 1;
};

/**
 * Start offset of the next cue strictly ahead of `pos`, or -1. The streamer
 * clamps its reveal to this so a span's entrance beat lands exactly on the
 * span's first character instead of somewhere inside it.
 */
export const nextPerformStart = (ranges: PerformRange[], pos: number): number => {
  for (const r of ranges) if (r.start > pos) return r.start;
  return -1;
};

/**
 * The nearest cue EDGE strictly after `pos` — the end of the span we're inside,
 * else the start of the next one. The streamer stops the reveal there so both
 * the entrance and the exit beat land exactly where the Director marked them
 * (a frame that jumped over the edge would swallow the beat).
 */
export const nextPerformBoundary = (ranges: PerformRange[], pos: number): number => {
  const cur = rangeAt(ranges, pos);
  return cur ? cur.end : nextPerformStart(ranges, pos);
};

/** The beat of silence owed before the span that begins exactly at `pos`. */
export const performEnterMs = (
  ranges: PerformRange[],
  pos: number,
  intensity: ExpressiveIntensity = 'expressive',
): number => {
  const r = ranges.find(x => x.start === pos);
  if (!r) return 0;
  return Math.round(scaleProfile(r.kind, intensity, r.strength).enterHold);
};

/**
 * The beat owed after the span that ends exactly at `pos` — the dead air behind
 * an interruption, and the time an `unwrite` needs to finish dissolving before
 * the passage moves on.
 */
export const performExitMs = (
  ranges: PerformRange[],
  pos: number,
  intensity: ExpressiveIntensity = 'expressive',
): number => {
  const r = ranges.find(x => x.end === pos);
  if (!r) return 0;
  return Math.round(scaleProfile(r.kind, intensity, r.strength).exitHold);
};

/**
 * Extra hold (ms) owed by the character just revealed at `revealedLen - 1` —
 * the per-word beat that gives "In. the. end." its cadence. Zero unless that
 * character ends a word inside a span whose profile holds words.
 */
export const performHoldMs = (
  text: string,
  ranges: PerformRange[],
  revealedLen: number,
  intensity: ExpressiveIntensity = 'expressive',
): number => {
  if (revealedLen <= 0 || revealedLen > text.length) return 0;
  const r = rangeAt(ranges, revealedLen - 1);
  if (!r) return 0;
  const hold = scaleProfile(r.kind, intensity, r.strength).wordHold;
  if (hold <= 0) return 0;
  const c = text[revealedLen - 1];
  if (/\s/.test(c)) return 0;                        // mid-gap, not a word end
  const next = text[revealedLen] ?? '';
  if (next !== '' && !/\s/.test(next)) return 0;     // still inside the word
  return Math.round(hold);
};

/**
 * Word → visual treatment map for the render layer, mirroring how the emphasis
 * track is applied (per word, so markdown nesting can't break a span). Pacing-
 * only kinds are excluded — they're felt in the reveal, not seen.
 */
/**
 * Words a cue's meaning never lives in.
 *
 * A cue marks a SPAN ("she pulls away, her voice barely there"), but the
 * renderer walks a word at a time, so the span is matched word by word. Mapping
 * its function words meant one cue painted EVERY "the", "of", "her" and "she"
 * in the whole passage — a page of letter-spaced, half-faded connective tissue.
 * The content words identify the span; these never do.
 */
const NEVER_MARK = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'is', 'it', 'as', 'so', 'if', 'be', 'was', 'were', 'are', 'am', 'do', 'did',
  'he', 'she', 'they', 'you', 'we', 'i', 'me', 'him', 'her', 'them', 'us', 'my',
  'his', 'their', 'our', 'your', 'its', 'this', 'that', 'these', 'those',
  'with', 'from', 'into', 'over', 'up', 'out', 'off', 'not', 'no', 'all',
  'has', 'had', 'have', 'been', 'then', 'than', 'there', 'here', 'what', 'who',
  'when', 'how', 'just', 'like', 'about', 'would', 'could', 'will', 'can',
]);

/** Is this word distinctive enough to carry a cue? Shared with the emphasis map. */
export const isMarkableWord = (normalized: string): boolean =>
  normalized.length >= 2 && !NEVER_MARK.has(normalized);

export const performWordKinds = (
  cues: ScenePerformCue[] | undefined,
): Map<string, PerformKind> | null => {
  if (!cues?.length) return null;
  const map = new Map<string, PerformKind>();
  for (const c of cues) {
    if (!PERFORM_VISUAL.has(c.kind)) continue;
    // Cadence cues are marked as RUNS instead — see performRuns. Leaving them
    // here too would dress the same word twice, by two different rules.
    if (RUN_KINDS.has(c.kind)) continue;
    for (const w of (c.text ?? '').split(/\s+/)) {
      const n = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
      if (isMarkableWord(n) && !map.has(n)) map.set(n, c.kind);
    }
  }
  return map.size ? map : null;
};

/* ------------------------------------------------------------------ */
/* Cadence cues — the ones whose unit is a RUN, not a word             */
/* ------------------------------------------------------------------ */

/**
 * The two verbs that exist for the beat of a whole run rather than for one
 * word.
 *
 * Every other cue names a word and means something about THAT word: swell it,
 * shake it, let it fade. These two name a cadence — "In. the. end." is one
 * gesture spread across three words, and each word landing separately IS the
 * effect.
 *
 * That distinction was invisible until you watched one play. The word→kind map
 * runs every word through `isMarkableWord`, which drops the ninety commonest
 * words in English so a phrase cue cannot paint every "the" on the page. Right
 * for a phrase; wrong here, where the stalled words are exactly the small ones:
 *
 *     In.      the.      end.
 *     dropped  dropped   marked
 *
 * The streamer paces all three — offsets, not words — so the reader watched two
 * words arrive slowly with nothing happening to them, which is indistinguishable
 * from the app hanging. No treatment on `.perf-stagger` could have fixed it,
 * because the words that stall were never the words that were marked.
 */
export const RUN_KINDS: ReadonlySet<PerformKind> = new Set<PerformKind>(['stagger', 'drop']);

/** A cadence cue, reduced to the normalised words it covers, in order. */
export interface PerformRun {
  words: string[];
  kind: PerformKind;
}

/** Cadence cues as ordered word sequences. Empty tokens are dropped. */
export const performRuns = (
  cues: ScenePerformCue[] | undefined,
): PerformRun[] | null => {
  if (!cues?.length) return null;
  const out: PerformRun[] = [];
  for (const c of cues) {
    if (!RUN_KINDS.has(c.kind) || !PERFORM_VISUAL.has(c.kind)) continue;
    const words = (c.text ?? '').split(/\s+/)
      .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase())
      .filter(Boolean);
    if (words.length) out.push({ words, kind: c.kind });
  }
  return out.length ? out : null;
};

/**
 * One word claimed by a cadence run.
 *
 * `key` identifies the OCCURRENCE, not the word: a run is very often a repeat
 * ("No. No. No."), and a per-word key would tell the second and third that they
 * had already played and hold them still — which is the exact opposite of the
 * cue. Stable across renders because the run is matched from the start of the
 * message every time.
 */
export interface RunMark {
  kind: PerformKind;
  key: string;
}

/** Fed one word at a time; answers how to mark it. See `runMatcher`. */
export type RunMatcher = (normalized: string) => RunMark | null;

/**
 * A forward matcher over the cadence runs, fed the passage's words in document
 * order.
 *
 * Deliberately greedy and backtrack-free, because the SAME thirty lines have to
 * work in both of Aura's render paths — `wrapWords` walks React children and
 * decides each word as it reaches it, with no chance to look ahead, while
 * `markPerformHtml` scans a string. A matcher that needed lookahead would mean
 * two implementations, and the whole point of this module is that the five
 * views mark the same words by the same rules.
 *
 * What that costs: a false PREFIX. If "in the" appears earlier in the passage
 * without "end" behind it, those two words get the treatment and the run then
 * abandons. Two softly tinted words, against two algorithms that will
 * eventually disagree — an easy trade.
 *
 * Punctuation-only tokens normalise to nothing and are skipped rather than
 * treated as a break: an em-dash inside a staggered line does not end the run.
 * Each run fires once, so a repeated phrase is not re-performed.
 */
export const runMatcher = (runs: PerformRun[] | null | undefined): RunMatcher => {
  if (!runs?.length) return () => null;
  const done = new Set<number>();
  let active: { run: number; pos: number } | null = null;
  return (norm: string): RunMark | null => {
    if (!norm) return null;              // punctuation — does not break a run
    if (active) {
      const run = runs[active.run];
      if (run.words[active.pos + 1] === norm) {
        const pos = ++active.pos;
        const at = active.run;
        if (pos === run.words.length - 1) { done.add(at); active = null; }
        return { kind: run.kind, key: `run${at}:${pos}` };
      }
      active = null;                     // sequence broke — fall through to a fresh start
    }
    for (let i = 0; i < runs.length; i++) {
      if (done.has(i) || runs[i].words[0] !== norm) continue;
      if (runs[i].words.length === 1) done.add(i);
      else active = { run: i, pos: 0 };
      return { kind: runs[i].kind, key: `run${i}:0` };
    }
    return null;
  };
};

/**
 * The cadence matcher for a message's cues — the pairing every render path
 * wants, so no call site has to remember that `performWordKinds` alone now
 * leaves stagger and drop unmarked.
 *
 * Stateful: build one per message, and feed it that message's words in order.
 */
export const performMatcher = (cues: ScenePerformCue[] | undefined): RunMatcher | undefined => {
  const runs = performRuns(cues);
  // `undefined`, not a no-op matcher, so callers can test "are there runs here"
  // with the same value they pass down — and so the markers can keep their
  // do-nothing fast path.
  return runs ? runMatcher(runs) : undefined;
};

/**
 * Cadence cues do NOT consult or claim the `claimed` set, unlike every other
 * mark here. A run is very often built out of repetition — "No. No. No." — and
 * `claimed` would let the first word through and silently drop the rest, which
 * is the whole cue. Same reasoning as the all-caps shout heuristic: a word
 * performed three times is performed three times.
 */


/* ------------------------------------------------------------------ */
/* Heuristic fallback — performance without the AI.                    */
/* ------------------------------------------------------------------ */

/** Sentences with their offsets (a sentence ends at .!?… or a line break). */
const sentences = (text: string): { start: number; end: number; text: string }[] => {
  const out: { start: number; end: number; text: string }[] = [];
  const re = /[^.!?…\n]*[.!?…]+|[^.!?…\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) continue;
    out.push({ start: m.index + lead, end: m.index + lead + t.length, text: t });
  }
  return out;
};

const wordCount = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/**
 * Titles and abbreviations that end in a period without ending a sentence.
 * `sentences()` splits on the period and cannot tell the difference, so
 * "signed J. R. R. Tolkien" arrived as a run of one-word sentences and was
 * heard as staccato — an unexplained hard-stop cadence in the middle of
 * ordinary prose. Initials are caught by shape (`R.`), these by name.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'rev', 'sgt', 'capt', 'lt', 'col', 'gen',
  'jr', 'sr', 'vs', 'etc', 'no', 'approx', 'inc', 'ltd', 'co', 'ave', 'rd', 'blvd',
  'am', 'pm', 'ca', 'cf', 'al', 'eg', 'ie',
]);

/**
 * Does this "sentence" actually end one? A single initial (`R.`), a title
 * (`Mrs.`), or a bare number (`3.`, a list marker) never does — they only look
 * like sentences because the splitter cuts on the period.
 */
const endsASentence = (text: string): boolean => {
  const core = text.replace(/[.!?…]+$/, '').trim();
  if (!core) return false;
  if (/^\p{Lu}$/u.test(core)) return false;                  // an initial: "R."
  if (/^\p{N}+$/u.test(core)) return false;                  // a list marker: "3."
  return !ABBREVIATIONS.has(core.replace(/\./g, '').toLowerCase());
};

/** Max cues the heuristic will ever emit for one passage. */
const HEURISTIC_CAP = 3;

/**
 * Read a performance straight off the punctuation, for stories the Director
 * hasn't been run on (the reader is AI-optional by design). Conservative and
 * pacing-only — choosing which *word* to swell is a directorial judgement, so
 * that stays the AI's job.
 *
 * - A run of two or more one-or-two-word sentences → `stagger` ("In. the. end.")
 * - Speech broken off on a dash → `cut` (race to the break, then dead air)
 * - Text right after a trailing ellipsis → `hold` (the pause before the drop)
 * - A shouted run of ALL-CAPS words → `slow` (land the shout, don't blur it)
 */
export const derivePerformCues = (text: string): ScenePerformCue[] => {
  if (!text || text.length < 40) return [];
  const out: ScenePerformCue[] = [];
  const claimed: [number, number][] = [];
  const free = (a: number, b: number) => !claimed.some(([x, y]) => a < y && b > x);
  const take = (a: number, b: number, kind: PerformKind) => {
    if (out.length >= HEURISTIC_CAP || !free(a, b)) return;
    claimed.push([a, b]);
    out.push({ text: text.slice(a, b), kind });
  };

  // Staccato runs — the "In. the. end." cadence.
  const sents = sentences(text);
  const staccato = (s: { text: string }) =>
    wordCount(s.text) <= 2 && /[.!?…]$/.test(s.text) && endsASentence(s.text);
  for (let i = 0; i < sents.length;) {
    let j = i;
    while (j < sents.length && staccato(sents[j])) j++;
    if (j - i >= 2) take(sents[i].start, sents[j - 1].end, 'stagger');
    i = j > i ? j : i + 1;
  }

  // Speech broken off mid-sentence: a dash pressed against the closing quote
  // ("But I never—"). The words race at the interruption and stop dead.
  const broken = /(\S+(?:\s+\S+){0,4}\s*(?:—|--))\s*["”]/g;
  let m: RegExpExecArray | null;
  while ((m = broken.exec(text)) !== null) {
    take(m.index, m.index + m[1].length, 'cut');
  }

  // An ellipsis that ENDS a sentence is a held breath — pause before whatever
  // follows it. One that trails off mid-sentence ("she hesitated... then
  // reached for the door") is a softening, not a beat: firing the 900ms `hold`
  // on those froze ordinary roleplay prose three times a message, which is the
  // most common way this track reads as lag rather than as direction.
  const ell = /(?:…|\.\.\.)\s+((?:\p{Lu}|["“'‘—])\S*(?:\s+\S+)?)/gu;
  while ((m = ell.exec(text)) !== null) {
    const start = m.index + m[0].length - m[1].length;
    take(start, start + m[1].length, 'hold');
  }

  // A shout in caps gets room to land instead of blurring past.
  const caps = /\b[\p{Lu}][\p{Lu}'’-]{2,}(?:\s+[\p{Lu}][\p{Lu}'’-]{1,})*\b/gu;
  while ((m = caps.exec(text)) !== null) take(m.index, m.index + m[0].length, 'slow');

  return out.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
};
