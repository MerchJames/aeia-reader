/**
 * The Director's performance treatment, applied to an HTML string.
 *
 * Aura renders text two different ways and always has: `MessageBlock` builds
 * React children through ReactMarkdown, while Book, Stage, VN and Sandbox build
 * HTML strings. `wrapWords` handles the first. This handles the second, so all
 * five views mark the same words, one word at a time, by the same rules —
 * before this, Stage and VN wrapped whole spans and Book and Sandbox marked
 * nothing at all, which made "Cinema — motion, weather and emphasis" a promise
 * only two of the five views kept.
 *
 * Two rules carry over from the React path and both are load-bearing:
 *
 *  - `isMarkableWord` — a cue names a SPAN, but matching is per word, so
 *    without a stoplist one cue painted every "the" and "her" on the page.
 *  - the `claimed` set — one mark stays one mark. A cue on "she pulls away"
 *    must not re-fire on every later "away".
 *
 * This is a scanner over the string rather than a DOM walk, for three reasons:
 * it is pure (so the repo's no-framework unit runner can test it), it never
 * round-trips the markup through `innerHTML` (Book measures the exact HTML it
 * is given, and a parse/serialise cycle quietly renormalises it), and all four
 * call sites are string pipelines already. The one thing a scanner must get
 * right is never touching anything inside a tag or an entity — hence the two
 * skip rules below.
 */

import { PerformKind, RunMatcher, isMarkableWord } from './scenePerform';
import { isShoutWord, normalizeWord } from './expressive';
import { HIGHLIGHT_COLORS, type SceneEmphasis } from '../types';

/** Elements whose text is not prose and must never be marked. */
const SKIP_TAGS = new Set(['code', 'pre', 'script', 'style', 'textarea']);

/** Whitespace or an HTML entity — separators, never candidates for marking. */
const TOKENS = /(\s+|&[#a-zA-Z0-9]+;)/;

export interface MarkOptions {
  /**
   * Words already spent. Share one set across every paragraph of a message so
   * a cue fires once per message rather than once per block.
   */
  claimed?: Set<string>;
  /**
   * Class for a marked word. Defaults to the performance track's `perf-*`.
   *
   * Exists because the EMPHASIS track (shout / whisper / sfx) needs exactly the
   * same scanner and the same two rules, and had none: it reached Storybook and
   * Chat through `wrapWords` and stopped dead at Book, Stage, VN and the export.
   * The perform track was unified across the five views and the emphasis track
   * was not, which is a difference nobody could have guessed from the settings.
   */
  className?: (kind: string) => string;
  /**
   * Also dress ALL-CAPS words as shouts, the way `wrapWords` does when the
   * reader has expressive text on.
   *
   * This is a HEURISTIC, not a Director cue, and it deliberately does not
   * consume `claimed` — "RUN!" shouted three times is shouted three times,
   * whereas a cue on a span fires once. Book had the cue path and not this one,
   * so a shouted line grew in Storybook and sat flat one view over.
   */
  shoutCaps?: boolean;
  /**
   * Normalised words whose treatment has already played, kept across renders.
   *
   * The HTML views rebuild their markup on every reveal tick, so a marked word
   * in the already-revealed part of a passage re-animated every time — measured
   * at 268 restarts on one word in six seconds on the Stage. A cue is supposed
   * to fire on the REVEAL of the word it marks; strobing for as long as the
   * passage keeps growing reads as a rendering fault, not as direction.
   *
   * Marked words are still MARKED on every pass (they must be, or the look
   * would vanish) — they just stop moving. See `.fx-played`.
   */
  played?: Set<string>;
  /**
   * The cadence matcher for this message, if any — see `runMatcher`.
   *
   * Kept by the caller rather than built here because a message is marked one
   * paragraph at a time, and a run has to be matched across the whole passage
   * in document order, exactly like `claimed`. Built once per message, fed
   * every word this scanner walks past.
   */
  match?: RunMatcher;
}

/**
 * ' fx-played' the second time a word is seen, '' the first. Records as it
 * goes, so the caller only has to keep the set alive across renders.
 */
const settled = (played: Set<string> | undefined, key: string): string => {
  if (!played) return '';
  if (played.has(key)) return ' fx-played';
  played.add(key);
  return '';
};

export const markPerformHtml = (
  html: string,
  kinds: Map<string, string> | null | undefined,
  opts: MarkOptions = {},
): string => {
  if ((!kinds?.size && !opts.shoutCaps && !opts.match) || !html) return html;
  const claimed = opts.claimed ?? new Set<string>();
  const classFor = opts.className ?? ((k: string) => `perf-${k}`);

  let out = '';
  let i = 0;
  let skipDepth = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);

    // --- a run of text
    const text = html.slice(i, lt === -1 ? html.length : lt);
    if (text) {
      if (skipDepth > 0) {
        out += text;
      } else {
        for (const part of text.split(TOKENS)) {
          if (!part) continue;
          // Separators pass through untouched: marking inside `&quot;` would
          // corrupt the entity, and marking whitespace is meaningless.
          if (TOKENS.test(part) && (/^\s+$/.test(part) || part.startsWith('&'))) {
            out += part;
            continue;
          }
          const norm = normalizeWord(part);
          // Fed EVERY word, in order, before anything else can `continue` past
          // it — a matcher that misses a word loses the sequence.
          const run = opts.match?.(norm);
          const kind = !claimed.has(norm) && isMarkableWord(norm) ? kinds?.get(norm) : undefined;
          if (!kind) {
            if (run) {
              out += `<span class="${classFor(run.kind)}${settled(opts.played, run.key)}">${part}</span>`;
            } else if (opts.shoutCaps && isShoutWord(part)) {
              // The caps heuristic, if asked for. No `claimed` bookkeeping: a
              // word shouted three times is shouted three times.
              out += `<span class="expr-shout${settled(opts.played, `caps:${norm}`)}">${part}</span>`;
            } else {
              out += part;
            }
            continue;
          }
          claimed.add(norm);
          out += `<span class="${classFor(kind)}${settled(opts.played, norm)}">${part}</span>`;
        }
      }
    }
    if (lt === -1) break;

    // --- a tag, copied verbatim
    const gt = html.indexOf('>', lt);
    if (gt === -1) { out += html.slice(lt); break; }
    const tag = html.slice(lt, gt + 1);
    out += tag;
    i = gt + 1;

    const name = /^<\s*(\/?)\s*([a-zA-Z0-9-]+)/.exec(tag);
    if (name && SKIP_TAGS.has(name[2].toLowerCase())) {
      if (name[1]) skipDepth = Math.max(0, skipDepth - 1);
      else if (!tag.endsWith('/>')) skipDepth++;
    }
  }

  return out;
};

