import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BookMarked, BookOpen, Bot, ChevronLeft, ChevronRight, Clapperboard, Film, Focus,
  GitBranch, Highlighter, Info, List, MessageSquare, MoreHorizontal, MoreVertical, Network, Pencil,
  Pin, PinOff, Search, Settings, Table2, Wand2, X,
} from 'lucide-react';
import { useIsMobile, useIsTouch } from '../hooks/useMediaQuery';
import { useAppStore } from '../store';
import { useAuraV2Store, committedCount, flatMessages } from '../stores/useAuraV2Store';
import { wordsPerSecond } from '../hooks/useStreamer';
import { UiMode, ViewMode } from '../types';
import { cn } from '../utils/cn';
import { resolveContent } from '../utils/lens';
import { buildSearchIndex, searchStory, SearchHit } from '../utils/storySearch';
import { VIEW_HINT, VIEW_LABEL, overflowViews, resolveVisibleViews } from '../utils/viewBar';

/** The one thing the bar owns that a pure module can't: the icons. */
const VIEW_ICON: Record<ViewMode, React.ReactNode> = {
  storybook: <BookOpen size={18} />,
  book: <BookMarked size={18} />,
  stage: <Clapperboard size={18} />,
  vn: <Film size={18} />,
  sandbox: <Wand2 size={18} />,
  chat: <MessageSquare size={18} />,
  branches: <GitBranch size={18} />,
  overview: <List size={18} />,
  highlights: <Highlighter size={18} />,
};

/** The workspace presets, in order, with a one-line "what this reveals" hint. */
const UI_MODES: { mode: UiMode; label: string; hint: string }[] = [
  { mode: 'read', label: 'Read', hint: 'Just the reading views — no AI tools in the way.' },
  { mode: 'cowrite', label: 'Cowrite', hint: 'Adds the AI writing assistant and the Chat view.' },
  { mode: 'scenes', label: 'Scenes', hint: 'Adds the Sandbox view and the Scene Director.' },
  { mode: 'all', label: 'All', hint: 'Everything, unfiltered.' },
];

