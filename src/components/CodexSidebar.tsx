import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked, Download, Eraser, MessageSquare, Search, Sparkles, Trash2, Underline, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import {
  CodexEntity, committedCount, EntityKind, useAuraV2Store, visibleEntities,
} from '../stores/useAuraV2Store';
import { codexToWorldInfo } from '../utils/codexExtractor';
import { downloadText, safeFilename } from '../utils/exporter';
import { KIND_ICON } from './EntityTooltip';
import { cn } from '../utils/cn';

type TabKind = EntityKind | 'notes';

const TABS: { kind: TabKind; label: string }[] = [
  { kind: 'character', label: 'Characters' },
  { kind: 'location', label: 'Places' },
  { kind: 'item', label: 'Items' },
  { kind: 'notes', label: 'Notes' },
];

const Row = ({
  entity, focused, onJump,
}: {
  entity: CodexEntity;
  focused: boolean;
  onJump: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const removeEntity = useAuraV2Store(s => s.removeEntity);
  const storyId = useAppStore(s => s.currentStory?.id);
  const Icon = KIND_ICON[entity.kind];
  // Entities discovered in the last minute get a soft "new" pulse.
  const isNew = Date.now() - entity.updatedAt < 60_000 && entity.mentions <= 2;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  return (
    <div
      ref={ref}
      className={cn(
        'group p-3 rounded-xl border transition-colors',
        focused
          ? 'border-accent ring-1 ring-accent bg-accent/5'
          : 'border-app-border/60 hover:border-app-border bg-app-text/[0.03]',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon size={13} className="text-accent shrink-0" />
        <button
          onClick={onJump}
          title="Jump to first appearance"
          className="font-bold text-sm truncate hover:text-accent transition-colors"
        >
          {entity.name}
        </button>
        {isNew && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" title="Just discovered" />
        )}
        <span className="ml-auto text-[10px] text-muted tabular-nums shrink-0">
          ×{entity.mentions}
        </span>
        <button
          onClick={() => storyId && removeEntity(storyId, entity.id)}
          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity shrink-0 flex items-center justify-center min-h-10 min-w-10 rounded"
          title="Remove entry"
          aria-label="Remove entry"
        >
          <X size={12} />
        </button>
      </div>
      <p className="text-xs leading-relaxed opacity-75 line-clamp-3">{entity.summary}</p>
      {entity.aliases.length > 0 && (
        <p className="text-[10px] text-muted mt-1 truncate">
          aka {entity.aliases.join(', ')}
        </p>
      )}
    </div>
  );
};

/**
 * The reader's living wiki. Fills itself in as the story is read — only
 * ever showing what the reader has already encountered — and stays out
 * of the way (a slide-in panel) the rest of the time.
 */
export const CodexSidebar = () => {
  const open = useAuraV2Store(s => s.codexOpen);
  const setOpen = useAuraV2Store(s => s.setCodexOpen);
  const tab = useAuraV2Store(s => s.codexTab);
  const setTab = useAuraV2Store(s => s.setCodexTab);
  const focusId = useAuraV2Store(s => s.codexFocusId);
  const codexEnabled = useAuraV2Store(s => s.codexEnabled);
  const setCodexEnabled = useAuraV2Store(s => s.setCodexEnabled);
  const codexUseAI = useAuraV2Store(s => s.codexUseAI);
  const setCodexUseAI = useAuraV2Store(s => s.setCodexUseAI);
  const codexHighlight = useAuraV2Store(s => s.codexHighlight);
  const setCodexHighlight = useAuraV2Store(s => s.setCodexHighlight);
  const clearCodex = useAuraV2Store(s => s.clearCodex);
  const statsByStory = useAuraV2Store(s => s.statsByStory);
  const removeAnnotation = useAuraV2Store(s => s.removeAnnotation);

  const story = useAppStore(s => s.currentStory);
  const annotations = useAuraV2Store(s => (story ? s.annotationsByStory[story.id] : undefined));
  const jumpToMessage = useAppStore(s => s.jumpToMessage);
  const aiConfigured = useAppStore(s => !!(s.aiBaseUrl && s.aiModel));
  const readCount = useAppStore(s =>
    s.chains.length === 0
      ? 0
      : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage));
  const allEntities = useAuraV2Store(s => (story ? s.codexByStory[story.id] : undefined));

  const [query, setQuery] = useState('');

  const known = useMemo(
    () => visibleEntities(allEntities ?? [], readCount),
    [allEntities, readCount],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (tab === 'notes') {
      return (annotations ?? [])
        .filter(a => !q || a.note.toLowerCase().includes(q) || (a.anchorText?.toLowerCase() ?? '').includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return known
      .filter(e => e.kind === tab)
      .filter(e => !q
        || e.name.toLowerCase().includes(q)
        || e.summary.toLowerCase().includes(q)
        || e.aliases.some(a => a.toLowerCase().includes(q)))
      .sort((a, b) => b.mentions - a.mentions);
  }, [known, tab, query, annotations]);

  const counts = useMemo(() => {
    const c: Record<TabKind, number> = { character: 0, location: 0, item: 0, notes: 0 };
    known.forEach(e => { c[e.kind]++; });
    c.notes = annotations?.length ?? 0;
    return c;
  }, [known, annotations]);

  if (!open || !story) return null;

  const msRead = statsByStory[story.id]?.msRead ?? 0;
  const hoursRead = msRead >= 3_600_000
    ? `${(msRead / 3_600_000).toFixed(1)} h`
    : `${Math.max(1, Math.round(msRead / 60_000))} min`;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-xs bg-surface text-app-text border-l border-app-border shadow-2xl flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
        <BookMarked size={17} className="text-accent" />
        <div className="min-w-0">
          <h2 className="font-bold leading-tight text-sm">Codex</h2>
          <p className="text-[10px] text-muted leading-tight truncate">
            What you've met so far · spoiler-free
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto flex items-center justify-center min-h-11 min-w-11 rounded-full hover:bg-app-text/10 transition-colors"
          title="Close codex"
          aria-label="Close codex"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex p-1 mx-3 mt-3 bg-app-text/5 rounded-lg text-xs">
        {TABS.map(({ kind, label }) => (
          <button
            key={kind}
            onClick={() => setTab(kind)}
            className={cn(
              'flex-1 py-1.5 min-h-10 rounded-md transition-colors font-medium',
              tab === kind ? 'bg-surface shadow-sm text-accent' : 'opacity-60 hover:opacity-100',
            )}
          >
            {label}
            <span className="ml-1 opacity-60 tabular-nums">{counts[kind]}</span>
          </button>
        ))}
      </div>

      <div className="relative mx-3 mt-2">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-50" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the codex…"
          className="w-full pl-8 pr-3 min-h-10 text-sm bg-app-text/5 border border-transparent rounded-full focus:outline-none focus:border-accent/50"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {shown.length === 0 ? (
          <div className="text-center text-xs text-muted px-4 py-10 leading-relaxed">
            {tab === 'notes'
              ? 'No anchored notes yet. Select text in the reader and tap "Note" to add one.'
              : codexEnabled
                ? known.length === 0
                  ? 'Nothing discovered yet. Keep reading — the codex fills itself in as names, places, and things appear.'
                  : `No ${TABS.find(t => t.kind === tab)?.label.toLowerCase()} found yet.`
                : 'The auto-codex is off. Enable it below to start building this story’s wiki as you read.'}
          </div>
        ) : tab === 'notes' ? (
          shown.map(a => (
            <div
              key={a.id}
              className="group p-3 rounded-xl border border-app-border/60 hover:border-app-border bg-app-text/[0.03]"
            >
              <div className="flex items-start gap-2">
                <MessageSquare size={13} className="text-accent shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  {a.anchorText && (
                    <p className="text-xs italic opacity-70 mb-1 line-clamp-2">“{a.anchorText}”</p>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{a.note}</p>
                </div>
                <button
                  onClick={() => story && removeAnnotation(story.id, a.id)}
                  className="opacity-0 group-hover:opacity-60 hover:!opacity-100 flex items-center justify-center min-h-10 min-w-10 rounded hover:bg-red-500/10 text-red-500 shrink-0"
                  aria-label="Delete note"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => a.messageId && jumpToMessage(a.messageId)}
                  className="text-[10px] text-accent hover:underline"
                >
                  Jump to message
                </button>
                <span className="text-[10px] text-muted ml-auto">
                  {new Date(a.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))
        ) : (
          shown.map(e => (
            <Row
              key={e.id}
              entity={e}
              focused={e.id === focusId}
              onJump={() => e.firstSeenMessageId && jumpToMessage(e.firstSeenMessageId)}
            />
          ))
        )}
      </div>

      <div className="border-t border-app-border p-3 space-y-1 text-xs">
        <label className="flex items-center gap-2 p-1.5 min-h-11 rounded-lg hover:bg-app-text/5 cursor-pointer">
          <input
            type="checkbox"
            checked={codexEnabled}
            onChange={(e) => setCodexEnabled(e.target.checked)}
            className="accent-[var(--app-accent)]"
          />
          <BookMarked size={13} className="opacity-70" />
          Build codex while reading
        </label>
        <label className="flex items-center gap-2 p-1.5 min-h-11 rounded-lg hover:bg-app-text/5 cursor-pointer">
          <input
            type="checkbox"
            checked={codexHighlight}
            onChange={(e) => setCodexHighlight(e.target.checked)}
            className="accent-[var(--app-accent)]"
          />
          <Underline size={13} className="opacity-70" />
          Underline lore words in the text
        </label>
        <label
          className={cn(
            'flex items-center gap-2 p-1.5 min-h-11 rounded-lg hover:bg-app-text/5 cursor-pointer',
            !aiConfigured && 'opacity-50 cursor-not-allowed',
          )}
          title={aiConfigured ? undefined : 'Set an AI endpoint in Settings → AI assistant first'}
        >
          <input
            type="checkbox"
            checked={codexUseAI && aiConfigured}
            disabled={!aiConfigured}
            onChange={(e) => setCodexUseAI(e.target.checked)}
            className="accent-[var(--app-accent)]"
          />
          <Sparkles size={13} className="opacity-70" />
          Refine entries with AI
        </label>

        <div className="flex items-center gap-1 pt-2">
          <button
            onClick={() => downloadText(
              `${safeFilename(story.title)}-lorebook.json`,
              codexToWorldInfo(known),
            )}
            disabled={known.length === 0}
            className="flex items-center gap-1.5 px-2.5 min-h-10 rounded-lg hover:bg-app-text/5 disabled:opacity-40 transition-colors"
            title="Export as SillyTavern World Info (lorebook) JSON"
          >
            <Download size={13} /> Lorebook
          </button>
          <button
            onClick={() => clearCodex(story.id)}
            disabled={!allEntities?.length}
            className="flex items-center gap-1.5 px-2.5 min-h-10 rounded-lg hover:bg-app-text/5 disabled:opacity-40 transition-colors"
            title="Clear and rebuild from the start"
          >
            <Eraser size={13} /> Rebuild
          </button>
          <span className="ml-auto text-[10px] text-muted" title="Time spent reading this story">
            {hoursRead} read
          </span>
        </div>
      </div>
    </div>
  );
};