/**
 * The `.perf-*` rules, as a string.
 *
 * The reader's copy lives in `src/index.css`, but the Sandbox renders inside a
 * sandboxed iframe with its own document and none of the app's stylesheet — a
 * marked word there would otherwise be a bare span. Exported from one place so
 * the two cannot drift into disagreeing about what "tremble" looks like.
 *
 * Deliberately small: the shared shape, the ten animations, and the
 * reduced-motion opt-out. Intensity variables come from the host page.
 */
export const PERFORM_CSS = `
.perf-slow,.perf-rush,.perf-stagger,.perf-hold,.perf-cut,
.perf-swell,.perf-tremble,.perf-drop,.perf-fade,.perf-unwrite{
display:inline-block;transform-origin:50% 60%;will-change:transform,opacity}
.perf-slow{animation:pSlow 1.6s cubic-bezier(.2,.7,.2,1) both}
.perf-rush{animation:pRush .34s ease-out both}
.perf-stagger{animation:pStamp .3s cubic-bezier(.2,.8,.3,1) both,
pRunTell .95s ease-out backwards}
.perf-hold{animation:pHold .9s ease-out both}
.perf-cut{animation:pCut .22s ease-in both}
.perf-swell{animation:pSwell 1.5s cubic-bezier(.2,.7,.2,1) both}
.perf-tremble{animation:pTremble .16s linear 9 both}
.perf-drop{font-weight:700;animation:pDrop .42s cubic-bezier(.2,.8,.3,1) both,
pRunTell .95s ease-out backwards}
.perf-fade{opacity:.55;font-style:italic;animation:pFade 1.4s ease-out both}
.perf-unwrite{animation:pUnwrite 2.6s ease-in both}
@keyframes pSlow{from{letter-spacing:.08em;opacity:.55}to{letter-spacing:normal;opacity:1}}
@keyframes pRush{from{transform:translateX(-.18em);opacity:.4}to{transform:none;opacity:1}}
@keyframes pStamp{from{transform:scale(1.14);opacity:.3}to{transform:none;opacity:1}}
@keyframes pHold{from{opacity:.3}60%{opacity:1}to{opacity:1}}
@keyframes pCut{from{opacity:1}to{opacity:.75;transform:translateX(.05em)}}
@keyframes pSwell{0%{transform:scale(1);opacity:.7}45%{transform:scale(1.12)}to{transform:scale(1);opacity:1}}
@keyframes pTremble{0%,to{transform:translate(0,0)}25%{transform:translate(.02em,-.02em)}75%{transform:translate(-.02em,.02em)}}
@keyframes pDrop{from{transform:translateY(-.22em);opacity:0}to{transform:none;opacity:1}}
@keyframes pFade{from{opacity:1}to{opacity:.55}}
@keyframes pUnwrite{from{opacity:1;filter:blur(0)}to{opacity:.28;filter:blur(.6px)}}
/* The cadence tell — see index.css. Decays over about three staggered words, so
   the run reads as a wave rather than as three unrelated stutters. */
@keyframes pRunTell{from{color:color-mix(in srgb,var(--accent) 72%,currentColor)}
to{color:currentColor}}
/* A cue fires once — see .fx-played in index.css. */
.fx-played{animation:none!important}
@media (prefers-reduced-motion:reduce){
.perf-slow,.perf-rush,.perf-stagger,.perf-hold,.perf-cut,
.perf-swell,.perf-tremble,.perf-drop,.perf-fade,.perf-unwrite{animation:none!important}
/* Without the tell a staggered run is pacing and nothing else — which is what
   lag looks like. Motion off, so the tell goes static. */
.perf-stagger,.perf-drop{text-decoration:underline;text-decoration-thickness:1px;
text-underline-offset:.2em;
text-decoration-color:color-mix(in srgb,var(--accent) 34%,transparent)}}
`;

