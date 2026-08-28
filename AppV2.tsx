import React, { lazy, Suspense, useEffect } from 'react';
import App from './App';
import { CodexSidebar } from './components/CodexSidebar';
import { PinDock } from './components/PinDock';
import { SheetsSidebar } from './components/SheetsSidebar';
import { RecapCard } from './components/RecapCard';
import { useCodexExtractor } from './hooks/useCodexExtractor';
import { useAppStore } from './store';
import { useAuraV2Store } from './stores/useAuraV2Store';

// React Flow (and its stylesheet) only load when the multiverse is opened —
// the default reading experience ships none of its weight.
const MultiverseExplorer = lazy(() =>
  import('./components/MultiverseExplorer').then(m => ({ default: m.MultiverseExplorer })));

const TICK = 5000;
/** How long after the last sign of life a manual reader still counts as reading. */
const IDLE_AFTER = 60_000;

/**
 * Accumulate per-story reading time.
 *
 * This used to tick only while text was streaming, which meant someone turning
 * pages in Book, or reading a settled passage at their own speed, accrued
 * nothing at all — the number under "time read" was really "time spent
 * watching the autoreader". Now streaming always counts, and a paused reader
 * counts too as long as the tab is visible and they have touched something in
 * the last minute. Still an estimate, but one that matches how the app is
 * actually read.
 */
const useReadingClock = () => {
  const inReader = useAppStore(s => s.screen === 'reader');

  // "Last read" means the last time you OPENED it. Stamped here rather than in
  // `openStory` because the app store must not import the v2 store — the
  // dependency already runs the other way, and closing the loop would make
  // module init order load-bearing.
  const openedId = useAppStore(s => (s.screen === 'reader' ? s.currentStory?.id : undefined));
  useEffect(() => {
    if (openedId) useAuraV2Store.getState().touchStory(openedId);
  }, [openedId]);

  useEffect(() => {
    if (!inReader) return;
    let lastActivity = Date.now();
    const mark = () => { lastActivity = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, mark, { passive: true });

    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const app = useAppStore.getState();
      const storyId = app.currentStory?.id;
      if (!storyId) return;
      const attentive = app.isStreaming || Date.now() - lastActivity < IDLE_AFTER;
      if (attentive) useAuraV2Store.getState().addReadingTime(storyId, TICK);
    }, TICK);

    return () => {
      clearInterval(id);
      for (const e of events) window.removeEventListener(e, mark);
    };
  }, [inReader]);
};

/**
 * v2 shell: the classic reader stays exactly as it was; the Codex, the
 * Multiverse, and the resume recap layer on top as overlays. All of them
 * are hidden until summoned, keeping the default experience pure reading.
 */
export default function AppV2() {
  useCodexExtractor();
  useReadingClock();

  const multiverseOpen = useAuraV2Store(s => s.multiverseOpen);
  const screen = useAppStore(s => s.screen);

  // Leaving the reader closes the overlays with it.
  useEffect(() => {
    if (screen !== 'reader') {
      const v2 = useAuraV2Store.getState();
      if (v2.multiverseOpen) v2.setMultiverseOpen(false);
      if (v2.codexOpen) v2.setCodexOpen(false);
      if (v2.sheetsOpen) v2.setSheetsOpen(false);
    }
  }, [screen]);

  return (
    <>
      <App />
      {screen === 'reader' && (
        <>
          <CodexSidebar />
          <SheetsSidebar />
          <PinDock />
          <RecapCard />
          {multiverseOpen && (
            <Suspense fallback={null}>
              <MultiverseExplorer />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}
