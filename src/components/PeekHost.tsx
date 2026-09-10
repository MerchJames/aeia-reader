import { useEffect, useRef, useState } from 'react';
import { ScanText, X } from 'lucide-react';
import { useAppStore } from '../store';
import { wordsPerSecond } from '../hooks/useStreamer';
import { peekState, proseAt, setPeekActive, showPeek, subscribePeek } from '../utils/peek';

/**
 * The peek panel: whatever the reader clicked, read to them.
 *
 * ── Where it is, and why ──────────────────────────────────────────────────
 *
 * Left, and OUTSIDE the settings drawer — which is on the right. A preview that
 * opened inside the panel would cover the control it was explaining, and would
 * reflow the list the reader was half way down. This has to be somewhere the
 * settings are not.
 *
 * ── Why it streams ────────────────────────────────────────────────────────
 *
 * Because this app already knows how to make text readable and it is not by
 * enlarging it: it reveals it at reading speed. At the reader's OWN speed,
 * since they have already told the app what pace they like.
 */
export const PeekHost = () => {
  const [{ active, text }, setState] = useState(peekState);
  const speed = useAppStore(s => s.playbackSpeed);
  const [shown, setShown] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => subscribePeek(setState), []);

  /*
   * One listener for the whole document while the mode is on.
   *
   * Capture phase, so a paragraph inside something that stops propagation is
   * still readable — and `preventDefault` on the way down, so clicking prose in
   * peek mode reads it instead of doing whatever that prose sits inside.
   */
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      const prose = proseAt(e.target as Element | null);
      if (!prose) return;
      e.preventDefault();
      e.stopPropagation();
      showPeek(prose);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active]);

  // Escape closes it, like every other transient thing in the app.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPeekActive(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  useEffect(() => {
    if (!text) { setShown(''); return; }
    const words = text.split(/(\s+)/);
    let i = 0;
    const every = Math.max(40, 1000 / (wordsPerSecond(speed) * 2));
    timer.current = setInterval(() => {
      i += 2;                                   // the word, and the space after it
      setShown(words.slice(0, i).join(''));
      if (i >= words.length && timer.current) clearInterval(timer.current);
    }, every);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [text, speed]);

  if (!active) return null;

  return (
    <div
      className="fixed z-[85] left-5 top-1/2 -translate-y-1/2 w-72 max-w-[80vw]
        rounded-xl border border-accent/40 bg-app-surface shadow-2xl p-3"
      data-testid="peek-panel"
      role="dialog"
      aria-label="Reading the small print"
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <ScanText size={12} className="text-accent shrink-0" />
        <span className="text-[11px] text-muted">
          {text ? 'Reading' : 'Tap any text to read it'}
        </span>
        <button
          onClick={() => setPeekActive(false)}
          title="Close"
          aria-label="Close"
          data-testid="peek-close"
          className="ml-auto p-1 rounded text-app-text/40 hover:text-app-text"
        >
          <X size={12} />
        </button>
      </div>
      <p
        className="text-[13px] leading-relaxed max-h-[50vh] overflow-y-auto min-h-[4rem]"
        aria-live="polite"
        data-testid="peek-text"
      >
        {shown}
        {!!text && shown.length < text.length && <span className="opacity-40">▍</span>}
      </p>
    </div>
  );
};