export const TopNavigation = () => {
  const currentStory = useAppStore(s => s.currentStory);
  const renameStory = useAppStore(s => s.renameStory);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const commitRename = () => {
    setRenaming(false);
    const next = draftTitle.trim();
    if (currentStory && next && next !== currentStory.title) {
      void renameStory(currentStory.id, next);
    }
  };
  const viewMode = useAppStore(s => s.viewMode);
  const setViewMode = useAppStore(s => s.setViewMode);
  const uiMode = useAppStore(s => s.uiMode);
  const setUiMode = useAppStore(s => s.setUiMode);
  const visibleViews = useAppStore(s => s.visibleViews);
  const toggleVisibleView = useAppStore(s => s.toggleVisibleView);
  const moveVisibleView = useAppStore(s => s.moveVisibleView);
  const resetVisibleViews = useAppStore(s => s.resetVisibleViews);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewsRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  // Width decides the LAYOUT; the input device decides the SIZE. A landscape
  // phone and a tablet are wide enough for the desktop header and still have
  // no mouse — sizing off `isMobile` alone left them with 30px icon targets.
  const touchSized = useIsTouch() || isMobile;
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
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

  // Close the view menu on an outside click.
  useEffect(() => {
    if (!viewMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) setViewMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [viewMenuOpen]);

  // Same for the phone's tool menu.
  useEffect(() => {
    if (!toolsOpen) return;
    const handler = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [toolsOpen]);

  // Escape closes whichever header menu is open. Every other panel in Aura
  // does this; these two were only dismissible by clicking away.
  useEffect(() => {
    if (!toolsOpen && !viewMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();      // don't also exit autofocus / close the reader
      setToolsOpen(false);
      setViewMenuOpen(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [toolsOpen, viewMenuOpen]);

  // A menu built for the phone layout must not survive a rotation to landscape
  // or a window resize — its button stops rendering and the panel would orphan.
  useEffect(() => { if (!isMobile) setToolsOpen(false); }, [isMobile]);

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

  // The bar the reader actually sees: their pins if they've made any, the
  // preset's seed otherwise. The view they're ON is always shown, pinned or not.
  const shownViews = resolveVisibleViews(visibleViews, uiMode, viewMode);
  const hiddenViews = overflowViews(shownViews);
  const aiToolVisible = uiMode === 'all' || uiMode === 'cowrite';
  const activeMode = UI_MODES.find(m => m.mode === uiMode) ?? UI_MODES[3];

  // Switching preset re-seeds the bar only while it's still ours to seed —
  // once the reader has pinned anything, the preset stops touching it. The
  // AI assistant still closes when the new preset no longer offers it.
  const changeMode = (m: UiMode) => {
    setUiMode(m);
    if (aiOpen && m !== 'all' && m !== 'cowrite') setAiOpen(false);
  };

  /**
   * The header's tools, declared once.
   *
   * A desktop renders them as icons in the bar; a phone renders them as
   * labelled rows in a menu. Same list either way — the two presentations
   * cannot drift, and adding a tool needs one entry, not two.
   *
   * `warm` marks the tools that use the amber "this is altering your reading"
   * treatment rather than the accent, matching what shipped.
   */
  const tools: {
    id: string; label: string; hint: string; icon: React.ReactNode;
    active?: boolean; warm?: boolean; onClick: () => void;
  }[] = [
    {
      id: 'multiverse', label: 'Multiverse', hint: 'Multiverse — story map & timelines (M)',
      icon: <Network size={18} />, onClick: () => setMultiverseOpen(true),
    },
    {
      id: 'codex', label: 'Codex', hint: "Codex — everything you've met so far (C)",
      icon: <BookMarked size={18} />, active: codexOpen, onClick: () => setCodexOpen(!codexOpen),
    },
    {
      id: 'sheets', label: 'Sheets', hint: 'Sheets — pinnable tables (S)',
      icon: <Table2 size={18} />, active: sheetsOpen, onClick: () => setSheetsOpen(!sheetsOpen),
    },
    ...(aiToolVisible ? [{
      id: 'ai', label: 'Assistant', hint: 'Reading assistant (AI)',
      icon: <Bot size={18} />, active: aiOpen, onClick: () => setAiOpen(!aiOpen),
    }] : []),
    {
      id: 'autofocus', label: 'Autofocus', hint: 'Autofocus handsfree mode',
      icon: <Focus size={18} />, active: isAutofocusMode, warm: true,
      onClick: () => setIsAutofocusMode(!isAutofocusMode),
    },
    {
      id: 'settings', label: 'Settings', hint: 'Settings',
      icon: <Settings size={18} />, onClick: () => setSettingsOpen(true),
    },
  ];

  /** The phone's tool menu: labels, and targets a thumb can actually hit. */
  const toolsMenu = (
    <div className="absolute right-0 top-full mt-2 w-60 rounded-xl bg-surface border border-app-border shadow-2xl p-1 z-50">
      {tools.map(t => (
        <button
          key={t.id}
          onClick={() => { t.onClick(); setToolsOpen(false); }}
          className={cn(
            'w-full flex items-center gap-3 px-3 min-h-11 rounded-lg text-sm text-left transition-colors',
            t.active ? (t.warm ? 'text-amber-500' : 'text-accent') : 'hover:bg-app-text/5',
          )}
        >
          <span className="shrink-0 opacity-80">{t.icon}</span>
          <span className="min-w-0 truncate">{t.label}</span>
          {t.active && <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70">on</span>}
        </button>
      ))}
      {hasOverrides && storyId && (
        <button
          onClick={() => { setLensOn(storyId, !lensOn); setToolsOpen(false); }}
          className={cn(
            'w-full flex items-center gap-3 px-3 min-h-11 rounded-lg text-sm text-left transition-colors',
            lensOn ? 'text-amber-500' : 'hover:bg-app-text/5',
          )}
        >
          <span className="shrink-0 opacity-80"><Pencil size={18} /></span>
          <span className="min-w-0 truncate">Lens edits ({overrides.length})</span>
          <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70">
            {lensOn ? 'shown' : 'hidden'}
          </span>
        </button>
      )}
      {/* Search is an input, not a row — a phone has no room for it in the bar,
        * so it lives at the foot of this menu where it can be full width. */}
      <div className="border-t border-app-border/60 mt-1 pt-1 px-1 pb-1">
        <input
          type="text"
          placeholder="Search story…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          aria-label="Search story"
          className="w-full min-h-10 px-3 text-sm bg-app-text/5 border border-transparent rounded-lg focus:outline-none focus:border-accent/50"
        />
      </div>
    </div>
  );

  /**
   * Built once and PLACED, not rendered twice.
   *
   * On a phone this sits in its own row under the title; on a desktop it sits
   * inline in the header. Rendering two copies behind `hidden sm:flex` would
   * give `viewsRef` two candidate nodes — React would attach it to whichever
   * mounted last, and the outside-click that closes the overflow menu would
   * silently stop working on one of them.
   */
  const viewButtons = shownViews.map(mode => (
    <button
      key={mode}
      data-view={mode}
      onClick={() => setViewMode(mode)}
      title={VIEW_LABEL[mode]}
      aria-label={VIEW_LABEL[mode]}
      className={cn(
        'rounded-md transition-colors shrink-0 flex items-center justify-center',
        touchSized ? 'min-h-10 min-w-10' : 'p-1.5',
        viewMode === mode
          ? 'bg-surface shadow-sm text-accent'
          : 'opacity-50 hover:opacity-100',
      )}
    >
      {VIEW_ICON[mode]}
    </button>
  ));

  const viewBar = (
    <div
      className="flex min-w-0 flex-1 bg-app-text/5 p-1 rounded-lg"
      ref={viewsRef}
    >
      {/* The strip scrolls rather than shrinking its buttons past the point of
        * being tappable, at every width — nine icons do not fit a phone, and
        * they do not fit beside the presets, search and six tools on a
        * landscape phone or a half-width desktop window either.
        *
        * The scroller wraps ONLY the buttons: `overflow-x` establishes a
        * clipping context in BOTH axes, so an absolutely-positioned menu
        * inside it is invisible — which is exactly what happened when the
        * overflow button lived in here. It stays outside, pinned to the end,
        * where it is also always reachable without scrolling. */}
      <div className="flex min-w-0 flex-1 overflow-x-auto no-scrollbar">{viewButtons}</div>
      <div className="relative shrink-0">
        <button
          onClick={() => setViewMenuOpen(!viewMenuOpen)}
          title="All views — pin the ones you use"
          aria-label="All views"
          aria-expanded={viewMenuOpen}
          data-testid="view-overflow"
          className={cn(
            'rounded-md transition-colors flex items-center justify-center',
            touchSized ? 'min-h-10 min-w-10' : 'p-1.5',
            viewMenuOpen ? 'bg-surface shadow-sm text-accent' : 'opacity-50 hover:opacity-100',
          )}
        >
          <MoreHorizontal size={18} />
        </button>
        {viewMenuOpen && (
          <ViewMenu
            shown={shownViews}
            hidden={hiddenViews}
            active={viewMode}
            customised={!!visibleViews}
            onPick={(m) => { setViewMode(m); setViewMenuOpen(false); }}
            onToggle={toggleVisibleView}
            onMove={moveVisibleView}
            onReset={resetVisibleViews}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="sticky top-0 z-40 border-b border-app-border bg-surface/85 backdrop-blur-md">
    <div className="flex items-center justify-between gap-2 sm:gap-3 px-2 sm:px-4 py-1.5 sm:py-3">
      <div className="flex items-center gap-1 sm:gap-3 min-w-0 flex-1 sm:flex-none">
        <button
          onClick={() => closeStory()}
          title="Back to library"
          aria-label="Back to library"
          className={cn(
            'flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm hover:bg-app-text/5 transition-colors shrink-0',
            touchSized && 'min-h-11 min-w-11',
          )}
        >
          <ArrowLeft size={17} />
          <span className="hidden sm:inline">Library</span>
        </button>
        {currentStory && (
          // The title earns its space on a phone now that the tool cluster has
          // collapsed into a menu — without it the bar is anonymous icons.
          <div className="min-w-0 block">
            {/* Click to rename. Imports take their title from the card, which in
              * a lot of exports is a placeholder ("unused"), so there has to be
              * a way to name the chat — and the title itself is the obvious
              * place to look for it. */}
            {renaming ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') { setRenaming(false); e.currentTarget.blur(); }
                }}
                aria-label="Chat name"
                data-testid="story-title-input"
                className="font-bold leading-tight bg-transparent border-b border-accent/60 outline-none w-48"
              />
            ) : (
              <h1
                onClick={() => { setDraftTitle(currentStory.title); setRenaming(true); }}
                title="Click to rename this chat"
                data-testid="story-title"
                className="font-bold truncate leading-tight cursor-text hover:text-accent transition-colors"
              >
                {currentStory.title}
              </h1>
            )}
            <p className="text-[11px] text-muted leading-tight">
              {currentStory.messageCount} messages
              {minutesLeft > 0 && ` · ~${minutesLeft} min left`}
            </p>
          </div>
        )}
      </div>

      {/* On a phone the view bar drops to its own row below — see `viewBar`. */}
      {!isMobile && (
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
          {/* Workspace preset — gates how much of the app is on screen. */}
          <div className="hidden lg:flex shrink-0 bg-app-text/5 p-1 rounded-lg" role="tablist" aria-label="Workspace mode">
            {UI_MODES.map(({ mode, label, hint }) => (
              <button
                key={mode}
                role="tab"
                aria-selected={uiMode === mode}
                onClick={() => changeMode(mode)}
                title={hint}
                className={cn(
                  'px-2.5 rounded-md text-xs font-medium transition-colors',
                  touchSized ? 'min-h-10' : 'py-1',
                  uiMode === mode ? 'bg-surface shadow-sm text-accent' : 'opacity-50 hover:opacity-100',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {viewBar}
        </div>
      )}

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
            className={cn(
              'pl-8 pr-3 text-sm bg-app-text/5 border border-transparent rounded-full focus:outline-none focus:border-accent/50 w-40 focus:w-64 transition-all',
              touchSized ? 'min-h-11' : 'py-1.5',
            )}
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
        {/* Desktop: the tools as bare icons. Phone: one button, a labelled
          * menu behind it — see `toolsMenu`. Both read from `tools`, so a tool
          * added in one place cannot go missing in the other. */}
        {!isMobile && tools.map(t => (
          <button
            key={t.id}
            onClick={t.onClick}
            title={t.hint}
            // The hint, not the short label: an icon-only button's accessible
            // name is all a screen reader gets, and "Assistant" does not say
            // what it assists with.
            aria-label={t.hint}
            className={cn(
              'rounded-lg transition-colors',
              touchSized ? 'flex items-center justify-center min-h-11 min-w-11' : 'p-2',
              t.active
                ? (t.warm ? 'bg-amber-500/20 text-amber-500' : 'bg-accent/20 text-accent')
                : 'opacity-60 hover:opacity-100 hover:bg-app-text/5',
            )}
          >
            {t.icon}
          </button>
        ))}
        {!isMobile && hasOverrides && storyId && (
          <div className="relative" ref={managerRef}>
            <button
              onClick={() => setLensManagerOpen(!lensManagerOpen)}
              title={`Lens — ${lensOn ? 'edits visible' : 'edits hidden'} (${overrides.length})`}
              className={cn(
                'rounded-lg transition-colors',
                touchSized ? 'flex items-center justify-center min-h-11 min-w-11' : 'p-2',
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
        {isMobile && (
          <div className="relative shrink-0" ref={toolsRef}>
            <button
              onClick={() => setToolsOpen(!toolsOpen)}
              aria-label="Tools"
              aria-expanded={toolsOpen}
              data-testid="tools-menu"
              className={cn(
                'min-h-11 min-w-11 flex items-center justify-center rounded-lg transition-colors',
                toolsOpen ? 'bg-accent/20 text-accent' : 'opacity-70 hover:bg-app-text/5',
              )}
            >
              <MoreVertical size={20} />
            </button>
            {toolsOpen && toolsMenu}
          </div>
        )}
      </div>
    </div>

    {/* Phone: the view bar gets its own row rather than fighting the title for
      * space. Nine icons will not fit beside a title at 390px, and squeezing
      * them was what pushed the whole header to 592px and knocked the fixed
      * playback bar off the centre of the screen. */}
    {isMobile && (
      <div className="flex items-center gap-2 px-2 pb-1.5">
        {viewBar}
      </div>
    )}

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

interface ViewMenuProps {
  shown: ViewMode[];
  hidden: ViewMode[];
  active: ViewMode;
  customised: boolean;
  onPick: (view: ViewMode) => void;
  onToggle: (view: ViewMode) => void;
  onMove: (view: ViewMode, direction: -1 | 1) => void;
  onReset: () => void;
}

/**
 * Every view, always — the pinned ones in the reader's order, then the rest.
 * This list is where views are DISCOVERED, so it never filters and never hides
 * a section: unpinning moves a view down the menu, it doesn't remove it.
 */
const ViewMenu = ({ shown, hidden, active, customised, onPick, onToggle, onMove, onReset }: ViewMenuProps) => {
  const row = (view: ViewMode, pinned: boolean, idx: number) => (
    <div
      key={view}
      className={cn(
        'group flex items-center gap-1 rounded-lg px-2 py-1.5 min-h-11 hover:bg-app-text/5 transition-colors',
        active === view && 'bg-accent/10',
      )}
    >
      <button
        onClick={() => onPick(view)}
        className="flex items-center gap-2 min-w-0 flex-1 self-stretch text-left"
      >
        <span className={cn('shrink-0', active === view ? 'text-accent' : 'opacity-60')}>
          {VIEW_ICON[view]}
        </span>
        <span className="min-w-0">
          <span className={cn('block text-xs font-medium truncate', active === view && 'text-accent')}>
            {VIEW_LABEL[view]}
          </span>
          <span className="block text-[10px] text-muted leading-tight truncate">{VIEW_HINT[view]}</span>
        </span>
      </button>
      {pinned && (
        <span className="flex opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onMove(view, -1)}
            disabled={idx === 0}
            title="Move left"
            aria-label="Move left"
            className="flex items-center justify-center min-h-10 min-w-10 opacity-60 hover:opacity-100 disabled:opacity-20"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            onClick={() => onMove(view, 1)}
            disabled={idx === shown.length - 1}
            title="Move right"
            aria-label="Move right"
            className="flex items-center justify-center min-h-10 min-w-10 opacity-60 hover:opacity-100 disabled:opacity-20"
          >
            <ChevronRight size={13} />
          </button>
        </span>
      )}
      <button
        onClick={() => onToggle(view)}
        title={pinned ? 'Unpin from the bar' : 'Pin to the bar'}
        data-testid={`view-pin-${view}`}
        className={cn(
          'flex items-center justify-center min-h-10 min-w-10 rounded shrink-0 transition-colors',
          pinned ? 'text-accent hover:bg-accent/15' : 'opacity-40 hover:opacity-100 hover:bg-app-text/10',
        )}
      >
        {pinned ? <Pin size={13} /> : <PinOff size={13} />}
      </button>
    </div>
  );

  return (
    <div
      data-testid="view-menu"
      className="absolute right-0 top-full mt-2 w-72 max-h-[70vh] overflow-y-auto rounded-xl bg-surface border border-app-border shadow-2xl p-2 z-50"
    >
      <div className="px-2 pt-1 pb-2 text-[10px] uppercase tracking-wide text-muted">On the bar</div>
      {shown.map((v, i) => row(v, true, i))}
      {hidden.length > 0 && (
        <>
          <div className="px-2 pt-3 pb-2 text-[10px] uppercase tracking-wide text-muted">More views</div>
          {hidden.map(v => row(v, false, -1))}
        </>
      )}
      {customised && (
        <button
          onClick={onReset}
          className="mt-2 w-full min-h-10 rounded-lg bg-app-text/5 text-[11px] text-muted hover:bg-app-text/10 hover:text-app-text transition-colors"
        >
          Reset to the workspace default
        </button>
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
