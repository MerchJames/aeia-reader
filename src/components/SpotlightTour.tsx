/**
 * The guided tour, running over the live app.
 *
 * ── Why a hole and not a highlight ─────────────────────────────────────────
 *
 * The thing being pointed at has to stay itself. A copy of the control drawn in
 * a modal is a picture of the app, and the reader learns where the picture is.
 * So the real screen stays where it is, everything else is dimmed, and the
 * control shows through a hole cut in the dimming — which means it is still the
 * actual button, in its actual place, and still clickable.
 *
 * Four rectangles rather than an SVG mask: the four make the hole out of solid
 * elements, so `pointer-events` works exactly as it reads — the dimmed parts
 * swallow clicks, the hole does not exist to swallow them.
 *
 * ── Degrading ──────────────────────────────────────────────────────────────
 *
 * A tour names anchors in markup this file does not own, and one day one of
 * them will be renamed. When the target cannot be found the card centres itself
 * and says nothing about a missing element — a tour that points confidently at
 * the wrong corner of the screen is worse than one that simply explains the
 * feature in words. `scripts/checkTourAnchors.mjs` is what stops it silently
 * happening; this is what it looks like when it does.
 *
 * The measuring is redone on scroll, on resize, and once a frame for a short
 * while after each stop — panels animate open, and a rectangle measured before
 * the animation finished is a hole in the wrong place.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, X } from 'lucide-react';
import { anchorSelector, stopLabel, type TourStop } from '../utils/tours';
import { cn } from '../utils/cn';

interface SpotlightTourProps {
  stops: readonly TourStop[];
  at: number;
  onStep: (to: number) => void;
  onClose: () => void;
  /** Ends the tour by finishing it rather than abandoning it. */
  onFinish: () => void;
  /** Open the manual entry behind a stop. */
  onDoc?: (docId: string) => void;
  /** Called before each stop, to switch views and open panels. */
  onPrepare?: (stop: TourStop) => void;
  /** This tour opened the sample story, and leaving it will close it again. */
  inSample?: boolean;
}

interface Box { top: number; left: number; width: number; height: number }

/** Breathing room around the spotlit element. */
const PAD = 6;
/** How long to keep re-measuring after a stop, for panels that animate open. */
const SETTLE_MS = 700;

