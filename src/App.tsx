import React, { lazy, Suspense, useEffect, useState } from 'react';
import { TopNavigation } from './components/TopNavigation';
import { PlaybackControls } from './components/PlaybackControls';
import { ReaderDisplay } from './components/ReaderDisplay';
import { BookView } from './components/BookView';
import { StageView } from './components/StageView';
import { VNView } from './components/VNView';
import { SandboxView } from './components/SandboxView';
import { OverviewMode } from './components/OverviewMode';
import { HighlightsMode } from './components/HighlightsMode';
import { BranchesMode } from './components/BranchesMode';
import { AutoFormatModal } from './components/AutoFormatModal';
import { RefineModal } from './components/RefineModal';

// AI panel pulls in KaTeX — load it only when opened.
const AIChat = lazy(() => import('./components/AIChat').then(m => ({ default: m.AIChat })));
import { SettingsPanel } from './components/SettingsPanel';
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
import { accentHex, resolveTheme } from './themes';
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
};

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
  const aiOpen = useAppStore(s => s.aiOpen);
  const loadFonts = useFontStore(s => s.loadFonts);
  const loadSprites = useSpriteStore(s => s.loadSprites);
  const loadBackdrops = useBackdropStore(s => s.loadBackdrops);
  const customFonts = useFontStore(s => s.fonts);
  const [showAutoFormat, setShowAutoFormat] = useState(false);
  const [showRefine, setShowRefine] = useState(false);

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
    root.style.setProperty('--app-accent', accentHex(accentColor) || themeDef.vars.accent);
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
          ) : viewMode === 'sandbox' ? (
            <SandboxView />
          ) : (
            <ReaderDisplay />
          )}
          <PlaybackControls />
        </>
      )}

      <SettingsPanel onOpenAutoFormat={() => setShowAutoFormat(true)} onOpenRefine={() => setShowRefine(true)} />
      {showAutoFormat && <AutoFormatModal onClose={() => setShowAutoFormat(false)} />}
      {showRefine && <RefineModal onClose={() => setShowRefine(false)} />}
      {aiOpen && screen === 'reader' && (
        <Suspense fallback={null}>
          <AIChat />
        </Suspense>
      )}
      <SceneSoundscape />
    </div>
  );
}
