/**
 * Where the assistant panel sits, when the reader has moved it.
 *
 * The panel used to be nailed to the bottom-right corner. That is the right
 * default and the wrong only option: on a wide screen it wastes two thirds of
 * the width, and while cowriting it wants to be tall and beside the text rather
 * than square and on top of it.
 *
 * ── The rule this module exists to enforce ─────────────────────────────────
 *
 * **A panel can always be grabbed again.** Every failure mode of a draggable
 * window is the same failure: it ends up somewhere the pointer cannot reach,
 * and since its position is persisted, it is still there tomorrow. A reader
 * whose assistant is 40px off the top of a laptop screen has lost it for good
 * and has no idea why.
 *
 * So `clampDock` is not a nicety applied on drag — it runs on the way IN, every
 * time the geometry is read, against the CURRENT window. That covers the cases
 * dragging alone does not: rotating a tablet, unplugging a second monitor,
 * halving a window, or opening the app on a smaller machine than the one the
 * position was saved on.
 *
 * Pure: no store, no React, no DOM. The viewport is passed in.
 */

export interface DockRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Small enough to be out of the way, big enough to still be a chat. */
export const MIN_W = 300;
export const MIN_H = 260;

/**
 * How much of the panel must stay on screen horizontally, and how much of its
 * top edge vertically.
 *
 * Vertically this is `HANDLE_H` rather than a fraction: the drag handle is the
 * header, so keeping the header reachable is exactly the same as keeping the
 * panel reachable. Letting the top go under the viewport is the one move that
 * cannot be undone by dragging.
 */
export const KEEP_VISIBLE = 120;
export const HANDLE_H = 36;

/** The corner the panel lives in until somebody moves it. */
export const CORNER_MARGIN = 16;

/**
 * The default geometry — what "docked" resolves to.
 *
 * Matches the panel's original fixed size so that undocking and re-docking is
 * visually a no-op, and the reader who never touches this never sees a change.
 */
export const defaultDock = (vp: Viewport): DockRect => {
  const w = Math.min(420, Math.max(MIN_W, vp.width - CORNER_MARGIN * 2));
  const h = Math.min(620, Math.round(vp.height * 0.8));
  return {
    w,
    h,
    x: Math.max(CORNER_MARGIN, vp.width - w - CORNER_MARGIN),
    y: Math.max(CORNER_MARGIN, vp.height - h - CORNER_MARGIN),
  };
};

/**
 * Force a rectangle to be reachable in this viewport.
 *
 * Size is clamped before position, because a panel wider than the window has no
 * valid x until it has been made to fit. Note what is NOT done: the panel is
 * allowed to hang off the right and bottom edges, since both of those can be
 * dragged back. Only the top is hard-stopped.
 */
export const clampDock = (rect: DockRect, vp: Viewport): DockRect => {
  const w = Math.round(Math.max(MIN_W, Math.min(rect.w, vp.width - CORNER_MARGIN)));
  const h = Math.round(Math.max(MIN_H, Math.min(rect.h, vp.height - CORNER_MARGIN)));
  // At least KEEP_VISIBLE pixels of the panel stay inside either edge, so a
  // panel dragged almost entirely off the left or right is still grabbable.
  const x = Math.round(Math.min(
    Math.max(rect.x, KEEP_VISIBLE - w),
    vp.width - KEEP_VISIBLE,
  ));
  // The header must be on screen: above zero it is unreachable, and below the
  // bottom edge there is nothing left to grab.
  const y = Math.round(Math.min(Math.max(rect.y, 0), vp.height - HANDLE_H));
  return { x, y, w, h };
};

/** Move by a pointer delta, then clamp. */
export const dragDock = (rect: DockRect, dx: number, dy: number, vp: Viewport): DockRect =>
  clampDock({ ...rect, x: rect.x + dx, y: rect.y + dy }, vp);

/** Which edge or corner a resize grip pulls. */
export type ResizeEdge = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

/**
 * Resize by a pointer delta from a given grip.
 *
 * A north or west grip moves the origin as well as the size — and it has to do
 * so from the ORIGINAL rectangle rather than the clamped one, or dragging a
 * left edge past the minimum width starts walking the whole panel across the
 * screen instead of stopping.
 */
export const resizeDock = (
  rect: DockRect, edge: ResizeEdge, dx: number, dy: number, vp: Viewport,
): DockRect => {
  let { x, y, w, h } = rect;
  if (edge.includes('e')) w = rect.w + dx;
  if (edge.includes('s')) h = rect.h + dy;
  if (edge.includes('w')) {
    w = Math.max(MIN_W, rect.w - dx);
    x = rect.x + (rect.w - w);
  }
  if (edge.includes('n')) {
    h = Math.max(MIN_H, rect.h - dy);
    y = rect.y + (rect.h - h);
  }
  return clampDock({ x, y, w, h }, vp);
};

/** Turn a rectangle into the inline style the panel renders with. */
export const dockStyle = (rect: DockRect): { left: number; top: number; width: number; height: number } =>
  ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });

/**
 * Read a stored rectangle back, rejecting anything that is not one.
 *
 * Persisted geometry outlives the code that wrote it. A half-written or
 * hand-edited value must fall back to the corner rather than render a panel at
 * `NaN`, which is invisible AND un-grabbable — the exact thing this module is
 * for.
 */
export const sanitizeDock = (value: unknown, vp: Viewport): DockRect | null => {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<DockRect>;
  const nums = [r.x, r.y, r.w, r.h];
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  return clampDock(r as DockRect, vp);
};

/**
 * One of a few useful shapes, for readers who would rather pick than drag.
 *
 * `tall` is the cowriting one: full-height beside the text, so the conversation
 * and the passage are visible at the same time.
 */
export type DockPreset = 'corner' | 'tall' | 'wide' | 'centre';

export const PRESET_LABEL: Record<DockPreset, string> = {
  corner: 'Corner',
  tall: 'Side column',
  wide: 'Bottom strip',
  centre: 'Centred',
};

export const presetDock = (preset: DockPreset, vp: Viewport): DockRect => {
  const m = CORNER_MARGIN;
  switch (preset) {
    case 'tall': {
      const w = Math.min(460, Math.max(MIN_W, Math.round(vp.width * 0.34)));
      return clampDock({ x: vp.width - w - m, y: m, w, h: vp.height - m * 2 }, vp);
    }
    case 'wide': {
      const h = Math.min(380, Math.max(MIN_H, Math.round(vp.height * 0.42)));
      return clampDock({ x: m, y: vp.height - h - m, w: vp.width - m * 2, h }, vp);
    }
    case 'centre': {
      const w = Math.min(720, Math.max(MIN_W, Math.round(vp.width * 0.6)));
      const h = Math.min(720, Math.max(MIN_H, Math.round(vp.height * 0.75)));
      return clampDock({ x: Math.round((vp.width - w) / 2), y: Math.round((vp.height - h) / 2), w, h }, vp);
    }
    case 'corner':
    default:
      return defaultDock(vp);
  }
};
