/**
 * The state of Aeia's SillyTavern endpoint, kept outside the panel that shows it.
 *
 * ── Why this is not just React state in `ProxyPanel` ───────────────────────
 *
 * It was, and that made the feature not work.
 *
 * The endpoint is a switch, not a screen: the reader turns it on, points
 * SillyTavern at the address, and closes the dialog to go and write. The
 * listener was already built for that — `bridge_start` takes a named holder and
 * the socket outlives the panel deliberately. But the loop that ANSWERS the
 * requests lived in the panel too, so closing it left a socket that accepted
 * connections and had nobody to hand them to. SillyTavern would send a message
 * and wait for the exchange's own timeout, every time, and the panel's copy
 * said the endpoint was listening — which it was.
 *
 * So the machinery moved to the root (`ProxyHost`) and what it produces lives
 * here, where a dialog can read it without owning it.
 *
 * Framework-free, same shape as `aiActivity`: a snapshot, a publish, and a
 * subscribe. React subscribes with `useEffect`; nothing here imports React.
 */

import type { ProxyEntry } from '../hooks/useProxy';

export interface ProxyLink {
  /** The port the listener actually opened, or null when it is not up. */
  port: number | null;
  /** Why it is not up, when that is something the reader can act on. */
  error: string | null;
  /** Completions handled this session, newest first. */
  log: ProxyEntry[];
}

/** A health readout, not a history — the panel shows a dozen at most. */
const KEEP = 12;

let snapshot: ProxyLink = { port: null, error: null, log: [] };
const listeners = new Set<(l: ProxyLink) => void>();

const publish = (next: ProxyLink) => {
  snapshot = next;
  for (const l of listeners) l(snapshot);
};

export const proxyLink = (): ProxyLink => snapshot;

export const subscribeProxyLink = (fn: (l: ProxyLink) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const setProxyPort = (port: number | null): void => {
  if (port === snapshot.port) return;
  publish({ ...snapshot, port });
};

export const setProxyError = (error: string | null): void => {
  if (error === snapshot.error) return;
  publish({ ...snapshot, error });
};

export const pushProxyEntry = (entry: ProxyEntry): void => {
  publish({ ...snapshot, log: [entry, ...snapshot.log].slice(0, KEEP) });
};

/** For tests, and for a reader who turned the endpoint off. */
export const resetProxyLink = (): void => {
  publish({ port: null, error: null, log: [] });
};