/* ------------------------------------------------------------------ */
/* The emphasis track, for the HTML views                              */
/* ------------------------------------------------------------------ */

/** How the reader's stylesheet names each emphasis kind. */
const EMPHASIS_CLASS: Record<string, string> = {
  shout: 'expr-shout',
  whisper: 'expr-whisper',
  sfx: 'sfx-mark',
};

/** Colours a `color` span may name — the highlighter's palette, reused. */
export const EMPHASIS_COLORS: readonly string[] = HIGHLIGHT_COLORS.map(c => c.key);

/**
 * A span's kind reduced to ONE string that decides its look — `shout`,
 * `underline`, `color-rose`.
 *
 * Three places used to work this out for themselves: `buildEmphasisMap` in
 * MessageBlock, `EMPHASIS_CLASS` here, and StageView's `stage-emk-${kind}`.
 * They had already drifted once — the emphasis track reached Storybook and Chat
 * and stopped dead at Book, Stage, VN and the export — and adding three kinds
 * to three independent switches is how that happens again. One key, resolved
 * once, and every path styles from it.
 */
export const emphasisKindKey = (e: SceneEmphasis): string =>
  e.kind === 'color'
    ? `color-${e.color && EMPHASIS_COLORS.includes(e.color) ? e.color : 'accent'}`
    : e.kind;

/** The class a kind key wears in the word-marked views and the export. */
export const emphasisClass = (key: string): string =>
  EMPHASIS_CLASS[key] ?? `expr-${key}`;

/**
 * Kinds that produce a visible mark. `beat` is a pause the streamer holds, with
 * nothing to draw.
 */
export const MARKABLE_EMPHASIS: ReadonlySet<string> = new Set([
  'shout', 'whisper', 'sfx', 'color', 'underline', 'strike',
]);

/**
 * The Director's spans plus the reader's own — the emphasis list every view
 * should be marking from.
 *
 * Four views assembled this for themselves and no two agreed: Storybook and
 * Chat merged SFX marks, Stage and VN merged SFX marks separately, and Book
 * merged nothing, so a span the reader had marked by hand was dressed in three
 * views and plain in the fourth. One function, called everywhere.
 *
 * Returns the SAME array when there is nothing to add, so memoized renderers do
 * not see a new object on every pass.
 */
