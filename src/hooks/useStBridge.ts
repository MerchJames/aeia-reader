/**
 * The window-side wiring for the SillyTavern bridge.
 *
 * `stBridge.ts` decides what is valid; this does the talking. It only ever
 * activates when this window was OPENED by something that put a handshake in
 * our URL, so a reader who has never installed the extension is running none of
 * it — the listener is not even attached.
 *
 * Two details in here are easy to get wrong and expensive to get wrong.
 *
 * **The nonce is scrubbed out of the address bar immediately.** It arrives in
 * the fragment because that is the one part of a URL that is never sent to a
 * server, but leaving it there puts the session's only secret in the address
 * bar, in the history, and in any screenshot the reader takes of this window.
 * It is read once into a ref and the fragment is replaced.
 *
 * **`event.source` is checked, not just the origin.** Origin alone would let
 * any other tab on the same origin as SillyTavern — including one SillyTavern
 * itself opened — post to us. Identity of the actual window is the check that
 * means anything, and the peer below is the only window we ever accept from.
 *
 * ── Why the peer is usually the PARENT and not the opener ──────────────────
 *
 * SillyTavern serves itself through `helmet()`, whose default
 * `Cross-Origin-Opener-Policy` is `same-origin`. That policy puts any
 * cross-origin window it opens into a separate browsing context group and cuts
 * the link in both directions — so a popped-open Aeia has `window.opener ===
 * null` and SillyTavern's handle to it is disowned. The bridge could not work
 * that way against a stock SillyTavern, and no amount of care on this side
 * changes it.
 *
 * COOP does not apply to FRAMES. So the extension embeds Aeia instead of
 * popping it, `window.parent` is SillyTavern, and messages flow both ways with
 * nothing for anyone to reconfigure. The opener path is kept for a
 * SillyTavern configured with `same-origin-allow-popups`, where it still works.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePreprocess } from './usePreprocess';
import { changedAnything, summarizeRun } from '../utils/preprocess';
import { applyPlan, describePlan, type ChatMsg } from '../utils/promptPipeline';
import { proxyBlocks } from '../utils/proxyBlocks';
import { useAppStore } from '../store';
import {
  envelope, readBridgeHandshake, readBridgeMessage,
  type BridgeChat, type BridgeOutbound, type BridgeSkip,
} from '../utils/stBridge';
import type { PushEdit } from '../utils/stSync';

/**
 * The handshake this window was opened with, captured before anything can
 * destroy it.
 *
 * Read at module load, which is the only moment it is reliably there. The
 * effect below scrubs the nonce out of the address bar the first time it runs,
 * and React's StrictMode mounts every effect twice in development — so the
 * second mount used to read an address bar its own first mount had already
 * cleaned, find nothing, and quietly attach no listener at all. The bridge
 * greeted SillyTavern once and then stopped listening, which from over there
 * looks exactly like an Aeia that never answered.
 *
 * A module constant rather than a ref for the same reason: a ref is per-mount,
 * and the thing being remembered is per-WINDOW.
 */
let OPENED_WITH = typeof window !== 'undefined'
  ? readBridgeHandshake(window.location.hash)
  : null;

/**
 * A NEW handshake arriving in the address bar of a window that is already open.
 *
 * `window.open(url, 'aeia-reader')` aimed at a tab that already exists does not
 * reload it — for a URL differing only in its fragment the browser just sets
 * the fragment. So when SillyTavern is reloaded and reconnects, it mints a
 * fresh nonce and opens "a new window" that is this same one, and without this
 * the bridge would keep checking every message against a nonce nobody is using
 * any more and silently drop all of them.
 */
const onHashHandshake = (fn: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = () => {
    const next = readBridgeHandshake(window.location.hash);
    if (!next || next.nonce === OPENED_WITH?.nonce) return;
    OPENED_WITH = next;
    fn();
  };
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
};

/**
 * The window on the other end of the bridge.
 *
 * The frame's parent when Aeia is embedded — which is the arrangement that
 * survives SillyTavern's COOP — and the opener when it was popped into a tab.
 * `window.parent` is this window itself at the top level, so the identity
 * check below is what keeps "not framed" from reading as "framed by myself".
 */
