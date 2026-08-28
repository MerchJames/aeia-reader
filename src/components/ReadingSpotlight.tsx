import React, { useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { FocusVars, focusMoved, focusVars } from '../utils/readingFocus';
import { cn } from '../utils/cn';

/**
 * The reading magnifier, for every view.
 *
 * ── Why this moved out of ReaderDisplay ────────────────────────────────────
 *
 * `utils/readingFocus` says the whole reason the spotlight is a viewport-fixed
 * scrim rather than a mask on the text is that it "behaves identically
 * everywhere because it is positional rather than structural" — and then it was
 * mounted inside ReaderDisplay, so nine of the thirteen views never got it. The
 * architecture was already right; only the mounting point was wrong.
 *
 * So it lives at the app root now, and finds the words the same way in every
 * view: whichever element carries `data-reveal-edge`. A view that wants the
 * magnifier marks the element holding its newest words and gets it; a view that
 * marks nothing simply has no spotlight, with no special case anywhere.
 */

/**
 * The rect of the newest revealed character — where the reader's eye is.
 *
 * The DOM of a streaming passage holds exactly the text revealed so far, so its
 * last glyph IS the reveal edge. Measure it; never count words to find it (a
 * derived index drifted behind by however many words the markdown renderer
 * handled differently), and never take the bounding box of the whole element
 * (that finds trailing chrome — swipe controls, the caret — instead of prose).
 *
 * The obvious version of this, a Range collapsed to the end of the element,
 * silently returns NO rects: the end boundary of a block sits after its last
 * child, not inside any text. That measured zero for every reader.
 */
export const revealEdgeRect = (row: HTMLElement): DOMRect | undefined => {
  const prose = (row.querySelector('.markdown-body') as HTMLElement | null) ?? row;
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? '').trim()) last = n as Text;
  }
  if (!last?.data.length) return undefined;
  const end = last.data.replace(/\s+$/, '').length || last.data.length;
  const range = document.createRange();
  range.setStart(last, Math.max(0, end - 1));
  range.setEnd(last, end);
  const rects = range.getClientRects();
  const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return r.height > 0 ? r : undefined;
};

export const ReadingSpotlight = () => {
  const on = useAppStore(s => s.isAutofocusMode && s.focusMagnifier && s.screen === 'reader');
  const style = useAppStore(s => s.magnifierStyle);
  const spotRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<FocusVars | null>(null);
  /**
   * Whether any view has told us where its words are yet.
   *
   * Without this the scrim paints anyway, with its hole at the stylesheet's
   * fallback of 50vw/50vh — so a view that marks no reveal edge gets its whole
   * surface dimmed and a light floating in the middle of nothing. That is
   * exactly what happened to Stage the moment this moved to the app root:
   * portraits, box and bubble all washed out, lit from the centre of the screen.
   *
   * A magnifier with nothing to magnify shows nothing.
   */
  const [found, setFound] = useState(false);

  /* No dependency array on purpose: the edge moves as words arrive, and the
   * cheap guard is `focusMoved` — which refuses most of these frames — rather
   * than a dependency list that would have to name every piece of state any
   * view might reveal text from. */
  useLayoutEffect(() => {
    const spot = spotRef.current;
    if (!on || !spot) return;
    // The view's own mark for "the newest words are here". The last one in the
    // document wins, so a view that marks a fallback element first and the live
    // one second gets the live one.
    const marks = document.querySelectorAll<HTMLElement>('[data-reveal-edge]');
    const row = marks[marks.length - 1];
    if (!row) { if (found) setFound(false); return; }
    const edge = revealEdgeRect(row);
    if (!edge) return;
    const next = focusVars(edge);
    if (!found) setFound(true);
    if (!next || !focusMoved(focusRef.current, next)) return;
    focusRef.current = next;
    for (const [k, v] of Object.entries(next)) spot.style.setProperty(k, v);
  });

  if (!on) return null;
  return (
    <div
      ref={spotRef}
      // Hidden, not unmounted: the effect above needs the element in order to
      // measure and to write the custom properties that decide it is time to
      // show. Unmounting it would mean it could never find its own words.
      className={cn('reading-spotlight', `rs-${style}`, !found && 'rs-idle')}
      data-testid="reading-spotlight"
      data-magnifier={style}
      aria-hidden="true"
    />
  );
};
