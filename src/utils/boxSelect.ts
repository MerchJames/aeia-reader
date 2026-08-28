/**
 * The frame tool — drawing a box round the words you want.
 *
 * ── Why a box, when a text selection already exists ────────────────────────
 *
 * Dragging a text selection is a *linear* gesture: it runs from one character
 * to another through the document order, and to take four lines out of the
 * middle of a paragraph you have to start exactly on a character and end
 * exactly on another. On a page that is still streaming, with a spotlight over
 * it, on a touch screen, that is a fiddle. A frame is a *spatial* gesture —
 * you point at a shape on the page and the words inside it are what you meant.
 *
 * It produces the same thing a text selection produces (some words, and the
 * passage they came from), which is the whole design: the frame is another way
 * to make a selection, so everything the reader can already do with one —
 * highlight, pin, note, ask, perform, rewrite — comes free and behaves
 * identically. Nothing here is a new kind of artifact.
 *
 * ── What lives here ────────────────────────────────────────────────────────
 *
 * The decisions, and nothing else: what counts as a drag rather than a click,
 * which words a rectangle has caught, which passage a frame belongs to, and how
 * the caught words go back together as readable text. The DOM walk that
 * measures the words is in the component, because it cannot run without a
 * layout engine — but it makes no decisions, so everything that can be wrong
 * can be tested here.
 *
 * Pure: no DOM, no store, no React.
 */

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Below this, in px, a drag was a click.
 *
 * A frame tool that fires on a stray click is worse than no frame tool: the
 * reader taps to dismiss something and gets a popover full of actions instead.
 * Both dimensions must clear it — a 400×3px smear across a line is a slip of
 * the hand, not a frame.
 */
export const MIN_DRAG = 14;

/**
 * How much of a word must be inside the box to count.
 *
 * Half. Anything stricter drops the first and last word of every frame (they
 * are the ones the edge cuts through, and they are the ones the reader was
 * aiming at); anything looser drags in the word past the edge, and a frame that
 * quietly captures more than it covers is not one you can trust.
 */
export const CAPTURE_RATIO = 0.5;

/** A drag between two points, as a rectangle — in any direction. */
export const normalizeBox = (ax: number, ay: number, bx: number, by: number): BoxRect => ({
  left: Math.min(ax, bx),
  top: Math.min(ay, by),
  width: Math.abs(ax - bx),
  height: Math.abs(ay - by),
});

export const isRealBox = (b: BoxRect): boolean =>
  b.width >= MIN_DRAG && b.height >= MIN_DRAG;

/** Fraction of `word` that lies inside `box` — 0 when they do not touch. */
export const overlapRatio = (word: BoxRect, box: BoxRect): number => {
  const area = word.width * word.height;
  if (area <= 0) return 0;
  const w = Math.min(word.left + word.width, box.left + box.width) - Math.max(word.left, box.left);
  const h = Math.min(word.top + word.height, box.top + box.height) - Math.max(word.top, box.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / area;
};

export const capturedBy = (word: BoxRect, box: BoxRect): boolean =>
  overlapRatio(word, box) >= CAPTURE_RATIO;

/** One measured word, in document order. */
export interface WordRect {
  text: string;
  rect: BoxRect;
  messageId?: string;
}

export interface Capture {
  /** The caught words, put back together. */
  text: string;
  /** The passage the frame belongs to — see `dominantMessage`. */
  messageId?: string;
  /** How many words were caught, for the reader-facing summary. */
  words: number;
  /** How many distinct passages the frame crossed. */
  messages: number;
}

/**
 * Which passage a frame belongs to when it spans more than one.
 *
 * The one it caught the most words from, not the first one it touched. A frame
 * dropped over a paragraph will usually clip the last line of the passage above
 * it, and anchoring the reader's note to THAT passage — because it came first
 * in the document — puts the note somewhere they were not looking.
 *
 * Ties go to the earlier passage, which is the only stable answer.
 */
export const dominantMessage = (words: WordRect[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const w of words) {
    if (!w.messageId) continue;
    counts.set(w.messageId, (counts.get(w.messageId) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
  return best;
};

/**
 * The caught words as readable text.
 *
 * Line breaks inside a paragraph are just where the column happened to end, so
 * they become spaces. A real vertical JUMP — a new paragraph, or a new passage
 * — becomes a blank line, because running two paragraphs together produces a
 * sentence nobody wrote, and this text goes on to be pinned, quoted back to a
 * model, and read aloud.
 */
export const joinCaptured = (words: WordRect[]): string => {
  const parts: string[] = [];
  let prev: WordRect | null = null;
  for (const w of words) {
    if (prev) {
      const newPassage = prev.messageId !== w.messageId;
      // A gap wider than one line of leading is a paragraph, not a wrap.
      const gap = w.rect.top - (prev.rect.top + prev.rect.height);
      const paragraph = gap > prev.rect.height * 0.6;
      parts.push(newPassage || paragraph ? '\n\n' : ' ');
    }
    parts.push(w.text);
    prev = w;
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
};

/** Everything the frame caught, decided in one place. */
export const capture = (words: WordRect[]): Capture => ({
  text: joinCaptured(words),
  messageId: dominantMessage(words),
  words: words.length,
  messages: new Set(words.map(w => w.messageId).filter(Boolean)).size,
});

/**
 * Where the action card hangs off a frame.
 *
 * Off the BOTTOM edge, unlike a text selection's card, which hangs above the
 * words. A frame is drawn top-down by almost everybody, so the reader's hand
 * and cursor finish at the bottom edge — and a card that appears above the box
 * appears behind where they were just looking.
 */
export const boxAnchor = (b: BoxRect): { x: number; y: number; bottom: number } => ({
  x: b.left + b.width / 2,
  y: b.top,
  bottom: b.top + b.height,
});

/** A one-line description of a frame, for the toast and the card's header. */
export const describeCapture = (c: Capture): string => {
  if (!c.words) return 'Nothing in the frame';
  const w = `${c.words} word${c.words === 1 ? '' : 's'}`;
  return c.messages > 1 ? `${w} across ${c.messages} passages` : w;
};