export const SpotlightTour = ({
  stops, at, onStep, onClose, onFinish, onDoc, onPrepare, inSample,
}: SpotlightTourProps) => {
  const [box, setBox] = useState<Box | null>(null);
  /** The card's own height, measured. See the placement note below. */
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stop = stops[at];

  const measure = useCallback(() => {
    if (!stop?.target) { setBox(null); return; }
    const el = document.querySelector(anchorSelector(stop.target));
    if (!el) { setBox(null); return; }
    const r = el.getBoundingClientRect();
    // A target scrolled out of view, or rendered but collapsed, has a rectangle
    // and no presence. Treating it as missing is right: the reader would be
    // looking at a hole over nothing.
    if (r.width < 2 || r.height < 2) { setBox(null); return; }
    setBox({
      top: Math.max(0, r.top - PAD),
      left: Math.max(0, r.left - PAD),
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
    });
  }, [stop]);

  // Prepare (switch view, open panel) before measuring, and scroll the target
  // into view — a tour that dims the screen around something off-screen has
  // pointed at nothing.
  useEffect(() => {
    if (!stop) return;
    onPrepare?.(stop);
    if (!stop.target) return;
    const el = document.querySelector(anchorSelector(stop.target));
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // `onPrepare` is deliberately out of the dependency list: it is rebuilt on
    // every render of the parent, and depending on it would re-run the whole
    // preparation — including a view switch — on every keystroke elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  useLayoutEffect(() => {
    measure();
    let raf = 0;
    const until = Date.now() + SETTLE_MS;
    const tick = () => {
      measure();
      if (Date.now() < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onStep(at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(at - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, onClose, onStep]);

  useEffect(() => { cardRef.current?.focus(); }, [at]);

  /*
   * Measure the card itself, every time its content changes.
   *
   * A ResizeObserver rather than a one-off read: the body, the example list and
   * the "needs AI" chip all change the height between stops, and a card
   * measured once at the first stop is placed by a stale number at the fourth.
   */
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const read = () => setCardHeight(el.getBoundingClientRect().height);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [at, stop]);

  if (!stop) return null;

  const last = at === stops.length - 1;
  const dim = 'fixed bg-black/60 z-[9998]';

  /*
   * Where the card goes.
   *
   * Under the hole when it fits, above it when it does not, and centred when
   * there is no hole — but every one of those is decided against the card's
   * MEASURED height, not a guess at it.
   *
   * The guess was 220px and it was wrong: a stop with an example list is well
   * over that, so a tall card at the second stop of a tour was placed below its
   * target, ran past the bottom of the window, and took the Next button with
   * it. The tour could not be advanced and there was nothing on screen to say
   * why. A card is also never taller than the viewport now — it scrolls inside
   * itself instead, so the footer is always the last thing on it.
   */
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const GAP = 12;
  /** Until the card has been measured once, assume it is tall. Placing a card
   *  too cautiously is invisible; placing it off-screen is what happened. */
  const height = cardHeight ?? 320;
  const maxHeight = Math.max(160, vh - GAP * 2);

  let cardStyle: React.CSSProperties;
  if (box) {
    const under = box.top + box.height + GAP;
    const over = box.top - GAP - height;
    // Below if the whole card fits below; else above if the whole card fits
    // above; else pinned to whichever edge leaves more room, and scrolling.
    const top = under + height <= vh - GAP
      ? under
      : over >= GAP
        ? over
        : Math.max(GAP, Math.min(vh - GAP - height, box.top > vh / 2 ? GAP : under));
    cardStyle = {
      position: 'fixed',
      top: Math.max(GAP, Math.min(top, Math.max(GAP, vh - GAP - Math.min(height, maxHeight)))),
      left: Math.min(Math.max(GAP, box.left), Math.max(GAP, vw - 360 - GAP)),
      width: Math.min(360, vw - GAP * 2),
      maxHeight,
    };
  } else {
    cardStyle = {
      position: 'fixed',
      top: Math.max(GAP, (vh - Math.min(height, maxHeight)) / 2),
      left: Math.max(GAP, (vw - Math.min(380, vw - GAP * 2)) / 2),
      width: Math.min(380, vw - GAP * 2),
      maxHeight,
    };
  }

  return (
    <>
      {box ? (
        <>
          <div className={dim} style={{ top: 0, left: 0, right: 0, height: box.top }} onClick={onClose} />
          <div
            className={dim}
            style={{ top: box.top + box.height, left: 0, right: 0, bottom: 0 }}
            onClick={onClose}
          />
          <div className={dim} style={{ top: box.top, left: 0, width: box.left, height: box.height }} onClick={onClose} />
          <div
            className={dim}
            style={{ top: box.top, left: box.left + box.width, right: 0, height: box.height }}
            onClick={onClose}
          />
          {/* The ring. `pointer-events-none` so the control underneath is still
              the control — the reader can use the thing being explained. */}
          <div
            className="fixed z-[9999] rounded-lg ring-2 ring-accent pointer-events-none transition-all duration-200"
            style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
          />
        </>
      ) : (
        <div className={cn(dim, 'inset-0')} onClick={onClose} />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-label={stop.title}
        data-testid="spotlight-card"
        style={cardStyle}
        className="z-[10000] flex flex-col rounded-xl border border-app-border bg-app-bg shadow-2xl outline-none overflow-hidden"
      >
        <div className="flex items-start gap-2 px-3.5 pt-3.5">
          <h3 className="text-sm font-semibold flex-1">{stop.title}</h3>
          {stop.ai && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent shrink-0">
              needs AI
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Leave the tour"
            className="p-0.5 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 shrink-0"
          >
            <X size={13} />
          </button>
        </div>

        {/* The only part allowed to scroll. Whatever a stop says, the row of
            buttons below stays on screen — losing Next is losing the tour. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3.5">
          <p className="text-[12px] leading-relaxed text-muted mt-1.5">{stop.body}</p>

          {stop.example && (
            <ul className="mt-2 space-y-0.5 rounded-lg bg-app-text/[0.04] px-2.5 py-2">
              {stop.example.map(line => (
                <li key={line} className="text-[11px] text-muted">{line}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 px-3.5 pt-2 pb-3.5 shrink-0 border-t border-app-border/40">
          {stop.doc && onDoc && (
            <button
              onClick={() => onDoc(stop.doc!)}
              className="flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <BookOpen size={11} /> More
            </button>
          )}
          {inSample && (
            // Said plainly, because it is a thing that will happen to the
            // screen. A sample that vanished without warning would read as the
            // app having lost the story they were just looking at.
            <span className="text-[10px] text-muted">sample · closes with the tour</span>
          )}
          <span className="text-[10px] text-muted ml-auto">{stopLabel(at, stops.length)}</span>
          <button
            onClick={() => onStep(at - 1)}
            disabled={at === 0}
            aria-label="Back"
            className="p-1 rounded-md border border-app-border disabled:opacity-30 hover:bg-app-text/5"
          >
            <ArrowLeft size={12} />
          </button>
          <button
            onClick={() => (last ? onFinish() : onStep(at + 1))}
            data-testid="spotlight-next"
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white"
          >
            {last ? 'Done' : <>Next <ArrowRight size={11} /></>}
          </button>
        </div>
      </div>
    </>
  );
};