export const bridgePeer = (): Window | null => {
  if (typeof window === 'undefined') return null;
  if (window.parent && window.parent !== window) return window.parent;
  return window.opener ?? null;
};

/** True when SillyTavern reached us, whatever the reader's settings say. */
export const openedBySillyTavern = (): boolean => !!OPENED_WITH && !!bridgePeer();

/**
 * The origin SillyTavern named for itself in the handshake.
 *
 * Read from the handshake rather than `document.referrer` or
 * `location.ancestorOrigins`: helmet's defaults include `Referrer-Policy:
 * no-referrer`, so the referrer is empty in a SillyTavern frame, and
 * `ancestorOrigins` does not exist in Firefox. The handshake is the one source
 * that is always there and is already checked against every message.
 */
export const bridgeOrigin = (): string | null => OPENED_WITH?.origin ?? null;

/** True when Aeia is running inside SillyTavern's own dialog. */
export const isEmbedded = (): boolean =>
  typeof window !== 'undefined' && window.parent !== window && !!OPENED_WITH;

/** How long to wait for SillyTavern to report back before giving up on a push. */
const REPLY_TIMEOUT_MS = 30_000;
/** How often, and how many times, to say hello before giving up. */
const HELLO_RETRY_MS = 400;
const HELLO_TRIES = 15;

/** Set when a handshake arrived but the opener was unreachable — see below. */
export interface StBridge {
  /** The chat most recently sent over — what the sync panel aligns against. */
  chat: BridgeChat;
  /**
   * Every chat this session has received, newest last, one per chat id.
   *
   * A whole-library sync arrives as many ordinary `chat` messages rather than
   * a new kind of message, so nothing on the wire had to change. What did have
   * to change is here: keeping only the last one would mean a library sync of
   * two hundred chats delivered one.
   */
  inbox: BridgeChat[];
  /** A handshake arrived, but the opener could not be reached (COOP). */
  blocked?: boolean;
  send: (edits: PushEdit[], label: string) => Promise<{ applied: number; skipped: BridgeSkip[] }>;
}

