import React, { lazy, Suspense, useEffect, useState } from 'react';
import { TopNavigation } from './components/TopNavigation';
import { PlaybackControls } from './components/PlaybackControls';
import { ReaderDisplay } from './components/ReaderDisplay';
import { BookView } from './components/BookView';
import { StageView } from './components/StageView';
import { VNView } from './components/VNView';
import { RpgView } from './components/RpgView';
import { ReadingSpotlight } from './components/ReadingSpotlight';
import { SandboxView } from './components/SandboxView';
import { OverviewMode } from './components/OverviewMode';
import { HighlightsMode } from './components/HighlightsMode';
import { BranchesMode } from './components/BranchesMode';
import { AutoFormatModal } from './components/AutoFormatModal';
import { SyncPanel } from './components/SyncPanel';
import { CowriterHost } from './components/CowriterHost';
import { PeekHost } from './components/PeekHost';
import { EditorViewHost } from './components/EditorViewHost';
import { ProxyHost } from './components/ProxyHost';
import { ProxyPanel } from './components/ProxyPanel';
import { BackupPanel } from './components/BackupPanel';
import { AlertHost } from './components/AlertHost';
import { CompletionPanel } from './components/CompletionPanel';
import { TourHost } from './components/TourHost';
import { SmartExportModal } from './components/SmartExportModal';
import { useStBridge } from './hooks/useStBridge';
import { useExeBridge } from './hooks/useExeBridge';
import { useBlendedChains } from './hooks/useBlendedChains';
import { bridgeToken, isDesktop } from './utils/exeBridge';

// AI panel pulls in KaTeX — load it only when opened.
const AIChat = lazy(() => import('./components/AIChat').then(m => ({ default: m.AIChat })));
/* Lazy for one reason: it is the only thing in the app that uses `compromise`,
 * and `compromise` is 351 kB — a third of everything the reader downloads
 * before the library appears, for a workbench most of them never open. Every
 * sibling modal here was already lazy; this one was imported at the top and so
 * was its NLP. */
const RefineModal = lazy(() => import('./components/RefineModal').then(m => ({ default: m.RefineModal })));

/**
 * The three shape views, split out of the main bundle.
 *
 * Each carries a layout engine of its own — a screenplay formatter, a comic
 * pager, a map — and none of them is on the bar by default, so a reader who
 * never opens one should never download one. The same reasoning already applies
 * to the AI assistant and the Multiverse.
 */
const ScriptView = lazy(() => import('./components/ScriptView').then(m => ({ default: m.ScriptView })));
const PanelsView = lazy(() => import('./components/PanelsView').then(m => ({ default: m.PanelsView })));
const AtlasView = lazy(() => import('./components/AtlasView').then(m => ({ default: m.AtlasView })));
const WorkspaceView = lazy(() => import('./components/WorkspaceView').then(m => ({ default: m.WorkspaceView })));
import { SettingsPanel } from './components/SettingsPanel';
import { AiActivityMeter } from './components/AiActivityMeter';
import { LivingBackground } from './components/LivingBackground';
import { Library } from './components/Library';
import { useStreamer } from './hooks/useStreamer';
import { useTTS } from './hooks/useTTS';
import { useAmbient } from './hooks/useAmbient';
import { useSceneSfx } from './hooks/useSceneSfx';
import { SceneSoundscape } from './components/SceneSoundscape';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAppStore } from './store';
import { customFamilyFor, useFontStore } from './stores/useFontStore';
import { useSpriteStore } from './stores/useSpriteStore';
import { useBackdropStore } from './stores/useBackdropStore';
import { accentHex, readableInk, resolveTheme } from './themes';
import { watchPointer } from './utils/uiContext';
import { cn } from './utils/cn';

const FONT_CLASS: Record<string, string> = {
  sans: 'font-sans',
  serif: 'font-serif',
  mono: 'font-mono',
  handwriting: 'font-handwriting',
  typewriter: 'font-typewriter',
  dyslexic: 'font-dyslexic',
  rounded: 'font-rounded',
  slab: 'font-slab',
  medieval: 'font-medieval',
  comic: 'font-comic',
  calligraphy: 'font-calligraphy',
};

