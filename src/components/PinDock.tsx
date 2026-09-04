import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, Lock, LockOpen, Move,
  ArrowLeft, ArrowRight, BookOpen, PanelRightClose, PanelRightOpen, Pencil, Pin as PinIcon,
  Plus, Trash2, Wand2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { Pin } from '../types';
import { activePageIndex, isBook, pageLabel, pagesOf } from '../utils/pinBook';
import { cn } from '../utils/cn';
import { askText } from '../utils/aiCall';
import { samplerParamsFrom } from '../utils/aiClient';
import { resolveContent } from '../utils/lens';
import { buildPinUpdateMessages, PinUpdateMode } from '../utils/pinUpdate';

/**
 * Assemble the recent story text feeding a 'source'-mode pin update: the pin's
 * source message plus the few before it, resolved through any Lens edits, so a
 * summary can be rebuilt with "what's happened since". Runs off the live stores
 * on demand (not per render).
 */
/**
 * The stacking band the whole dock lives in — cards, column and toggle.
 *
 * Everything here sits BELOW every panel and modal in the app (the lowest of
 * those is 50), because the dock is furniture at the edge of the reading
 * surface and a panel is a thing the reader just opened and is looking at. It
 * used to be the other way round in places — the toggle at 50 and a floating
 * pin at 60 — so opening the Codex or a centred modal left the pin controls
 * sitting on top of it, which is the one arrangement neither of them wants.
 *
 * A number rather than a Tailwind class so the four values here are visibly one
 * band; splitting them across `z-40`/`z-50` literals is how they drifted apart.
 */
const DOCK_Z = 40;

/**
 * Room for a rewritten pin, in tokens.
 *
 * A rewrite is usually about as long as what it rewrites, so the pin's own
 * length is the only honest estimate available. Floored well above the 1024 a
 * local backend tends to default to — the case this exists for — and capped so
 * a 150k-character pin does not ask for a budget no endpoint will honour.
 */
const pinRewriteBudget = (content: string): number =>
  Math.min(16000, Math.max(2048, Math.ceil(content.length / 3) + 512));

const collectPinSource = (pin: Pin): string => {
  const app = useAppStore.getState();
  const storyId = app.currentStory?.id;
  if (!storyId) return '';
  const v2 = useAuraV2Store.getState();
  const overrides = v2.overridesByStory[storyId];
  const lensOn = !!v2.lensOnByStory[storyId];
  const flat = app.chains.flatMap(c => c.messages);
  const through = pin.messageId ? flat.findIndex(m => m.id === pin.messageId) : flat.length - 1;
  const end = through === -1 ? flat.length : through + 1;
  const window = flat.slice(Math.max(0, end - 8), end);
  return window
    .map(m => `${m.name}: ${resolveContent(m, overrides, lensOn)}`)
    .join('\n\n');
};

/**
 * AI-written HTML renders in a fully sandboxed iframe: no scripts, no
 * origin access — CSS/SVG charts and tables display, anything active
 * is inert. Theme colors are injected so the visual sits in the page.
 */
const HtmlPin = ({ pin }: { pin: Pin }) => {
  // Recompute whenever the theme (or a custom color) changes so the pin's
  // text/background track the reader instead of freezing at capture time.
  const themeKey = useAppStore(s => `${s.theme}|${s.textColor}|${s.bgColor}|${s.accentColor}`);
  const [doc, setDoc] = useState('');

  useEffect(() => {
    // Read the CSS vars a frame later: theme changes are applied in an
    // effect on <html>, so we wait for the browser to settle them in.
    const raf = requestAnimationFrame(() => {
      const root = getComputedStyle(document.documentElement);
      const bg = root.getPropertyValue('--app-bg').trim() || '#0f172a';
      const surface = root.getPropertyValue('--app-surface').trim() || '#1e293b';
      const text = root.getPropertyValue('--app-text').trim() || '#d1d5db';
      const border = root.getPropertyValue('--app-border').trim() || '#3f3f46';
      const accent = root.getPropertyValue('--app-accent').trim() || '#8b5cf6';
      setDoc(`<!doctype html><html><head><style>
        html,body{margin:0;padding:6px;background:${surface};color:${text};font:12px/1.5 system-ui,sans-serif}
        *{box-sizing:border-box;max-width:100%}
        table{border-collapse:collapse;width:100%;background:${bg}}
        th,td{border:1px solid ${border};padding:3px 6px;text-align:left}
        a{color:${accent}}
        img,svg{max-width:100%;height:auto}
      </style></head><body>${pin.content}</body></html>`);
    });
    return () => cancelAnimationFrame(raf);
  }, [pin.content, themeKey]);

  return (
    <iframe
      sandbox=""
      srcDoc={doc}
      title={pin.title}
      className="w-full rounded-md bg-surface"
      style={{ height: 220, border: 'none' }}
    />
  );
};

