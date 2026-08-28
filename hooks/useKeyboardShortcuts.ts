import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';

const isTyping = (e: KeyboardEvent) =>
  e.target instanceof HTMLInputElement ||
  e.target instanceof HTMLTextAreaElement ||
  e.target instanceof HTMLSelectElement;

/**
 * Global shortcuts. Listeners are registered once; state is read through
 * useAppStore.getState() so the handlers never go stale.
 *
 *   Space        play / pause — or "go on" while a passage is held (RPG mode)
 *   ← / →        previous / next page (paginated layout)
 *   Q tap        slower   |  Q hold: rewind while held
 *   E tap        faster   |  E hold: 3x boost while held
 *   F hold       (autofocus) highlight selection on release
 *   M            multiverse (story map)     C  codex sidebar
 *   Escape       close multiverse/codex / exit autofocus / close settings
 */
/** Views that own their arrow keys because they paginate on their own terms. */
const OWN_PAGER = new Set(['book', 'script', 'panels']);

/** How far one press of W/S moves the autofocus zoom, and A/D the pan. */
const ZOOM_STEP = 0.1;
const PAN_STEP = 30;
/** Bounds, so the page can neither vanish nor become one letter wide. */
const AUTOFOCUS_MIN = 0.5;
const AUTOFOCUS_MAX = 3;

