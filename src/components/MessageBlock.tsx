import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, ChevronLeft, ChevronRight, ChevronRight as Caret, EyeOff, ImageIcon, MessageSquare, Pencil, Pin as PinIcon, Wand2 } from 'lucide-react';
import { cn } from '../utils/cn';
import { useAppStore } from '../store';
import { resolveTheme } from '../themes';
import { hasColorMarks, resolveColor, splitColorRuns } from '../utils/fontColor';
import {
  AnimationStyle,
  AutoFormatRule,
  DialogueAnimation,
  DialogueStyle,
  FontColorMode,
  Message,
  OocHandling,
  PinFormat,
  SceneArt,
  SceneEmphasis,
  ScenePerformCue,
  StatRule,
  StreamEffect,
  Theme,
  ViewMode,
} from '../types';
import { ThemeDef } from '../themes';
import {
  balanceEmphasis,
  processText,
  truncateToWord,
} from '../utils/textProcessor';
import { isShoutWord, normalizeWord } from '../utils/expressive';
import {
  PerformKind, RunMatcher, isMarkableWord, performRuns, performWordKinds, runMatcher,
} from '../utils/scenePerform';
import {
  FX_LIFETIME_MS, emphasisClass, emphasisKindKey, MARKABLE_EMPHASIS,
} from '../utils/performMarkup';
import { attributeSpeaker, aiSpeakerFor, DialogueAttribution } from '../utils/dialogueSegments';
import { buildStatPanel, isBarStat, StatEntry } from '../utils/statFormatter';
import {
  CharColorBundle, MarkupPreset, MarkupPresets, markupClass, quoteChannel,
} from '../utils/markupStyles';
import { SceneArtStrip } from './SceneArtStrip';

/** Strip markdown markers for a plain-text context preview. */
const plainish = (t: string): string =>
  t.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Pull quoted spans out of a message for the phone "dialogue only" mode, each
 * paired with the narration surrounding it (from the previous line to the next)
 * so hovering a bubble can reveal the text around it.
 */
const extractDialogueSegments = (
  text: string, cast: string[] = [], dialogue?: DialogueAttribution[],
  names: { characterName?: string; userName?: string } = {},
): { quote: string; context: string; speaker?: string }[] => {
  const re = /["“]([^"”\n]{1,400})["”]/g;
  const matches: { inner: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1].trim()) matches.push({ inner: m[1].trim(), start: m.index, end: re.lastIndex });
  }
  return matches.map((mm, i) => {
    const from = i > 0 ? matches[i - 1].end : 0;
    const to = i < matches.length - 1 ? matches[i + 1].start : text.length;
    const context = plainish(text.slice(from, to));
    // Enrichment attribution first, then the narration heuristic — so a quote
    // the author voices for someone else is labelled, not read as this message's.
    const speaker = aiSpeakerFor(mm.inner, dialogue, names)
      ?? attributeSpeaker(text.slice(from, mm.start).slice(-72), text.slice(mm.end, to).slice(0, 72), cast);
    return { quote: mm.inner, context, speaker };
  });
};

