/**
 * The desktop half of the SillyTavern bridge.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * In a browser, SillyTavern embeds Aeia in a frame and the two windows talk.
 * Packaged as an .exe there is no window to embed and no origin to share, so
 * that mechanism does not merely degrade — it has nothing to attach to.
 *
 * So the desktop build listens instead. `src-tauri/src/bridge.rs` opens a
 * socket on 127.0.0.1 and the extension calls it. The direction is forced:
 * Aeia cannot call SillyTavern, because every SillyTavern endpoint wants a CSRF
 * token issued to its own page. We own our own server, so we own its CORS.
 *
 * ── Why the reader's edits go out by being COLLECTED ───────────────────────
 *
 * A push is queued here and picked up by SillyTavern on its next poll, rather
 * than sent. Same reason: we cannot call them. It makes "send back" take up to
 * a poll interval to land, which is the price of not asking every reader to
 * reconfigure their SillyTavern.
 *
 * ── On being off ──────────────────────────────────────────────────────────
 *
 * `start` is called when the sync opens and `stop` when it closes, and the Rust
 * side times the socket out on its own if something forgets. A listening port
 * on somebody's machine is not a thing to leave running for a feature they use
 * for a minute a week.
 *
 * Everything here is a no-op in a browser. The module is imported
 * unconditionally and `isDesktop()` is false, so the web build carries a few
 * hundred bytes of dead branch and no behaviour.
 */

import type { BridgeChat } from './stBridge';
import type { PushEdit } from './stSync';

/* ------------------------------------------------------------------ */
/* Am I an exe?                                                        */
/* ------------------------------------------------------------------ */

/**
 * Tauri injects its IPC bridge before any of our code runs, so this is
 * knowable synchronously and never changes for the life of the window.
 */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** `invoke`, imported only where it exists. */
const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
};

/* ------------------------------------------------------------------ */
/* The shared secret                                                   */
/* ------------------------------------------------------------------ */

/**
 * The token the extension must present, kept across restarts.
 *
 * Persisted rather than minted per run because the reader has to type it into
 * SillyTavern once; a token that changed every launch would make that a chore
 * they repeat forever. It lives in `localStorage` beside the rest of the
 * config — a secret whose whole power is over a loopback socket that is usually
 * closed, guarding a mailbox for chat text.
 */
const TOKEN_KEY = 'aeia.bridge.token';

export const bridgeToken = (): string => {
  try {
    const kept = localStorage.getItem(TOKEN_KEY);
    if (kept && kept.length >= 16) return kept;
    const made = mintToken();
    localStorage.setItem(TOKEN_KEY, made);
    return made;
  } catch {
    // Private mode, or storage denied. A per-session token still works; it
    // just has to be re-copied into SillyTavern.
    return mintToken();
  }
};

const mintToken = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};

/* ------------------------------------------------------------------ */
/* The listener                                                        */
/* ------------------------------------------------------------------ */

export interface BridgeAddress {
  port: number;
  token: string;
}

/** Start listening. Resolves with where SillyTavern should call. */
export const startListener = async (): Promise<BridgeAddress> => {
  const token = bridgeToken();
  const port = await call<number>('bridge_start', { token });
  return { port, token };
};

export const stopListener = async (): Promise<void> => {
  await call<void>('bridge_stop');
};

/** The port, or null when nothing is listening — including after a timeout. */
export const listenerPort = async (): Promise<number | null> =>
  (await call<number | null>('bridge_status')) ?? null;

/* ------------------------------------------------------------------ */
/* The mail                                                            */
/* ------------------------------------------------------------------ */

/**
 * Chats SillyTavern has pushed since the last call, parsed.
 *
 * The Rust side stores payloads as opaque strings and has no opinion about
 * their shape; this is where they become the same `BridgeChat` the browser
 * build gets over `postMessage`, so everything downstream — the panel, the
 * alignment, the import — cannot tell which transport it came from.
 *
 * A payload that does not parse is DROPPED rather than thrown: one malformed
 * push must not stop the good ones behind it in the same batch.
 */
export const takeChats = async (): Promise<BridgeChat[]> => {
  const raw = await call<string[]>('bridge_take_inbox');
  const out: BridgeChat[] = [];
  for (const text of raw) {
    const chat = readChat(text);
    if (chat) out.push(chat);
  }
  return out;
};

/** Validate a pushed chat. Unknown shapes are refused, not coerced. */
export const readChat = (text: string): BridgeChat | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  // The extension sends the same envelope it posts in a browser, so the chat
  // may be nested under `chat` or be the whole body.
  const body = (raw.chat && typeof raw.chat === 'object' ? raw.chat : raw) as Record<string, unknown>;
  const file = typeof body.file === 'string' ? body.file : '';
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  if (!file || !chatId) return null;
  return {
    chatId,
    character: typeof body.character === 'string' ? body.character : '',
    user: typeof body.user === 'string' ? body.user : '',
    file,
    messageCount: typeof body.messageCount === 'number' ? body.messageCount : 0,
  };
};

/** Queue edits for SillyTavern to collect. */
export const queueEdits = async (edits: PushEdit[], label: string, chatId: string): Promise<void> => {
  await call<void>('bridge_queue_edits', {
    payload: JSON.stringify({ type: 'apply', edits, label, chatId }),
  });
};

/** What SillyTavern reported about edits it collected. */
export interface AppliedReport {
  applied: number;
  skipped: { index: number; reason: string }[];
}

export const takeApplied = async (): Promise<AppliedReport[]> => {
  const raw = await call<string[]>('bridge_take_applied');
  const out: AppliedReport[] = [];
  for (const text of raw) {
    const report = readApplied(text);
    if (report) out.push(report);
  }
  return out;
};

/** Validate a report. A push that is answered with rubbish counts as nothing. */
export const readApplied = (text: string): AppliedReport | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.applied !== 'number') return null;
  const skipped = Array.isArray(raw.skipped) ? raw.skipped : [];
  return {
    applied: raw.applied,
    skipped: skipped
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map(s => ({
        index: typeof s.index === 'number' ? s.index : -1,
        reason: typeof s.reason === 'string' ? s.reason : 'no reason given',
      })),
  };
};

/** What to type into SillyTavern's Aeia address box. */
export const desktopAddress = (port: number): string => `http://127.0.0.1:${port}`;