export const useKeyboardShortcuts = () => {
  const heldQ = useRef(false);
  const heldE = useRef(false);
  const qHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qDidHold = useRef(false);
  const eDidHold = useRef(false);
  const speedBeforeBoost = useRef<number | null>(null);
  const heldF = useRef(false);

  useEffect(() => {
    const HOLD_MS = 300;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = useAppStore.getState();
      const k = e.key.toLowerCase();

      switch (k) {
        case ' ':
          e.preventDefault();
          // When a passage is being HELD for the reader (RPG mode, or the
          // press-to-advance setting), space is "go on" rather than
          // "play/pause" — that is what the caret blinking in the corner is
          // asking for. Owned here rather than in a second listener the view
          // adds: two global handlers for one key means whichever runs last
          // wins, and the view's advance was being immediately paused by this.
          if (s.awaitingInput) s.advanceOnInput();
          else s.setIsStreaming(!s.isStreaming);
          break;

        case 'f':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            document.getElementById('search-input')?.focus();
          } else if (s.screen === 'reader' && !heldF.current) {
            // Hold F to enter highlight mode; ReaderDisplay pauses streaming so a
            // selection can hold, and captures it when F is released.
            heldF.current = true;
            s.setIsHighlightMode(true);
          }
          break;

        /* Autofocus zoom and pan.
         *
         * Owned here rather than by ReaderDisplay, which is where they used to
         * live — so nine of the thirteen views had an Autofocus button that lit
         * up and then ignored every key it advertises. Views apply the zoom in
         * whatever way suits them (a font size, a page scale, a map step); the
         * keys only ever move the number. */
        case 'w':
          if (!s.isAutofocusMode) break;
          e.preventDefault();
          s.setAutofocusZoom(Math.min(AUTOFOCUS_MAX, s.autofocusZoom + ZOOM_STEP));
          break;

        case 'a':
        case 'd':
          if (!s.isAutofocusMode) break;
          e.preventDefault();
          s.setAutofocusPanX(s.autofocusPanX + (k === 'a' ? PAN_STEP : -PAN_STEP));
          break;

        case 'b':
          /* The frame tool TOGGLES, where highlight mode is held.
           *
           * Deliberate: a highlight is one gesture and holding a key for it is
           * natural, but framing is aim-then-drag and holding a key through a
           * two-handed drag on a trackpad is not. ReaderDisplay owns Escape
           * while the tool is up. */
          if (s.screen === 'reader') s.setIsBoxMode(!s.isBoxMode);
          break;

        case 'arrowright':
          // Views that paginate themselves turn their own pages on arrows: a
          // screenplay page is 55 lines and a comic page is a comic page, and
          // neither is the slice of messages `nextPage` moves through.
          if (OWN_PAGER.has(s.viewMode)) break;
          if (s.layoutMode === 'paginated' && s.screen === 'reader') s.nextPage();
          break;

        case 'arrowleft':
          if (OWN_PAGER.has(s.viewMode)) break;
          if (s.layoutMode === 'paginated' && s.screen === 'reader') s.prevPage();
          break;

        case 'q':
          if (heldQ.current) break;
          heldQ.current = true;
          qDidHold.current = false;
          qHoldTimer.current = setTimeout(() => {
            qDidHold.current = true;
            useAppStore.getState().setReverseStream(true);
          }, HOLD_MS);
          break;

        case 'e':
          if (heldE.current) break;
          heldE.current = true;
          eDidHold.current = false;
          eHoldTimer.current = setTimeout(() => {
            eDidHold.current = true;
            const st = useAppStore.getState();
            speedBeforeBoost.current = st.playbackSpeed;
            st.setPlaybackSpeed(Math.min(100, st.playbackSpeed * 3));
          }, HOLD_MS);
          break;

        case 'm':
          if (s.screen === 'reader') {
            const v2 = useAuraV2Store.getState();
            v2.setMultiverseOpen(!v2.multiverseOpen);
          }
          break;

        case 'c':
          if (s.screen === 'reader') {
            const v2 = useAuraV2Store.getState();
            v2.setCodexOpen(!v2.codexOpen);
          }
          break;

        /* One key, one owner. W/A/D are free, but S already opens Sheets — and a
         * second `case 's'` further up the switch would have silently shadowed
         * this one, so Sheets would have stopped opening for everybody. In
         * autofocus, S is the counterpart of W and zooms out; everywhere else it
         * is Sheets, exactly as before. */
        case 's':
          if (s.isAutofocusMode) {
            e.preventDefault();
            s.setAutofocusZoom(Math.max(AUTOFOCUS_MIN, s.autofocusZoom - ZOOM_STEP));
            break;
          }
          if (s.screen === 'reader') {
            const v2 = useAuraV2Store.getState();
            v2.setSheetsOpen(!v2.sheetsOpen);
          }
          break;

        case 'escape': {
          const v2 = useAuraV2Store.getState();
          if (v2.multiverseOpen) v2.setMultiverseOpen(false);
          else if (v2.sheetsOpen) v2.setSheetsOpen(false);
          else if (v2.codexOpen) v2.setCodexOpen(false);
          else if (s.settingsOpen) s.setSettingsOpen(false);
          else if (s.isAutofocusMode) s.setIsAutofocusMode(false);
          break;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = useAppStore.getState();

      switch (e.key.toLowerCase()) {
        case 'f':
          if (heldF.current) {
            heldF.current = false;
            // ReaderDisplay watches this transition and captures the current
            // selection (with the right message id) as a highlight.
            s.setIsHighlightMode(false);
          }
          break;

        case 'q':
          if (!heldQ.current) break;
          heldQ.current = false;
          if (qHoldTimer.current) clearTimeout(qHoldTimer.current);
          if (qDidHold.current) {
            s.setReverseStream(false);
          } else {
            s.setPlaybackSpeed(Math.max(1, s.playbackSpeed - 10));
          }
          break;

        case 'e':
          if (!heldE.current) break;
          heldE.current = false;
          if (eHoldTimer.current) clearTimeout(eHoldTimer.current);
          if (eDidHold.current && speedBeforeBoost.current !== null) {
            s.setPlaybackSpeed(speedBeforeBoost.current);
            speedBeforeBoost.current = null;
          } else if (!eDidHold.current) {
            s.setPlaybackSpeed(Math.min(100, s.playbackSpeed + 10));
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (qHoldTimer.current) clearTimeout(qHoldTimer.current);
      if (eHoldTimer.current) clearTimeout(eHoldTimer.current);
    };
  }, []);
};