/** Deterministic color from a name, for fallback avatars. */
const avatarColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 45%)`;
};

const Avatar = ({ name, src }: { name: string; src?: string }) =>
  src ? (
    <img
      src={src}
      alt={name}
      className="w-10 h-10 rounded-full object-cover shrink-0 ring-2 ring-app-border"
      referrerPolicy="no-referrer"
    />
  ) : (
    <div
      className="w-10 h-10 rounded-full shrink-0 ring-2 ring-app-border flex items-center justify-center text-white font-bold text-sm select-none"
      style={{ background: avatarColor(name || '?') }}
      aria-hidden
    >
      {(name?.trim()?.[0] ?? '?').toUpperCase()}
    </div>
  );

const StatPanel = ({ entries }: { entries: StatEntry[] }) => {
  const table = entries.some(e => e.display === 'table');
  if (table) {
    return (
      <div className="mb-3 overflow-hidden rounded-lg border border-app-border/60 bg-app-text/5">
        <table className="w-full text-sm">
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className="border-b border-app-border/40 last:border-0">
                <td className="px-3 py-1.5 font-medium opacity-80 w-1/3">{e.key}</td>
                <td className="px-3 py-1.5">{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {entries.map((e, i) => {
        const bar = isBarStat(e.key, e.value);
        const numeric = parseFloat(e.value);
        return (
          <div
            key={i}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-app-text/10 border border-app-border/40"
          >
            <span className="font-medium opacity-80">{e.key}</span>
            <span className="opacity-100">{e.value}</span>
            {bar && !Number.isNaN(numeric) && (
              <div className="w-12 h-1.5 rounded-full bg-app-text/20 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.min(100, Math.max(0, numeric))}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Terminal "decrypt" caret: a short run of glyphs cycling ahead of the
 * revealed text. The scramble lives entirely in the caret so the real
 * (markdown-rendered) text is never corrupted by random characters.
 */
const DECRYPT_GLYPHS = '!<>-_\\/[]{}—=+*^?#$%&01';
const DecryptCaret = () => {
  const [glyphs, setGlyphs] = useState('▓▒░');
  useEffect(() => {
    const id = setInterval(() => {
      let out = '';
      for (let i = 0; i < 3; i++) {
        out += DECRYPT_GLYPHS[Math.floor(Math.random() * DECRYPT_GLYPHS.length)];
      }
      setGlyphs(out);
    }, 66);
    return () => clearInterval(id);
  }, []);
  return <span className="decrypt-caret font-mono ml-0.5" aria-hidden>{glyphs}</span>;
};

const textOf = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (React.isValidElement(children)) return textOf((children.props as any).children);
  return '';
};

/* ------------------------------------------------------------------ */
/* Streaming word-reveal                                               */
/* ------------------------------------------------------------------ */

/** Max words animated at the streaming tail. Older words settle to plain text. */
const WORD_REVEAL_CAP = 24;
/** Stagger between tail words (ms). */
const WORD_REVEAL_STAGGER = 30;
/** Word boundary for indexing — any non-whitespace run. */
const WORD_RE = /\S+/g;

const countWords = (text: string): number => {
  const matches = text.match(WORD_RE);
  return matches ? matches.length : 0;
};

/** Signature of HTML-looking code the AI writes for charts and layouts. */
const HTML_ISH = /<\s*(table|div|svg|style|section|article|html|canvas|figure|ul|chart)/i;

interface WordCounter {
  /**
   * The shared cursor, advanced by TOP-LEVEL blocks only.
   *
   * ── Why a word's number is not simply "next" ──────────────────────────────
   *
   * Words have to be numbered in the order they are READ, because the number is
   * what decides whether a word is in the streaming tail. They used to be
   * numbered in the order React happened to render them, which is not the same
   * order at all: `wrapWords` numbers a block's plain text when the `p`
   * renderer runs, but hands back its child elements untouched, and React only
   * descends into those `em` / `strong` children afterwards — each advancing
   * this same counter.
   *
   * So every plain word in a paragraph was numbered before any emphasised one,
   * and "the last 24 numbers" stopped meaning "the last 24 words". On a passage
   * with emphasis in it the reveal lit up the ITALICISED words, scattered right
   * back through the paragraph, while the words actually arriving got nothing —
   * measured at 22 of 24 animating words sitting inside `<em>` while the six
   * newest words on screen were plain. The effect looked like it was lagging
   * the text, and how far it lagged depended on how marked-up the passage was,
   * so it came and went.
   *
   * The fix is `reserved`: a parent's walk hands each child element the range
   * its words occupy, so a child numbers itself where it actually sits rather
   * than wherever the render happened to reach. Blocks need no reservation —
   * React finishes one block's whole subtree before starting the next, so they
   * are already in order, and they are the only things that move this cursor.
   */
  block: { value: number };
  /**
   * Element (hast node) → the word number its first word gets.
   *
   * Written by whichever walk passed over the element, read by the renderer
   * React later calls for it. Keyed by the hast node because that is the one
   * object both sides can see: react-markdown passes it to every component as
   * `node`, and the React element it built carries it in `props`.
   */
  reserved: Map<unknown, number>;
  /** Words first seen this render — staggers a burst without lagging steady streams. */
  fresh: number;
  /**
   * Cue words already spent in this message.
   *
   * A Director cue points at ONE span, but the renderer matches it word by word,
   * so without this a cue on "she pulls away" re-fired on every later "away" —
   * and combined with common words that meant a single cue flooded the whole
   * passage with treatments. One mark stays one mark.
   */
  claimed: Set<string>;
  /**
   * This message's cadence matcher — see `runMatcher`.
   *
   * It lives on the counter because a run has to be matched across the whole
   * passage in document order, and `wrapWords` is called once per markdown
   * block. The counter is the only thing that already spans them all.
   */
  runs: RunMatcher;
}

/** Longest stagger a burst of new words can accumulate (10 × 30ms). */
const WORD_REVEAL_MAX_BATCH = 10;

/**
 * Wrap the streaming tail words of plain string segments in animated spans.
 * Lore tooltips, nested elements, and non-string children are left untouched
 * so the block-level reveal handles them.
 *
 * Each word's animation START TIME is stamped once, when the word first
 * arrives (kept in `starts`, which lives for the whole stream) — so a word
 * animates relative to its own arrival, not its position in the tail window.
 * New words appear immediately; only same-frame bursts get a small stagger.
 *
 * ── Why a start time and not a delay ──────────────────────────────────────
 *
 * This map used to hold the assigned stagger, which was the right idea against
 * the wrong failure. A stored delay survives a RE-RENDER; it does nothing
 * against a REMOUNT, and this subtree remounts constantly — the `components`
 * object below is built inline, so every render hands react-markdown new
 * component identities and React rebuilds the tree rather than updating it.
 * A remounted span starts its animation again from zero.
 *
 * The reveal ticks every ~13ms at reading speed and the animations run for
 * 400-900ms, so no word ever got more than about 3% into its own arrival. For
 * the seven effects that open at `opacity: 0` that meant the whole 24-word
 * tail stayed INVISIBLE for as long as a passage streamed — the reader was
 * reading 24 words behind the reveal, with a hole of laid-out blank space
 * where the newest words should be. Cinema and Performance both ship `fade`,
 * so this was the default reading experience. Every unit test passed; a
 * screenshot showed it immediately.
 *
 * Stamping the START and emitting `animationDelay` relative to now makes the
 * remount harmless: the fresh element seeks to exactly where the old one had
 * got to. It is the same negative-delay resume already used for the Director's
 * cues a few lines down, which had to solve this once already.
 */
/**
 * Paint the colours the author wrote, where they wrote them.
 *
 * A colour cannot be said in markdown, so `normalizeInlineHtml` leaves it as a
 * sentinel run in the text (see `utils/fontColor`) and this is where it becomes
 * a colour again. Runs are turned into spans BEFORE `markLore` and `wrapWords`
 * see the children, which has one consequence worth stating: `wrapWords` does
 * not walk into elements, so words inside a coloured run keep the colour but
 * not the per-word arrival animation. That is the right way round — the colour
 * is a distinction the author drew and the animation is decoration — and it is
 * why this is a span rather than a per-word style.
 *
 * Untouched, and cheap, on the overwhelming majority of passages: no sentinel
 * in the string means the original children come straight back.
 */
const paintColors = (
  node: React.ReactNode, mode: FontColorMode, dark: boolean,
): React.ReactNode => {
  if (mode === 'ignore') return node;
  if (typeof node === 'string') {
    if (!hasColorMarks(node)) return node;
    const runs = splitColorRuns(node);
    if (runs.length === 1 && runs[0].color === null) return runs[0].text;
    return runs.map((run, i) => {
      const css = run.color ? resolveColor(run.color, mode, dark) : null;
      return css
        ? <span key={i} className="expr-authored-color" style={{ color: css }}>{run.text}</span>
        : <React.Fragment key={i}>{run.text}</React.Fragment>;
    });
  }
  if (Array.isArray(node)) return node.map(n => paintColors(n, mode, dark));
  return node;
};

const wrapWords = (
  node: React.ReactNode,
  counter: WordCounter,
  /** Where this walk is in the document, in words. See `WordCounter.block`. */
  cursor: { value: number },
  settled: number,
  style: string | null,
  starts: Map<number, number>,
  expressive: boolean,
  readingWord: number | null,
  emphasis: Map<string, string> | null,
  perform: Map<string, PerformKind> | null,
  /**
   * Words whose arrival animation has already run, kept for the life of the
   * stream.
   *
   * A marked word restarted its animation on essentially every reveal tick —
   * measured at 291 restarts on a single word in six seconds of streaming, and
   * 362 in Chat. The cue is meant to fire ON THE REVEAL of the word; instead it
   * strobed for as long as the passage kept growing, which reads as a rendering
   * fault rather than as direction. Once a word has played, it keeps the LOOK
   * (the classes carry static styling too) and drops the motion.
   */
  played: Map<number, number>,
  /** True when this message has cadence runs to mark — see counter.runs. */
  runs: boolean,
): React.ReactNode => {
  // Nothing to do unless we're animating the streaming tail, dressing shouts,
  // karaoke-highlighting the voice's word, or applying Director emphasis /
  // performance. When only `expressive` is on we wrap just the shout words, so
  // it stays cheap.
  if ((!style || WORD_REVEAL_CAP <= 0) && !expressive && readingWord == null
    && !emphasis && !perform && !runs) return node;
  if (typeof node === 'string') {
    if (!node.trim()) return node;
    const out: React.ReactNode[] = [];
    let at = 0;
    let m: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(node))) {
      const word = m[0];
      const idx = cursor.value++;
      // Director emphasis (AI-judged) wins over the caps-only shout heuristic.
      const norm = normalizeWord(word);
      const first = !counter.claimed.has(norm);
      const dir = emphasis && first ? emphasis.get(norm) : undefined;
      // One resolver for every path, so Book/Stage/VN/export cannot disagree
      // with this one about what a kind looks like.
      const emphCls = dir ? emphasisClass(dir) : (expressive && isShoutWord(word) ? 'expr-shout' : null);
      // How the Director wants this word to ARRIVE (swell, tremble, drop, fade).
      // The cadence matcher is fed EVERY word, in order, whatever else happens
      // to it — a matcher that misses a word loses the sequence.
      const run = counter.runs(norm);
      const perf = (perform && first ? perform.get(norm) : undefined) ?? run?.kind;
      if (dir || (perf && !run)) counter.claimed.add(norm);
      const reading = readingWord != null && idx === readingWord;
      // How far into its treatment this word already is (see `played`). A
      // rebuilt element resumes rather than restarting, and stops for good once
      // it has had its full run.
      let fxDelay = 0;
      let fxDone = false;
      if (dir || perf) {
        const first = played.get(idx);
        if (first === undefined) played.set(idx, Date.now());
        else {
          fxDelay = Date.now() - first;
          fxDone = fxDelay >= FX_LIFETIME_MS;
        }
      }
      const inTail = !!style && idx >= settled && idx < settled + WORD_REVEAL_CAP;
      if (!inTail && !emphCls && !reading && !perf) {
        // Ordinary settled/out-of-window word — emit as plain text. Keyed, so a
        // growing children array reconciles by identity rather than by position
        // (see the note on remounting below).
        out.push(node.slice(at, m.index + word.length));
      } else {
        if (m.index > at) out.push(node.slice(at, m.index));
        if (inTail && !starts.has(idx)) {
          // When this word's animation should BEGIN: now, plus its share of the
          // burst stagger. Stored absolute so any later render can work out how
          // far in it should already be.
          starts.set(idx, Date.now()
            + Math.min(counter.fresh++, WORD_REVEAL_MAX_BATCH) * WORD_REVEAL_STAGGER);
        }
        out.push(
          <span
            key={`w-${idx}`}
            className={cn(
              inTail && `word-reveal word-reveal-${style}`,
              emphCls,
              reading && 'tts-reading',
              fxDone && emphCls && 'fx-played',
            )}
            style={
              inTail
                // Positive on the word's first frame (its stagger), negative
                // afterwards — which seeks INTO the animation rather than
                // replaying it. Past the end, `animation-fill-mode: both` just
                // holds the settled state, which is what a cooled word is.
                ? { animationDelay: `${starts.get(idx)! - Date.now()}ms` }
                // Not in the tail, but mid-treatment: resume where it was.
                : (emphCls && fxDelay && !fxDone ? { animationDelay: `-${fxDelay}ms` } : undefined)
            }
          >
            {/* The performance treatment nests INSIDE the reveal span so the two
                animations (arrival + swell/tremble) don't overwrite each other. */}
            {perf
              ? (
                <span
                  className={cn(`perf-${perf}`, fxDone && 'fx-played')}
                  style={fxDelay && !fxDone ? { animationDelay: `-${fxDelay}ms` } : undefined}
                >
                  {word}
                </span>
              )
              : word}
          </span>,
        );
      }
      at = m.index + word.length;
    }
    if (at < node.length) out.push(node.slice(at));
    return out.length === 1 ? out[0] : out;
  }
  if (Array.isArray(node)) {
    return node.map(n => wrapWords(n, counter, cursor, settled, style, starts, expressive, readingWord, emphasis, perform, played, runs));
  }
  /*
   * An element this walk does not go inside — an `em`, a `strong`, a heading,
   * an entity mention from the codex, an image.
   *
   * Its words are still WORDS: they are on the page, they are read in this
   * position, and the numbering has to account for them or everything after
   * them is numbered as though they were not there. So step the cursor over
   * the whole subtree, and leave behind the number its first word should get,
   * for the renderer React will call for it in a moment.
   *
   * This is also what finally makes the codex honest. An entity mention is
   * wrapped in an element by `markLore`, so its words were counted by
   * `countWords` towards the settled total and then never claimed back — the
   * same desync the headings carry a comment about, except this one GREW as
   * you read, because the codex fills up as it goes.
   */
  if (React.isValidElement(node)) {
    const hast = (node.props as { node?: unknown })?.node;
    if (hast !== undefined) counter.reserved.set(hast, cursor.value);
    cursor.value += countWords(textOf(node));
  }
  return node;
};

/**
 * The cursor a renderer should number from.
 *
 * A reserved base means an ancestor's walk already decided where this element
 * sits, so it numbers itself privately inside that range and leaves the shared
 * cursor alone. No reservation means this is a top-level block, which owns the
 * shared cursor and moves it on for the block after it.
 */
const cursorFor = (counter: WordCounter, node: unknown): { value: number } => {
  const base = counter.reserved.get(node);
  return base === undefined ? counter.block : { value: base };
};

/** Word → emphasis-kind-key map from the Director's spans (verbatim substrings).
 *  Beats are pacing, not visual. whisper/shout are gated on the expressive
 *  toggle (they say how a line SOUNDS); colour/underline/strike are typographic
 *  and are not. Reader-authored marks always show. */
const buildEmphasisMap = (
  spans: SceneEmphasis[] | undefined,
  on: boolean,
): Map<string, string> | null => {
  if (!spans || spans.length === 0) return null;
  const map = new Map<string, string>();
  for (const s of spans) {
    if (!MARKABLE_EMPHASIS.has(s.kind)) continue;
    if ((s.kind === 'whisper' || s.kind === 'shout') && !on) continue; // expressive-gated
    const key = emphasisKindKey(s);
    for (const w of s.text.split(/\s+/)) {
      const n = normalizeWord(w);
      // Same span-matched-by-word problem as performWordKinds — a cue on a
      // phrase must not mark every "the" and "her" in the passage.
      if (isMarkableWord(n) && !map.has(n)) map.set(n, key);
    }
  }
  return map.size ? map : null;
};

export interface MessageBlockProps {
  msg: Message;
  content: string;
  isStreamingMsg: boolean;
  /** True once the streaming reveal has committed the whole passage — stops the
   *  in-progress last word from staying hidden through the end-of-message hold. */
  revealComplete?: boolean;
  /** Enrichment per-quote speaker attribution (phone dialogue-only view). */
  dialogue?: DialogueAttribution[];
  isMsgZoomed: boolean;
  avatar?: string;
  /** Raw message content, used for the per-block "view original" toggle. */
  rawContent?: string;
  /** Whether this message has a Lens override applied. */
  hasOverride?: boolean;
  /** Number of reader notes anchored to this message. */
  noteCount?: number;
  /** Opens the scoped thread listing this message's notes. */
  onOpenNotes?: (messageId: string) => void;
  /** Pins a table/code visual from this message to the side dock. */
  onPinContent?: (messageId: string, content: string, format: PinFormat) => void;
  /** Opens the AI assistant in Lens-edit mode targeting this message. */
  onLensEdit?: (messageId: string) => void;
  /** Opens the scene-image composer for this beat. Absent when no image
   *  backend is configured, so the button simply is not there. */
  onSceneImage?: (messageId: string) => void;
  /** Pictures generated for this beat. Rendered through the same grid as the
   *  message's own images — annotation alongside the source, never inside it. */
  sceneArt?: SceneArt[];
  /** Deletes one generated picture. */
  onRemoveArt?: (messageId: string, artId: string) => void;
  msgAnim: AnimationStyle;
  /** Per-word streaming effect (independent of the block reveal). */
  streamEffect: StreamEffect;
  /** Kinetic typography — scale shouts and dress scene breaks. */
  expressiveText: boolean;
  /** TTS is actively narrating — karaoke-highlight the word at the reveal edge. */
  ttsReading: boolean;
  /** Scene Director emphasis spans for this message (whisper/shout/beat). */
  emphasis?: SceneEmphasis[];
  /** Scene Director performance cues — the visual half (swell/tremble/drop/fade);
   *  the pacing half is applied by the streamer. */
  perform?: ScenePerformCue[];
  theme: Theme;
  themeDef: ThemeDef;
  minimalBubbles: boolean;
  isAutofocusMode: boolean;
  viewMode: ViewMode;
  phoneDialogueOnly: boolean;
  dialogueColor: string;
  dialogueStyle: DialogueStyle;
  dialogueAnimation: DialogueAnimation;
  /** The other four markup channels — aside, beat, shout, heading. */
  markup: MarkupPresets;
  /** Resolved per-character (and, advanced, per-channel) color overrides —
   *  see `resolveCharColors()`. Each channel present overrides that
   *  channel's own configured color. */
  charColors?: CharColorBundle;
  hideMetadata: boolean;
  oocHandling: OocHandling;
  autoFormat: boolean;
  autoFormatRules: AutoFormatRule[];
  statRules: StatRule[];
  paragraphSpacing: boolean;
  dialogueOwnLine: boolean;
  smartTypography: boolean;
  styleQuotes: boolean;
  substituteNames: boolean;
  characterName?: string;
  userName?: string;
  showImages: boolean;
  swipeSelections: Record<string, number>;
  activeRef?: React.RefObject<HTMLDivElement>;
  /**
   * Marks this row as where the newest words are, for the reading magnifier.
   *
   * Not the same thing as `isStreamingMsg`: when playback stops there is no
   * streaming message, and the light has to stay on the last passage the reader
   * reached rather than vanishing. ReaderDisplay decides which row that is.
   */
  revealEdge?: boolean;
  onMessageClick: (id: string) => void;
  onImageClick: (src: string) => void;
  onShowDialogueTip: (e: React.MouseEvent<HTMLElement>, text: string) => void;
  onHideDialogueTip: () => void;
  markLore: (children: React.ReactNode) => React.ReactNode;
  onSelectSwipe: (id: string, index: number) => void;
}

/* ------------------------------------------------------------------ */
/* Markup channels                                                      */
/* ------------------------------------------------------------------ */

/**
 * How deep inside `**` we are.
 *
 * `****shout****` is a strong node inside a strong node, and react-markdown
 * renders each one with the same component — so the inner node has no way to
 * know it is the loud one except by being told. React context is that telling:
 * one provider, set by the outer node, read by the inner.
 */
const StrongDepth = React.createContext(0);

const StrongMark = ({
  markup, charColors, expressiveText, animate, children, ...props
}: {
  markup: MarkupPresets;
  /** Per-character (and, advanced, per-channel) color overrides — see
   *  `MessageBlockProps.charColors`. */
  charColors?: CharColorBundle;
  expressiveText: boolean;
  animate: boolean;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) => {
  const depth = React.useContext(StrongDepth);
  const base = depth > 0 ? markup.shout : markup.bold;
  const charColor = depth > 0 ? charColors?.shout : charColors?.bold;
  const preset = charColor ? { ...base, color: charColor } : base;
  return (
    <strong
      className={cn(
        depth > 0 ? 'mk-shout' : 'mk-bold',
        markupClass(preset, {
          animate: animate && preset.animation !== 'none',
          baseWeight: 'font-bold',
        }),
        expressiveText && 'expr-key',
      )}
      {...props}
    >
      {children}
    </strong>
  );
};

/**
 * `h1`–`h6` overrides for one heading preset.
 *
 * All six levels share the channel on purpose: the reader chose a look for "a
 * heading the AI wrote", and an RP log's `#` versus `###` is not a considered
 * hierarchy — it is whatever the model felt like that turn. Sizes still come
 * from the prose stylesheet, so the levels stay distinguishable.
 */