const PinCard = ({
  pin,
  storyId,
  hidden,
}: {
  pin: Pin;
  storyId: string;
  hidden?: boolean;
}) => {
  const updatePin = useAuraV2Store(s => s.updatePin);
  const addPinVersion = useAuraV2Store(s => s.addPinVersion);
  const setPinActiveVersion = useAuraV2Store(s => s.setPinActiveVersion);
  // AI is available for pin updates only once an endpoint + model are set.
  const aiReady = useAppStore(s => !!s.aiBaseUrl && !!s.aiModel);
  const cardRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // AI update composer state.
  const [composerOpen, setComposerOpen] = useState(false);
  const [mode, setMode] = useState<PinUpdateMode>(pin.messageId ? 'source' : 'revise');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versions = pin.versions;
  const activeVersion = pin.activeVersion ?? (versions ? versions.length - 1 : 0);
  const pages = pagesOf(pin);
  const pageIndex = activePageIndex(pin);
  const addPinPage = useAuraV2Store(s => s.addPinPage);
  const updatePinPage = useAuraV2Store(s => s.updatePinPage);
  const setPinActivePage = useAuraV2Store(s => s.setPinActivePage);
  const removePinPage = useAuraV2Store(s => s.removePinPage);
  const movePinPage = useAuraV2Store(s => s.movePinPage);
  const editPinPage = useAuraV2Store(s => s.editPinPage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const startEdit = () => { setDraft(pin.content); setEditing(true); };
  const commitDraft = () => {
    editPinPage(storyId, pin.id, draft);
    setEditing(false);
  };

  const runUpdate = async () => {
    const app = useAppStore.getState();
    const base = app.aiBaseUrl;
    const key = app.aiApiKey;
    const model = app.aiModel;
    if (!base || !model || busy) return;
    setBusy(true);
    setError(null);
    try {
      const messages = buildPinUpdateMessages({
        format: pin.format,
        mode,
        instruction,
        currentContent: pin.content,
        sourceText: mode === 'source' ? collectPinSource(pin) : undefined,
        card: app.currentStory?.card,
      });
      /*
       * Room to answer, and the reader's own ceiling.
       *
       * This call named neither, so no `max_tokens` was sent and whatever the
       * endpoint defaults to applied — which on most local backends is 512 or
       * 1024, and a pin is a DOCUMENT. A four-thousand-word chart came back cut
       * off at a thousand tokens with nothing to say why. The rewrite of a pin
       * is at least as long as the pin, so the budget is sized from it; the
       * reader's Advanced setting is merged last and still wins if they set one.
       */
      const reply = await askText({ base, key, model }, messages, {
        label: 'Reworking a pin',
        params: { temperature: 0.4 },
        reader: samplerParamsFrom(app.aiAdvanced),
        budget: pinRewriteBudget(pin.content),
      });
      if (!reply) { setError('Empty reply'); return; }
      addPinVersion(storyId, pin.id, {
        content: reply,
        source: 'ai',
        instruction: instruction.trim() || undefined,
      });
      setInstruction('');
      setComposerOpen(false);
    } catch (e: any) {
      setError(e?.message ?? 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const locked = pin.locked ?? true;
  // A pin "floats" once it has an absolute position — locking then freezes
  // it in place rather than snapping it back to the dock column.
  const floating = pin.x != null && pin.y != null;

  const startDrag = (e: React.MouseEvent) => {
    if (locked || !cardRef.current) return;
    draggingRef.current = true;
    setDragging(true);
    const rect = cardRef.current.getBoundingClientRect();
    offsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // Live-position via local state only — committing to the persisted
      // store on every frame would re-serialize every pin (up to 150k chars
      // each) and stutter the whole app. We write to the store once, on drop.
      const next = { x: e.clientX - offsetRef.current.x, y: e.clientY - offsetRef.current.y };
      posRef.current = next;
      setDragPos(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      if (posRef.current) updatePin(storyId, pin.id, posRef.current);
      setDragPos(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [storyId, pin.id, updatePin]);

  const toggleLock = () => {
    if (locked) {
      // Unlocking pops the pin out of the dock column into a free-floating
      // card, seeded at its current on-screen spot so it doesn't jump.
      const patch: Partial<Pin> = { locked: false };
      if (pin.x == null && cardRef.current) {
        const r = cardRef.current.getBoundingClientRect();
        patch.x = r.left;
        patch.y = r.top;
      }
      updatePin(storyId, pin.id, patch);
    } else {
      // Locking keeps x/y untouched → the card stays exactly where it is.
      updatePin(storyId, pin.id, { locked: true });
    }
  };

  const live = dragPos ?? (floating ? { x: pin.x!, y: pin.y! } : null);
  const style: React.CSSProperties = live
    ? {
        position: 'fixed', left: live.x, top: live.y, width: 320, maxWidth: '85vw',
        // Inside the dock's own band (see DOCK_Z): a dragged card rises above
        // its neighbours and a floating one above a docked one, but none of
        // them above a panel. A floating pin used to sit at 60, which put it
        // over the Codex, the Sheets rail and every centred modal.
        zIndex: dragging ? DOCK_Z + 3 : locked ? DOCK_Z + 1 : DOCK_Z + 2,
      }
    : { position: 'relative' };

  return (
    <div
      ref={cardRef}
      style={style}
      hidden={hidden}
      className={cn(
        'rounded-xl border border-app-border bg-surface/95 shadow-lg overflow-hidden',
        !locked && 'cursor-move',
        dragging && 'ring-2 ring-accent/50 shadow-2xl',
      )}
    >
      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b border-app-border/60 select-none text-app-text"
        onMouseDown={startDrag}
      >
        {!locked && <Move size={10} className="opacity-40 shrink-0" />}
        <PinIcon size={11} className="text-accent shrink-0" />
        <span className="text-[11px] font-bold truncate flex-1" title={pin.title}>{pin.title}</span>
        <button
          onClick={() => updatePin(storyId, pin.id, { inContext: !pin.inContext })}
          title={pin.inContext
            ? 'In AI context — the assistant can reference this. Click to exclude.'
            : 'Include in AI context'}
          className={cn(
            'p-1 rounded-md transition-colors text-app-text',
            pin.inContext ? 'text-accent bg-accent/15' : 'opacity-70 hover:opacity-100 hover:bg-app-text/10',
          )}
        >
          <Bot size={12} />
        </button>
        {/* The two ways to change a pin, side by side: by hand, or by asking.
          * They keep history differently on purpose — see `applyManualEdit`. */}
        <button
          onClick={() => (editing ? setEditing(false) : startEdit())}
          title="Edit this text by hand (your first edit keeps the original)"
          aria-pressed={editing}
          data-testid="pin-edit-page"
          className={cn(
            'p-1 rounded-md hover:bg-app-text/10 transition-colors',
            editing ? 'text-accent bg-accent/15' : 'text-app-text opacity-70 hover:opacity-100',
          )}
        >
          <Pencil size={12} />
        </button>
        {aiReady && (
          <button
            onClick={() => setComposerOpen(o => !o)}
            title="Update this pin with the AI (keeps every version)"
            className={cn(
              'p-1 rounded-md transition-colors text-app-text',
              composerOpen ? 'text-accent bg-accent/15' : 'opacity-70 hover:opacity-100 hover:bg-app-text/10',
            )}
          >
            <Wand2 size={12} />
          </button>
        )}
        <button
          onClick={toggleLock}
          title={locked ? 'Unlock to move' : 'Lock in place'}
          className="p-1 rounded-md text-app-text opacity-70 hover:opacity-100 hover:bg-app-text/10 transition-colors"
        >
          {locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
        <button
          onClick={() => updatePin(storyId, pin.id, { collapsed: !pin.collapsed })}
          title={pin.collapsed ? 'Expand' : 'Collapse'}
          className="p-1 rounded-md text-app-text opacity-70 hover:opacity-100 hover:bg-app-text/10 transition-colors"
        >
          {pin.collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
        <button
          onClick={() => addPinPage(storyId, pin.id, { content: '' })}
          title={isBook(pin)
            ? 'Add a page to this pin'
            : 'Add a page — turns this pin into a small book you can leaf through'}
          data-testid="pin-add-page"
          className="p-1 rounded-md text-app-text opacity-70 hover:opacity-100 hover:bg-app-text/10 transition-colors"
        >
          <Plus size={12} />
        </button>
        <button
          onClick={() => updatePin(storyId, pin.id, { docked: false })}
          title="Remove from dock (kept in the Sheets panel)"
          className="p-1 rounded-md text-app-text opacity-70 hover:opacity-100 hover:bg-app-text/10 transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      {!pin.collapsed && (
        <div className="max-h-80 overflow-y-auto p-2 bg-surface">
          {editing ? (
            /*
              * Writing straight into a page.
              *
              * A pin used to be something you CAPTURED — a chart the model
              * drew, a passage you kept — and the only way to change one was to
              * ask the assistant. Pages break that: "add a page" hands the
              * reader an empty one, and an empty page with no way to type into
              * it is a dead end. Saved as an ordinary page edit, not as a
              * version, because typing is not a redraft.
              */
            <div className="space-y-1.5">
              <textarea
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitDraft();
                }}
                rows={8}
                placeholder="Write this page…"
                className="w-full text-xs bg-app-text/[0.04] border border-accent/40 rounded-md px-2 py-1.5 outline-none resize-y font-mono leading-relaxed"
              />
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[10px] text-muted">⌘/Ctrl + Enter to save</span>
                <button
                  onClick={() => setEditing(false)}
                  className="text-[10px] px-2 py-0.5 rounded hover:bg-app-text/10 text-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={commitDraft}
                  className="text-[10px] px-2 py-0.5 rounded bg-accent text-white font-medium"
                  data-testid="pin-page-save"
                >
                  Save
                </button>
              </div>
            </div>
          ) : pin.format === 'html' ? (
            <HtmlPin pin={pin} />
          ) : pin.content.trim() ? (
            <div className="markdown-body text-xs overflow-x-auto text-app-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{pin.content}</ReactMarkdown>
            </div>
          ) : (
            <button
              onClick={startEdit}
              className="w-full py-4 text-[11px] text-muted italic hover:text-accent transition-colors"
            >
              This page is empty — click to write it.
            </button>
          )}
        </div>
      )}

      {/*
        * Page bar — only once a pin is actually a book.
        *
        * Above the version switcher and visually quieter than it, because the
        * two answer different questions and a reader must not confuse them:
        * this one is WHICH entry, the one below is which draft of it. A pin
        * that is a single note shows neither, which is nearly all of them.
        */}
      {!pin.collapsed && isBook(pin) && (
        <div className="flex items-center gap-1 px-2 py-1 border-t border-app-border/50 text-[10px] text-app-text/70">
          <BookOpen size={11} className="shrink-0 opacity-60" />
          <button
            onClick={() => setPinActivePage(storyId, pin.id, Math.max(0, pageIndex - 1))}
            disabled={pageIndex === 0}
            className="w-5 h-5 rounded-full hover:bg-app-text/10 flex items-center justify-center disabled:opacity-25"
            title="Previous page"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="font-mono tabular-nums shrink-0">{pageIndex + 1}/{pages.length}</span>
          <button
            onClick={() => setPinActivePage(storyId, pin.id, Math.min(pages.length - 1, pageIndex + 1))}
            disabled={pageIndex === pages.length - 1}
            className="w-5 h-5 rounded-full hover:bg-app-text/10 flex items-center justify-center disabled:opacity-25"
            title="Next page"
          >
            <ChevronRight size={12} />
          </button>
          <button
            onDoubleClick={() => {
              const name = window.prompt('Name this page', pages[pageIndex].title ?? '');
              if (name !== null) updatePinPage(storyId, pin.id, pageIndex, { title: name.trim() });
            }}
            title="Double-click to name this page"
            className="flex-1 min-w-0 truncate text-left px-1 rounded hover:bg-app-text/5"
          >
            {pageLabel(pages[pageIndex], pageIndex)}
          </button>
          <button
            onClick={() => movePinPage(storyId, pin.id, pageIndex, -1)}
            disabled={pageIndex === 0}
            className="w-5 h-5 rounded hover:bg-app-text/10 flex items-center justify-center disabled:opacity-25"
            title="Move this page earlier"
          >
            <ArrowLeft size={11} />
          </button>
          <button
            onClick={() => movePinPage(storyId, pin.id, pageIndex, 1)}
            disabled={pageIndex === pages.length - 1}
            className="w-5 h-5 rounded hover:bg-app-text/10 flex items-center justify-center disabled:opacity-25"
            title="Move this page later"
          >
            <ArrowRight size={11} />
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Remove "${pageLabel(pages[pageIndex], pageIndex)}" from this pin?`)) {
                removePinPage(storyId, pin.id, pageIndex);
              }
            }}
            className="w-5 h-5 rounded hover:bg-app-text/10 hover:text-red-500 flex items-center justify-center"
            title="Remove this page"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {/* Version switcher — flip between the original and AI/manual updates. */}
      {!pin.collapsed && versions && versions.length > 1 && (
        <div className="flex items-center gap-1.5 px-2 py-1 border-t border-app-border/50 text-[10px] text-app-text/70">
          <button
            onClick={() => setPinActiveVersion(storyId, pin.id, (activeVersion - 1 + versions.length) % versions.length)}
            className="w-5 h-5 rounded-full hover:bg-app-text/10 flex items-center justify-center"
            title="Previous version"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="font-mono tabular-nums">{activeVersion + 1}/{versions.length}</span>
          <button
            onClick={() => setPinActiveVersion(storyId, pin.id, (activeVersion + 1) % versions.length)}
            className="w-5 h-5 rounded-full hover:bg-app-text/10 flex items-center justify-center"
            title="Next version"
          >
            <ChevronRight size={12} />
          </button>
          <span className="uppercase tracking-wider opacity-70">
            {versions[activeVersion]?.source === 'original' ? 'original' : versions[activeVersion]?.source}
          </span>
          {versions[activeVersion]?.instruction && (
            <span className="truncate italic opacity-60" title={versions[activeVersion]!.instruction}>
              · {versions[activeVersion]!.instruction}
            </span>
          )}
        </div>
      )}

      {/* AI update composer — instruction + source toggle → a new version. */}
      {composerOpen && (
        <div className="px-2 py-2 border-t border-app-border/60 bg-app-text/[0.03] flex flex-col gap-1.5">
          {pin.messageId && (
            <div className="flex gap-1">
              {(['source', 'revise'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex-1 py-1 text-[10px] rounded-md border transition-colors',
                    mode === m
                      ? 'border-accent bg-accent/10 text-accent font-bold'
                      : 'border-transparent bg-app-text/5 hover:bg-app-text/10 text-app-text/80',
                  )}
                >
                  {m === 'source' ? 'From source' : 'Revise text'}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder={mode === 'source'
              ? 'e.g. re-summarize with what’s happened since'
              : 'e.g. tighten this and add the latest reveal'}
            rows={2}
            className="w-full resize-none rounded-md bg-surface border border-app-border px-2 py-1 text-[11px] text-app-text placeholder:text-app-text/40 focus:outline-none focus:border-accent"
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void runUpdate(); }
            }}
          />
          {error && <span className="text-[10px] text-red-500">{error}</span>}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void runUpdate()}
              disabled={busy}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent text-white text-[11px] font-medium disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {busy ? 'Updating…' : 'Update'}
            </button>
            <button
              onClick={() => { setComposerOpen(false); setError(null); }}
              className="px-2 py-1 rounded-md text-[11px] text-app-text/70 hover:bg-app-text/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Right-margin dock for pinned visuals — the reader's charts and tables,
 * always in view while reading, one click to hide. On narrow windows the
 * cards overlay the text edge, so the whole dock collapses to a small
 * "N pins" chip. Pins that have been dragged out float free at their own
 * position; the rest live in the dock column.
 */
/** Compact set switcher shown beside the dock chip — swap saved views while
 *  reading without opening the Sheets panel. */
const DockSetSwitcher = ({ storyId }: { storyId: string }) => {
  const sets = useAuraV2Store(s => s.pinSetsByStory[storyId]);
  const activeId = useAuraV2Store(s => s.activePinSetByStory[storyId] ?? '');
  const applyPinSet = useAuraV2Store(s => s.applyPinSet);
  const setActivePinSet = useAuraV2Store(s => s.setActivePinSet);
  if (!sets || sets.length === 0) return null;

  return (
    <select
      value={activeId}
      onChange={(e) => (e.target.value ? applyPinSet(storyId, e.target.value) : setActivePinSet(storyId, null))}
      title="Switch pin set — restores which pins are shown and which are in AI context"
      className="max-w-[9rem] px-2 py-1.5 rounded-full bg-surface/95 border border-app-border shadow-md text-[11px] font-medium opacity-70 hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
    >
      <option value="">No set</option>
      {sets.map(s => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  );
};

export const PinDock = () => {
  const story = useAppStore(s => s.currentStory);
  const screen = useAppStore(s => s.screen);
  const pins = useAuraV2Store(s => (story ? s.pinsByStory[story.id] : undefined));
  const hasSets = useAuraV2Store(s => (story ? (s.pinSetsByStory[story.id]?.length ?? 0) > 0 : false));
  const dockOpen = useAuraV2Store(s => s.pinDockOpen);
  const setPinDockOpen = useAuraV2Store(s => s.setPinDockOpen);

  if (screen !== 'reader' || !story) return null;
  const docked = (pins ?? []).filter(p => p.docked);
  // Keep the control cluster mounted whenever there are pins or sets — an
  // active set can legitimately hide every pin, and the switcher is how you
  // get them back.
  if (docked.length === 0 && !hasSets) return null;

  const column = docked.filter(p => p.x == null);
  const floating = docked.filter(p => p.x != null);

  return (
    <>
      <div
        style={{ zIndex: DOCK_Z + 4 }}
        className="fixed right-4 top-20 pointer-events-auto flex items-center gap-1.5"
      >
        <DockSetSwitcher storyId={story.id} />
        {docked.length > 0 && (
          <button
            onClick={() => setPinDockOpen(!dockOpen)}
            title={dockOpen ? 'Hide all pins' : 'Show all pins'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface/95 border border-app-border shadow-md text-[11px] font-medium opacity-70 hover:opacity-100 transition-opacity"
          >
            {dockOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
            {docked.length} pin{docked.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {dockOpen && column.length > 0 && (
        <div
          style={{ zIndex: DOCK_Z }}
          className="fixed right-4 top-[6.5rem] bottom-28 w-80 max-w-[85vw] flex flex-col gap-2 pointer-events-none"
        >
          <div className="pointer-events-auto flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {column.map(p => <PinCard key={p.id} pin={p} storyId={story.id} />)}
          </div>
        </div>
      )}
      {dockOpen && floating.map(p => (
        <PinCard key={p.id} pin={p} storyId={story.id} />
      ))}
    </>
  );
};