/** Holds the reading area's shape while a split-out view loads. */
const ViewLoading = () => <div className="flex-1 min-h-0" aria-hidden="true" />;

export default function App() {
  useStreamer();
  useTTS();
  useAmbient();
  useSceneSfx();
  useKeyboardShortcuts();

  const screen = useAppStore(s => s.screen);
  const viewMode = useAppStore(s => s.viewMode);
  const theme = useAppStore(s => s.theme);
  const accentColor = useAppStore(s => s.accentColor);
  const bgColor = useAppStore(s => s.bgColor);
  const textColor = useAppStore(s => s.textColor);
  const fontFamily = useAppStore(s => s.fontFamily);
  const themeEffects = useAppStore(s => s.themeEffects);
  const expressiveText = useAppStore(s => s.expressiveText);
  const expressiveIntensity = useAppStore(s => s.expressiveIntensity);
  const initLibrary = useAppStore(s => s.initLibrary);
  const aiTourGuide = useAppStore(s => s.aiTourGuide);
  const aiOpen = useAppStore(s => s.aiOpen);
  const aiEmbedded = useAppStore(s => s.aiEmbedded);
  const stSyncEnabled = useAppStore(s => s.stSyncEnabled);
  const loadFonts = useFontStore(s => s.loadFonts);
  const loadSprites = useSpriteStore(s => s.loadSprites);
  const loadBackdrops = useBackdropStore(s => s.loadBackdrops);
  const customFonts = useFontStore(s => s.fonts);
  const [showAutoFormat, setShowAutoFormat] = useState(false);
  const [showRefine, setShowRefine] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showProxy, setShowProxy] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showCompletions, setShowCompletions] = useState(false);
  const [showExport, setShowExport] = useState(false);

  /**
   * The bridge, when a SillyTavern extension opened this window.
   *
   * Returns null — and attaches no listener at all — for everyone else and for
   * anyone who has not switched the sync on, so a reader who has never
   * installed the extension runs none of it. When one HAS opened us, the panel
   * opens itself: they clicked "sync" over there, and making them find a menu
   * item here to finish the thing they already started would be a strange
   * place to stop.
   */
  const stBridge = useStBridge();
  useEffect(() => { if (stBridge) setShowSync(true); }, [!!stBridge]);

  /**
   * The same conversation over a socket, for the desktop build.
   *
   * Passed `showSync` rather than being mounted conditionally, because the
   * listener's lifetime IS this flag: it opens when the reader opens the sync
   * and closes when they leave it. A hook cannot be called conditionally, so
   * the condition goes inside it.
   *
   * There is no `setShowSync` here to match the browser's: nothing over there
   * can open this window, so the reader is always the one who started it.
   */
  const exeBridge = useExeBridge(showSync && stSyncEnabled);
  // Keeps `chains` in step with the reader's blends — see the hook.
  useBlendedChains();

  /**
   * The library asked for a story's sync panel.
   *
   * Opening a story is async, so the library sets a flag and this waits for the
   * story to actually be open before showing the panel — the panel reads the
   * open story, and showing it a beat early would show it the previous one.
   */
  /*
   * Let the guide know what the reader is pointing at.
   *
   * Only while the guide is switched on, and only ever recorded locally — the
   * value is read when a tool asks and never sent otherwise. That is the whole
   * difference between "what does this button do?" being answerable and the app
   * shipping somebody's cursor to a model all evening. See `utils/uiContext`.
   */
  useEffect(() => {
    if (!aiTourGuide) return;
    return watchPointer();
  }, [aiTourGuide]);

  const syncRequestId = useAppStore(s => s.syncRequestId);
  const openStoryId = useAppStore(s => s.currentStory?.id);
  useEffect(() => {
    if (!syncRequestId) return;
    if (openStoryId !== syncRequestId) return;
    setShowSync(true);
    useAppStore.setState({ syncRequestId: null });
  }, [syncRequestId, openStoryId]);

  useEffect(() => {
    void initLibrary();
    void loadFonts();
    void loadSprites();
    void loadBackdrops();
  }, [initLibrary, loadFonts, loadSprites, loadBackdrops]);

  const themeDef = resolveTheme(theme, bgColor, textColor);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', themeDef.isDark);
    root.style.setProperty('--app-bg', themeDef.vars.bg);
    root.style.setProperty('--app-surface', themeDef.vars.surface);
    root.style.setProperty('--app-text', themeDef.vars.text);
    root.style.setProperty('--app-muted', themeDef.vars.muted);
    const accent = accentHex(accentColor) || themeDef.vars.accent;
    root.style.setProperty('--app-accent', accent);
    // What can be read ON the accent. Every solid accent surface uses this
    // rather than a hard-coded white — see `readableInk`.
    root.style.setProperty('--app-accent-ink', readableInk(accent));
    root.style.setProperty('--app-border', themeDef.vars.border);
    root.style.setProperty('--bubble-ai', themeDef.vars.bubbleAi);
    root.style.setProperty('--bubble-user', themeDef.vars.bubbleUser);
    root.style.setProperty('--bubble-user-text', themeDef.vars.bubbleUserText);
  }, [themeDef, accentColor]);

  // 'theme' = follow the theme's signature font; anything else is the
  // reader's explicit choice and wins on every theme.
  const effectiveFont = fontFamily === 'theme' ? (themeDef.font ?? 'sans') : fontFamily;
  // A user-uploaded font is applied inline (it has no Tailwind class); built-in
  // fonts use their utility class. Falls back cleanly if the custom id is gone.
  const customFamily = customFamilyFor(effectiveFont, customFonts);

  return (
    <div
      className={cn(
        // h-dvh, not h-screen: on mobile browsers 100vh is the viewport with the
        // URL bar RETRACTED, so the bottom of the app — where the playback bar
        // lives — sits under the browser chrome until you scroll. dvh tracks the
        // visible viewport. Falls back to vh on anything that lacks it.
        'h-dvh flex flex-col bg-app-bg text-app-text transition-colors duration-500',
        customFamily ? 'font-sans' : (FONT_CLASS[effectiveFont] ?? 'font-sans'),
        // Marks "reader follows the theme" — lets themes with a strong
        // identity (pixel faces) apply their own without fighting a choice.
        fontFamily === 'theme' && !customFamily && 'stock-font',
        themeDef.rootClass,
        // Intensity for the Director's typographic treatment. On the ROOT, so
        // every view inherits it — Stage, VN, Book and Sandbox render their own
        // markup and never had ReaderDisplay's `.reader-page` to inherit from.
        expressiveText && `expr-${expressiveIntensity}`,
        !themeEffects && 'no-effects',
      )}
      style={customFamily ? { fontFamily: `"${customFamily}", var(--font-sans)` } : undefined}
    >
      <LivingBackground />
      {screen === 'library' ? (
        <Library />
      ) : (
        <>
          <TopNavigation />
          {viewMode === 'overview' ? (
            <OverviewMode />
          ) : viewMode === 'highlights' ? (
            <HighlightsMode />
          ) : viewMode === 'branches' ? (
            <BranchesMode />
          ) : viewMode === 'book' ? (
            <BookView />
          ) : viewMode === 'stage' ? (
            <StageView />
          ) : viewMode === 'vn' ? (
            <VNView />
          ) : viewMode === 'rpg' ? (
            <RpgView />
          ) : viewMode === 'script' ? (
            <Suspense fallback={<ViewLoading />}><ScriptView /></Suspense>
          ) : viewMode === 'panels' ? (
            <Suspense fallback={<ViewLoading />}><PanelsView /></Suspense>
          ) : viewMode === 'atlas' ? (
            <Suspense fallback={<ViewLoading />}><AtlasView /></Suspense>
          ) : viewMode === 'sandbox' ? (
            <SandboxView />
          ) : viewMode === 'workspace' ? (
            <Suspense fallback={<ViewLoading />}><WorkspaceView /></Suspense>
          ) : (
            <ReaderDisplay />
          )}
          <PlaybackControls />
        </>
      )}

      <SettingsPanel
        onOpenAutoFormat={() => setShowAutoFormat(true)}
        onOpenRefine={() => setShowRefine(true)}
        onOpenSync={() => setShowSync(true)}
        onOpenProxy={() => setShowProxy(true)}
        onOpenSmartExport={() => setShowExport(true)}
        onOpenBackup={() => setShowBackup(true)}
        onOpenCompletions={() => setShowCompletions(true)}
      />
      {/* The reading magnifier. At the ROOT, not inside a view: it is a
        * viewport-fixed scrim positioned from the words' own coordinates, so
        * mounting it once gives every view the same magnifier — see
        * components/ReadingSpotlight. */}
      <ReadingSpotlight />
      {/* How much the AI is doing, anywhere in the app — see utils/aiActivity. */}
      <AiActivityMeter />
      {/* The cowriter's note. At the root beside the reader's companions, and on
        * the other side of the page — see components/CowriterHost. */}
      <CowriterHost />
      {/* Reading the small print. At the root because it deliberately sits
        * OUTSIDE the settings drawer — see components/PeekHost. */}
      <PeekHost />
      {/* The cowriter's editor view, and the mark that opens it in the views
        * that have no selection popover — see components/EditorViewHost. */}
      <EditorViewHost />
      {showAutoFormat && <AutoFormatModal onClose={() => setShowAutoFormat(false)} />}
      {showRefine && (
        <Suspense fallback={null}><RefineModal onClose={() => setShowRefine(false)} /></Suspense>
      )}
      {showExport && <SmartExportModal onClose={() => setShowExport(false)} />}
      {/* The SillyTavern endpoint itself — no UI, and deliberately OUTSIDE the
        * dialog below. The reader turns it on and closes the dialog to go and
        * write; the requests have to keep being answered. See ProxyHost. */}
      <ProxyHost />
      {showProxy && <ProxyPanel onClose={() => setShowProxy(false)} />}
      {showSync && (
        <SyncPanel
          onClose={() => setShowSync(false)}
          desktop={isDesktop()
            ? {
              address: exeBridge?.address ?? null,
              token: bridgeToken(),
              error: exeBridge?.error ?? null,
            }
            : undefined}
          bridge={stBridge
            ? {
              chatId: stBridge.chat.chatId,
              file: stBridge.chat.file,
              inbox: stBridge.inbox,
              send: stBridge.send,
            }
            // The desktop socket only counts as a bridge once a chat has
            // actually come over it — before that there is nothing to align
            // against, and a panel offering to sync an empty file is worse
            // than one saying it is waiting.
            : exeBridge?.chat
              ? {
                chatId: exeBridge.chat.chatId,
                file: exeBridge.chat.file,
                inbox: exeBridge.inbox,
                send: exeBridge.send,
              }
              : undefined}
        />
      )}
      {/* One assistant, one conversation, one mount. A view that hosts it in a
        * column of its own sets `aiEmbedded`, and the floating copy stands
        * down — two mounts would be two chats writing into one thread. */}
      {aiOpen && screen === 'reader' && !aiEmbedded && (
        <Suspense fallback={null}>
          <AIChat />
        </Suspense>
      )}
      {showBackup && <BackupPanel onClose={() => setShowBackup(false)} />}
      {showCompletions && <CompletionPanel onClose={() => setShowCompletions(false)} />}
      {/* The app's only notification surface. At the ROOT so a storage failure
        * raised from lib/ during startup has somewhere to land — see
        * utils/alerts for why console.error was not enough. */}
      {/* Guided tours, at the root: one crosses the library, the reader, a
        * view switch and a panel before it is done, and anything mounted
        * inside a screen would unmount as it worked. */}
      <TourHost />
      <AlertHost />
      <SceneSoundscape />
    </div>
  );
}