const headingRenderers = (
  preset: MarkupPreset,
  animate: boolean,
  wrap: (children: React.ReactNode, node: unknown) => React.ReactNode,
) => {
  const className = cn(
    'mk-heading',
    markupClass(preset, { animate: animate && preset.animation !== 'none' }),
  );
  const make = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
    ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <Tag className={className} {...props}>{wrap(children, node)}</Tag>
    );
  return { h1: make('h1'), h2: make('h2'), h3: make('h3'), h4: make('h4'), h5: make('h5'), h6: make('h6') };
};

const MessageContent = React.memo(({
  msg,
  content,
  isStreamingMsg,
  revealComplete,
  msgAnim,
  dialogueColor,
  dialogueStyle,
  dialogueAnimation,
  markup,
  charColors,
  hideMetadata,
  oocHandling,
  autoFormat,
  autoFormatRules,
  statRules,
  paragraphSpacing,
  dialogueOwnLine,
  smartTypography,
  styleQuotes,
  substituteNames,
  characterName,
  userName,
  showImages,
  swipeSelections,
  onImageClick,
  onSelectSwipe,
  markLore,
  onPinContent,
  sceneArt,
  onRemoveArt,
  expressiveText,
  ttsReading,
  emphasis,
  perform,
  totalRevealed,
  wordRevealStyle,
  wordStarts,
  playedFx,
}: Pick<MessageBlockProps, 'msg' | 'content' | 'isStreamingMsg' | 'revealComplete' | 'msgAnim' | 'dialogueColor'
  | 'dialogueStyle' | 'dialogueAnimation' | 'markup' | 'charColors' | 'hideMetadata' | 'oocHandling' | 'autoFormat'
  | 'autoFormatRules' | 'statRules' | 'paragraphSpacing' | 'dialogueOwnLine' | 'smartTypography'
  | 'styleQuotes' | 'substituteNames' | 'characterName' | 'userName' | 'showImages'
  | 'swipeSelections' | 'onImageClick' | 'onSelectSwipe' | 'markLore' | 'onPinContent'
  | 'expressiveText' | 'ttsReading' | 'emphasis' | 'perform' | 'sceneArt' | 'onRemoveArt'> & {
    totalRevealed: number;
    wordRevealStyle: string | null;
    wordStarts: Map<number, number>;
    playedFx: Map<number, number>;
  }) => {
  // Narrow selectors rather than props: threading these through
  // `MessageBlockProps` would mean another line in each of the two memo
  // comparators, and both are primitives that change roughly never.
  const fontColorMode = useAppStore(s => s.fontColorMode);
  const dark = useAppStore(s => resolveTheme(s.theme, s.bgColor, s.textColor).isDark);

  const { entries: statEntries, prose: statProse } = buildStatPanel(content, statRules);
  const processedText = isStreamingMsg
    // Hide the in-progress last word only while still revealing; show the whole
    // passage once committed so the end-of-message hold never looks cut off.
    ? balanceEmphasis(revealComplete ? statProse : truncateToWord(statProse))
    : processText(statProse, {
        // Hidden SillyTavern messages (/hide, narrator, system notes) are
        // meant to be readable in the reader; stripping their metadata tags
        // can erase them entirely, so preserve their full text.
        hideMetadata: hideMetadata && !msg.hidden,
        fontColorMode,
        oocHandling,
        autoFormat,
        autoFormatRules,
        paragraphSpacing,
        dialogueOwnLine,
        smartTypography,
        styleQuotes,
        substituteNames,
        characterName,
        userName,
        role: msg.role,
      }).processedText;

  // Cadence runs (stagger, drop) are matched across the whole message in
  // document order, so the matcher is built here, once, and lives on the
  // counter that every markdown block shares.
  const runs = performRuns(perform);
  const counter: WordCounter = {
    block: { value: 0 }, reserved: new Map(), fresh: 0, claimed: new Set(), runs: runMatcher(runs),
  };

  /*
   * Where the settled text ends, in the walker's own numbering.
   *
   * The threshold has to be in the SAME units as the indices it is compared
   * against, and it was not. It was counted off the raw streamed text, where
   * `*door*.` is one token; the walker numbers the RENDERED text, where the
   * emphasis ends and `.` begins a new text node, so it is two. Every marked
   * span with punctuation after it pushed the indices one further ahead of the
   * threshold, so the newest words fell past the end of the tail window and
   * arrived with no reveal at all — six words' worth on a passage with
   * emphasis in every sentence.
   *
   * There is no way to count the rendered words up front — that number only
   * exists once the walk has finished. So take it from the walk itself, one
   * render behind: `totalRef` is stamped after each commit with where the
   * cursor actually ended. Being a tick stale is harmless in the one direction
   * it errs — a slightly LOW total means a slightly longer tail, so the newest
   * words are always inside it, which is the whole point. `totalRevealed` only
   * has to say whether anything has been revealed at all.
   */
  const totalRef = useRef({ key: '', n: 0 });
  if (totalRef.current.key !== msg.id) totalRef.current = { key: msg.id, n: 0 };
  useEffect(() => { totalRef.current.n = counter.block.value; });
  const settledCount = totalRevealed > 0
    ? Math.max(0, totalRef.current.n - WORD_REVEAL_CAP)
    : 0;
  // The word at the reveal edge is what the voice is narrating (the reveal is
  // paced to the voice), so highlight it as a karaoke cue while TTS reads.
  const readingWord = ttsReading && isStreamingMsg
    ? Math.max(0, countWords(processedText) - 1)
    : null;
  // Director-supplied whisper/shout words (fall back to the caps heuristic when
  // this passage hasn't been read by the Director).
  const emphasisMap = buildEmphasisMap(emphasis, expressiveText);
  // Director-supplied performance treatments — how the marked words ARRIVE.
  const performMap = performWordKinds(perform);
  // Kept per message for the life of the component, so a word's treatment is
  // frozen once it has played however many times the tree is rebuilt.

  /**
   * Everything that happens to a run of words on its way to the page.
   *
   * Colour first (the author's own notation), then the codex's lore tooltips,
   * then the per-word reveal and the Director's emphasis. Five renderers used
   * to spell this out in full, which meant five places to keep in step every
   * time the walk gained an argument.
   */
  const dress = (children: React.ReactNode, node: unknown): React.ReactNode =>
    wrapWords(
      markLore(paintColors(children, fontColorMode, dark)),
      counter, cursorFor(counter, node), settledCount, wordRevealStyle, wordStarts,
      expressiveText, readingWord, emphasisMap, performMap, playedFx, !!runs,
    );

  return (
    <div
      className={cn(
        'markdown-body max-w-none',
        msgAnim === 'smooth' && isStreamingMsg && 'animate-smooth-reveal',
        msgAnim === 'magic' && isStreamingMsg && 'animate-magic-reveal',
        msgAnim === 'fade' && isStreamingMsg && 'animate-fade-in',
        msgAnim === 'blur' && isStreamingMsg && 'animate-blur-reveal',
        msgAnim === 'ink' && isStreamingMsg && 'animate-ink-reveal',
        msgAnim === 'glitch' && isStreamingMsg && 'animate-glitch-reveal',
        msgAnim === 'rise' && isStreamingMsg && 'animate-rise-reveal',
      )}
    >
      {statEntries.length > 0 && (
        <StatPanel entries={statEntries} />
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node, children, ...props }) => (
            <p {...props}>
              {dress(children, node)}
            </p>
          ),
          li: ({ node, children, ...props }) => (
            <li {...props}>
              {dress(children, node)}
            </li>
          ),
          hr: ({ node: _node }) =>
            expressiveText
              ? <div className="scene-break" aria-hidden="true">✦ ✦ ✦</div>
              : <hr />,
          /* An emphasis span is one of three things: speech, an aside, or plain
           * emphasis. `styleQuotes` delivers the first two here already wrapped
           * in `*…*`; which quote opened them is what tells them apart. */
          em: ({ node, ...props }) => {
            const channel = quoteChannel(textOf(props.children));
            if (!channel) {
              return (
                <em className="italic opacity-90" {...props}>
                  {dress(props.children, node)}
                </em>
              );
            }
            // The speech channel is still the legacy dialogue settings.
            // `charColors` (per-character, and advanced per-channel, when the
            // reader turned that on) overrides whichever channel color would
            // otherwise apply.
            const preset = channel === 'speech'
              ? { color: charColors?.speech || dialogueColor, style: dialogueStyle, animation: dialogueAnimation }
              : { ...markup.aside, color: charColors?.aside || markup.aside.color };
            /* Word-wrapped like every other text-bearing renderer, and for the
             * reason spelled out on the headings below: `settledCount` is
             * computed from `countWords` over the WHOLE passage, but only words
             * that pass through `wrapWords` advance `counter`. A branch that
             * renders its children raw therefore counts towards the settled
             * total without ever claiming an index back, and `counter.value`
             * stops being the word's real position.
             *
             * This branch was that bug's last hiding place, and the worst one
             * to leave it in: `styleQuotes` is on by default, so on an RP log —
             * which is mostly speech — the counter could fall so far behind
             * `settled` that the tail window never opened and the stream effect
             * silently did nothing at all. Quoted speech now animates, and the
             * words after it land where they actually are. */
            return (
              <em
                className={cn(
                  `mk-${channel}`,
                  markupClass(preset, {
                    animate: !isStreamingMsg && preset.animation !== 'none',
                    baseWeight: 'font-medium',
                  }),
                )}
                {...props}
              >
                {dress(props.children, node)}
              </em>
            );
          },
          /* `**beat**` and `****shout****` are the same mdast node at two
           * depths, and only the parent knows which. The outer node of a
           * doubled pair renders nothing of its own and hands the depth down;
           * the inner one dresses itself as the louder channel. */
          strong: ({ node, ...props }) => {
            // The node here is HAST, not MDAST — react-markdown hands components
            // the tree AFTER remark-rehype, so the child to look for is an
            // `element` with a tagName, not a `strong`. Getting this wrong is
            // silent: `****` simply renders as `**` and the channel looks dead.
            const kid = (node as any)?.children?.length === 1
              ? (node as any).children[0] : null;
            const doubled = kid?.type === 'element' && kid.tagName === 'strong';
            if (doubled) {
              const base = counter.reserved.get(node);
              if (base !== undefined) counter.reserved.set(kid, base);
              return <StrongDepth.Provider value={1}>{props.children}</StrongDepth.Provider>;
            }
            return (
              <StrongMark
                markup={markup}
                charColors={charColors}
                expressiveText={expressiveText}
                animate={!isStreamingMsg}
                {...props}
              >
                {wrapWords(props.children, counter, cursorFor(counter, node), settledCount, wordRevealStyle, wordStarts, expressiveText, readingWord, emphasisMap, performMap, playedFx, !!runs)}
              </StrongMark>
            );
          },
          /* Headings the AI wrote into a passage. They were never word-wrapped,
           * which quietly desynced the reveal: `countWords` counts their words
           * towards `settledCount` and nothing was claiming them back. */
          ...headingRenderers(
            markup.heading,
            !isStreamingMsg,
            (children, node) => dress(children, node),
          ),
          // AI-written tables get a hover pin — captured verbatim from the
          // processed source so the dock re-renders exactly what's shown.
          table: ({ node, ...props }) => {
            const pos = (node as any)?.position;
            const src = pos?.start?.offset != null && pos?.end?.offset != null
              ? processedText.slice(pos.start.offset, pos.end.offset)
              : '';
            return (
              <div className="relative group/pin overflow-x-auto">
                {onPinContent && !isStreamingMsg && src && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onPinContent(msg.id, src, 'markdown'); }}
                    title="Pin this table to the side"
                    className="absolute top-1 right-1 z-10 p-1.5 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-lg bg-surface/95 border border-app-border shadow-sm opacity-0 group-hover/pin:opacity-100 transition-opacity"
                  >
                    <PinIcon size={12} />
                  </button>
                )}
                <table {...props} />
              </div>
            );
          },
          // Code blocks: HTML-looking ones pin as live visuals, the rest as code.
          pre: ({ node: _node, children, ...props }) => {
            const text = textOf(children);
            const isHtml = HTML_ISH.test(text);
            return (
              <div className="relative group/pin">
                {onPinContent && !isStreamingMsg && text.trim() && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPinContent(
                        msg.id,
                        isHtml ? text : `\`\`\`\n${text}\n\`\`\``,
                        isHtml ? 'html' : 'markdown',
                      );
                    }}
                    title={isHtml ? 'Pin as a live visual' : 'Pin this block to the side'}
                    className="absolute top-1.5 right-1.5 z-10 p-1.5 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-lg bg-surface/95 border border-app-border shadow-sm opacity-0 group-hover/pin:opacity-100 transition-opacity"
                  >
                    <PinIcon size={12} />
                  </button>
                )}
                <pre {...props}>{children}</pre>
              </div>
            );
          },
          img: ({ node: _node, src, alt }) => {
            if (!showImages || !src) return null;
            return (
              <img
                src={src as string}
                alt={(alt as string) || ''}
                className="reader-img"
                loading="lazy"
                referrerPolicy="no-referrer"
                onClick={(e) => { e.stopPropagation(); onImageClick(src as string); }}
              />
            );
          },
        }}
      >
        {processedText}
      </ReactMarkdown>
      {showImages && msg.images && msg.images.length > 0 && (
        <div className="reader-img-grid">
          {msg.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt=""
              className="reader-img"
              loading="lazy"
              referrerPolicy="no-referrer"
              onClick={(e) => { e.stopPropagation(); onImageClick(src); }}
            />
          ))}
        </div>
      )}
      {showImages && sceneArt && sceneArt.length > 0 && (
        <SceneArtStrip
          art={sceneArt}
          onImageClick={onImageClick}
          onRemove={onRemoveArt && !isStreamingMsg ? (id) => onRemoveArt(msg.id, id) : undefined}
        />
      )}
      {msg.swipes && msg.swipes.length > 1 && (() => {
        const len = msg.swipes.length;
        const idx = swipeSelections[msg.id] ?? Math.max(0, msg.swipes.indexOf(msg.content));
        return (
          <div
            className="flex items-center gap-2 mt-3 text-xs opacity-70"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => onSelectSwipe(msg.id, (idx - 1 + len) % len)}
              className="w-6 h-6 rounded-full hover:bg-app-text/10 flex items-center justify-center"
              title="Previous version"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="font-mono tabular-nums">{idx + 1}/{len}</span>
            <button
              onClick={() => onSelectSwipe(msg.id, (idx + 1) % len)}
              className="w-6 h-6 rounded-full hover:bg-app-text/10 flex items-center justify-center"
              title="Next version"
            >
              <ChevronRight size={14} />
            </button>
            <span className="uppercase tracking-wider text-[10px] opacity-70">what-ifs</span>
          </div>
        );
      })()}
      {isStreamingMsg && (
        msgAnim === 'decrypt' ? (
          <DecryptCaret />
        ) : (
          <span
            className={cn(
              'inline-block w-2 h-4 ml-1 align-middle animate-pulse',
              msgAnim === 'magic'
                ? 'bg-purple-500 shadow-[0_0_8px_2px_rgba(168,85,247,0.8)]'
                : 'bg-current',
            )}
          />
        )
      )}
    </div>
  );
}, (prev, next) => {
  return prev.msg === next.msg
    && prev.content === next.content
    && prev.isStreamingMsg === next.isStreamingMsg
    && prev.msgAnim === next.msgAnim
    && prev.dialogueColor === next.dialogueColor
    && prev.dialogueStyle === next.dialogueStyle
    && prev.dialogueAnimation === next.dialogueAnimation
    && prev.markup === next.markup
    // A fresh bundle is built every render (ReaderDisplay resolves it inline),
    // so compare the four fields rather than object identity.
    && prev.charColors?.speech === next.charColors?.speech
    && prev.charColors?.aside === next.charColors?.aside
    && prev.charColors?.bold === next.charColors?.bold
    && prev.charColors?.shout === next.charColors?.shout
    && prev.hideMetadata === next.hideMetadata
    && prev.oocHandling === next.oocHandling
    && prev.autoFormat === next.autoFormat
    && prev.autoFormatRules === next.autoFormatRules
    && prev.statRules === next.statRules
    && prev.paragraphSpacing === next.paragraphSpacing
    && prev.dialogueOwnLine === next.dialogueOwnLine
    && prev.smartTypography === next.smartTypography
    && prev.styleQuotes === next.styleQuotes
    && prev.substituteNames === next.substituteNames
    && prev.characterName === next.characterName
    && prev.userName === next.userName
    && prev.showImages === next.showImages
    && prev.swipeSelections === next.swipeSelections
    && prev.markLore === next.markLore
    && prev.onPinContent === next.onPinContent
    && prev.expressiveText === next.expressiveText
    && prev.ttsReading === next.ttsReading
    && prev.emphasis === next.emphasis
    && prev.perform === next.perform
    && prev.sceneArt === next.sceneArt
    && prev.onRemoveArt === next.onRemoveArt
    && prev.revealComplete === next.revealComplete
    && prev.totalRevealed === next.totalRevealed
    && prev.wordRevealStyle === next.wordRevealStyle
    && prev.wordStarts === next.wordStarts
    && prev.playedFx === next.playedFx;
});

