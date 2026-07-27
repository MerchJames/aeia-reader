import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BookMarked, BookOpen, Bot, Clapperboard, Film, Focus, GitBranch, Highlighter,
  Info, List, MessageSquare, Network, Pencil, Search, Settings, Table2, Wand2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store, committedCount, flatMessages } from '../stores/useAuraV2Store';
import { wordsPerSecond } from '../hooks/useStreamer';
import { UiMode, ViewMode } from '../types';
import { cn } from '../utils/cn';
import { resolveContent } from '../utils/lens';
import { buildSearchIndex, searchStory, SearchHit } from '../utils/storySearch';

/** Which workspace group a view belongs to — gates its visibility per UiMode. */
type ViewGroup = 'read' | 'cowrite' | 'scenes';

const VIEW_BUTTONS: { mode: ViewMode; icon: React.ReactNode; label: string; group: ViewGroup }[] = [
  { mode: 'storybook', icon: <BookOpen size={18} />, label: 'Storybook', group: 'read' },
  { mode: 'book', icon: <BookMarked size={18} />, label: 'Book', group: 'read' },
  { mode: 'stage', icon: <Clapperboard size={18} />, label: 'Stage', group: 'read' },
  { mode: 'vn', icon: <Film size={18} />, label: 'Visual Novel', group: 'read' },
  { mode: 'sandbox', icon: <Wand2 size={18} />, label: 'Sandbox', group: 'scenes' },
  { mode: 'chat', icon: <MessageSquare size={18} />, label: 'Chat', group: 'cowrite' },
  { mode: 'branches', icon: <GitBranch size={18} />, label: 'Branches', group: 'read' },
  { mode: 'overview', icon: <List size={18} />, label: 'Overview', group: 'read' },
  { mode: 'highlights', icon: <Highlighter size={18} />, label: 'Highlights', group: 'read' },
];

/** The workspace presets, in order, with a one-line "what this reveals" hint. */
const UI_MODES: { mode: UiMode; label: string; hint: string }[] = [
  { mode: 'read', label: 'Read', hint: 'Just the reading views — no AI tools in the way.' },
  { mode: 'cowrite', label: 'Cowrite', hint: 'Adds the AI writing assistant and the Chat view.' },
  { mode: 'scenes', label: 'Scenes', hint: 'Adds the Sandbox view and the Scene Director.' },
  { mode: 'all', label: 'All', hint: 'Everything, unfiltered.' },
];

/** Is a view's group visible under the active workspace preset? Reading views
 *  are always on; 'all' shows every group; otherwise the mode name = the group. */
const groupVisible = (group: ViewGroup, mode: UiMode): boolean =>
  mode === 'all' || group === 'read' || group === mode;

