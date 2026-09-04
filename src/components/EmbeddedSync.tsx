/**
 * Aeia, running inside SillyTavern's own dialog, showing only the sync.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * The bridge was built around SillyTavern popping Aeia into a tab and the two
 * windows talking. That cannot work: SillyTavern serves itself through
 * `helmet()`, whose default `Cross-Origin-Opener-Policy` is `same-origin`, and
 * that policy puts any cross-origin window it opens into a separate browsing
 * context group — severing `window.opener` and disowning SillyTavern's own
 * handle to the tab it just opened. Both directions, nothing left to talk over.
 *
 * COOP does not apply to FRAMES. So the extension embeds Aeia instead, and the
 * whole protocol survives untouched — same handshake, same nonce, same
 * messages, `window.parent` in place of `window.opener`. The alternative was
 * asking every single person who wants the sync to edit their SillyTavern's
 * server source, which is not an install step anyone should ship.
 *
 * ── Why the reader's real library is here, and when it is not ──────────────
 *
 * The frame is the SAME ORIGIN as the reader's own Aeia tab, so it shares the
 * IndexedDB the library lives in. This is not a copy of their stories or a
 * fresh instance to be imported into — it is their library, seen through a
 * smaller window. That is the property that makes syncing from inside
 * SillyTavern mean anything.
 *
 * It is also conditional, which cost a day to find out. Browsers partition
 * storage by TOP-LEVEL SITE, and a frame whose site differs from the page
 * holding it is a third party with its own private box — its own IndexedDB, its
 * own BroadcastChannel. Everything below still works in that box, and nothing
 * in it is ever visible to the reader. `localhost` and `127.0.0.1` are the same
 * machine and different sites, so SillyTavern opened at one while Aeia is
 * addressed at the other splits the library in two with no error anywhere.
 *
 * The extension now moves its Aeia address onto SillyTavern's own host so this
 * cannot happen by default, and `storageSplit` catches what is left. Nothing
 * can detect a partition directly — no API says — so this is checked the only
 * way it can be: by the addresses.
 *
 * ── What it deliberately does not render ───────────────────────────────────
 *
 * Everything else. No reader, no codex, no pin dock, no scene director, no
 * ambient audio — a 400px panel inside somebody else's app is not the place
 * for a reading experience, and mounting the whole app to show one dialog
 * would start the streamer, the extractor and the reading clock inside a frame
 * nobody is reading in.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { SyncPanel } from './SyncPanel';
import { bridgeOrigin, useStBridge } from '../hooks/useStBridge';
import { bothLoopback, storageSplit } from '../utils/stBridge';
import { useAppStore } from '../store';

export const EmbeddedSync = () => {
  const bridge = useStBridge();
  const library = useAppStore(s => s.library);
  const libraryLoaded = useAppStore(s => s.libraryLoaded);
  const initLibrary = useAppStore(s => s.initLibrary);
  const openStory = useAppStore(s => s.openStory);
  const currentId = useAppStore(s => s.currentStory?.id);
  const [tried, setTried] = useState('');

  /**
   * Is this frame looking at the reader's real library, or a private copy?
   *
   * The one thing that can quietly falsify the premise of the whole panel. See
   * `storageSplit` — a frame whose SITE differs from the page holding it is
   * given its own storage, so every import here succeeds, reports success, and
   * lands somewhere the reader cannot open. It is invisible from the inside:
   * the library reads empty-but-working, exactly as a new install would.
   */
  const split = useMemo(
    () => storageSplit(typeof window === 'undefined' ? '' : window.location.href, bridgeOrigin()),
    [],
  );
  const sameMachine = !!split && bothLoopback(split.here, split.there);

  // Nothing else mounts the library in this frame, and the sync needs it to
  // know which chats are already here.
  useEffect(() => { if (!libraryLoaded) void initLibrary(); }, [libraryLoaded, initLibrary]);

  /**
   * Open the story this chat belongs to — but only when it is certainly that one.
   *
   * ── Why this is strict ─────────────────────────────────────────────────
   *
   * It used to fall back to matching the CHARACTER's name, and that was
   * actively dangerous. A reader with five chats with Carys has five stories in
   * their library, and — because the importer names a SillyTavern story after
   * its character — all five are called "Carys". Matching on the name picked
   * whichever came first, so a sync of one conversation opened a different one
   * and offered to write it over the top. The mismatch guard in the panel
   * caught it, which is the only reason it was a warning and not a loss.
   *
   * So: the chat id, recorded the last time this pair was synced, or nothing.
   * A guess is worse than a question here — an unmatched chat falls through to
   * "not in your library yet", which is both true and safe.
   */
  useEffect(() => {
    const chatId = bridge?.chat.chatId;
    if (!chatId || !libraryLoaded || tried === chatId) return;
    setTried(chatId);
    if (currentId) return;
    const want = chatId.trim().toLowerCase();
    const found = library.find(m => m.stChatId?.trim().toLowerCase() === want)
      // A story imported from this exact chat file before the bridge existed —
      // an exact whole-title match on the chat's own name, never a character.
      ?? library.find(m => m.title.trim().toLowerCase() === want);
    if (found) void openStory(found.id);
  }, [bridge?.chat.chatId, libraryLoaded, library, currentId, openStory, tried]);

  if (!bridge) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-center bg-app-bg text-app-text">
        <p className="text-sm text-muted max-w-xs leading-relaxed">
          Waiting for SillyTavern…
          <br />
          <span className="text-[11px]">
            If this does not change, the Aeia address in the extension may be pointing somewhere else.
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-app-bg text-app-text">
      {split && (
        <div className="m-3 p-3 rounded-lg bg-red-500/10 border border-red-500/40 text-sm">
          <p className="flex gap-2 text-red-300">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              <strong className="font-medium">This frame has a library of its own.</strong>{' '}
              SillyTavern is at <code>{split.there}</code> and Aeia at <code>{split.here}</code>.
              {' '}
              {sameMachine
                ? 'That is the same machine under two names, and your browser counts them as two different sites'
                : 'Your browser counts those as two different sites'}
              {' '}— so it gives this frame a private box of storage, and nothing brought in here will
              ever appear in the Aeia you read.
            </span>
          </p>
          <a
            href={split.suggested}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       bg-accent text-white font-medium"
          >
            <ExternalLink size={12} /> Read Aeia at {split.suggested}
          </a>
          <p className="mt-1.5 text-[11px] text-app-muted">
            Open your library there and this frame is the same library again. The other address keeps
            whatever is already in it — nothing is lost, it is just a second shelf.
          </p>
        </div>
      )}
      {/*
        * Which library this is, said out loud.
        *
        * A frame cannot know where the reader keeps their tab open, so it
        * cannot warn about every way the two can be different addresses. What
        * it can do is name its own, with a count beside it — which is enough
        * for anyone to see at a glance that the shelf in here is not the shelf
        * out there, without knowing anything about site partitioning.
        */}
      <p className="px-4 pt-3 text-[11px] text-app-muted">
        Library at <code>{window.location.origin}</code> ·{' '}
        {libraryLoaded ? `${library.length} ${library.length === 1 ? 'story' : 'stories'}` : 'loading…'}
      </p>
      <SyncPanel
        // There is no "close" inside a frame — closing is the host's dialog,
        // and a button that did nothing would be worse than no button.
        onClose={() => { /* the dialog owns dismissal */ }}
        embedded
        bridge={{
          chatId: bridge.chat.chatId,
          file: bridge.chat.file,
          inbox: bridge.inbox,
          send: bridge.send,
        }}
      />
    </div>
  );
};
