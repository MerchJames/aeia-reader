/**
 * The cowriting view: the text, and everything you work on it with, in columns
 * you arrange yourself.
 *
 * Every other view is about READING the story — how it looks, how it arrives,
 * what it sounds like. This one is about working on it, and that changes what
 * the screen owes you.
 *
 * ── Why this stopped being sliders ─────────────────────────────────────────
 *
 * It used to be one text column, positioned with five sliders (side, width,
 * edge gap, leading, size), plus a fixed rail that shuffled through pins, sets,
 * sheets and branchlines ONE AT A TIME. Two things were wrong with that.
 *
 * A slider makes you describe an arrangement in numbers instead of making it:
 * "width 58, gap 2" is a thing you tune by watching the screen, not a thing you
 * meant. And a rail that shows one panel at a time cannot express the
 * arrangement this view exists for — the text here, the assistant beside it,
 * the notes beside that — which is precisely what the reader asked for.
 *
 * So: columns. Drag a panel's header into another column; drag a column's edge
 * to resize. `utils/workspaceLayout` owns what those two gestures may not do.
 *
 * ── The lock ───────────────────────────────────────────────────────────────
 *
 * A panel header is both a title and a drag handle; a column edge is both a
 * border and a resize grip. Once an arrangement is right, both are things to
 * knock by accident on the way to a button. The lock refuses both gestures and
 * changes nothing else — the arrangement renders identically, because the
 * reader locked it for being exactly where they wanted it.
 *
 * ── The assistant lives here now ───────────────────────────────────────────
 *
 * It used to float OVER this view in its own window. In a view whose whole
 * subject is arranging your working surface, the most-used tool being the one
 * thing you could not arrange was the obvious gap.
 *
 * **Editing is in place.** Click a passage and you are in a textarea holding
 * what the page currently shows, Lens included. Save writes a Lens override —
 * the same layer the assistant proposes into, never the imported text.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, GitBranch, Layers, Lock, LockOpen, Pencil, Pin as PinIcon, Plus,
  Settings2, Table2, Undo2, Wand2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { flatWithIndex } from '../utils/contextZone';
import { resolveContent } from '../utils/lens';
import { isNoopChange } from '../utils/textDiff';
import {
  LAYOUT_PRESETS, LIMITS, MAX_COLUMNS, PANELS, addPanel, evenColumns, findPanel, gridTemplate,
  hasPanel, matchingPreset, movePanel, passageStyle, patchLayout, removePanel, resizeColumn,
  sanitizeLayout, textStyle,
  type LayoutPreset, type PanelId, type WorkspaceLayout,
} from '../utils/workspaceLayout';
import { cn } from '../utils/cn';

/** Where the layout lives. Local to the device, like every other view preference. */
const LAYOUT_KEY = 'aeia.workspace.layout';

const loadLayout = (): WorkspaceLayout => {
  try {
    return sanitizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'));
  } catch {
    // A private window, or a hand-edited value. A layout is a preference; a
    // broken one costs the default, never the view.
    return sanitizeLayout(null);
  }
};

const PANEL_ICON: Record<PanelId, React.ReactNode> = {
  text: <Pencil size={12} />,
  assistant: <Bot size={12} />,
  pins: <PinIcon size={12} />,
  sets: <Layers size={12} />,
  sheets: <Table2 size={12} />,
  branches: <GitBranch size={12} />,
};

const PANEL_LABEL = Object.fromEntries(PANELS.map(p => [p.id, p.label])) as Record<PanelId, string>;

/** What the reader is dragging, and from where. */
interface PanelDrag {
  panel: PanelId;
  from: number;
}