/**
 * The model's chain of thought, in its own collapsed section.
 *
 * Deliberately NOT prose: no reveal, no TTS, no expressive typography, no
 * markdown channels. It is the working, and it reads as working — which is the
 * whole reason it is worth showing separately rather than leaving inline where
 * it used to arrive dressed as narration.
 *
 * Subscribes to the setting itself rather than taking it as a prop: threading
 * one more field through `MessageBlockProps` would mean two more lines in each
 * memo comparator, and this component renders nothing at all for the passages
 * (almost all of them) that carry no reasoning.
 */
const ReasoningBlock = ({ text }: { text?: string }) => {
  const show = useAppStore(s => s.showReasoning);
  const [open, setOpen] = useState(false);
  if (!show || !text?.trim()) return null;
  return (
    <div
      className="not-prose mb-3 rounded-lg border border-app-border/70 bg-app-text/[0.03] overflow-hidden"
      data-testid="reasoning-block"
      onClick={e => e.stopPropagation()}
    >
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted hover:bg-app-text/5 transition-colors"
      >
        <Caret size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        <Brain size={12} className="shrink-0 opacity-70" />
        <span className="font-medium">Thinking</span>
        <span className="ml-auto tabular-nums opacity-60">
          {text.trim().split(/\s+/).length} words
        </span>
      </button>
      {open && (
        <p className="px-3 pb-2.5 pt-0.5 text-[11.5px] leading-relaxed text-muted whitespace-pre-wrap break-words font-sans opacity-90">
          {text.trim()}
        </p>
      )}
    </div>
  );
};

