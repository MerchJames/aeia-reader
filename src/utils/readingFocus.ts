/**
 * The reading magnifier — a spotlight that follows the reveal edge.
 *
 * ── Why this is an overlay and not a mask ──────────────────────────────────
 *
 * The first three attempts masked the text element itself (`mask-image` on the
 * message row, then on `.markdown-body`). That was the wrong architecture, and
 * it failed differently every time: it faded the chat bubble's own chrome, it
 * fought the autofocus font-size zoom, it did nothing at all in Book and VN
 * (which use their own renderers, not MessageBlock), and its geometry was
 * expressed as percentages of the masked element's box — so every layout quirk
 * moved the band off the words.
 *
 * The established technique is a viewport-fixed SCRIM with a hole in it: one
 * `position: fixed` layer, `pointer-events: none`, whose radial gradient is
 * positioned from CSS custom properties updated as the reveal moves. Nothing
 * about the text is touched, so it cannot interfere with zoom, bubbles, or any
 * view's renderer, and it behaves identically everywhere because it is
 * positional rather than structural. Updating custom properties rather than
 * rewriting the gradient is also the cheap path — the browser keeps the layer
 * and only moves the light.
 *
 * Teleprompters do exactly this: a fixed reading mark at where you are, with
 * what you have already read gently falling away behind it.
 *
 * Everything here is in VIEWPORT pixels, because `getBoundingClientRect()`
 * already returns viewport coordinates and the scrim is fixed to the viewport.
 * No percentages and no dependence on any element's box — precisely the class
 * of bug that made this drift.
 */

/** The parts of a DOMRect this needs — plain data, so it is testable. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How wide the lit core is, in line heights. */
const CORE_X = 8;
/** How tall, in line heights — a little over one line, so the line reads whole. */
const CORE_Y = 2.1;
/** Bounds, so a strange line box can neither black out nor reveal the screen. */
const MIN_RX = 120;
const MAX_RX = 1100;
const MIN_RY = 34;
const MAX_RY = 260;

export interface FocusVars {
  /** Centre of the light, in viewport px. */
  '--focus-x': string;
  '--focus-y': string;
  /** Radii of the lit ellipse, in px. */
  '--focus-rx': string;
  '--focus-ry': string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Where the light goes, from the rect of the newest revealed character.
 *
 * Returns null only when the rect is unusable — a zero-height box means the
 * text has not laid out yet, and lighting nothing would flash the page dark.
 */
export const focusVars = (edge: Box): FocusVars | null => {
  if (edge.height <= 0) return null;

  // A horizontal ellipse: reading runs along a line, so the light follows the
  // line rather than drawing a circle that clips the words either side of it.
  const rx = clamp(edge.height * CORE_X, MIN_RX, MAX_RX);
  const ry = clamp(edge.height * CORE_Y, MIN_RY, MAX_RY);

  return {
    '--focus-x': `${Math.round(edge.left + edge.width / 2)}px`,
    '--focus-y': `${Math.round(edge.top + edge.height / 2)}px`,
    '--focus-rx': `${Math.round(rx)}px`,
    '--focus-ry': `${Math.round(ry)}px`,
  };
};

/**
 * Has the light moved enough to be worth repainting?
 *
 * The reveal fires per character, and most characters move the edge a couple of
 * pixels along the same line — nobody can see that. A LINE BREAK moves it a
 * whole line height and must be followed at once, so the vertical threshold is
 * much tighter than the horizontal one.
 */
export const focusMoved = (prev: FocusVars | null, next: FocusVars): boolean => {
  if (!prev) return true;
  if (prev['--focus-ry'] !== next['--focus-ry']) return true; // font size changed
  const dx = Math.abs(parseFloat(prev['--focus-x']) - parseFloat(next['--focus-x']));
  const dy = Math.abs(parseFloat(prev['--focus-y']) - parseFloat(next['--focus-y']));
  return dx > 8 || dy > 3;
};
