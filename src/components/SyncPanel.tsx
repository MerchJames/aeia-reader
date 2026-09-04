/**
 * Two-way sync with SillyTavern, with the reader in the middle of it.
 *
 * The engine underneath (`stSync`, `stApply`) is decided and tested. This is the
 * part that makes it safe to point at a real chat: nothing moves in either
 * direction until the reader has seen what would move and pressed the button
 * for that direction.
 *
 * ── The shape of the screen, and why ───────────────────────────────────────
 *
 * A sync is not one action, it is two that happen to share an alignment, and
 * conflating them is how sync features eat people's work. So there are two
 * buttons, always, and they are never the same button:
 *
 *   **Bring in** is everything ST has that we do not — new messages, and edits
 *   made over there. It writes here and touches nothing in SillyTavern.
 *
 *   **Send back** is our Lens edits going the other way. It writes a merged
 *   `.jsonl` for the reader to put in place, or hands the edits to the
 *   extension if one opened us.
 *
 * Conflicts — both sides changed the same message — are the only thing that
 * blocks either button, and only the send half. They are shown with both
 * versions side by side and resolved one at a time. There is no "take all
 * mine": a conflict is by definition a case where the machine does not know,
 * and offering to resolve fifty of them in one click is offering to not read
 * them.
 *
 * ── The backup ─────────────────────────────────────────────────────────────
 *
 * Sending back means the reader replaces a file in SillyTavern's `chats`
 * folder. If anything in this is wrong, that is the file it is wrong about, so
 * the backup is offered FIRST and the merged file is not downloadable until it
 * has been taken. It is one extra click and it is the difference between a bad
 * sync being an annoyance and a bad sync being a loss.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, Download,
  FileJson, Link2, RefreshCw, Shield, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { describePull, planPull, type PullPlan } from '../utils/stApply';
import { announceLibrary, syncedStoryTitle } from '../utils/stBridge';
import {
  alignSync, looksLikeSameChat, mergeToFile, parseStFile, pushEdits, summarize,
  type OurMessage, type StLine, type SyncRow, type SyncStatus,
} from '../utils/stSync';
import { describeApplied, pushProblem, type BridgeSkip } from '../utils/stBridge';
import { cn } from '../utils/cn';

/** Rows that are nothing but agreement are hidden until asked for. */
const QUIET: readonly SyncStatus[] = ['same', 'pushed'];

const STATUS_LABEL: Record<SyncStatus, string> = {
  same: 'Unchanged',
  ours: 'Your edit → SillyTavern',
  theirs: 'Changed in SillyTavern',
  conflict: 'Both changed',
  pushed: 'Already synced',
  'added-there': 'New in SillyTavern',
  'missing-there': 'Not in SillyTavern any more',
};

const STATUS_TONE: Record<SyncStatus, string> = {
  same: 'text-app-muted',
  ours: 'text-sky-400',
  theirs: 'text-emerald-400',
  conflict: 'text-amber-400',
  pushed: 'text-app-muted',
  'added-there': 'text-emerald-400',
  'missing-there': 'text-app-muted',
};

export interface SyncPanelProps {
  onClose: () => void;
  /**
   * Rendered inside SillyTavern's own dialog rather than over the reader.
   *
   * Drops the modal scrim and the close button: the host supplies both, and a
   * dark overlay inside a 420px frame is just a dark frame.
   */
  embedded?: boolean;
  /**
   * The desktop build's listening address, for the reader to copy into
   * SillyTavern.
   *
   * Separate from `bridge` because it exists BEFORE any chat has arrived —
   * it is the thing you need in order to make one arrive. In the browser build
   * there is no address and this is absent.
   */
  desktop?: { address: string | null; token: string; error: string | null };
  /**
   * Set when a SillyTavern extension opened this window: the chat arrives over
   * the bridge instead of being dropped, and edits can go straight back.
   */
  bridge?: {
    chatId: string;
    file: string;
    /**
     * Every chat SillyTavern has sent this session.
     *
     * A whole-library sync is many ordinary `chat` messages, so this is usually
     * one entry and occasionally two hundred. The panel's own alignment always
     * works on the chat named above; this is only what the library import
     * offers to bring in.
     */
    inbox?: { chatId: string; character: string; user: string; file: string }[];
    /** Send the edits to SillyTavern. Resolves with what it actually did. */
    send: (edits: ReturnType<typeof pushEdits>['edits'], label: string)
      => Promise<{ applied: number; skipped: BridgeSkip[] }>;
  };
}

