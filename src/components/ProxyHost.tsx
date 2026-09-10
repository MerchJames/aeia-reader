/**
 * The SillyTavern endpoint, running wherever the reader is.
 *
 * No UI. Mounted once at the root so the endpoint's lifetime is the reader's
 * switch and not the dialog that flips it — see `utils/proxyLink` for what went
 * wrong when this lived in `ProxyPanel`.
 *
 * Two things happen here and nowhere else: the socket is opened and closed as
 * `proxyEnabled` changes, and `useProxy` drains the requests that arrive on it.
 * They belong together — a listener with nobody draining it is worse than no
 * listener, because SillyTavern waits on it.
 */

import { useEffect } from 'react';
import { useAppStore } from '../store';
import { useProxy } from '../hooks/useProxy';
import { bridgeToken, isDesktop } from '../utils/exeBridge';
import { pushProxyEntry, resetProxyLink, setProxyError, setProxyPort } from '../utils/proxyLink';

/** This feature's name on the shared listener. */
const HOLDER = 'proxy';

const call = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
};

export const ProxyHost = () => {
  const enabled = useAppStore(s => s.proxyEnabled);
  const live = enabled && isDesktop();

  useProxy(enabled, pushProxyEntry);

  useEffect(() => {
    if (!isDesktop()) return;
    let gone = false;
    void (async () => {
      try {
        if (enabled) {
          const port = await call<number>('bridge_start', { token: bridgeToken(), holder: HOLDER });
          if (!gone) { setProxyPort(port); setProxyError(null); }
        } else {
          await call('bridge_stop', { holder: HOLDER });
          if (!gone) resetProxyLink();
        }
      } catch (e: any) {
        if (!gone) setProxyError(String(e?.message ?? e));
      }
    })();
    return () => { gone = true; };
  }, [enabled]);

  // The socket can close itself under us — the app quitting, a port conflict,
  // its own idle timeout — and a reader whose panel still claims an address
  // would go hunting through SillyTavern for a fault that is here.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void call<number | null>('bridge_status')
        .then(open => setProxyPort(open ?? null))
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
  }, [live]);

  return null;
};