export const useStBridge = (): StBridge | null => {
  /*
   * The reader's switch — and the one thing that outranks it.
   *
   * The switch keeps the bridge INERT rather than merely invisible: with no
   * handshake and the sync off, no listener is attached at all, so another page
   * cannot open a channel to a reader who never asked for one.
   *
   * But a valid handshake in this window's own URL is not another page taking
   * a liberty — it is the reader, in SillyTavern, having just pressed "sync".
   * Requiring them to go and find a second switch in a second app to finish the
   * thing they already started bought no safety and cost the whole feature:
   * SillyTavern opened Aeia, Aeia said nothing back, and both sides sat there
   * looking broken. So the handshake is treated as the consent it is, and the
   * setting is switched on to match rather than silently disagreeing with what
   * the app is doing.
   */
  const setEnabled = useAppStore(s => s.setStSyncEnabled);
  const [shakeAt, setShakeAt] = useState(0);
  const enabled = useAppStore(s => s.stSyncEnabled) || openedBySillyTavern();

  useEffect(() => {
    if (openedBySillyTavern()) setEnabled(true);
    // Re-runs the connection below with the new nonce.
    return onHashHandshake(() => { setEnabled(true); setShakeAt(n => n + 1); });
  }, [setEnabled]);
  const [chat, setChat] = useState<BridgeChat | null>(null);
  /**
   * The second pass, in a ref.
   *
   * The message listener is installed once and must not be torn down and
   * rebuilt whenever a render produces a new callback identity — a listener
   * that re-subscribes mid-conversation can miss the message it was waiting
   * for. A ref keeps the closure pointed at the current runner without making
   * the runner a dependency of the effect.
   */
  const preprocess = usePreprocess();
  const preprocessRef = useRef(preprocess);
  preprocessRef.current = preprocess;
  const [inbox, setInbox] = useState<BridgeChat[]>([]);
  const [blocked, setBlocked] = useState(false);
  const nonceRef = useRef('');
  const originRef = useRef('');
  /** Resolver for the push currently in flight. One at a time, by design. */
  const pendingRef = useRef<((r: { applied: number; skipped: BridgeSkip[] }) => void) | null>(null);
  /** Set once SillyTavern has said anything at all, which stops the greeting. */
  const greeted = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    // The captured handshake, not the address bar — see `OPENED_WITH`.
    const shake = OPENED_WITH;
    if (!shake) return;
    const peer = bridgePeer();
    if (!peer) {
      /*
       * The handshake arrived but the window that sent it is unreachable.
       *
       * Almost always SillyTavern's `Cross-Origin-Opener-Policy`. It runs
       * `helmet()` with only the CSP turned off, and helmet's default COOP is
       * `same-origin` — which puts any CROSS-ORIGIN window it opens into a
       * separate browsing context group and severs the link in both
       * directions. Aeia on :3000 opened from SillyTavern on :8000 is exactly
       * that case, and no amount of care on this side can reach back through
       * it: the postMessage bridge cannot work against a stock SillyTavern.
       *
       * Said out loud, with the fix, because the alternative is a tab that
       * opens and sits there.
       */
      console.warn(
        '[Aeia] The sync could not reach SillyTavern: this window has no reachable peer.\n'
        + 'A popped-open Aeia is cut off by SillyTavern\'s Cross-Origin-Opener-Policy. '
        + 'Update the Aeia Bridge extension — current versions embed Aeia instead, '
        + 'which that policy does not affect.',
      );
      setBlocked(true);
      return;
    }

    nonceRef.current = shake.nonce;
    originRef.current = shake.origin;
    // Out of the address bar, the history entry and any screenshot. `replaceState`
    // rather than assigning `location.hash`, which would push a new entry and
    // leave the old one — nonce and all — in the back button.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch { /* a sandboxed or file:// context; not worth failing the bridge over */ }

    /** Send to the peer, addressed to the origin it named. */
    const post = (body: BridgeOutbound) =>
      peer.postMessage(envelope(nonceRef.current, body), originRef.current);

    const onMessage = (e: MessageEvent) => {
      // Identity first: only the window on the other end, at the origin it named.
      if (e.source !== peer) return;
      if (e.origin !== originRef.current) return;

      const msg = readBridgeMessage(e.data, nonceRef.current);
      if (!msg) return;
      greeted.current = true;

      if (msg.type === 'chat') {
        setChat(msg.chat);
        // Keyed by chat id so a re-send replaces rather than duplicates — the
        // extension's "Send again" is the same chat, not a second one.
        setInbox(prev => [...prev.filter(c => c.chatId !== msg.chat.chatId), msg.chat]);
        return;
      }
      if (msg.type === 'draft') {
        /**
         * A reply SillyTavern just generated, handed over for a second pass.
         *
         * Deliberately fire-and-forget from the message handler's point of
         * view: the run takes seconds and makes model calls, and a handler
         * that awaited it would block every other message on the channel —
         * including the reader pressing something in the sync panel.
         *
         * Nothing is applied here. The revision goes back and the EXTENSION
         * applies it, keeping the original as a swipe, which is the only
         * arrangement where a bad second pass costs a swipe rather than the
         * message.
         */
        const draft = msg.draft;
        if (!preprocessRef.current) return;
        void preprocessRef.current(draft.text, {
          onStage: (label, step, total) =>
            post({ type: 'stage', stage: { label, step, total } }),
        }).then(result => {
          post({
            type: 'revision',
            revision: {
              index: draft.index,
              text: result.text,
              original: draft.text,
              summary: summarizeRun(result),
              changed: changedAnything(result),
            },
          });
        }).catch(() => {
          // Report the original back unchanged rather than leaving the
          // extension waiting: a draft that never gets an answer leaves the
          // reader's message sitting behind a status line forever.
          post({
            type: 'revision',
            revision: {
              index: draft.index,
              text: draft.text,
              original: draft.text,
              summary: 'The second pass could not run; the reply is unchanged.',
              changed: false,
            },
          });
        });
        return;
      }
      if (msg.type === 'prompt') {
        /*
         * The browser's half of the request pipeline.
         *
         * SillyTavern emits its assembled prompt, awaits its extensions, and
         * sends whatever they leave behind — so a tab that cannot listen on a
         * port can still do everything the desktop proxy does to a prompt. Same
         * `applyPlan`, same settings, same tests.
         *
         * Synchronous and fast by design: SillyTavern is holding its
         * generation open waiting for this, so nothing here makes a model call.
         * Weaving material in is string work.
         */
        const { id, messages } = msg.prompt;
        try {
          const app = useAppStore.getState();
          const shaped = applyPlan(messages as ChatMsg[], proxyBlocks(app));
          post({
            type: 'shaped',
            shaped: {
              id,
              messages: shaped.messages.map(m => ({ role: m.role, content: m.content })),
              summary: describePlan(shaped),
              changed: shaped.injected.length > 0 || shaped.dropped > 0,
            },
          });
        } catch {
          // Hand back exactly what arrived. A prompt this could not shape must
          // still be sent — the alternative is a message that never generates.
          post({
            type: 'shaped',
            shaped: { id, messages, summary: 'unchanged', changed: false },
          });
        }
        return;
      }
      if (msg.type === 'applied') {
        pendingRef.current?.({ applied: msg.applied, skipped: msg.skipped });
        pendingRef.current = null;
        return;
      }
      if (msg.type === 'error') {
        // An error still settles the promise: a push that reports nothing is
        // indistinguishable from one that is still going, and the panel would
        // sit disabled forever.
        pendingRef.current?.({ applied: 0, skipped: [{ index: -1, reason: msg.message }] });
        pendingRef.current = null;
      }
    };

    window.addEventListener('message', onMessage);
    /*
     * Greet the opener — and keep greeting it until it answers.
     *
     * One `hello` is a race the other side can lose. SillyTavern only starts
     * listening once its own handler is wired, and a window that loads fast
     * enough can say hello into the gap; the extension then sits at "offline"
     * for ever, because nothing in the protocol makes anyone speak twice. So it
     * is repeated until a message comes back, and given up on rather than
     * repeated for ever.
     */
    greeted.current = false;
    const greet = () => peer.postMessage(
      envelope(shake.nonce, { type: 'hello' }), shake.origin,
    );
    greet();
    let tries = 0;
    const retry = setInterval(() => {
      if (greeted.current || ++tries > HELLO_TRIES) { clearInterval(retry); return; }
      greet();
    }, HELLO_RETRY_MS);

    return () => {
      clearInterval(retry);
      window.removeEventListener('message', onMessage);
    };
    // `enabled` only: the handshake is read once from the URL this window was
    // opened with, so re-running on anything else would re-announce `hello` to
    // a window that has already been talked to.
  }, [enabled]);

  const send = useCallback((edits: PushEdit[], label: string) => (
    new Promise<{ applied: number; skipped: BridgeSkip[] }>((resolve, reject) => {
      /*
       * The peer, not `window.opener`.
       *
       * This half was left behind when the bridge moved into a frame to get
       * around SillyTavern's COOP. Listening was fixed to accept the parent;
       * sending still addressed the opener, which in a frame is null — so
       * every "Send back" failed with "SillyTavern is no longer connected"
       * while the header said, correctly, that it was connected.
       */
      const peer = bridgePeer();
      if (!nonceRef.current || !peer) {
        reject(new Error('SillyTavern is no longer connected.'));
        return;
      }
      if (pendingRef.current) {
        reject(new Error('A send is already in progress.'));
        return;
      }
      pendingRef.current = resolve;
      peer.postMessage(
        envelope(nonceRef.current, { type: 'apply', edits, label }),
        originRef.current,
      );
      // The tab on the other side can be closed, reloaded, or simply busy. A
      // push that never settles leaves the panel's buttons disabled with no
      // explanation, which reads as the app hanging.
      window.setTimeout(() => {
        if (pendingRef.current !== resolve) return;
        pendingRef.current = null;
        reject(new Error('SillyTavern did not answer. Is the tab still open?'));
      }, REPLY_TIMEOUT_MS);
    })
  ), []);

  return chat ? { chat, inbox, send, blocked } : null;
};