const trim = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * A chat from the bridge, as a file the importer can take.
 *
 * The library import goes through `importFiles` rather than a private path of
 * its own, so a chat that arrives over the bridge gets everything a dropped
 * file gets: the same parser, the same duplicate detection, the branch-export
 * pairing, the card attachment. A second import path would be a second set of
 * those behaviours to keep in step, and the first thing to drift would be the
 * duplicate check — which is the one that stops a library sync run twice from
 * doubling the library.
 */
const asFile = (chat: { chatId: string; file: string }): File =>
  new File([chat.file], `${chat.chatId || 'chat'}.jsonl`, { type: 'application/jsonl' });

/**
 * One fact and a way to copy it.
 *
 * The token is masked until asked for. Not because a shoulder-surfer is a real
 * threat to a loopback mailbox, but because a reader recording their screen
 * should not have to think about whether this line matters.
 */
const CopyRow = ({ label, value, secret }: { label: string; value: string; secret?: boolean }) => {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-app-muted">{label}</span>
      <code className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-app-surface border border-app-border">
        {shown ? value : '•'.repeat(Math.min(24, value.length))}
      </code>
      {secret && (
        <button onClick={() => setShown(v => !v)}
          className="text-app-muted hover:text-app-text px-1">{shown ? 'hide' : 'show'}</button>
      )}
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); },
            () => { /* a clipboard the OS said no to; the text is on screen */ },
          );
        }}
        className="px-2 py-1 rounded border border-app-border hover:bg-app-bg text-app-text"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
};

