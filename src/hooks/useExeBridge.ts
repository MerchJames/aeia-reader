/**
 * The desktop bridge, in the shape the sync panel already understands.
 *
 * `useStBridge` is the browser one — a frame, a nonce, `postMessage`. This is
 * the same conversation over a loopback socket, and it deliberately returns the
 * same `StBridge` so that everything downstream (the panel, the alignment, the
 * import, the push) cannot tell which one it is talking to. Two transports, one
 * protocol; anything else would be two sync features to keep in step.
 *
 * ── Why it polls ───────────────────────────────────────────────────────────
 *
 * Nothing here can be pushed to. The Rust listener has no way to wake the
 * window — it holds mailboxes, and this empties them. A second of latency on a
 * chat arriving is not worth an event channel to remove.
 *
 * ── Why it starts and stops with the panel ─────────────────────────────────
 *
 * Because the reader asked for a bridge that is off when it is not in use, and
 * because they are right. The hook is only mounted while the sync is open; the
 * socket lives exactly that long, plus the Rust side's own idle timeout in case
 * something ever forgets to unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isDesktop, listenerPort, queueEdits, startListener, stopListener,
  takeApplied, takeChats, type AppliedReport,
} from '../utils/exeBridge';
import type { BridgeChat, BridgeSkip } from '../utils/stBridge';
import type { PushEdit } from '../utils/stSync';

/** How often to empty the mailboxes. */
const POLL_MS = 1000;
/** How long to wait for SillyTavern to collect a push and report on it. */
const REPLY_TIMEOUT_MS = 90_000;

export interface ExeBridge {
  /** Where SillyTavern should call, for the reader to copy over. */
  address: string | null;
  /** The chat most recently pushed. */
  chat: BridgeChat | null;
  /** Every chat pushed this session, one per chat id. */
  inbox: BridgeChat[];
  /** Set when the socket could not be opened at all. */
  error: string | null;
  send: (edits: PushEdit[], label: string) => Promise<{ applied: number; skipped: BridgeSkip[] }>;
}

export const useExeBridge = (enabled: boolean): ExeBridge | null => {
  const [address, setAddress] = useState<string | null>(null);
  const [inbox, setInbox] = useState<BridgeChat[]>([]);
  const [chat, setChat] = useState<BridgeChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Resolver for the push in flight. One at a time, as in the browser. */
  const pending = useRef<((r: AppliedReport) => void) | null>(null);
  /** The chat the panel is aligned against, for the push to name. */
  const chatId = useRef('');

  const live = enabled && isDesktop();

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const chats = await takeChats();
        if (chats.length && !stopped) {
          setInbox(prev => {
            const next = [...prev];
            for (const c of chats) {
              const at = next.findIndex(x => x.chatId === c.chatId);
              if (at >= 0) next[at] = c;
              else next.push(c);
            }
            return next;
          });
          // The last one pushed is the one the panel aligns against — the same
          // rule as the browser bridge, where the newest `chat` message wins.
          setChat(chats[chats.length - 1]);
          chatId.current = chats[chats.length - 1].chatId;
        }
        const reports = await takeApplied();
        if (reports.length && pending.current) {
          const resolve = pending.current;
          pending.current = null;
          resolve(reports[0]);
        }
        // A listener that timed itself out must not be reported as connected.
        if (!stopped && (await listenerPort()) === null) setAddress(null);
      } catch {
        // A failed poll is not a failed bridge — the app may be shutting down,
        // or a command may have raced the listener stopping. The next tick
        // either works or the status check above turns the address off.
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, POLL_MS);
    };

    void (async () => {
      try {
        const { port } = await startListener();
        if (stopped) { void stopListener(); return; }
        setAddress(`http://127.0.0.1:${port}`);
        setError(null);
        void tick();
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Closed with the panel. The socket exists for as long as the reader is
      // looking at the sync and not one moment longer.
      void stopListener();
    };
  }, [live]);

  const send = useCallback((edits: PushEdit[], label: string) => (
    new Promise<{ applied: number; skipped: BridgeSkip[] }>((resolve, reject) => {
      if (!live) { reject(new Error('The desktop bridge is not running.')); return; }
      if (pending.current) { reject(new Error('A send is already in progress.')); return; }
      pending.current = resolve;
      // The chat the edits were computed against travels with them. SillyTavern
      // applies to whatever chat is open over there, which need not be this one
      // — the reader can switch chats between pressing sync and pressing send.
      // The per-edit staleness check would refuse nearly all of them anyway,
      // but "nothing applied, 40 skipped" is a far worse thing to read than
      // "that is a different chat".
      queueEdits(edits, label, chatId.current).catch(e => {
        pending.current = null;
        reject(new Error(String(e?.message ?? e)));
      });
      window.setTimeout(() => {
        if (pending.current !== resolve) return;
        pending.current = null;
        // Longer than the browser's wait, and worth saying why: over here the
        // edits sit in a mailbox until SillyTavern next looks in it, so "no
        // answer" usually means nothing is looking rather than something broke.
        reject(new Error(
          'SillyTavern has not collected the edits. Is the Aeia panel open there, with the '
          + 'address below entered?',
        ));
      }, REPLY_TIMEOUT_MS);
    })
  ), [live]);

  if (!live) return null;
  return { address, chat, inbox, error, send };
};
