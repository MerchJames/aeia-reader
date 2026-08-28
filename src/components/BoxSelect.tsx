import React, { useCallback, useRef, useState } from 'react';
import {
  BoxRect, Capture, WordRect, boxAnchor, capture, capturedBy, isRealBox, normalizeBox,
} from '../utils/boxSelect';

/**
 * The frame tool's surface: an overlay you drag a rectangle on.
 *
 * Everything that decides anything is in `utils/boxSelect`. What is here is the
 * part that cannot be: measuring where the words actually are.
 *
 * ── Why it measures words and not characters ──────────────────────────────
 *
 * `Range.getClientRects()` on a whole text node returns one rect per LINE, not
 * per word, so a box over the middle of a line would capture the entire line.
 * Measuring per character is exact and far too slow — a long passage is tens of
 * thousands of ranges, laid out synchronously, on every mouse-up.
 *
 * A word is the right grain. It is also the grain the reader is working in:
 * nobody draws a box meaning "half of 'whether'".
 *
 * ── Why it walks text nodes and not elements ──────────────────────────────
 *
 * The prose is full of inline elements — every emphasis span, every wrapped
 * word from the reveal, every highlight — and an element walk would either
 * double-count their text or miss the text between them. Text nodes are the
 * one layer where every character appears exactly once.
 */

/** A word inside a text node, as an offset pair. */
const wordSpans = (data: string): [number, number][] => {
  const out: [number, number][] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data))) out.push([m.index, m.index + m[0].length]);
  return out;
};

/** The passage a node sits in, by walking up to the nearest `data-msg-id`. */
const messageIdOf = (node: Node, root: Element): string | undefined => {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement && n.dataset.msgId) return n.dataset.msgId;
    n = n.parentNode;
  }
  return undefined;
};

/**
 * Every word the box caught, in document order.
 *
 * The cheap guard first: a text node whose own bounding rect misses the box
 * entirely cannot contain a caught word, and on a long page that skips almost
 * everything before a single word is measured.
 */
const wordsInBox = (root: HTMLElement, box: BoxRect): WordRect[] => {
  const found: WordRect[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (!text.data.trim()) continue;
    // Skip anything the reader cannot see — collapsed chrome, aria-only text.
    const parent = text.parentElement;
    if (!parent || parent.closest('[aria-hidden="true"]')) continue;

    range.selectNodeContents(text);
    const bounds = range.getBoundingClientRect();
    if (!bounds.height) continue;
    if (bounds.bottom < box.top || bounds.top > box.top + box.height) continue;
    if (bounds.right < box.left || bounds.left > box.left + box.width) continue;

    const msgId = messageIdOf(text, root);
    for (const [start, end] of wordSpans(text.data)) {
      range.setStart(text, start);
      range.setEnd(text, end);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const rect: BoxRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      if (capturedBy(rect, box)) {
        found.push({ text: text.data.slice(start, end), rect, messageId: msgId });
      }
    }
  }
  return found;
};

interface BoxSelectProps {
  /** The scrolling element the words live in. */
  rootRef: React.RefObject<HTMLElement | null>;
  /** Called with the caught words and where to hang the card. */
  onCapture: (result: Capture, anchor: { x: number; y: number; bottom: number }) => void;
  /** Called when the reader draws nothing, or presses Escape. */
  onCancel: (reason: 'empty' | 'tiny' | 'escape') => void;
}

export const BoxSelect = ({ rootRef, onCapture, onCancel }: BoxSelectProps) => {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<BoxRect | null>(null);

  const finish = useCallback((b: BoxRect) => {
    startRef.current = null;
    setBox(null);
    if (!isRealBox(b)) { onCancel('tiny'); return; }
    const root = rootRef.current;
    const words = root ? wordsInBox(root, b) : [];
    if (!words.length) { onCancel('empty'); return; }
    onCapture(capture(words), boxAnchor(b));
  }, [onCapture, onCancel, rootRef]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Left button / primary touch only: a right-click is a context menu.
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    setBox({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) return;
    setBox(normalizeBox(s.x, s.y, e.clientX, e.clientY));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) return;
    finish(normalizeBox(s.x, s.y, e.clientX, e.clientY));
  };

  return (
    <div
      className="fixed inset-0 z-[65] cursor-crosshair select-none touch-none"
      data-testid="box-select-surface"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { startRef.current = null; setBox(null); onCancel('escape'); }}
    >
      {/* The instruction sits at the top, out of the way of the prose the
        * reader is aiming at — and disappears the moment they start drawing. */}
      {!box && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-surface/95 border border-app-border shadow-lg text-xs pointer-events-none">
          Drag a frame over the words &middot; <span className="opacity-60">Esc to cancel</span>
        </div>
      )}
      {box && (
        <div
          className="absolute border-2 border-accent rounded-md bg-accent/10 pointer-events-none"
          data-testid="box-select-frame"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
};
