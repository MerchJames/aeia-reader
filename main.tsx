import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppV2 from './AppV2.tsx';
import {hydrateV2} from './stores/useAuraV2Store';
import './index.css';

const mount = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppV2 />
  </StrictMode>,
);

// The v2 store now reads from IndexedDB, which is async where localStorage was
// not. Load before the first render so no component ever sees an empty codex —
// and mount anyway if the read fails, rather than showing a blank window.
hydrateV2().catch(e => console.error('v2 store: hydration failed', e)).finally(mount);