export const TopNavigation = () => {
  const currentStory = useAppStore(s => s.currentStory);
  const viewMode = useAppStore(s => s.viewMode);
  const setViewMode = useAppStore(s => s.setViewMode);
  const uiMode = useAppStore(s => s.uiMode);
  const setUiMode = useAppStore(s => s.setUiMode);
  const searchQuery = useAppStore(s => s.searchQuery);
  const setSearchQuery = useAppStore(s => s.setSearchQuery);
  const isAutofocusMode = useAppStore(s => s.isAutofocusMode);
  const setIsAutofocusMode = useAppStore(s => s.setIsAutofocusMode);
  const setSettingsOpen = useAppStore(s => s.setSettingsOpen);
  const aiOpen = useAppStore(s => s.aiOpen);
  const setAiOpen = useAppStore(s => s.setAiOpen);
  const closeStory = useAppStore(s => s.closeStory);
  const codexOpen = useAuraV2Store(s => s.codexOpen);
  const setCodexOpen = useAuraV2Store(s => s.setCodexOpen);
  const sheetsOpen = useAuraV2Store(s => s.sheetsOpen);
  const setSheetsOpen = useAuraV2Store(s => s.setSheetsOpen);
  const setMultiverseOpen = useAuraV2Store(s => s.setMultiverseOpen);
  const overridesByStory = useAuraV2Store(s => s.overridesByStory);
  const lensOnByStory = useAuraV2Store(s => s.lensOnByStory);
  const setLensOn = useAuraV2Store(s => s.setLensOn);
  const removeOverride = useAuraV2Store(s => s.removeOverride);
  const lensManagerOpen = useAuraV2Store(s => s.lensManagerOpen);
  const setLensManagerOpen = useAuraV2Store(s => s.setLensManagerOpen);

  const storyId = currentStory?.id;
  const overrides = storyId ? overridesByStory[storyId] ?? [] : [];
  const lensOn = !!storyId && !!lensOnByStory[storyId];
  const hasOverrides = overrides.length > 0;
  const managerRef = useRef<HTMLDivElement>(null);
  const jumpToMessage = useAppStore(s => s.jumpToMessage);
  const searchRef = useRef<HTMLDivElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Close the lens manager when clicking outside it.
  useEffect(() => {
    if (!lensManagerOpen) return;
    const handler = (e: MouseEvent) => {
      if (managerRef.current && !managerRef.current.contains(e.target as Node)) {
        setLensManagerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [lensManagerOpen, setLensManagerOpen]);

  // Kindle-style "time left in story", from position and reading speed.
  const chains = useAppStore(s => s.chains);
  const currentChainIndex = useAppStore(s => s.currentChainIndex);
  const currentMessageIndex = useAppStore(s => s.currentMessageIndex);
  const streaming = useAppStore(s => !!s.streamingMessage);
  const playbackSpeed = useAppStore(s => s.playbackSpeed);
  const cumWords = useMemo(() => {
    const msgs = flatMessages(chains);
    const cum = new Array<number>(msgs.length + 1);
    cum[0] = 0;
    msgs.forEach((m, i) => {
      const text = resolveContent(m, overrides, lensOn);
      cum[i + 1] = cum[i] + text.split(/\s+/).length;
    });
    return cum;
  }, [chains, overrides, lensOn]);
  const minutesLeft = useMemo(() => {
    if (cumWords.length <= 1) return 0;
    const read = Math.min(
      committedCount(chains, currentChainIndex, currentMessageIndex, streaming),
      cumWords.length - 1,
    );
    const remaining = cumWords[cumWords.length - 1] - cumWords[Math.max(0, read)];
    return Math.round(remaining / (wordsPerSecond(playbackSpeed) * 60));
  }, [cumWords, chains, currentChainIndex, currentMessageIndex, streaming, playbackSpeed]);

  // Full-story search: index every message once per story (resolved through
  // Lens), then substring-search on a debounced query so keystrokes stay cheap.
  const searchIndex = useMemo(() => {
    if (!currentStory) return [];
    const items = chains.flatMap((c, ci) =>
      c.messages.map((m, mi) => ({
        id: m.id, name: m.name, content: resolveContent(m, overrides, lensOn),
        chainIndex: ci, messageIndex: mi,
      })));
    return buildSearchIndex(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, overrides, lensOn, currentStory?.id]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 220);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const hits = useMemo(
    () => searchStory(searchIndex, debouncedQuery),
    [searchIndex, debouncedQuery],
  );

  // Close the results dropdown on an outside click.
  useEffect(() => {
    if (!searchFocused) return;
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [searchFocused]);

  const gotoHit = (hit: SearchHit) => {
    jumpToMessage(hit.id);
    // Clear the query so the reader shows the destination in full context
    // rather than the filtered-to-matches view.
    setSearchQuery('');
    setSearchFocused(false);
  };

  const showResults = searchFocused && debouncedQuery.trim().length >= 2;

  // Views visible under the active preset; the AI assistant is a Cowrite tool.
  const visibleViews = VIEW_BUTTONS.filter(v => groupVisible(v.group, uiMode));
  const aiToolVisible = uiMode === 'all' || uiMode === 'cowrite';
  const activeMode = UI_MODES.find(m => m.mode === uiMode) ?? UI_MODES[3];

  // Switching preset: if it hides the view you're on, land on a visible one,
  // and close the AI assistant if the new preset no longer offers it.
  const changeMode = (m: UiMode) => {
    setUiMode(m);
    const nextViews = VIEW_BUTTONS.filter(v => groupVisible(v.group, m));
    if (!nextViews.some(v => v.mode === viewMode)) setViewMode(nextViews[0].mode);
    if (aiOpen && m !== 'all' && m !== 'cowrite') setAiOpen(false);
  };

  return (
    <div className="sticky top-0 z-40 border-b border-app-border bg-surface/85 backdrop-blur-md">
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => closeStory()}
          title="Back to library"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm hover:bg-app-text/5 transition-colors shrink-0"
        >
          <ArrowLeft size={17} />
          <span className="hidden sm:inline">Library</span>
        </button>
        {currentStory && (
          <div className="min-w-0 hidden md:block">
            <h1 className="font-bold truncate leading-tight">{currentStory.title}</h1>
            <p className="text-[11px] text-muted leading-tight">
              {currentStory.messageCount} messages
              {minutesLeft > 0 && ` · ~${minutesLeft} min left`}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Workspace preset — gates how much of the app is on screen. */}
        <div className="hidden md:flex bg-app-text/5 p-1 rounded-lg" role="tablist" aria-label="Workspace mode">
          {UI_MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              role="tab"
              aria-selected={uiMode === mode}
              onClick={() => changeMode(mode)}
              title={hint}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                uiMode === mode ? 'bg-surface shadow-sm text-accent' : 'opacity-50 hover:opacity-100',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex bg-app-text/5 p-1 rounded-lg">
          {visibleViews.map(({ mode, icon, label }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              title={label}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                viewMode === mode
                  ? 'bg-surface shadow-sm text-accent'
                  : 'opacity-50 hover:opacity-100',
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="relative hidden sm:block" ref={searchRef}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-50" size={14} />
          <input
            id="search-input"
            type="text"
            placeholder="Search story…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchFocused(false); (e.target as HTMLInputElement).blur(); } }}
            className="pl-8 pr-3 py-1.5 text-sm bg-app-text/5 border border-transparent rounded-full focus:outline-none focus:border-accent/50 w-40 focus:w-64 transition-all"
          />
          {showResults && (
            <div className="absolute right-0 top-full mt-2 w-[22rem] max-h-[65vh] overflow-y-auto rounded-xl bg-surface border border-app-border shadow-2xl z-50">
              <div className="sticky top-0 px-3 py-2 text-[11px] font-medium text-muted bg-surface/95 border-b border-app-border/60">
                {hits.length === 0
                  ? 'No matches in this story'
                  : `${hits.length}${hits.length >= 60 ? '+' : ''} match${hits.length === 1 ? '' : 'es'} across the story`}
              </div>
              {hits.map(hit => (
                <button
                  key={hit.id}
                  onClick={() => gotoHit(hit)}
                  className="w-full text-left px-3 py-2 border-b border-app-border/40 last:border-0 hover:bg-app-text/5 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[11px] font-bold truncate">{hit.name || 'Passage'}</span>
                    <span className="text-[10px] text-muted shrink-0 ml-auto font-mono">
                      §{hit.chainIndex + 1}
                      {hit.count > 1 && ` · ${hit.count}×`}
                    </span>
                  </div>
                  <p className="text-[11px] leading-snug opacity-80 line-clamp-2">
                    {hit.pre}
                    <mark className="bg-accent/30 text-app-text rounded-sm px-0.5">{hit.hit}</mark>
                    {hit.post}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setMultiverseOpen(true)}
          title="Multiverse — story map & timelines (M)"
          className="p-2 rounded-lg opacity-60 hover:opacity-100 hover:bg-app-text/5 transition-colors"
        >
          <Network size={18} />
        </button>
        <button
          onClick={() => setCodexOpen(!codexOpen)}
          title="Codex — everything you've met so far (C)"
          className={cn(
            'p-2 rounded-lg transition-colors',
            codexOpen
              ? 'bg-accent/20 text-accent'
              : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
          )}
        >
          <BookMarked size={18} />
        </button>
        <button
          onClick={() => setSheetsOpen(!sheetsOpen)}
          title="Sheets — pinnable tables (S)"
          className={cn(
            'p-2 rounded-lg transition-colors',
            sheetsOpen
              ? 'bg-accent/20 text-accent'
              : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
          )}
        >
          <Table2 size={18} />
        </button>
        {hasOverrides && storyId && (
          <div className="relative" ref={managerRef}>
            <button
              onClick={() => setLensManagerOpen(!lensManagerOpen)}
              title={`Lens — ${lensOn ? 'edits visible' : 'edits hidden'} (${overrides.length})`}
              className={cn(
                'p-2 rounded-lg transition-colors',
                lensOn || lensManagerOpen
                  ? 'bg-amber-500/20 text-amber-500'
                  : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
              )}
            >
              <Pencil size={18} />
            </button>
            {lensManagerOpen && (
              <LensManagerPopover
                storyId={storyId}
                overrides={overrides}
                lensOn={lensOn}
                onClose={() => setLensManagerOpen(false)}
              />
            )}
          </div>
        )}
        {aiToolVisible && (
          <button
            onClick={() => setAiOpen(!aiOpen)}
            title="Reading assistant (AI)"
            className={cn(
              'p-2 rounded-lg transition-colors',
              aiOpen
                ? 'bg-accent/20 text-accent'
                : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
            )}
          >
            <Bot size={18} />
          </button>
        )}
        <button
          onClick={() => setIsAutofocusMode(!isAutofocusMode)}
          title="Autofocus handsfree mode"
          className={cn(
            'p-2 rounded-lg transition-colors',
            isAutofocusMode
              ? 'bg-amber-500/20 text-amber-500'
              : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
          )}
        >
          <Focus size={18} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          className="p-2 rounded-lg opacity-60 hover:opacity-100 hover:bg-app-text/5 transition-colors"
        >
          <Settings size={18} />
        </button>
      </div>
    </div>

      {/* Guided assistance: what the active preset shows, and how to see more. */}
      {uiMode !== 'all' && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-muted border-t border-app-border/50">
          <Info size={12} className="shrink-0 text-accent/70" />
          <span className="min-w-0">
            <b className="text-app-text/80 font-semibold">{activeMode.label} mode</b> — {activeMode.hint}{' '}
            <button onClick={() => changeMode('all')} className="text-accent hover:underline">Show everything</button>
            {' '}or switch presets above.
          </span>
        </div>
      )}
    </div>
  );
};

interface LensManagerPopoverProps {
  storyId: string;
  overrides: import('../types').MessageOverride[];
  lensOn: boolean;
  onClose: () => void;
}

const LensManagerPopover = ({ storyId, overrides, lensOn, onClose }: LensManagerPopoverProps) => {
  const setLensOn = useAuraV2Store(s => s.setLensOn);
  const removeOverride = useAuraV2Store(s => s.removeOverride);
  const clearOverrides = useAuraV2Store(s => s.clearOverrides);
  const jumpToMessage = useAppStore(s => s.jumpToMessage);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div className="absolute right-0 top-full mt-2 w-72 max-h-[70vh] overflow-y-auto rounded-xl bg-surface border border-app-border shadow-2xl p-3 z-50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-bold">Lens edits</span>
        <button onClick={onClose} className="p-1 opacity-50 hover:opacity-100"><X size={14} /></button>
      </div>
      <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={lensOn}
          onChange={(e) => setLensOn(storyId, e.target.checked)}
          className="accent-amber-500"
        />
        Show edits in reader
      </label>
      {overrides.length === 0 ? (
        <p className="text-xs opacity-50">No edits yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {overrides.slice().reverse().map(o => (
            <div key={`${o.messageId}-${o.kind}`} className="text-xs border border-app-border/50 rounded-lg p-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={cn(
                  'px-1 py-0.5 rounded font-medium',
                  o.kind === 'rewrite' ? 'bg-violet-500/15 text-violet-400' : 'bg-emerald-500/15 text-emerald-400',
                )}>
                  {o.kind}
                </span>
                <span className="opacity-50">{new Date(o.createdAt).toLocaleDateString()}</span>
                <button
                  onClick={() => removeOverride(storyId, o.messageId, o.kind)}
                  className="ml-auto text-rose-400 hover:text-rose-300"
                >
                  Revert
                </button>
              </div>
              {o.note && <p className="opacity-70 mb-1 italic">{o.note}</p>}
              <p className="opacity-90 line-clamp-3">{o.content.slice(0, 180)}{o.content.length > 180 ? '…' : ''}</p>
              <button
                onClick={() => { jumpToMessage(o.messageId); onClose(); }}
                className="mt-1.5 text-accent hover:underline"
              >
                Jump to message
              </button>
            </div>
          ))}
          {confirmClear ? (
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => { clearOverrides(storyId); setConfirmClear(false); }}
                className="flex-1 py-1.5 rounded-lg bg-rose-500/20 text-rose-400 text-xs font-medium hover:bg-rose-500/30"
              >
                Confirm clear all
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="flex-1 py-1.5 rounded-lg bg-app-text/10 text-xs hover:bg-app-text/20"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="mt-1 py-1.5 rounded-lg bg-app-text/10 text-xs hover:bg-app-text/20"
            >
              Clear all edits
            </button>
          )}
        </div>
      )}
    </div>
  );
};