/** The chip on a passage SillyTavern had marked `is_system` / `/hide`. */
const HiddenMark = ({ hidden }: { hidden?: boolean }) => {
  if (!hidden) return null;
  return (
    <span
      title="Hidden in SillyTavern (/hide or a system entry) — shown because you asked for it"
      data-testid="hidden-mark"
      className="not-prose inline-flex items-center gap-1 align-middle mr-2 px-1.5 py-0.5 rounded text-[10px] font-medium normal-case tracking-normal bg-app-text/10 text-muted"
    >
      <EyeOff size={10} /> hidden
    </span>
  );
};

export const MessageBlock = React.memo((props: MessageBlockProps) => {
  const {
    msg,
    content,
    isStreamingMsg,
    isMsgZoomed,
    avatar,
    rawContent,
    hasOverride,
    noteCount = 0,
    onOpenNotes,
    onPinContent,
    onLensEdit,
    onSceneImage,
    sceneArt,
    onRemoveArt,
    msgAnim,
    streamEffect,
    theme,
    themeDef,
    minimalBubbles,
    isAutofocusMode,
    viewMode,
    phoneDialogueOnly,
    activeRef,
    revealEdge,
    onMessageClick,
    onShowDialogueTip,
    onHideDialogueTip,
  } = props;

  const isUser = msg.role === 'user';
  const [showOriginal, setShowOriginal] = useState(false);
  const displayContent = showOriginal && rawContent != null ? rawContent : content;

  // Streaming word-reveal: only the last WORD_REVEAL_CAP words animate.
  // The effect is its own setting — the block reveal (msgAnim) stays untouched.
  const totalWords = isStreamingMsg ? countWords(displayContent) : 0;
  const totalRevealed = totalWords;
  const wordRevealStyle = isStreamingMsg && streamEffect !== 'none' ? streamEffect : null;

  // When each word's reveal STARTED, stamped on first arrival and kept for the
  // whole stream — so neither a re-render nor a remount can restart a word's
  // reveal or reschedule it. See the note on `wrapWords`.
  const wordStartsRef = useRef<{ key: string; map: Map<number, number> }>({ key: '', map: new Map() });
  const delayKey = isStreamingMsg ? msg.id : '';
  if (wordStartsRef.current.key !== delayKey) {
    wordStartsRef.current = { key: delayKey, map: new Map() };
  }
  const wordStarts = wordStartsRef.current.map;

  // Same lifetime as the starts, and for the same reason: a fact about a word's
  // FIRST appearance, which a re-render must not be able to undo.
  const playedFxRef = useRef<{ key: string; set: Map<number, number> }>({ key: '', set: new Map() });
  if (playedFxRef.current.key !== delayKey) {
    playedFxRef.current = { key: delayKey, set: new Map() };
  }
  const playedFx = playedFxRef.current.set;

  // Phone "dialogue only" — show just the spoken lines as received-text
  // bubbles; each quote becomes its own bubble, narration is hidden.
  // Hidden SillyTavern messages (/hide, narrator, system notes) are still
  // part of the story, so they render as a single bubble even without quotes.
  if (theme === 'phone' && phoneDialogueOnly && viewMode !== 'storybook') {
    const { characterName, userName } = props;
    const cast = [characterName, userName, msg.name].filter(Boolean) as string[];
    let segments = extractDialogueSegments(displayContent, cast, props.dialogue,
      { characterName, userName });
    if (!segments.length && !msg.hidden) return null;
    if (!segments.length && msg.hidden) segments = [{ quote: displayContent, context: '' }];
    const ownerName = (msg.name ?? '').trim().toLowerCase();
    return (
      <div
        key={msg.id}
        data-msg-id={msg.id}
        ref={isStreamingMsg ? activeRef : undefined}
        data-reveal-edge={revealEdge ? '' : undefined}
        onClick={() => onMessageClick(msg.id)}
        data-streaming={isStreamingMsg}
        data-zoomed={isMsgZoomed}
        className={cn(
          'flex w-full mb-4 cursor-pointer group transition-all duration-500 gap-3 message-block',
          isUser ? 'justify-end flex-row-reverse' : 'justify-start',
          isAutofocusMode && !isStreamingMsg && 'opacity-25 blur-[1px]',
        )}
      >
        {!minimalBubbles && <Avatar name={msg.name} src={avatar} />}
        <div className="flex flex-col gap-1.5 max-w-[78%]">
          {segments.map((seg, i) => {
            const hasContext = seg.context && seg.context !== seg.quote;
            // A line the author voices for someone else (an NPC, or the reader
            // being quoted): tag it and float it the other way so it never
            // reads as this character's own speech.
            const other = !!seg.speaker && seg.speaker.trim().toLowerCase() !== ownerName;
            const asUser = other && !!userName && seg.speaker!.trim().toLowerCase() === userName.trim().toLowerCase();
            const alignRight = isUser ? !other : asUser;
            return (
              <div key={i} className={cn('flex flex-col gap-0.5', alignRight ? 'self-end items-end' : 'self-start items-start')}>
                {other && !asUser && (
                  <span className="text-[0.7em] font-semibold uppercase tracking-wide opacity-55 px-1">{seg.speaker}</span>
                )}
                <div
                  onMouseEnter={hasContext ? (e) => onShowDialogueTip(e, seg.context) : undefined}
                  onMouseLeave={onHideDialogueTip}
                  className={cn(
                    'px-4 py-2 rounded-2xl shadow-sm text-[0.95em] leading-snug',
                    hasContext && 'cursor-help',
                    alignRight
                      ? 'bg-bubble-user text-bubble-user-text rounded-br-md'
                      : other
                        ? 'bg-bubble-ai border border-app-accent/50 rounded-bl-md'
                        : 'bg-bubble-ai border border-app-border/60 rounded-bl-md',
                  )}
                >
                  {seg.quote}
                </div>
              </div>
            );
          })}
          {isStreamingMsg && (
            <span className="inline-block w-2 h-3 bg-current animate-pulse rounded-full opacity-60" />
          )}
        </div>
      </div>
    );
  }

  if (viewMode === 'storybook') {
    return (
      <div
        key={msg.id}
        data-msg-id={msg.id}
        data-role={msg.role}
        data-streaming={isStreamingMsg}
        data-zoomed={isMsgZoomed}
        ref={isStreamingMsg ? activeRef : undefined}
        data-reveal-edge={revealEdge ? '' : undefined}
        onClick={() => onMessageClick(msg.id)}
        title={isStreamingMsg ? 'Click to play/pause' : 'Click to replay from here'}
        className={cn(
          'mb-8 cursor-pointer hover:bg-app-text/5 transition-all duration-500 p-4 rounded-xl message-block group',
          isStreamingMsg ? 'opacity-100' : 'opacity-90',
          isUser && 'italic opacity-80 border-l-2 border-app-border pl-4 ml-2',
          isMsgZoomed && 'scale-105 transform origin-left shadow-lg bg-app-text/5 my-12',
          isAutofocusMode && !isStreamingMsg && 'opacity-25 blur-[1px]',
        )}
      >
        {onPinContent && !isStreamingMsg && (
          <button
            onClick={(e) => { e.stopPropagation(); onPinContent(msg.id, displayContent, 'markdown'); }}
            title="Pin this whole message to the side dock"
            className="float-right ml-2 mt-1 p-1 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-full text-app-text/50 hover:text-accent hover:bg-accent/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <PinIcon size={12} />
          </button>
        )}
        {noteCount > 0 && !isStreamingMsg && onOpenNotes && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenNotes(msg.id); }}
            title={`${noteCount} note${noteCount === 1 ? '' : 's'} on this passage`}
            className="float-right ml-3 mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] text-app-text/50 hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <MessageSquare size={11} />
            {noteCount}
          </button>
        )}
        <ReasoningBlock text={msg.reasoning} />
        {msg.hidden && <HiddenMark hidden />}
        <MessageContent {...props} content={displayContent} totalRevealed={totalRevealed} wordRevealStyle={wordRevealStyle} wordStarts={wordStarts} playedFx={playedFx} />
      </div>
    );
  }

  // Chat mode
  return (
    <div
      key={msg.id}
      data-msg-id={msg.id}
      data-role={msg.role}
      data-streaming={isStreamingMsg}
      data-zoomed={isMsgZoomed}
      ref={isStreamingMsg ? activeRef : undefined}
      data-reveal-edge={revealEdge ? '' : undefined}
      onClick={() => onMessageClick(msg.id)}
      title={isStreamingMsg ? 'Click to play/pause' : 'Click to replay from here'}
      className={cn(
        'flex w-full mb-6 cursor-pointer group transition-all duration-500 gap-3 message-block',
        isUser ? 'justify-end flex-row-reverse' : 'justify-start',
        isMsgZoomed && cn('scale-105 transform my-8', isUser ? 'origin-right' : 'origin-left'),
        isAutofocusMode && !isStreamingMsg && 'opacity-25 blur-[1px]',
      )}
    >
      {!minimalBubbles && <Avatar name={msg.name} src={avatar} />}
      <div
        className={cn(
          'reader-bubble max-w-[80%] px-5 py-4 relative transition-all',
          minimalBubbles
            ? 'rounded-none border-b border-app-border shadow-none max-w-full w-full'
            : cn(
                'rounded-2xl shadow-md group-hover:ring-2 ring-accent/40',
                isUser
                  ? 'bg-bubble-user text-bubble-user-text rounded-br-sm'
                  : 'bg-bubble-ai rounded-bl-sm border border-app-border/60',
              ),
          isMsgZoomed && 'ring-2 ring-yellow-500/50 shadow-xl',
        )}
      >
        <div className="reader-bubble-name text-xs font-bold mb-2 opacity-70 uppercase tracking-wider flex items-center gap-2">
          {msg.name}
          <HiddenMark hidden={msg.hidden} />
          {(noteCount > 0 || hasOverride || onPinContent || onLensEdit || onSceneImage) && !isStreamingMsg && (
            <span className="ml-auto flex items-center gap-0.5">
              {onSceneImage && (
                <button
                  onClick={(e) => { e.stopPropagation(); onSceneImage(msg.id); }}
                  title="Picture this scene"
                  data-testid="scene-image-button"
                  className="p-1 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-full text-app-text/50 hover:text-accent hover:bg-accent/10 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <ImageIcon size={12} />
                </button>
              )}
              {onLensEdit && (
                <button
                  onClick={(e) => { e.stopPropagation(); onLensEdit(msg.id); }}
                  title="Lens edit — have the AI rewrite this message"
                  className="p-1 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-full text-app-text/50 hover:text-accent hover:bg-accent/10 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Wand2 size={12} />
                </button>
              )}
              {onPinContent && (
                <button
                  onClick={(e) => { e.stopPropagation(); onPinContent(msg.id, displayContent, 'markdown'); }}
                  title="Pin this whole message to the side dock"
                  className="p-1 touch:min-h-10 touch:min-w-10 touch:inline-flex touch:items-center touch:justify-center rounded-full text-app-text/50 hover:text-accent hover:bg-accent/10 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <PinIcon size={12} />
                </button>
              )}
              {noteCount > 0 && onOpenNotes && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenNotes(msg.id); }}
                  title={`${noteCount} note${noteCount === 1 ? '' : 's'} on this passage`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full normal-case tracking-normal font-medium text-[10px] text-app-text/50 hover:text-accent hover:bg-accent/10 transition-colors"
                >
                  <MessageSquare size={11} />
                  {noteCount}
                </button>
              )}
              {hasOverride && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowOriginal(o => !o); }}
                  title={showOriginal ? 'Show edited version' : 'View original'}
                  className={cn(
                    'p-1 rounded-full transition-colors',
                    showOriginal ? 'text-amber-500 bg-amber-500/10' : 'text-app-text/40 hover:text-app-text/70 hover:bg-app-text/10',
                  )}
                >
                  <Pencil size={12} />
                </button>
              )}
            </span>
          )}
        </div>
        <ReasoningBlock text={msg.reasoning} />
        <MessageContent {...props} content={displayContent} totalRevealed={totalRevealed} wordRevealStyle={wordRevealStyle} wordStarts={wordStarts} playedFx={playedFx} />
      </div>
    </div>
  );
}, (prev, next) => {
  return prev.msg.id === next.msg.id
    && prev.content === next.content
    && prev.rawContent === next.rawContent
    && prev.hasOverride === next.hasOverride
    && prev.noteCount === next.noteCount
    && prev.onOpenNotes === next.onOpenNotes
    && prev.onPinContent === next.onPinContent
    && prev.onLensEdit === next.onLensEdit
    && prev.onSceneImage === next.onSceneImage
    && prev.sceneArt === next.sceneArt
    && prev.onRemoveArt === next.onRemoveArt
    && prev.streamEffect === next.streamEffect
    && prev.isStreamingMsg === next.isStreamingMsg
    && prev.isMsgZoomed === next.isMsgZoomed
    && prev.avatar === next.avatar
    && prev.msgAnim === next.msgAnim
    && prev.theme === next.theme
    && prev.themeDef === next.themeDef
    && prev.minimalBubbles === next.minimalBubbles
    && prev.isAutofocusMode === next.isAutofocusMode
    && prev.viewMode === next.viewMode
    && prev.phoneDialogueOnly === next.phoneDialogueOnly
    && prev.activeRef === next.activeRef
    && prev.revealEdge === next.revealEdge
    && prev.onMessageClick === next.onMessageClick
    && prev.onImageClick === next.onImageClick
    && prev.onShowDialogueTip === next.onShowDialogueTip
    && prev.onHideDialogueTip === next.onHideDialogueTip
    && prev.markLore === next.markLore
    && prev.onSelectSwipe === next.onSelectSwipe
    && prev.swipeSelections === next.swipeSelections
    && prev.dialogueColor === next.dialogueColor
    && prev.dialogueStyle === next.dialogueStyle
    && prev.dialogueAnimation === next.dialogueAnimation
    && prev.markup === next.markup
    // A fresh bundle is built every render (ReaderDisplay resolves it inline),
    // so compare the four fields rather than object identity.
    && prev.charColors?.speech === next.charColors?.speech
    && prev.charColors?.aside === next.charColors?.aside
    && prev.charColors?.bold === next.charColors?.bold
    && prev.charColors?.shout === next.charColors?.shout
    && prev.hideMetadata === next.hideMetadata
    && prev.oocHandling === next.oocHandling
    && prev.autoFormat === next.autoFormat
    && prev.autoFormatRules === next.autoFormatRules
    && prev.statRules === next.statRules
    && prev.paragraphSpacing === next.paragraphSpacing
    && prev.dialogueOwnLine === next.dialogueOwnLine
    && prev.smartTypography === next.smartTypography
    && prev.styleQuotes === next.styleQuotes
    && prev.substituteNames === next.substituteNames
    && prev.characterName === next.characterName
    && prev.userName === next.userName
    && prev.showImages === next.showImages
    && prev.ttsReading === next.ttsReading
    /*
     * The last word of every message depended on this line.
     *
     * While a passage reveals, `truncateToWord` hides the word still being
     * typed, and `revealComplete` is what finally says "show the whole thing".
     * But by the time it flips, `streamedText` is ALREADY the full text — that
     * is the reveal loop's own exit condition — so `finishCurrentMessage`
     * changes nothing except this flag. Without it here the comparator saw
     * fifty-odd identical props and skipped the render, the inner content never
     * heard that the reveal had finished, and the message sat through its whole
     * pause still hiding its final word before advancing. The word was never
     * drawn at all, on any message: "…guttered out on its" and then the next
     * passage.
     *
     * `MessageContent` has always compared it. This is the memo ABOVE it, and a
     * prop that never reaches a component cannot be compared by it.
     */
    && prev.revealComplete === next.revealComplete
    && prev.emphasis === next.emphasis
    && prev.perform === next.perform;
});
