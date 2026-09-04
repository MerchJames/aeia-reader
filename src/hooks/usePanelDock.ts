/**
 * The pointer half of `panelDock.ts`.
 *
 * All the geometry lives in the pure module and is tested there; this is the
 * part that cannot be — pointer capture, the window resizing under a saved
 * position, and writing the result back to the store without doing it sixty
 * times a second.
 *
 * Three things it is careful about:
 *
 * **Pointer capture, not a document listener.** A drag that loses the pointer
 * when it crosses an iframe, a scrollbar or the window edge leaves the panel
 * stuck to the cursor with no button held. `setPointerCapture` keeps every move
 * and the release on the element that started it.
 *
 * **The live rectangle is state, the stored one is not.** Dragging updates
 * local state every frame; the store is written once, on release. Sixty
 * localStorage writes per second is how a smooth drag becomes a stuttering one.
 *
 * **The window is watched.** A position saved on a bigger screen is re-clamped
 * on resize, so the panel cannot be stranded off-screen by anything other than
 * a drag — see the module's own doc for why that is the failure that matters.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampDock, defaultDock, dragDock, resizeDock, sanitizeDock,
  type DockRect, type ResizeEdge, type Viewport,
} from '../utils/panelDock';

const viewport = (): Viewport => ({
  width: typeof window === 'undefined' ? 1280 : window.innerWidth,
  height: typeof window === 'undefined' ? 800 : window.innerHeight,
});

interface Gesture {
  kind: 'drag' | 'resize';
  edge: ResizeEdge;
  startX: number;
  startY: number;
  from: DockRect;
}

export interface PanelDock {
  rect: DockRect;
  /** True while the reader is dragging or resizing — suppresses transitions. */
  active: boolean;
  /** Put on the header. */
  onDragStart: (e: React.PointerEvent) => void;
  /** Put on each grip. */
  onResizeStart: (edge: ResizeEdge) => (e: React.PointerEvent) => void;
  /** Jump to a preset or an explicit rectangle. */
  setRect: (next: DockRect) => void;
  /** Back to the corner, forgetting the stored position. */
  reset: () => void;
}

/**
 * @param stored  the persisted rectangle, or null/undefined for the default
 * @param onCommit called once when a gesture ends, with the final rectangle
 */
export const usePanelDock = (
  stored: unknown,
  onCommit: (rect: DockRect | null) => void,
  /**
   * When true, the panel does not move or resize.
   *
   * Enforced at the START of a gesture rather than by leaving the handles off
   * the page: the header is also the title bar and the resize grips sit on the
   * edges, so a locked panel keeps every one of them exactly where it was and
   * simply refuses to be dragged by them. Nothing shifts when the lock goes on,
   * which is the point — the reader locked it because it was where they wanted
   * it.
   */
  locked = false,
): PanelDock => {
  const [rect, setLive] = useState<DockRect>(
    () => sanitizeDock(stored, viewport()) ?? defaultDock(viewport()),
  );
  const [active, setActive] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef(rect);
  latest.current = rect;

  // A stored value arriving late (the store hydrates after first paint) or
  // changing from elsewhere. Ignored mid-gesture, or the panel would jump out
  // from under the pointer.
  useEffect(() => {
    if (gesture.current) return;
    const next = sanitizeDock(stored, viewport());
    if (next) setLive(next);
  }, [stored]);

  // The window changing under a saved position — a rotation, a second monitor
  // unplugged, a window halved. Re-clamped rather than left stranded.
  useEffect(() => {
    const onResize = () => {
      if (gesture.current) return;
      setLive(r => clampDock(r, viewport()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const begin = (kind: Gesture['kind'], edge: ResizeEdge) => (e: React.PointerEvent) => {
    if (locked) return;
    // Left button / primary touch only: a right-click on the header is a
    // context menu, not the start of a drag.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    gesture.current = { kind, edge, startX: e.clientX, startY: e.clientY, from: latest.current };
    setActive(true);
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    setLive(g.kind === 'drag'
      ? dragDock(g.from, dx, dy, viewport())
      : resizeDock(g.from, g.edge, dx, dy, viewport()));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!gesture.current) return;
    gesture.current = null;
    setActive(false);
    // Written once, at the end. Committing every frame is what turns a smooth
    // drag into a stuttering one.
    onCommit(latest.current);
  }, [onCommit]);

  useEffect(() => {
    if (!active) return;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // A cancelled gesture (the OS taking over, a tab switch mid-drag) must
    // settle too, or `active` stays true and the panel never accepts a click.
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [active, onPointerMove, onPointerUp]);

  /*
   * The lock stops the READER moving the panel. It does not stop the WINDOW
   * moving under it: the resize clamp above still runs, because a panel locked
   * on a wide monitor and reopened on a laptop would otherwise be locked
   * off-screen, which is precisely the trap `panelDock` exists to prevent.
   */
  const setRect = useCallback((next: DockRect) => {
    const clamped = clampDock(next, viewport());
    setLive(clamped);
    onCommit(clamped);
  }, [onCommit]);

  const reset = useCallback(() => {
    setLive(defaultDock(viewport()));
    onCommit(null);
  }, [onCommit]);

  return {
    rect,
    active,
    onDragStart: begin('drag', 'se'),
    onResizeStart: (edge: ResizeEdge) => begin('resize', edge),
    setRect,
    reset,
  };
};
