/**
 * The live wire between a SillyTavern tab and this one.
 *
 * Syncing through a file works and always will — the reader exports a `.jsonl`,
 * drops it here, and downloads a merged one. It is also four manual steps and a
 * trip through the Downloads folder every time. This is the same sync with the
 * file handling taken out: SillyTavern opens Aeia in a window and the two talk
 * over `postMessage`.
 *
 * ── Why postMessage, and not an HTTP call ──────────────────────────────────
 *
 * The obvious design is for Aeia to fetch SillyTavern's chat API directly.
 * SillyTavern will not allow it: its CORS origin defaults to `null`, so every
 * cross-origin read from us is refused unless the reader edits `config.yaml`,
 * and telling people to loosen the security settings of the app holding all
 * their chats is not an install step worth writing. The reverse — ST fetching
 * us — needs Aeia to be listening on a port, which it is not when it is a page
 * in a browser tab.
 *
 * `window.postMessage` needs neither. It is the one channel two origins get for
 * free, it is explicitly designed for this, and it works whether Aeia is on a
 * dev server, a static host, or a file the reader opened themselves.
 *
 * ── What makes it safe ─────────────────────────────────────────────────────
 *
 * A window that can post to us can also be a hostile page, and what is being
 * moved is the reader's entire chat log. Three things gate it, and all three
 * must hold:
 *
 * 1. **We only ever act as the OPENED window.** SillyTavern opens us; the nonce
 *    arrives in our own URL fragment. A page that did not open us cannot be
 *    `window.opener`, and a page that did not choose the nonce cannot know it.
 * 2. **The opener names its own origin up front**, in that same fragment, and
 *    we address our first message to exactly that origin. If the opener is
 *    anything else the browser drops the message rather than delivering the
 *    nonce to a stranger.
 * 3. **Every later message is checked against all three** — source, origin and
 *    nonce — and anything that fails is ignored in silence. Nothing here
 *    throws: this code's whole input is untrusted, and a parse error that
 *    escaped would be a way to break the tab from outside it.
 *
 * What crosses the wire is still only ever a suggestion. Edits sent to
 * SillyTavern are applied there by an extension that shows the reader every one
 * of them first, and edits arriving here land in the same review panel a
 * dropped file does. Neither side writes because the other asked.
 *
 * Pure: no store, no React, no DOM — the wiring lives in `useStBridge`.
 */

import type { PushEdit } from './stSync';

export const BRIDGE_PROTOCOL = 'aeia-bridge';

/**
 * Bump only for a change the other side cannot ignore.
 *
 * Both ends check this and refuse a mismatch, because the alternative is an
 * extension a year out of date silently misreading a field and writing the
 * wrong text into somebody's chat. A refusal the reader can see is the good
 * outcome here.
 */
export const BRIDGE_VERSION = 1;

/** A whole chat file is a lot to move, but not unbounded. */
export const MAX_CHAT_BYTES = 32 * 1024 * 1024;

/** More edits than this in one push is a bug, not a session. */
export const MAX_EDITS = 5000;

/* ------------------------------------------------------------------ */
/* The handshake, which arrives in our own URL                         */
/* ------------------------------------------------------------------ */

export interface BridgeHandshake {
  /** The opener's secret. Proves a message came from the window that opened us. */
  nonce: string;
  /** The opener's origin, which is where — and only where — we reply. */
  origin: string;
}

/**
 * A nonce we are willing to trust.
 *
 * Length is the point: this is the only secret in the protocol. The charset is
 * restricted so a nonce can never carry anything that changes the meaning of
 * the fragment it travelled in.
 */
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Read the handshake out of a URL fragment.
 *
 * Returns null for anything at all suspicious rather than a partial result: a
 * handshake missing either half is not a weaker handshake, it is not one.
 */
