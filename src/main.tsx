import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppV2 from './AppV2.tsx';
import {EmbeddedSync} from './components/EmbeddedSync';
import {CrashScreen} from './components/CrashScreen';
import {isEmbedded} from './hooks/useStBridge';
import {hydrateV2} from './stores/useAuraV2Store';
import './index.css';

/**
 * Two things this file can start.
 *
 * The reader, or — when SillyTavern has embedded us in its own dialog — the
 * sync panel and nothing else. Decided HERE rather than inside the app because
 * the difference is which app runs at all: mounting the reader to show one
 * panel would start the streamer, the codex extractor, the reading clock and
 * the ambient audio inside a 420px frame that nobody is reading in.
 *
 * `isEmbedded` reads a handshake captured at module load, so this is settled
 * before the first render and never flips underneath one.
 */
const mount = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      * Outside everything, including the theme.
      *
      * React unmounts the whole tree when a render throws with nothing to catch
      * it. In a browser that is a white page and a console entry; in the
      * packaged app it is a BLACK WINDOW with no console to open, which is
      * indistinguishable from a hang or a broken install. This is the only
      * thing that turns that into a sentence.
      */}
    <CrashScreen>
      {isEmbedded() ? <EmbeddedSync /> : <AppV2 />}
    </CrashScreen>
  </StrictMode>,
);

// The v2 store now reads from IndexedDB, which is async where localStorage was
// not. Load before the first render so no component ever sees an empty codex —
// and mount anyway if the read fails, rather than showing a blank window.
hydrateV2().catch(e => console.error('v2 store: hydration failed', e)).finally(mount);
