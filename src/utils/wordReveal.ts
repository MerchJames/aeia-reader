/**
 * Per-word reveal, for views that render their own text.
 *
 * `MessageBlock` has had this since the first build, but it is woven into a
 * React children walk — it has to survive markdown, emphasis spans, Director
 * cues and reader marks arriving as a tree. The Script, Panels and Atlas views
 * render plain strings into their own layouts, so they need the same BEHAVIOUR
 * off a much simpler input, and copying the tree-walker into three more files
 * would be three more places for the reveal to drift out of step.
 *
 * The contract is deliberately identical to MessageBlock's: only the last
 * `REVEAL_CAP` words animate, each staggered by `REVEAL_STAGGER`, and
 * everything before that is settled plain text. A steady stream therefore has a
 * short moving tail rather than a whole passage pulsing at once — and a passage
 * that arrives in one burst staggers instead of flashing.
 *
 * Pure: no DOM, no store, no React.
 */

/** Words animating at the tail. Beyond this, a reveal reads as a strobe. */
export const REVEAL_CAP = 24;
/** Milliseconds between one tail word and the next. */
export const REVEAL_STAGGER = 30;

export interface RevealWord {
  text: string;
  /**
   * Whitespace that followed this word, kept verbatim so lines still break.
   *
   * It MUST be rendered outside the animated span. `.word-reveal` is
   * `display: inline-block` — which is what lets a word be scaled and moved
   * without disturbing the line — and an inline-block drops the whitespace at
   * its own edges. Put the gap inside and every animating word in the tail runs
   * into the next one, which reads as the text having lost its spaces.
   */
  after: string;
  /** True when this word is in the animating tail. */
  fresh: boolean;
  /** Animation delay in ms; 0 for settled words. */
  delay: number;
}

/**
 * Split text into words, marking the tail.
 *
 * Whitespace is carried on the word before it rather than dropped, because
 * these words are re-emitted as spans and rebuilding the gaps from `' '` would
 * silently collapse every line break the writer put in a passage.
 */
export const revealWords = (
  text: string,
  opts: { cap?: number; stagger?: number } = {},
): RevealWord[] => {
  const cap = opts.cap ?? REVEAL_CAP;
  const stagger = opts.stagger ?? REVEAL_STAGGER;
  const out: RevealWord[] = [];
  const re = /(\S+)(\s*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[1], after: m[2], fresh: false, delay: 0 });

  const settled = Math.max(0, out.length - cap);
  for (let i = settled; i < out.length; i++) {
    out[i].fresh = true;
    out[i].delay = (i - settled) * stagger;
  }
  return out;
};

/**
 * The class for one word.
 *
 * Returns '' when the word has settled or no effect is on, so a settled word
 * carries no animation class at all — a span that keeps its class keeps its
 * animation, and every re-render would replay it.
 */
export const revealClass = (word: RevealWord, style: string | null): string =>
  word.fresh && style && style !== 'none' ? `word-reveal word-reveal-${style}` : '';