export const readBridgeHandshake = (hash: string): BridgeHandshake | null => {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return null;

  let params: URLSearchParams;
  try { params = new URLSearchParams(raw); } catch { return null; }

  const nonce = params.get(BRIDGE_PROTOCOL) ?? '';
  const origin = params.get('origin') ?? '';
  if (!NONCE_RE.test(nonce)) return null;

  // A wildcard here would have us broadcast the reader's chat to whatever page
  // happens to be listening. It is the one value that must never be accepted.
  if (!origin || origin === '*') return null;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin !== origin) return null;  // an origin, not a URL with a path

  return { nonce, origin };
};

/* ------------------------------------------------------------------ */
/* What each side may say                                              */
/* ------------------------------------------------------------------ */

/** A chat, as SillyTavern hands it over. */
export interface BridgeChat {
  /** ST's own name for the chat file — shown, and used to match on re-sync. */
  chatId: string;
  character: string;
  user: string;
  /**
   * The entire chat as `.jsonl` text, header line included.
   *
   * Deliberately the file format rather than a parsed structure: it is what
   * `parseStFile` already takes, so the live path and the dropped-file path
   * meet immediately and every guarantee proved for one holds for the other.
   */
  file: string;
  /** ST's own count, for a sanity check against what we parse out. */
  messageCount: number;
}


/**
 * A reply SillyTavern has just generated, handed over for a second pass.
 *
 * ── Why the generation itself does not come through here ───────────────────
 *
 * The tempting design is for Aeia to sit between SillyTavern and the model:
 * take the prompt, call the backend, process the answer, hand it back. It has
 * three problems and this shape has none of them. Aeia in a browser cannot
 * reach most backends (the same CORS wall that rules out fetching ST's own
 * API); it would have to hold the reader's API key; and it would put a browser
 * tab on the critical path of every generation, so a closed tab breaks
 * SillyTavern rather than merely turning off a feature.
 *
 * Instead SillyTavern generates exactly as it always has, with its own key and
 * its own endpoint, and hands over the FINISHED reply. Aeia's second pass runs
 * against Aeia's own configured model — a call it already knows how to make.
 * Nothing new has to be reachable, and a missing Aeia costs a check rather
 * than a conversation.
 *
 * It also means the critic need not be the writer: a big creative model can
 * write while a small fast one checks, which is only possible because these
 * are two separate calls to two separate places.
 */
export interface BridgeDraft {
  /** Position among the file's message lines, as `PushEdit.index`. */
  index: number;
  /** What the model wrote. Never modified in place — see `BridgeRevision`. */
  text: string;
  /** Speaker, for the reader's log. */
  name: string;
  /** ST's chat id, so a reply from a chat that has since changed is refused. */
  chatId: string;
}

/**
 * A prompt SillyTavern is about to send, handed over to be worked on.
 *
 * The browser's answer to the desktop proxy. A packaged Aeia can BE
 * SillyTavern's endpoint and see every prompt on the way past; a browser tab
 * cannot listen on a port, so it would have been shut out of the whole
 * request-side feature — except that SillyTavern emits its assembled prompt to
 * extensions, awaits them, and sends whatever array they leave behind. So the
 * extension hands it over, waits for this to come back, and puts it in place.
 *
 * Same pipeline, same tests, different transport. The alternative was a feature
 * that existed only for people who run the exe.
 */
export interface BridgePrompt {
  /** Matches the reply, so a late answer can be told from the current one. */
  id: string;
  /** The messages as SillyTavern assembled them. */
  messages: { role: string; content: string }[];
}

/** The prompt to send instead, or the same one. */
export interface BridgeShaped {
  id: string;
  messages: { role: string; content: string }[];
  /** One line for the reader: what was done, or that nothing was. */
  summary: string;
  changed: boolean;
}

/** Progress, for the extension's status line. */
export interface BridgeStage {
  label: string;
  /** 1-based, so a status line can say "2 of 5". */
  step: number;
  total: number;
}

/**
 * The outcome of a second pass.
 *
 * `original` travels back alongside `text` even though SillyTavern already has
 * it. It is the receipt: the extension checks that what Aeia thought it was
 * revising is still what the message says, and keeps the original as a swipe
 * so nothing the model wrote is ever lost.
 */