export const readerEmphasis = (
  director: SceneEmphasis[] | undefined,
  sfx: { text: string }[] | undefined,
  marks: SceneEmphasis[] | undefined,
): SceneEmphasis[] | undefined => {
  if (!sfx?.length && !marks?.length) return director;
  // The reader's own marks go FIRST, because both consumers of this list —
  // `emphasisWordKinds` here and Stage's span fencing — take the first claim on
  // a word and ignore later ones. The Director's read is a suggestion; a mark
  // the reader made by hand is a decision, so it has to be the one that lands.
  return [...(marks ?? []), ...(sfx ?? []).map(m => ({ text: m.text, kind: 'sfx' as const })),
    ...(director ?? [])];
};

/**
 * Word → emphasis kind key, mirroring `buildEmphasisMap` in `MessageBlock`.
 *
 * `beat` is excluded (it is a pause, not a treatment), and shout/whisper are
 * gated on the reader's expressive-text setting exactly as they are in the
 * React path — otherwise Book would dress words that Storybook leaves plain.
 */
export const emphasisWordKinds = (
  spans: SceneEmphasis[] | undefined,
  expressiveText: boolean,
): Map<string, string> | null => {
  if (!spans?.length) return null;
  const map = new Map<string, string>();
  for (const s of spans) {
    if (!MARKABLE_EMPHASIS.has(s.kind)) continue;   // 'beat' is a pause, not a look
    if ((s.kind === 'whisper' || s.kind === 'shout') && !expressiveText) continue;
    const key = emphasisKindKey(s);
    for (const w of (s.text ?? '').split(/\s+/)) {
      const n = normalizeWord(w);
      // Same span-matched-by-word hazard as the performance track: a cue on a
      // phrase must not mark every "the" and "her" in the passage.
      if (isMarkableWord(n) && !map.has(n)) map.set(n, key);
    }
  }
  return map.size ? map : null;
};

/**
 * Both tracks, in one call, sharing one `claimed` set.
 *
 * Emphasis goes first because the Director's read outranks the performance
 * track's heuristic on the same word, and sharing `claimed` keeps a word from
 * being wrapped twice — one mark stays one mark, across both tracks.
 */
export const markSceneHtml = (
  html: string,
  emphasis: Map<string, string> | null | undefined,
  perform: Map<string, PerformKind> | null | undefined,
  claimed: Set<string>,
  shoutCaps = false,
  /** Kept across renders by the caller so a cue fires once — see MarkOptions. */
  played?: Set<string>,
  /** This message's cadence matcher, kept across its paragraphs — see MarkOptions. */
  match?: RunMatcher,
): string => {
  let out = markPerformHtml(html, emphasis, {
    claimed,
    shoutCaps,
    played,
    className: emphasisClass,
  });
  // The cadence matcher belongs to the performance pass alone: feeding it twice
  // would advance every run by two words per word of prose.
  out = markPerformHtml(out, perform, { claimed, played, match });
  return out;
};

/**
 * The emphasis classes, as a string — the companion to `PERFORM_CSS`.
 *
 * Same reason: the exported HTML file and the Sandbox iframe have their own
 * documents and none of `src/index.css`. Values match the reader's at the
 * "expressive" intensity, since a static file has no intensity picker.
 */
export const EMPHASIS_CSS = `
.expr-shout{display:inline-block;font-weight:800;font-size:1.15em;letter-spacing:.01em;
line-height:1;color:color-mix(in srgb,var(--accent) 40%,currentColor)}
.expr-whisper{opacity:.62;font-style:italic;font-size:.94em;letter-spacing:-.01em}
.sfx-mark{border-bottom:1px dashed color-mix(in srgb,var(--accent) 45%,transparent)}
.expr-underline{text-decoration:underline;text-decoration-thickness:1.5px;
text-underline-offset:.18em;text-decoration-color:color-mix(in srgb,var(--accent) 65%,transparent)}
.expr-strike{text-decoration:line-through;text-decoration-thickness:1.5px;
text-decoration-color:color-mix(in srgb,var(--accent) 70%,transparent);opacity:.72}
.expr-color-accent{color:color-mix(in srgb,var(--accent) 78%,currentColor)}
.expr-color-yellow{color:color-mix(in srgb,#eab308 72%,currentColor)}
.expr-color-green{color:color-mix(in srgb,#22c55e 72%,currentColor)}
.expr-color-blue{color:color-mix(in srgb,#3b82f6 72%,currentColor)}
.expr-color-pink{color:color-mix(in srgb,#ec4899 72%,currentColor)}
.expr-color-orange{color:color-mix(in srgb,#f97316 72%,currentColor)}
`;