export const WorkspaceView = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const chains = useAppStore(s => s.chains);
  const currentChainIndex = useAppStore(s => s.currentChainIndex);
  const currentMessageIndex = useAppStore(s => s.currentMessageIndex);
  const setLensEditTarget = useAppStore(s => s.setLensEditTarget);
  const setAiOpen = useAppStore(s => s.setAiOpen);
  const overrides = useAuraV2Store(s => (storyId ? s.overridesByStory[storyId] : undefined));
  const lensOn = useAuraV2Store(s => (storyId ? !!s.lensOnByStory[storyId] : false));
  const setOverride = useAuraV2Store(s => s.setOverride);
  const removeOverride = useAuraV2Store(s => s.removeOverride);
  const setLensOn = useAuraV2Store(s => s.setLensOn);

  const [layout, setLayout] = useState<WorkspaceLayout>(loadLayout);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<PanelDrag | null>(null);
  /** Column the pointer is over during a panel drag — `columns.length` = a new one. */
  const [over, setOver] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const commit = useCallback((next: WorkspaceLayout) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* not worth a warning */ }
  }, []);
  const patch = useCallback((p: Partial<WorkspaceLayout>) => {
    commit(patchLayout(layout, p));
  }, [commit, layout]);

  const flat = useMemo(() => flatWithIndex(chains), [chains]);
  const editedIds = useMemo(
    () => new Set((overrides ?? []).map(o => o.messageId)),
    [overrides],
  );
  const currentId = chains[currentChainIndex]?.messages[currentMessageIndex]?.id;

  const shown = (msg: { id: string; content: string }) =>
    resolveContent(msg as never, overrides, lensOn);

  const beginEdit = (id: string, text: string) => {
    setEditingId(id);
    setDraft(text);
  };

  /**
   * Save an edit as a Lens override.
   *
   * Never as a change to the message. The imported transcript is the one thing
   * in this app that is never written to — it is what "turn the Lens off and
   * read the original" means, and an in-place editor is exactly where that
   * promise would quietly get broken.
   */
  const commitEdit = (id: string, original: string) => {
    if (!storyId) return;
    const text = draft.trim();
    setEditingId(null);
    if (!text || isNoopChange(original, text)) return;
    setOverride(storyId, {
      messageId: id, kind: 'rewrite', content: text, source: 'user', createdAt: Date.now(),
    });
    // Edits are deliberate work; they do not wait on the debounce.
    void flushV2();
    // An edit nobody can see is an edit that looks like it failed.
    if (!lensOn) setLensOn(storyId, true);
  };

  /* ── Dragging a column edge ─────────────────────────────────────────────
   *
   * In fractions of the grid rather than pixels, so the arrangement survives
   * the window being resized — `resizeColumn` never sees a pixel.
   */
  const startResize = (index: number) => (e: React.PointerEvent) => {
    if (layout.locked || e.button !== 0) return;
    e.preventDefault();
    const width = gridRef.current?.getBoundingClientRect().width ?? 1;
    const startX = e.clientX;
    const from = layout;
    let latest = from;
    const move = (ev: PointerEvent) => {
      latest = resizeColumn(from, index, (ev.clientX - startX) / width);
      setLayout(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // Written once, at the end: committing every frame turns a smooth drag
      // into a stuttering one and fills localStorage with intermediate states.
      commit(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /* ── Dragging a panel ───────────────────────────────────────────────────
   *
   * HTML5 drag-and-drop rather than pointer events, the opposite of the
   * choice the Branching board made — and for the opposite reason. There the
   * point was the LINE you are pulling, which native DnD cannot draw. Here the
   * point is the drop target, native DnD gives that for free, and it brings the
   * platform's own drag affordance with it.
   */
  const onDrop = (column: number) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    if (!drag) return;
    const at = column < layout.columns.length
      // Dropped on the column it came from: leave the order alone rather than
      // guessing a new position from a coordinate.
      ? (column === drag.from ? findPanel(layout, drag.panel)?.at ?? 0 : Infinity)
      : Infinity;
    commit(movePanel(layout, drag.panel, column, at));
    setDrag(null);
  };

  const preset = matchingPreset(layout);
  const missing = PANELS.filter(p => !hasPanel(layout, p.id));

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="workspace-view">
      {/* ── The bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-app-border/60 shrink-0">
        <button
          onClick={() => patch({ locked: !layout.locked })}
          aria-pressed={layout.locked}
          data-testid="workspace-lock"
          title={layout.locked
            ? 'Unlock — panels can be dragged and columns resized again'
            : 'Lock this arrangement'}
          className={cn(
            'flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors',
            layout.locked ? 'bg-accent/15 text-accent font-bold' : 'text-muted hover:bg-app-text/5',
          )}
        >
          {layout.locked ? <Lock size={11} /> : <LockOpen size={11} />}
          {layout.locked ? 'Locked' : 'Unlocked'}
        </button>
        <div className="w-px h-4 bg-app-border/60 mx-0.5" />
        {(Object.keys(LAYOUT_PRESETS) as LayoutPreset[]).map(k => (
          <button
            key={k}
            onClick={() => commit({ ...LAYOUT_PRESETS[k].layout, locked: layout.locked })}
            title={LAYOUT_PRESETS[k].hint}
            data-testid={`workspace-preset-${k}`}
            className={cn(
              'text-[11px] px-2 py-1 rounded-md transition-colors',
              preset === k ? 'bg-accent/15 text-accent font-bold' : 'text-muted hover:bg-app-text/5',
            )}
          >
            {LAYOUT_PRESETS[k].label}
          </button>
        ))}
        <div className="flex-1" />
        {editedIds.size > 0 && storyId && (
          <button
            onClick={() => setLensOn(storyId, !lensOn)}
            title={lensOn ? 'Showing your edits' : 'Showing the original text'}
            className={cn(
              'flex items-center gap-1 text-[11px] px-2 py-1 rounded-md',
              lensOn ? 'text-amber-500 bg-amber-500/10' : 'text-muted hover:bg-app-text/5',
            )}
          >
            <Pencil size={11} /> {editedIds.size}
          </button>
        )}
        {/* Summoning a panel is a menu choice, not a pointer gesture, so it
          * stays available while locked — the lock is about not knocking things
          * out of place, not about freezing the workspace. */}
        {missing.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setAddOpen(v => !v)}
              title="Add a panel"
              data-testid="workspace-add-panel"
              className={cn(
                'p-1.5 rounded-md',
                addOpen ? 'text-accent bg-accent/10' : 'text-muted hover:bg-app-text/5',
              )}
            >
              <Plus size={14} />
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-surface border border-app-border shadow-2xl p-1 z-30">
                {missing.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { commit(addPanel(layout, p.id)); setAddOpen(false); }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-app-text/5"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      {PANEL_ICON[p.id]} {p.label}
                    </span>
                    <span className="block text-[10px] text-muted leading-snug pl-5">{p.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          onClick={() => setControlsOpen(v => !v)}
          title="Set the text"
          aria-expanded={controlsOpen}
          data-testid="workspace-controls"
          className={cn(
            'p-1.5 rounded-md',
            controlsOpen ? 'text-accent bg-accent/10' : 'text-muted hover:bg-app-text/5',
          )}
        >
          <Settings2 size={14} />
        </button>
      </div>

      {controlsOpen && (
        <TextControls layout={layout} onPatch={patch} onEven={() => commit(evenColumns(layout))} />
      )}

      {/* ── The columns ────────────────────────────────────────────────── */}
      <div
        ref={gridRef}
        className="relative flex-1 min-h-0 grid"
        style={{ gridTemplateColumns: gridTemplate(layout) }}
      >
        {layout.columns.map((column, i) => (
          <div
            key={column.id}
            className={cn(
              // Scrolls rather than squeezing: with several panels stacked,
              // `flex-1` alone gives each an equal share of the height however
              // small that is, and four panels in one column is four headers
              // and no content. Each panel keeps a floor (see PanelFrame) and
              // the column scrolls when they no longer fit.
              'relative min-w-0 flex flex-col overflow-y-auto border-r border-app-border/60 last:border-r-0',
              over === i && 'bg-accent/[0.06]',
            )}
            onDragOver={e => { if (drag) { e.preventDefault(); setOver(i); } }}
            onDragLeave={() => setOver(o => (o === i ? null : o))}
            onDrop={onDrop(i)}
          >
            {column.panels.map(panel => (
              <PanelFrame
                key={panel}
                panel={panel}
                locked={layout.locked}
                dragging={drag?.panel === panel}
                onDragStart={() => setDrag({ panel, from: i })}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                onRemove={panel === 'text' ? undefined : () => commit(removePanel(layout, panel))}
              >
                {panel === 'text' ? (
                  <div className="h-full overflow-y-auto px-4 py-4" style={textStyle(layout)}>
            {flat.map(({ msg, index }) => {
              const text = shown(msg);
              const editing = editingId === msg.id;
              return (
                <div
                  key={msg.id}
                  style={passageStyle(layout)}
                  className={cn(
                    'group relative rounded-lg px-3 py-2 -mx-3 transition-colors',
                    msg.id === currentId && 'bg-accent/[0.04]',
                    !editing && 'hover:bg-app-text/[0.03]',
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] font-mono text-muted">#{index}</span>
                    <span className="text-[11px] font-bold opacity-70">{msg.name}</span>
                    {editedIds.has(msg.id) && (
                      <span className="text-[9px] uppercase tracking-wide text-amber-500">edited</span>
                    )}
                    <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {editedIds.has(msg.id) && storyId && (
                        <button
                          onClick={() => { removeOverride(storyId, msg.id); void flushV2(); }}
                          title="Drop your edit and go back to the original"
                          aria-label="Drop this edit"
                          className="p-1 rounded hover:bg-app-text/10 text-muted"
                        >
                          <Undo2 size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => { setLensEditTarget(msg.id); setAiOpen(true); }}
                        title="Ask the assistant to rewrite this"
                        aria-label="Ask the assistant to rewrite this"
                        className="p-1 rounded hover:bg-app-text/10 text-muted"
                      >
                        <Wand2 size={12} />
                      </button>
                      {!editing && (
                        <button
                          onClick={() => beginEdit(msg.id, text)}
                          title="Edit this passage"
                          aria-label="Edit this passage"
                          data-testid="workspace-edit"
                          className="p-1 rounded hover:bg-app-text/10 text-muted"
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                    </span>
                  </div>

                  {editing ? (
                    <div className="space-y-1.5">
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); }
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitEdit(msg.id, text);
                        }}
                        rows={Math.min(24, Math.max(4, draft.split('\n').length + 2))}
                        style={{ lineHeight: layout.leading }}
                        className="w-full bg-app-text/[0.04] border border-accent/40 rounded-lg px-3 py-2 outline-none resize-y font-serif"
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted flex-1">
                          Saved to the Lens — your imported text is untouched.
                        </span>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-[11px] px-2 py-1 rounded-md hover:bg-app-text/10 text-muted"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => commitEdit(msg.id, text)}
                          data-testid="workspace-save"
                          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white"
                        >
                          <Check size={11} /> Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      onDoubleClick={() => beginEdit(msg.id, text)}
                      className="whitespace-pre-wrap break-words font-serif cursor-text"
                    >
                      {text || <span className="opacity-40">(empty)</span>}
                    </p>
                  )}
                </div>
              );
            })}
                    {!flat.length && (
                      <p className="text-sm text-muted text-center py-12">
                        This story has no passages yet.
                      </p>
                    )}
                  </div>
                ) : panel === 'assistant' ? (
                  <AssistantSlot />
                ) : panel === 'pins' ? <PinsPanel />
                  : panel === 'sets' ? <SetsPanel />
                    : panel === 'sheets' ? <SheetsPanel />
                      : <BranchesPanel />}
              </PanelFrame>
            ))}

            {/* The edge between this column and the next. Wider than it looks:
              * a 1px border is a border, and a resize grip needs to be a target. */}
            {i < layout.columns.length - 1 && !layout.locked && (
              <div
                onPointerDown={startResize(i)}
                data-testid="workspace-resize"
                className="absolute top-0 right-0 h-full w-2 translate-x-1 cursor-col-resize z-20 hover:bg-accent/30 transition-colors"
                aria-label={`Resize column ${i + 1}`}
              />
            )}
          </div>
        ))}

        {/* Drop past the last column to split the workspace. Only while a drag
          * is live, and only when there is room — an always-present strip would
          * be a piece of furniture nobody could name. */}
        {drag && layout.columns.length < MAX_COLUMNS && (
          <div
            onDragOver={e => { e.preventDefault(); setOver(layout.columns.length); }}
            onDragLeave={() => setOver(o => (o === layout.columns.length ? null : o))}
            onDrop={onDrop(layout.columns.length)}
            className={cn(
              'absolute right-0 top-0 h-full w-16 border-l-2 border-dashed flex items-center justify-center text-[10px] text-center z-30',
              over === layout.columns.length
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-app-border/60 text-muted bg-app-bg/60',
            )}
          >
            new<br />column
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* One panel in a column                                               */
/* ------------------------------------------------------------------ */

/**
 * The frame around a panel: its name, its grip, and its way out.
 *
 * The header IS the drag handle, which is why `draggable` is on the header and
 * not the frame — making the whole panel draggable would mean selecting a word
 * of the story started dragging the column it is in.
 */
const PanelFrame = ({
  panel, locked, dragging, onDragStart, onDragEnd, onRemove, children,
}: {
  panel: PanelId;
  locked: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onRemove?: () => void;
  children: React.ReactNode;
}) => (
  <div
    className={cn(
      // `flex-1` to share the height when there is room, and a floor so that
      // sharing it can never reduce a panel to its own title bar.
      'flex-1 shrink-0 min-h-44 flex flex-col border-b border-app-border/60 last:border-b-0',
      dragging && 'opacity-40',
    )}
    data-testid={`workspace-panel-${panel}`}
  >
    <div
      draggable={!locked}
      onDragStart={e => {
        // Firefox refuses to start a drag with nothing on the transfer.
        e.dataTransfer.setData('text/plain', panel);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 border-b border-app-border/40 bg-app-text/[0.02] shrink-0 select-none',
        locked ? '' : 'cursor-grab active:cursor-grabbing',
      )}
    >
      <span className={cn('shrink-0', locked ? 'opacity-30' : 'opacity-60')}>{PANEL_ICON[panel]}</span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted truncate">
        {PANEL_LABEL[panel]}
      </span>
      {onRemove && !locked && (
        <button
          onClick={onRemove}
          title={`Take ${PANEL_LABEL[panel]} off the workspace`}
          className="ml-auto p-0.5 rounded text-muted opacity-40 hover:opacity-100 hover:bg-app-text/10"
        >
          <X size={11} />
        </button>
      )}
    </div>
    <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
  </div>
);

/**
 * The assistant, in a column of its own.
 *
 * There is ONE assistant with one conversation, so this does not mount a second
 * copy — it claims the only one. `aiEmbedded` tells `App` to stand the floating
 * panel down for as long as this column is on screen, and the same component
 * renders here without its window: no fixed position, no drag, no resize grips,
 * because the column already supplies all four.
 *
 * Opening it on mount is the right default and not an imposition: a reader who
 * put an Assistant panel in their workspace has said what they want the column
 * for, and an empty column with a button in it would be one more click every
 * time they open the view.
 */
const AssistantSlot = () => {
  const setAiOpen = useAppStore(s => s.setAiOpen);
  const setAiEmbedded = useAppStore(s => s.setAiEmbedded);
  useEffect(() => {
    setAiEmbedded(true);
    setAiOpen(true);
    // Released on unmount — leaving it set would hide the floating assistant
    // everywhere in the app the moment the reader left the Workspace.
    return () => setAiEmbedded(false);
  }, [setAiEmbedded, setAiOpen]);
  return (
    <Suspense fallback={
      <div className="h-full flex items-center justify-center">
        <Bot size={20} className="opacity-30 animate-pulse" />
      </div>
    }>
      <EmbeddedAssistant />
    </Suspense>
  );
};

/** Lazily loaded here for the same reason `App` loads it lazily: it is the
 *  single biggest chunk in the app, and most reading never opens it. */
const EmbeddedAssistant = lazy(() =>
  import('./AIChat').then(m => ({ default: () => <m.AIChat embedded /> })));

/* ------------------------------------------------------------------ */
/* Setting the text                                                    */
/* ------------------------------------------------------------------ */

/**
 * The three numbers that are still numbers.
 *
 * Position and width became gestures — you drag the thing. Type size, leading
 * and passage spacing did not, because there is nothing on screen to drag: they
 * are properties OF the text rather than of the arrangement, and a slider is
 * the right control for a continuous property with no spatial handle.
 */
const TextControls = ({
  layout, onPatch, onEven,
}: {
  layout: WorkspaceLayout;
  onPatch: (p: Partial<WorkspaceLayout>) => void;
  onEven: () => void;
}) => {
  const slider = (
    label: string,
    field: 'leading' | 'paragraphGap' | 'fontSize',
    step: number,
    suffix = '',
  ) => (
    <label className="flex items-center gap-2 text-[11px] min-w-0">
      <span className="text-muted w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={LIMITS[field][0]}
        max={LIMITS[field][1]}
        step={step}
        value={layout[field]}
        onChange={e => onPatch({ [field]: parseFloat(e.target.value) } as Partial<WorkspaceLayout>)}
        aria-label={label}
        className="flex-1 min-w-16 accent-[var(--app-accent)]"
      />
      <span className="w-10 text-right tabular-nums text-muted shrink-0">
        {layout[field]}{suffix}
      </span>
    </label>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5 px-3 py-2.5 border-b border-app-border/60 bg-app-text/[0.02] shrink-0">
      {slider('Text size', 'fontSize', 1)}
      {slider('Line height', 'leading', 0.05)}
      {slider('Passage gap', 'paragraphGap', 0.1)}
      <button
        onClick={onEven}
        disabled={layout.locked || layout.columns.length < 2}
        className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40 justify-self-start"
        title="Give every column the same width"
      >
        Even columns
      </button>
    </div>
  );
};

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[11px] text-muted text-center py-8 px-3 leading-relaxed">{children}</p>
);

const PinsPanel = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const pins = useAuraV2Store(s => (storyId ? s.pinsByStory[storyId] : undefined)) ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  if (!pins.length) return <Empty>No pins yet. Summaries and Tasks land here.</Empty>;
  return (
    <div className="space-y-1">
      {pins.map(p => (
        <div key={p.id} className="rounded-lg border border-app-border overflow-hidden">
          <button
            onClick={() => setOpenId(openId === p.id ? null : p.id)}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-app-text/5"
          >
            <span className="text-[11px] font-bold truncate flex-1 min-w-0">{p.title}</span>
            {(p.versions?.length ?? 0) > 1 && (
              <span className="text-[9px] text-muted shrink-0">
                v{(p.activeVersion ?? 0) + 1}/{p.versions?.length}
              </span>
            )}
          </button>
          {openId === p.id && (
            <p className="px-2 pb-2 text-[11px] leading-snug whitespace-pre-wrap opacity-80 max-h-64 overflow-y-auto">
              {p.content}
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

const SetsPanel = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const sets = useAuraV2Store(s => (storyId ? s.pinSetsByStory[storyId] : undefined)) ?? [];
  const activeId = useAuraV2Store(s => (storyId ? s.activePinSetByStory[storyId] : undefined));
  const applyPinSet = useAuraV2Store(s => s.applyPinSet);
  if (!sets.length) return <Empty>No pin sets. A set remembers which pins are docked and which are in context.</Empty>;
  return (
    <div className="space-y-1">
      {sets.map(s => (
        <button
          key={s.id}
          onClick={() => storyId && applyPinSet(storyId, s.id)}
          className={cn(
            'w-full text-left rounded-lg border px-2 py-1.5 transition-colors',
            activeId === s.id ? 'border-accent bg-accent/10' : 'border-app-border hover:bg-app-text/5',
          )}
        >
          <span className={cn('block text-[11px] font-bold truncate', activeId === s.id && 'text-accent')}>
            {s.name}
          </span>
          <span className="block text-[10px] text-muted">
            {s.docked.length} docked · {s.inContext.length} in context
          </span>
        </button>
      ))}
    </div>
  );
};

const SheetsPanel = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const sheets = useAuraV2Store(s => (storyId ? s.sheetsByStory[storyId] : undefined)) ?? [];
  if (!sheets.length) return <Empty>No sheets. Build one from the Summarize panel, or by hand.</Empty>;
  return (
    <div className="space-y-2">
      {sheets.map(s => (
        <div key={s.id} className="rounded-lg border border-app-border overflow-hidden">
          <div className="px-2 py-1.5 border-b border-app-border/60 text-[11px] font-bold truncate">
            {s.title}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-muted">
                  {s.columns.map(c => <th key={c} className="text-left px-1.5 py-1 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {s.rows.slice(0, 40).map((row, i) => (
                  <tr key={i} className="border-t border-app-border/40">
                    {s.columns.map(c => (
                      <td key={c} className="px-1.5 py-1 align-top">{row[c] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * The alternate takes on the passage the reader is ON.
 *
 * Scoped to the current message on purpose: a list of every branchline in the
 * story is a different feature (the Branches view), and while drafting the only
 * one that matters is the one under the cursor.
 *
 * ── Why this is not four paragraphs in a row ───────────────────────────────
 *
 * It was, and it was unreadable — four takes on the same passage are four
 * near-identical walls of prose, and the reader's actual question is never
 * "what do these say" but "how do these DIFFER". Four clamped blobs answer the
 * first question badly and the second not at all.
 *
 * So each take is a card that leads with what tells it apart: how long it is,
 * how much of it is dialogue, and its opening line — the three things that
 * distinguish two versions of the same beat at a glance. The full text is one
 * click away, expanded in place, because sometimes you do have to read them.
 */
const BranchesPanel = () => {
  const chains = useAppStore(s => s.chains);
  const currentChainIndex = useAppStore(s => s.currentChainIndex);
  const currentMessageIndex = useAppStore(s => s.currentMessageIndex);
  const swipeSelections = useAppStore(s => s.swipeSelections);
  const selectSwipe = useAppStore(s => s.selectSwipe);
  const [openTake, setOpenTake] = useState<number | null>(null);

  const msg = chains[currentChainIndex]?.messages[currentMessageIndex];
  const swipes = msg?.swipes ?? [];

  // Reading the takes is about the one passage you are on; moving to another
  // passage should not leave a take from the last one expanded.
  useEffect(() => { setOpenTake(null); }, [msg?.id]);

  if (!msg) return <Empty>Nothing selected.</Empty>;
  if (swipes.length < 2) {
    return <Empty>This passage has one version. Alternates show up here when it has more.</Empty>;
  }
  const active = swipeSelections[msg.id] ?? Math.max(0, swipes.indexOf(msg.content));

  return (
    <div className="h-full overflow-y-auto p-2 space-y-1.5">
      <p className="text-[10px] text-muted px-1">
        {swipes.length} takes on #{currentMessageIndex + 1} — click one to read it here, or
        {' '}<span className="text-accent">Use</span> it in the story.
      </p>
      {swipes.map((text, i) => {
        const clean = text.replace(/\s+/g, ' ').trim();
        const words = clean ? clean.split(' ').length : 0;
        // Rough, and rough is the point: an exact percentage of a passage that
        // is speech would be a number nobody could act on. A bar you can
        // compare against the take below it is the whole use.
        const spoken = (clean.match(/["“][^"”]+["”]/g) ?? []).join(' ').length;
        const dialogue = clean.length ? Math.round((spoken / clean.length) * 100) : 0;
        const isOpen = openTake === i;
        return (
          <div
            key={i}
            className={cn(
              'rounded-lg border transition-colors',
              i === active ? 'border-accent bg-accent/[0.07]' : 'border-app-border hover:border-accent/40',
            )}
          >
            <button
              onClick={() => setOpenTake(isOpen ? null : i)}
              className="w-full text-left px-2 py-1.5"
              aria-expanded={isOpen}
            >
              <span className="flex items-center gap-1.5 mb-1">
                <span className={cn('text-[10px] font-mono', i === active ? 'text-accent' : 'text-muted')}>
                  {i + 1}
                </span>
                {i === active && (
                  <span className="text-[9px] uppercase tracking-wide text-accent font-bold">showing</span>
                )}
                <span className="ml-auto flex items-center gap-2 text-[9px] text-muted tabular-nums">
                  <span title={`${words} words`}>{words}w</span>
                  <span title={`about ${dialogue}% dialogue`} className="flex items-center gap-1">
                    <span className="w-8 h-1 rounded-full bg-app-text/10 overflow-hidden">
                      <span
                        className="block h-full bg-accent/60"
                        style={{ width: `${Math.min(100, dialogue)}%` }}
                      />
                    </span>
                    {dialogue}%
                  </span>
                </span>
              </span>
              <span
                className={cn(
                  'block text-[11px] leading-snug',
                  isOpen ? 'whitespace-pre-wrap opacity-85' : 'line-clamp-2 opacity-70',
                )}
              >
                {isOpen ? text : clean}
              </span>
            </button>
            <div className="flex items-center gap-1 px-2 pb-1.5">
              <button
                onClick={() => setOpenTake(isOpen ? null : i)}
                className="text-[10px] text-muted hover:text-app-text"
              >
                {isOpen ? 'Less' : 'Read'}
              </button>
              {i !== active && (
                <button
                  onClick={() => selectSwipe(msg.id, i)}
                  className="ml-auto text-[10px] px-2 py-0.5 rounded-md border border-app-border hover:border-accent hover:text-accent"
                  title="Make this the version the story shows"
                >
                  Use
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