export interface BridgeRevision {
  index: number;
  /** The revised reply. Equal to `original` when nothing was changed. */
  text: string;
  original: string;
  /** One line for the reader, from `summarizeRun`. */
  summary: string;
  /** True when a change was actually made. */
  changed: boolean;
}

/** One edit SillyTavern declined, and why — shown to the reader verbatim. */
export interface BridgeSkip {
  index: number;
  reason: string;
}

/** SillyTavern → Aeia. */
export type BridgeInbound =
  | { type: 'chat'; chat: BridgeChat }
  | { type: 'draft'; draft: BridgeDraft }
  | { type: 'prompt'; prompt: BridgePrompt }
  | { type: 'applied'; applied: number; skipped: BridgeSkip[] }
  | { type: 'error'; message: string };

/** Aeia → SillyTavern. */
export type BridgeOutbound =
  | { type: 'hello' }
  | { type: 'stage'; stage: BridgeStage }
  | { type: 'revision'; revision: BridgeRevision }
  | { type: 'shaped'; shaped: BridgeShaped }
  | { type: 'apply'; edits: PushEdit[]; label: string };

/** Wrap a message for sending. Both ends stamp every message the same way. */
export const envelope = (nonce: string, body: BridgeOutbound): Record<string, unknown> => ({
  protocol: BRIDGE_PROTOCOL,
  v: BRIDGE_VERSION,
  nonce,
  ...body,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Turn an arriving `MessageEvent`'s data into something we will act on.
 *
 * The caller has already checked source and origin; this checks the contents.
 * Null means "not for us, or not valid" and the caller drops it — there is
 * deliberately no way to tell those two apart from the outside, because a
 * chatty rejection is a way to probe what we accept.
 */
export const readBridgeMessage = (data: unknown, nonce: string): BridgeInbound | null => {
  if (!isObj(data)) return null;
  if (data.protocol !== BRIDGE_PROTOCOL) return null;
  if (data.v !== BRIDGE_VERSION) return null;
  if (!nonce || data.nonce !== nonce) return null;

  switch (data.type) {
    case 'chat': {
      const c = data.chat;
      if (!isObj(c)) return null;
      const file = str(c.file);
      // An empty file is not a chat, and an enormous one is not a mistake we
      // should try to survive by parsing it.
      if (!file || file.length > MAX_CHAT_BYTES) return null;
      return {
        type: 'chat',
        chat: {
          chatId: str(c.chatId),
          character: str(c.character),
          user: str(c.user),
          file,
          messageCount: typeof c.messageCount === 'number' ? c.messageCount : 0,
        },
      };
    }
    case 'draft': {
      const d = data.draft;
      if (!isObj(d)) return null;
      const text = str(d.text);
      // An empty draft is not a reply, and an enormous one is not a mistake to
      // survive by parsing. Same reasoning as the chat cap above.
      if (!text || text.length > MAX_CHAT_BYTES) return null;
      if (typeof d.index !== 'number' || !Number.isInteger(d.index) || d.index < 0) return null;
      return {
        type: 'draft',
        draft: { index: d.index, text, name: str(d.name), chatId: str(d.chatId) },
      };
    }
    case 'prompt': {
      const p = data.prompt;
      if (!isObj(p)) return null;
      const id = str(p.id);
      const raw = Array.isArray(p.messages) ? p.messages : null;
      if (!id || !raw) return null;
      // Every message must be readable, and the whole prompt must be a size a
      // prompt can be. A malformed one is refused rather than half-repaired:
      // the extension keeps its own copy and sends that instead, so refusing
      // costs the reader nothing at all.
      const messages: { role: string; content: string }[] = [];
      let total = 0;
      for (const item of raw) {
        if (!isObj(item)) return null;
        const role = str(item.role);
        const content = str(item.content);
        if (!role) return null;
        total += content.length;
        if (total > MAX_CHAT_BYTES) return null;
        messages.push({ role, content });
      }
      if (!messages.length) return null;
      return { type: 'prompt', prompt: { id, messages } };
    }
    case 'applied': {
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      return {
        type: 'applied',
        applied: typeof data.applied === 'number' ? data.applied : 0,
        skipped: skipped.filter(isObj).map(s => ({
          index: typeof s.index === 'number' ? s.index : -1,
          reason: str(s.reason) || 'no reason given',
        })),
      };
    }
    case 'error':
      return { type: 'error', message: str(data.message) || 'SillyTavern reported an error' };
    default:
      return null;
  }
};

/**
 * Is this push fit to send?
 *
 * Returns a sentence for the reader, or null when it is fine. Refusing here is
 * cheap; the same refusal after the other side has half-applied it is not.
 */
export const pushProblem = (edits: readonly PushEdit[]): string | null => {
  if (!edits.length) return 'Nothing to send — no edits of yours are missing from SillyTavern.';
  if (edits.length > MAX_EDITS) {
    return `${edits.length} edits is more than this can send at once (limit ${MAX_EDITS}).`;
  }
  for (const e of edits) {
    if (!Number.isInteger(e.index) || e.index < 0) return 'An edit has no valid position.';
    // `was` may legitimately be empty; `text` may not. A blank push would
    // erase a message in SillyTavern, which no part of this feature is for.
    if (!e.text.trim()) return 'An edit would blank a message in SillyTavern.';
  }
  return null;
};

/**
 * A one-line account of a completed push, skips included.
 *
 * The skips are the part worth surfacing: an edit SillyTavern refused because
 * the message had changed under us is the system working, and the reader needs
 * to know it happened so they can look again rather than assume it all landed.
 */
export const describeApplied = (applied: number, skipped: readonly BridgeSkip[]): string => {
  const a = `${applied} message${applied === 1 ? '' : 's'} updated in SillyTavern`;
  if (!skipped.length) return `${a}.`;
  return `${a}; ${skipped.length} skipped because ${
    skipped.length === 1 ? 'it had' : 'they had'} changed there since.`;
};

/* ------------------------------------------------------------------ */
/* Naming a chat that arrived over the bridge                          */
/* ------------------------------------------------------------------ */

/**
 * A title that tells two chats with the same character apart.
 *
 * The importer names a SillyTavern story after its CHARACTER, which is right
 * for the usual case and useless the moment somebody has more than one chat
 * with the same person: five conversations with Carys all import as "Carys",
 * the library shows five identical rows, and nothing on screen says which is
 * which. Syncing a whole library makes that the normal case rather than the
 * edge one.
 *
 * SillyTavern's own file name is the only thing that distinguishes them, and it
 * usually ends in something a person chose — `… - Branch #1`, `… - a second
 * try`. That tail is the name; when there is no tail, the date it was started
 * is at least an answer to "which one is this".
 */
export const syncedStoryTitle = (character: string, chatId: string): string => {
  const who = character.trim();
  const id = chatId.trim();
  if (!id) return who || 'SillyTavern chat';
  if (!who) return id;
  // The chat is named after the character and nothing else — there is nothing
  // to disambiguate, and "Carys · Carys" would be worse than "Carys".
  if (id.toLowerCase() === who.toLowerCase()) return who;

  // "2025-10-13 @00h 45m 12s 743ms - Branch #1" → "Branch #1"
  const tail = id.includes(' - ') ? id.slice(id.lastIndexOf(' - ') + 3).trim() : '';
  if (tail && tail.toLowerCase() !== who.toLowerCase()) return `${who} · ${tail}`;

  const date = /^(\d{4}-\d{2}-\d{2})/.exec(id)?.[1];
  return date ? `${who} · ${date}` : `${who} · ${id.slice(0, 32)}`;
};

/* ------------------------------------------------------------------ */
/* Telling the other tab                                               */
/* ------------------------------------------------------------------ */

/**
 * The channel Aeia's own tabs use to tell each other the library moved.
 *
 * The sync runs inside a frame in SillyTavern. That frame is the same origin as
 * the reader's Aeia tab, so it writes to the same IndexedDB — but the tab
 * already has its library in memory and no reason to look again. So a chat
 * synced from SillyTavern landed correctly and simply did not appear until the
 * reader thought to refresh, which reads as the sync having done nothing.
 *
 * `BroadcastChannel` rather than a storage event because the write is to
 * IndexedDB, which fires nothing, and because this needs to say WHAT changed
 * rather than merely that something did.
 */
export const LIBRARY_CHANNEL = 'aeia.library';

export type LibraryNews =
  | { type: 'imported'; count: number }
  | { type: 'pulled'; storyId: string };

/** Say that the library changed. Silent where BroadcastChannel is missing. */
export const announceLibrary = (news: LibraryNews): void => {
  try {
    const channel = new BroadcastChannel(LIBRARY_CHANNEL);
    channel.postMessage(news);
    channel.close();
  } catch { /* an old browser, or a context without it; the reader can refresh */ }
};

/** Listen for another tab changing the library. Returns an unsubscribe. */
export const onLibraryNews = (fn: (news: LibraryNews) => void): (() => void) => {
  try {
    const channel = new BroadcastChannel(LIBRARY_CHANNEL);
    const handler = (e: MessageEvent) => {
      const news = e.data as LibraryNews | null;
      if (news && (news.type === 'imported' || news.type === 'pulled')) fn(news);
    };
    channel.addEventListener('message', handler);
    return () => { channel.removeEventListener('message', handler); channel.close(); };
  } catch {
    return () => {};
  }
};

/* ------------------------------------------------------------------ */
/* The partitioned-storage trap                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether this frame's library is the same library the reader opens in a tab.
 *
 * ── The trap ───────────────────────────────────────────────────────────────
 *
 * The whole point of embedding Aeia in SillyTavern is that the frame is Aeia's
 * real origin, so what it shows is the reader's actual library rather than a
 * copy. That holds — but only while the browser agrees that the frame is not a
 * third party.
 *
 * Browsers partition storage by the TOP-LEVEL SITE. A frame whose site differs
 * from the page holding it gets its own private box: its own IndexedDB, its own
 * localStorage, its own BroadcastChannel. Everything works perfectly inside the
 * box and nothing in it is ever visible anywhere else.
 *
 * `localhost` and `127.0.0.1` are the SAME MACHINE and DIFFERENT SITES. Ports
 * are not part of a site, so SillyTavern on `localhost:8000` framing Aeia on
 * `localhost:3000` is first-party and shares storage — but SillyTavern on
 * `127.0.0.1:8000` (which is what the launcher opens) framing Aeia on
 * `localhost:3000` is cross-site, and every chat imported in that frame lands
 * in a library the reader can never open.
 *
 * Nothing on either side can detect a partition directly — the API is
 * deliberately silent about it. The hosts, however, say it plainly, and they
 * are the only thing that ever causes it here.
 */
export interface StorageSplit {
  /** Where this frame's library lives. */
  here: string;
  /** The page holding the frame. */
  there: string;
  /** Same address, at SillyTavern's host — where both agree. */
  suggested: string;
}

/** Loopback under any of its names, which is the only case that arises here. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * `null` when the frame and its host page are the same site — the good case.
 *
 * Only host names are compared. A different PORT is not a different site and
 * must never be reported as one, or the reader is sent chasing a problem they
 * do not have.
 */
export const storageSplit = (frameHref: string, hostOrigin: string | null): StorageSplit | null => {
  if (!hostOrigin) return null;
  let here: URL, there: URL;
  try {
    here = new URL(frameHref);
    there = new URL(hostOrigin);
  } catch {
    return null;
  }
  if (here.hostname === there.hostname) return null;
  const suggested = new URL(here.toString());
  suggested.hostname = there.hostname;
  suggested.hash = '';
  return {
    here: here.origin,
    there: there.origin,
    suggested: suggested.origin,
  };
};

/** True when both addresses are the same machine under different names. */
export const bothLoopback = (a: string, b: string): boolean => {
  try {
    return LOOPBACK.has(new URL(a).hostname) && LOOPBACK.has(new URL(b).hostname);
  } catch {
    return false;
  }
};