export const SyncPanel = ({ onClose, bridge, desktop, embedded }: SyncPanelProps) => {
  const story = useAppStore(s => s.currentStory);
  const applyStPull = useAppStore(s => s.applyStPull);
  const markStSynced = useAppStore(s => s.markStSynced);
  const overrides = useAuraV2Store(s => (story ? s.overridesByStory[story.id] : undefined));
  const removeOverride = useAuraV2Store(s => s.removeOverride);

  const [lines, setLines] = useState<StLine[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [mismatch, setMismatch] = useState(false);
  const [showQuiet, setShowQuiet] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const library = useAppStore(st => st.library);
  const importFiles = useAppStore(st => st.importFiles);
  const markStSyncedById = useAppStore(st => st.markStSynced);
  const renameStory = useAppStore(st => st.renameStory);

  /**
   * Chats SillyTavern has sent that this library has never seen.
   *
   * Matched on the chat id we recorded when a story was last synced, and on
   * title as a fallback for a story imported from a file before the bridge
   * existed. Getting this wrong in the generous direction is the safe one:
   * `importFiles` does its own duplicate detection, so a chat offered twice is
   * refused there rather than landing twice.
   */
  const newChats = useMemo(() => {
    const known = new Set<string>();
    for (const m of library) {
      if (m.stChatId) known.add(m.stChatId.toLowerCase());
      known.add(m.title.trim().toLowerCase());
    }
    return (bridge?.inbox ?? []).filter(c => !known.has(c.chatId.trim().toLowerCase()));
  }, [library, bridge?.inbox]);

  const importAll = async () => {
    if (!newChats.length) return;
    setImporting(true);
    try {
      const result = await importFiles(newChats.map(asFile));

      /*
       * Name and mark what just arrived — matched by FILE, not by title or
       * position.
       *
       * Title cannot tell these apart. The importer names a SillyTavern story
       * after its character, so five chats with Carys all import as "Carys";
       * matching on that picked an arbitrary one, which is how a sync came to
       * open a different conversation and offer to write over it.
       *
       * Position cannot tell them apart either, and that is less obvious: hand
       * over three chats and you may get back two stories, because a chat that
       * is already part of one is absorbed and branch files of the same chat
       * collapse together. Pairing the n-th story with the n-th chat then names
       * a story after a different conversation — the exact fault being fixed,
       * arrived at from the other side. So the importer says which file made
       * which story, and that is what is used.
       */
      const byFile = new Map(newChats.map(c => [`${c.chatId || 'chat'}.jsonl`, c]));
      const metaById = (id: string) => useAppStore.getState().library.find(m => m.id === id);
      for (const made of result.created) {
        const chat = byFile.get(made.file);
        const meta = metaById(made.storyId);
        if (!chat || !meta) continue;
        const name = syncedStoryTitle(chat.character || meta.characterName || '', chat.chatId);
        if (name && name !== meta.title) await renameStory(meta.id, name);
        await markStSyncedById(meta.id, chat.chatId);
      }
      /*
       * Chats that joined a story instead of becoming one.
       *
       * The importer refuses to make a second story out of a chat that is
       * already part of one — an earlier checkpoint is absorbed, a divergent
       * branch is attached as a timeline. That is right, and it used to be
       * invisible: nothing was created, so nothing was named or stamped, the
       * panel said "Brought in 1 chat" and the reader went looking in a library
       * that had not changed. Now the story that swallowed it is stamped with
       * this chat id, which is also what makes the NEXT sync of it align
       * against that story instead of offering the same import again.
       */
      for (const join of result.attached) {
        const chat = byFile.get(join.file);
        // Never over the top of a link that already exists: one story can hold
        // one chat id, and the trunk's own is worth more than a branch's.
        if (chat && !metaById(join.storyId)?.stChatId) {
          await markStSyncedById(join.storyId, chat.chatId);
        }
      }

      // A chat Aeia had never seen is the case this whole banner exists for, and
      // stopping at "imported" would leave the reader on a panel still telling
      // them to open a story. Land them in the one it belongs to — the story it
      // just became, or the one it turned out to be part of.
      if (!story) {
        const landed = useAppStore.getState().library
          .find(m => m.stChatId === newChats[0].chatId)
          ?? (result.attached[0]
            ? useAppStore.getState().library.find(m => m.id === result.attached[0].storyId)
            : undefined);
        if (landed) await useAppStore.getState().openStory(landed.id);
      }
      // The reader's own Aeia tab has its library in memory and no reason to
      // look again; without this the chats land and stay invisible.
      if (result.imported || result.attached.length) {
        announceLibrary({ type: 'imported', count: result.imported });
      }
      // What actually happened, not what was asked for. A count of what was
      // handed over would report a success for every chat the importer
      // deliberately declined to duplicate.
      setNote([
        result.imported
          ? `Brought in ${result.imported} chat${result.imported === 1 ? '' : 's'}.`
          : '',
        ...result.notes,
        ...result.errors,
      ].filter(Boolean).join(' ') || 'Nothing new — these chats are already in your library.');
    } catch (e: any) {
      setNote(`Import failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setImporting(false);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Our side of the comparison.
   *
   * `current` goes through `resolveContent` with the Lens forced ON, whatever
   * the reader's toggle says. The Lens switch is about what they are reading
   * right now; the edits exist either way, and a sync run with it off would
   * quietly decline to push every rewrite they have made.
   */
  const ourMessages: OurMessage[] = useMemo(() => (
    (story?.messages ?? []).map(m => ({
      id: m.id,
      original: m.content,
      current: resolveContent(m, overrides, true),
      name: m.name,
    }))
  ), [story?.messages, overrides]);

  const load = useCallback((text: string, name: string) => {
    setLines(parseStFile(text));
    setFileName(name);
    setBackedUp(false);
    setNote('');
  }, []);

  /**
   * A chat handed over by the extension needs no dropping.
   *
   * Keyed on the chat id rather than the file so that re-opening the same chat
   * does not throw away conflict resolutions the reader is halfway through
   * making, while switching chats in SillyTavern does reload.
   */
  const bridgeKey = bridge?.chatId;
  useEffect(() => {
    if (bridge) load(bridge.file, bridge.chatId || 'SillyTavern');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeKey]);

  /**
   * Align the file against the story — and re-align when the story CHANGES.
   *
   * The alignment used to be computed once, inside `load`. From the reader's
   * side that was fine: a file is dropped onto a story that is already open. In
   * the frame it was wrong in the worst possible way, because there the chat
   * arrives BEFORE the story exists. Aligning 45 messages against a library
   * side of nothing yields forty-five "new in SillyTavern" rows and — since no
   * row has both halves — a verdict of "this is not the same chat". Then the
   * import lands, the story opens, and that stale reading is what the reader
   * sees: a red warning naming the story that was just created FROM this exact
   * file, over a summary claiming every message is new.
   *
   * So the alignment is derived from the two things it actually depends on. It
   * is keyed on the identity of the lines and of the story rather than on
   * `ourMessages`, because pulling changes the messages and re-running here
   * would discard the rows `doPull` just wrote — and it would do it in the one
   * moment when a stale-looking screen is most alarming.
   */
  const alignedRef = useRef<{ lines: StLine[] | null; storyId: string | null }>(
    { lines: null, storyId: null },
  );
  useEffect(() => {
    const storyId = story?.id ?? null;
    if (!lines) {
      alignedRef.current = { lines: null, storyId };
      setRows([]);
      setMismatch(false);
      return;
    }
    if (alignedRef.current.lines === lines && alignedRef.current.storyId === storyId) return;
    alignedRef.current = { lines, storyId };
    const next = alignSync(ourMessages, lines);
    setRows(next);
    // With no story there is nothing to be a mismatch WITH. Judging it against
    // an empty side always says "different chat", which is not a finding.
    setMismatch(!!story && !looksLikeSameChat(next));
  }, [lines, story, ourMessages]);

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    load(await file.text(), file.name);
  };

  const summary = useMemo(() => summarize(rows), [rows]);
  const push = useMemo(() => pushEdits(rows), [rows]);
  const plan: PullPlan | null = useMemo(() => (
    story ? planPull(rows, story.messages, () => `st-${Math.random().toString(36).slice(2, 10)}`, {
      characterName: story.characterName,
      userName: story.userName,
    }) : null
  ), [rows, story]);

  const resolve = (index: number, choice: 'ours' | 'theirs') => {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, resolution: choice } : r)));
  };

  const doPull = async () => {
    if (!plan || plan.empty || !story) return;
    setBusy(true);
    try {
      // Overrides first: `applyStPull` re-renders, and a message showing a
      // stale Lens rewrite for even one frame reads as the pull not working.
      for (const id of plan.clearOverrides) removeOverride(story.id, id);
      await applyStPull(plan.messages);
      // The link is recorded on a sync that actually moved something, not on
      // merely opening the panel — the library groups by "kept in step with a
      // chat", and a story you looked at once is not that.
      if (bridge?.chatId) void markStSynced(story.id, bridge.chatId);
      announceLibrary({ type: 'pulled', storyId: story.id });
      setNote(describePull(plan));
      // The story has moved; the alignment we are looking at describes a
      // version of it that no longer exists. Re-run it against what we have now
      // rather than leaving stale rows on screen inviting a second press.
      if (lines) setRows(alignSync(
        plan.messages.map(m => ({
          id: m.id, original: m.content, name: m.name,
          current: resolveContent(m, plan.clearOverrides.length ? undefined : overrides, true),
        })), lines,
      ));
    } finally {
      setBusy(false);
    }
  };

  const download = (name: string, text: string) => {
    const blob = new Blob([text], { type: 'application/jsonl;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const base = fileName.replace(/\.jsonl$/i, '') || 'chat';

  const doBackup = () => {
    if (!lines) return;
    // The bytes we were given, not a re-serialisation of them. A backup that
    // has been through our parser is not a backup of the original.
    download(`${base}.bak.jsonl`, lines.map(l => l.raw).join('\n') + '\n');
    setBackedUp(true);
  };

  const doMerge = () => {
    if (!lines) return;
    const merged = mergeToFile(lines, rows);
    download(`${base}.jsonl`, merged.text);
    setNote(`Wrote ${merged.patched} of your edit${merged.patched === 1 ? '' : 's'} into the file. `
      + 'Replace the chat in SillyTavern’s data/<user>/chats folder with it, then reload the chat there.');
  };

  const doSend = async () => {
    if (!bridge) return;
    const problem = pushProblem(push.edits);
    if (problem) { setNote(problem); return; }
    setBusy(true);
    try {
      const res = await bridge.send(push.edits, story?.title ?? 'Aeia');
      setNote(describeApplied(res.applied, res.skipped));
    } catch (e: any) {
      setNote(e?.message ?? 'SillyTavern did not answer.');
    } finally {
      setBusy(false);
    }
  };

  const blocked = summary.conflict > 0 && rows.some(r => r.status === 'conflict' && !r.resolution);
  const shown = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => showQuiet || !QUIET.includes(row.status));

  return (
    <div className={embedded
      ? 'min-h-dvh'
      : 'fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4'}>
      <div className={embedded
        ? 'w-full min-h-dvh flex flex-col bg-app-surface'
        : 'w-full max-w-3xl max-h-[88vh] flex flex-col rounded-xl border border-app-border bg-app-surface shadow-2xl'}>

        <header className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <RefreshCw size={16} className="text-app-muted" />
          <h2 className="font-medium text-app-text">Sync with SillyTavern</h2>
          {bridge && (
            <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full
                             bg-emerald-500/15 text-emerald-400">
              <Link2 size={11} /> connected
            </span>
          )}
          {!embedded && (
            <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-app-bg text-app-muted"
              aria-label="Close">
              <X size={16} />
            </button>
          )}
        </header>

        {/*
          * How SillyTavern reaches a desktop Aeia.
          *
          * Shown until a chat has actually come over, then it has done its job
          * and gets out of the way. It is two facts — an address and a token —
          * because that is genuinely all the extension needs, and burying them
          * in a settings page would mean the one screen that explains the
          * feature is not the screen you are on when you need it.
          */}
        {desktop && !bridge && (
          <div className="m-4 p-3 rounded-lg border border-app-border bg-app-bg/60 space-y-2">
            {desktop.error ? (
              <p className="text-sm text-amber-300 flex gap-2">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span>{desktop.error}</span>
              </p>
            ) : (
              <>
                <p className="text-sm text-app-text">
                  SillyTavern can reach Aeia at this address while this panel is open.
                </p>
                <div className="grid gap-1.5 text-xs">
                  <CopyRow label="Address" value={desktop.address ?? 'starting…'} />
                  <CopyRow label="Token" value={desktop.token} secret />
                </div>
                <p className="text-[11px] text-app-muted leading-relaxed">
                  In SillyTavern: Extensions → Aeia Bridge → put the address in <b>Aeia address</b>,
                  the token in <b>App token</b>, then press Sync. The listener is only open while
                  you are on this screen, so leave it open until the chat comes over.
                </p>
              </>
            )}
          </div>
        )}

        {/*
          * The library import, above everything else.
          *
          * It is the one thing here that does not need a story open — it is
          * about chats this library has never seen — so it sits above the
          * "open a story first" notice rather than under it. Shown only when
          * SillyTavern has actually sent more than the panel is working on.
          */}
        {newChats.length > 0 && (
          <div className="m-4 p-3 rounded-lg bg-accent/10 border border-accent/30 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-app-text">
                {newChats.length} chat{newChats.length === 1 ? '' : 's'} here {newChats.length === 1 ? 'is' : 'are'} not in your library yet.
              </p>
              <p className="text-[11px] text-app-muted truncate">
                {newChats.slice(0, 4).map(c => c.chatId).join(' · ')}
                {newChats.length > 4 ? ` · and ${newChats.length - 4} more` : ''}
              </p>
            </div>
            <button
              onClick={importAll}
              disabled={importing}
              data-testid="sync-import-all"
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium disabled:opacity-40"
            >
              {importing ? 'Bringing in…' : 'Bring them in'}
            </button>
          </div>
        )}

        {!story && !newChats.length && (
          <p className="p-6 text-sm text-app-muted">
            {bridge
              // Connected, a chat arrived, and it is already in the library —
              // so the only thing missing is having it open.
              ? 'Open the story this chat belongs to — a sync compares the two.'
              : 'Open a story first — a sync compares it against a chat file.'}
          </p>
        )}

        {story?.activeTimeline && (
          <p className="m-4 p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
            You’re reading a branch. Sync compares against the main thread, so switch back to it first.
          </p>
        )}

        {story && !story.activeTimeline && (
          <div className="flex-1 min-h-0 overflow-y-auto">

            {lines === null ? (
              <div
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}
                onClick={() => inputRef.current?.click()}
                className="m-4 p-8 rounded-lg border-2 border-dashed border-app-border
                           text-center cursor-pointer hover:border-app-accent/60"
              >
                <FileJson size={28} className="mx-auto mb-2 text-app-muted" />
                <p className="text-sm text-app-text">Drop this chat’s <code>.jsonl</code> here</p>
                <p className="mt-1 text-xs text-app-muted">
                  In SillyTavern it lives in <code>data/&lt;user&gt;/chats/&lt;character&gt;/</code>.
                  Nothing is written until you say so.
                </p>
                <input ref={inputRef} type="file" accept=".jsonl,.json" className="hidden"
                  onChange={e => void onFiles(e.target.files)} />
              </div>
            ) : (
              <>
                <div className="px-4 pt-3 flex items-center gap-2 text-xs text-app-muted">
                  <FileJson size={13} />
                  <span className="truncate">{fileName}</span>
                  {!bridge && (
                    <button onClick={() => setLines(null)}
                      className="ml-auto underline hover:text-app-text">use a different file</button>
                  )}
                </div>

                {mismatch && (
                  <p className="m-4 p-3 rounded-lg bg-red-500/10 text-red-300 text-sm flex gap-2">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                    <span>
                      This file doesn’t look like the same chat as “{story.title}” — almost none of
                      the opening messages match. Syncing it would offer to write a different
                      conversation over yours. Check the file before going on.
                    </span>
                  </p>
                )}

                <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  {([
                    ['New there', summary.addedThere],
                    ['Changed there', summary.theirs],
                    ['Your edits', summary.ours],
                    ['Both changed', summary.conflict],
                  ] as const).map(([label, n]) => (
                    <div key={label} className={cn('rounded-lg py-2 bg-app-bg',
                      n > 0 ? 'text-app-text' : 'text-app-muted')}>
                      <div className="text-lg leading-none">{n}</div>
                      <div className="text-[11px] mt-1">{label}</div>
                    </div>
                  ))}
                </div>

                {summary.clean && (
                  <p className="mx-4 mb-3 text-sm text-app-muted flex items-center gap-2">
                    <Check size={14} className="text-emerald-400" /> Both sides already agree.
                  </p>
                )}

                <ul className="px-4 pb-3 space-y-2">
                  {shown.map(({ row, index }) => (
                    <li key={index} className="rounded-lg border border-app-border p-2.5 text-sm">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</span>
                        <span className="text-app-muted">
                          {row.ours?.name || row.theirs?.name}
                        </span>
                      </div>

                      {row.status === 'conflict' ? (
                        <div className="mt-2 grid sm:grid-cols-2 gap-2">
                          {(['ours', 'theirs'] as const).map(side => (
                            <button
                              key={side}
                              onClick={() => resolve(index, side)}
                              className={cn(
                                'text-left p-2 rounded border text-xs leading-relaxed',
                                row.resolution === side
                                  ? 'border-app-accent bg-app-accent/10 text-app-text'
                                  : 'border-app-border text-app-muted hover:text-app-text',
                              )}
                            >
                              <div className="mb-1 font-medium flex items-center gap-1">
                                {row.resolution === side && <Check size={11} />}
                                {side === 'ours' ? 'Keep yours' : 'Take SillyTavern’s'}
                              </div>
                              {trim(side === 'ours' ? row.ours?.current ?? '' : row.theirs?.mes ?? '')}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-app-muted leading-relaxed">
                          {trim(row.status === 'added-there' || row.status === 'theirs'
                            ? row.theirs?.mes ?? ''
                            : row.ours?.current ?? '')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>

                {rows.length > shown.length && (
                  <button onClick={() => setShowQuiet(v => !v)}
                    className="mx-4 mb-3 text-xs text-app-muted underline hover:text-app-text">
                    {showQuiet ? 'Hide' : 'Show'} {rows.length - shown.length} unchanged
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {lines !== null && story && !story.activeTimeline && (
          <footer className="border-t border-app-border p-3 space-y-3">
            {note && <p className="text-xs text-app-muted leading-relaxed">{note}</p>}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void doPull()}
                disabled={busy || !plan || plan.empty}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                           bg-app-accent text-white disabled:opacity-40"
              >
                <ArrowDownToLine size={14} />
                Bring in{plan && !plan.empty ? ` ${plan.added + plan.updated}` : ''}
              </button>

              {bridge ? (
                <button
                  onClick={() => void doSend()}
                  disabled={busy || blocked || !push.edits.length}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                             border border-app-border text-app-text disabled:opacity-40"
                >
                  <ArrowUpFromLine size={14} /> Send {push.edits.length} back
                </button>
              ) : (
                <>
                  <button
                    onClick={doBackup}
                    disabled={busy}
                    className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border',
                      backedUp
                        ? 'border-emerald-500/40 text-emerald-400'
                        : 'border-app-border text-app-text')}
                  >
                    {backedUp ? <Check size={14} /> : <Shield size={14} />} Back up the original
                  </button>
                  <button
                    onClick={doMerge}
                    disabled={busy || blocked || !backedUp || !push.edits.length}
                    title={!backedUp ? 'Take the backup first' : undefined}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                               border border-app-border text-app-text disabled:opacity-40"
                  >
                    <Download size={14} /> Merged file with your {push.edits.length} edit
                    {push.edits.length === 1 ? '' : 's'}
                  </button>
                </>
              )}
            </div>

            {blocked && (
              <p className="text-xs text-amber-400">
                Choose a version for each “both changed” message before sending anything back.
              </p>
            )}
            {plan && plan.keptMissing > 0 && (
              <p className="text-xs text-app-muted">
                {plan.keptMissing} message{plan.keptMissing === 1 ? '' : 's'} here
                {plan.keptMissing === 1 ? ' is' : ' are'} no longer in SillyTavern.
                Keeping {plan.keptMissing === 1 ? 'it' : 'them'} — a sync never deletes.
              </p>
            )}
          </footer>
        )}
      </div>
    </div>
  );
};
