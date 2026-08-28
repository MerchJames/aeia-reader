import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { THEMES } from '../themes';
import { cn } from '../utils/cn';
import { HIGHLIGHT_COLORS, Message, PinFormat } from '../types';
import { paintHighlights } from '../utils/highlightPaint';
import { resolveContent } from '../utils/lens';
import { readerEmphasis } from '../utils/performMarkup';
import { mergePerformCues } from '../utils/scenePerform';
import { resolveWeather } from '../utils/sceneWeather';
import { useSceneVfx, useSceneWeather } from '../hooks/useSceneWeather';
import { SceneVfx } from './SceneVfx';
import { SceneFx } from './SceneFx';
import { useEntityHighlighter } from './EntityTooltip';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { useScenes } from '../hooks/useScenes';
import { SceneAtmosphere } from './SceneAtmosphere';
import { SceneSpine } from './SceneSpine';
import { motion, AnimatePresence } from 'motion/react';
import { MessageBlock } from './MessageBlock';
import { SelectionPopover } from './SelectionPopover';
import { AnnotationThread } from './AnnotationThread';
import { AskCharacter } from './AskCharacter';
import { LiveReactor } from './LiveReactor';
import { SceneImageModal } from './SceneImageModal';
import { deleteArt, releaseArtUrl } from '../lib/artStorage';
import { resolveCharColors, sanitizeMarkupPresets } from '../utils/markupStyles';
import { BoxSelect } from './BoxSelect';
import { Capture, describeCapture } from '../utils/boxSelect';

/** Themes that read better without chat bubbles. */
const MINIMAL_BUBBLE_THEMES = new Set(['book', 'notebook', 'essay', 'newspaper']);

/** Short human title for a captured visual: first meaningful line, de-marked. */
const derivePinTitle = (content: string): string => {
  const line = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|`#*_>-]+/g, ' ')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .find(l => l.length > 2) ?? 'Pinned visual';
  return line.length > 42 ? `${line.slice(0, 42).trimEnd()}…` : line;
};

export const ReaderDisplay = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  // Codex lore words get a whisper-quiet underline + hover tooltip.
  // Identity function (zero cost) when the codex is off or still empty.
  const markLore = useEntityHighlighter();
  // Hybrid Scene Director: auto-reads the current page while enabled.
  useSceneDirector();

  // Adaptive theming — the reading surface is dressed for the SCENE the reader
  // is in (a contiguous mood span), not the single passage in focus, so the
  // atmosphere holds across the scene and only eases at its boundary. Tension
  // within the scene rides the arc. Works with no AI (heuristic scenes); the
  // Director only refines it. See SceneAtmosphere for the layers.
  const { scenes, active: scene, activeId: activeSceneId } = useScenes();
  const atmosphereOn = store.sceneTheming && store.themeEffects;

  // Particle weather for the passage being read — see `useSceneWeather`, which
  // is where the rules live now that all five views share them.
  const weatherMsg = store.streamingMessage
    ?? [...store.visibleMessages].reverse().find(m => m.role !== 'user');
  const weather = useSceneWeather(scene, weatherMsg);
  // Screen effects — a flash on an impact, a desaturate over grief. These
  // existed only on the Stage and in the VN, which is what "Scene Read effects
  // don't show in Story and Chat" actually meant.
  const vfx = useSceneVfx(scene, weatherMsg?.id);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The currently-streaming message element — the focus target that the
  // viewport tracks so the live text never trails out of sight.
  const activeRef = useRef<HTMLDivElement>(null);
  // Follow the streaming text only while the reader is near the bottom;
  // scrolling up to reread suspends following until they return (or press play).
  const followRef = useRef(true);
  // Distinguishes our own scroll writes from genuine user scrolls, so
  // auto-following never gets mistaken for the reader taking control.
  const programmaticRef = useRef(false);

  const [direction, setDirection] = React.useState(1);
  const [lightbox, setLightbox] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [dialogueTip, setDialogueTip] = React.useState<
    { text: string; x: number; y: number; placement: 'top' | 'bottom' } | null
  >(null);
  const wasHighlightRef = useRef(false);

  const [selPopover, setSelPopover] = React.useState<
    { x: number; y: number; bottom?: number; text: string; messageId?: string; framed?: boolean } | null
  >(null);
  const [noteDraft, setNoteDraft] = React.useState('');
  const [threadOpen, setThreadOpen] = React.useState<
    { messageId?: string; anchorText?: string } | null
  >(null);
  /** The beat whose scene-image composer is open, if any. */
  const [imageFor, setImageFor] = React.useState<string | null>(null);
  const prevIndexRef = useRef(store.currentChainIndex);

  useEffect(() => {
    if (store.currentChainIndex !== prevIndexRef.current) {
      setDirection(store.currentChainIndex > prevIndexRef.current ? 1 : -1);
      prevIndexRef.current = store.currentChainIndex;
    }
  }, [store.currentChainIndex]);

  // Scroll without it being counted as a user scroll (only when it moves).
  const scrollTo = (el: HTMLDivElement, top: number) => {
    const clamped = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    if (Math.abs(clamped - el.scrollTop) < 0.5) return;
    programmaticRef.current = true;
    el.scrollTop = clamped;
  };

  // Center the streaming line in the reading zone. In autofocus it sits higher
  // (~55%) so the reader looks at one spot; otherwise it rides near the bottom.
  const centerActive = () => {
    const el = scrollRef.current;
    if (!el) return;
    const active = activeRef.current;
    if (active) {
      const focusRatio = store.isAutofocusMode ? 0.55 : 0.72;
      const elRect = el.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const activeBottom = aRect.bottom - elRect.top + el.scrollTop;
      scrollTo(el, activeBottom - el.clientHeight * focusRatio);
    } else {
      scrollTo(el, el.scrollHeight);
    }
  };

  useEffect(() => {
    if (store.isStreaming) {
      followRef.current = true;
      requestAnimationFrame(centerActive);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.isStreaming, store.isAutofocusMode]);

  // Track the reveal BEFORE paint (useLayoutEffect) so the new character and
  // the scroll adjustment land in the same frame — otherwise the text paints
  // at the old position first, which reads as shaking.
  useLayoutEffect(() => {
    // Autofocus is hands-free: always follow. Otherwise honor scroll-up-to-pause.
    if (!store.isStreaming) return;
    if (!store.isAutofocusMode && !followRef.current) return;
    centerActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store.streamedText, store.visibleMessages.length, store.isStreaming,
    store.isAutofocusMode, store.autofocusZoom, store.layoutMode,
  ]);

  // Entering autofocus: snap to the streaming line at once and, handsfree,
  // start playback so the view follows along immediately.
  useEffect(() => {
    if (!store.isAutofocusMode) return;
    followRef.current = true;
    const id = requestAnimationFrame(() => requestAnimationFrame(centerActive));
    if (!store.isStreaming && store.streamingMessage) store.setIsStreaming(true);
    // Entering fullscreen or resizing changes the viewport — re-center on it.
    const recenter = () => requestAnimationFrame(centerActive);
    window.addEventListener('resize', recenter);
    document.addEventListener('fullscreenchange', recenter);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', recenter);
      document.removeEventListener('fullscreenchange', recenter);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.isAutofocusMode]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Ignore the scroll event our own centering just produced.
    if (programmaticRef.current) { programmaticRef.current = false; return; }
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };

  // Paint saved highlights back onto the text (CSS Custom Highlight API), so a
  // highlight is actually visible in place — not just an entry in the panel.
  // Runs on structural changes only (not per streamed char): committed text
  // nodes are stable while a later message streams.
  const highlights = store.currentStory?.highlights;
  useEffect(() => {
    const id = requestAnimationFrame(() => paintHighlights(scrollRef.current, highlights ?? []));
    return () => cancelAnimationFrame(id);
  }, [
    highlights, store.visibleMessages.length, store.viewMode,
    store.currentChainIndex, store.layoutMode, store.searchQuery, store.isStreaming,
  ]);

  // Highlight mode (hold F): pause streaming on entry so the DOM stops churning
  // and a selection can hold; on exit (F released) capture the selection as a
  // highlight — which the paint effect then makes visible immediately.
  useEffect(() => {
    const was = wasHighlightRef.current;
    wasHighlightRef.current = store.isHighlightMode;
    if (store.isHighlightMode && !was) {
      if (store.isStreaming) store.setIsStreaming(false);
      return;
    }
    if (!store.isHighlightMode && was) {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text) return;
      let node: Node | null = sel!.anchorNode;
      let messageId: string | undefined;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement && node.dataset.msgId) { messageId = node.dataset.msgId; break; }
        node = node.parentNode;
      }
      store.addHighlight({
        id: Math.random().toString(36).slice(2, 9),
        text, messageId, timestamp: Date.now(), color: 'yellow',
      });
      sel?.removeAllRanges();
      setToast('Highlighted');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.isHighlightMode]);

  /* The frame tool. Streaming pauses on entry for the same reason highlight
   * mode pauses it: the words are the target, and a target that is still
   * growing moves out from under the box between the drag and the release. */
  const boxMode = store.isBoxMode;
  useEffect(() => {
    if (!boxMode) return;
    if (store.isStreaming) store.setIsStreaming(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); useAppStore.getState().setIsBoxMode(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxMode]);

  /* A frame produces exactly what a text selection produces, so it goes to the
   * same popover — every action the reader already knows works on it unchanged.
   * Anchored to the frame's own edges, not to a DOM range. */
  const onFramed = useCallback((result: Capture, anchor: { x: number; y: number; bottom: number }) => {
    const st = useAppStore.getState();
    st.setIsBoxMode(false);
    setNoteDraft('');
    setSelPopover({ ...anchor, text: result.text, messageId: result.messageId, framed: true });
    setToast(describeCapture(result));
  }, []);

  const onFrameCancel = useCallback((reason: 'empty' | 'tiny' | 'escape') => {
    if (reason === 'tiny') return;   // a click, not a frame — stay in the tool
    useAppStore.getState().setIsBoxMode(false);
    if (reason === 'empty') setToast('Nothing in the frame');
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1400);
    return () => clearTimeout(t);
  }, [toast]);

  /* Rebuilt through the sanitiser rather than read raw: persisted settings
   * outlive the build that wrote them, and a channel this build does not know
   * about must not reach a className. */
  const markup = useMemo(() => sanitizeMarkupPresets(store.markupPresets), [store.markupPresets]);

  const themeDef = THEMES[store.theme] ?? THEMES.dark;
  const minimalBubbles = MINIMAL_BUBBLE_THEMES.has(store.theme);

  // Note counts per message, for the subtle gutter markers.
  const annotations = storyId ? v2.annotationsByStory[storyId] : undefined;
  const noteCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of annotations ?? []) m.set(a.messageId, (m.get(a.messageId) ?? 0) + 1);
    return m;
  }, [annotations]);

  const openNotes = useCallback((id: string) => setThreadOpen({ messageId: id }), []);

  /** The beat "Ask <character>" is anchored to: the one being revealed, else the
   *  last one the reader has reached. */
  const askAnchorId = store.streamingMessage?.id
    ?? store.visibleMessages[store.visibleMessages.length - 1]?.id;

  // Hand a message off to the AI assistant's Lens-edit mode.
  const lensEdit = useCallback((id: string) => useAppStore.getState().setLensEditTarget(id), []);

  const sceneImage = useCallback((id: string) => setImageFor(id), []);

  /** Delete one generated picture: the metadata row AND the bytes behind it. */
  const removeArt = useCallback((messageId: string, artId: string) => {
    const sid = useAppStore.getState().currentStory?.id;
    if (!sid) return;
    useAuraV2Store.getState().removeSceneArt(sid, messageId, artId);
    releaseArtUrl(artId);
    void deleteArt(artId);
  }, []);

  const pinContent = useCallback((messageId: string, content: string, format: PinFormat) => {
    const sid = useAppStore.getState().currentStory?.id;
    if (!sid) return;
    useAuraV2Store.getState().addPin(sid, {
      title: derivePinTitle(content),
      format,
      content,
      messageId,
      inContext: false,
      docked: true,
    });
    setToast('Pinned to the side');
  }, []);

  // Build a fast message-id → chain lookup once per chains change, instead of
  // scanning every chain for every message on every render.
  const chainByMessageId = useMemo(() => {
    const map = new Map<string, typeof store.chains[0]>();
    for (const chain of store.chains) {
      for (const m of chain.messages) map.set(m.id, chain);
    }
    return map;
  }, [store.chains]);

  /**
   * The word-arrival effect actually in force.
   *
   * Exactly the rule `resolveMsgAnim` uses for the block animation just below:
   * while ambient effects are on, a theme's signature wins — and the settings
   * panel already tells the reader that in those words ("Some themes bring
   * their own signature reveal while ambient effects are on"). Turning ambient
   * effects off hands every choice back.
   *
   * Not conditioned on the reader's value being "still the default": the
   * reading modes set `streamEffect` themselves, so "default" is three
   * different values depending on the mode, and a rule nobody can predict is
   * worse than one that is simply stated.
   */
  const effectiveStreamEffect =
    (store.themeEffects && themeDef.streamEffect) || store.streamEffect;

  const resolveMsgAnim = useCallback((msg: Message) => {
    const chain = chainByMessageId.get(msg.id);
    return (chain?.starred && chain?.starSettings?.animationStyle)
      || (store.themeEffects && themeDef.animation)
      || store.animationStyle;
  }, [chainByMessageId, store.themeEffects, themeDef.animation, store.animationStyle]);

  const handleMessageClick = useCallback((id: string) => {
    // Ignore the click that ends a text selection (the reader was highlighting).
    if (window.getSelection()?.toString().trim()) return;
    const s = useAppStore.getState();
    if (id === s.streamingMessage?.id) {
      s.setIsStreaming(!s.isStreaming);
    } else {
      s.restreamFromId(id);
    }
  }, []);

  const showDialogueTip = useCallback((e: React.MouseEvent<HTMLElement>, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    const placement: 'top' | 'bottom' = r.top < 170 ? 'bottom' : 'top';
    setDialogueTip({ text, x: r.left + r.width / 2, y: placement === 'top' ? r.top : r.bottom, placement });
  }, []);

  const hideDialogueTip = useCallback(() => setDialogueTip(null), []);

  // All hooks must run before this bail-out — an empty story that later gains
  // chains would otherwise change the hook order and crash the reader.
  if (store.chains.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-50 h-[80vh]">
        <p className="text-lg">This story is empty.</p>
      </div>
    );
  }

  const matchesSearch = (msg: Message) => {
    if (!store.searchQuery) return true;
    const q = store.searchQuery.toLowerCase();
    const content = resolveContent(msg, overrides, lensOn).toLowerCase();
    return content.includes(q) || msg.name.toLowerCase().includes(q);
  };

  const handleTextMouseUp = () => {
    // While holding F (highlight mode) the release captures the selection with a
    // default color — don't also pop the color/note picker.
    if (store.isHighlightMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setSelPopover(null); return; }
    const text = sel.toString().trim();
    if (!text) { setSelPopover(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    let node: Node | null = sel.anchorNode;
    let messageId: string | undefined;
    while (node && node !== document.body) {
      if (node instanceof HTMLElement && node.dataset.msgId) { messageId = node.dataset.msgId; break; }
      node = node.parentNode;
    }
    setNoteDraft('');
    setSelPopover({ x: rect.left + rect.width / 2, y: rect.top, bottom: rect.bottom, text, messageId });
  };

  const saveHighlight = (color: string) => {
    if (!selPopover) return;
    store.addHighlight({
      id: Math.random().toString(36).slice(2, 9),
      text: selPopover.text,
      messageId: selPopover.messageId,
      timestamp: Date.now(),
      note: noteDraft.trim() || undefined,
      color,
    });
    window.getSelection()?.removeAllRanges();
    setSelPopover(null);
    setToast('Highlighted');
  };

  const saveAnnotation = () => {
    if (!selPopover?.messageId) return;
    const note = noteDraft.trim();
    if (!note && !selPopover.text) return;
    v2.addAnnotation(storyId!, {
      messageId: selPopover.messageId,
      anchorText: selPopover.text || undefined,
      note: note || selPopover.text,
    });
    window.getSelection()?.removeAllRanges();
    setSelPopover(null);
    setNoteDraft('');
    setToast('Note saved');
  };

  /** The last passage the reader has arrived at, for the magnifier's fallback. */
  const lastReadId = store.visibleMessages[store.visibleMessages.length - 1]?.id;

  const renderBlock = (msg: Message, content: string, isStreamingMsg = false) => {
    const chain = chainByMessageId.get(msg.id);
    const isMsgZoomed = !!chain?.starred && !!chain?.starSettings?.zoom;
    const isUser = msg.role === 'user';
    // Reader-supplied profile pictures win, then per-character avatars for
    // group chats, then the story's own fallback avatar.
    const avatar = msg.avatar ?? (isUser
      ? store.currentStory?.userAvatar
      : store.currentStory?.characterAvatars?.[msg.name]
        ?? store.currentStory?.characterAvatar
        ?? store.currentStory?.avatar);

    // Reader-authored SFX marks render as an always-on 'sfx' emphasis span. Only
    // build a new array when marks exist, so the memo stays stable otherwise.
    const baseEmphasis = store.sceneEmphasis && storyId ? v2.sceneByStory[storyId]?.[msg.id]?.emphasis : undefined;
    const sfxMarks = storyId ? v2.sfxMarksByStory[storyId]?.[msg.id] : undefined;
    const emphasis = readerEmphasis(
      baseEmphasis, sfxMarks, storyId ? v2.emphasisMarksByStory[storyId]?.[msg.id] : undefined,
    );

    // Performance cues: the reader's hand-marked spans win over the Director's.
    const perform = store.scenePerformance && storyId
      ? mergePerformCues(
        v2.performMarksByStory[storyId]?.[msg.id],
        v2.sceneByStory[storyId]?.[msg.id]?.perform,
      )
      : undefined;

    return (
      <MessageBlock
        key={msg.id}
        msg={msg}
        content={content}
        rawContent={msg.content}
        hasOverride={!!storyId && !!overrides?.some(o => o.messageId === msg.id)}
        noteCount={noteCounts.get(msg.id) ?? 0}
        onOpenNotes={openNotes}
        onPinContent={pinContent}
        onLensEdit={store.aiBaseUrl && store.aiModel ? lensEdit : undefined}
        onSceneImage={store.imageBaseUrl ? sceneImage : undefined}
        sceneArt={storyId ? v2.artByStory[storyId]?.[msg.id] : undefined}
        onRemoveArt={removeArt}
        streamEffect={effectiveStreamEffect}
        expressiveText={store.expressiveText}
        ttsReading={store.ttsEnabled && store.ttsPending && isStreamingMsg}
        emphasis={emphasis}
        perform={perform}
        dialogue={storyId ? v2.sceneByStory[storyId]?.[msg.id]?.dialogue : undefined}
        isStreamingMsg={isStreamingMsg}
        revealComplete={isStreamingMsg && store.revealComplete}
        isMsgZoomed={isMsgZoomed}
        avatar={avatar}
        msgAnim={resolveMsgAnim(msg)}
        theme={store.theme}
        themeDef={themeDef}
        minimalBubbles={minimalBubbles}
        isAutofocusMode={store.isAutofocusMode}
        viewMode={store.viewMode}
        phoneDialogueOnly={store.phoneDialogueOnly}
        dialogueColor={store.dialogueColor}
        dialogueStyle={store.dialogueStyle}
        markup={markup}
        dialogueAnimation={store.dialogueAnimation}
        charColors={resolveCharColors(
          msg.name, store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
        )}
        hideMetadata={store.hideMetadata}
        oocHandling={store.oocHandling}
        autoFormat={store.autoFormat}
        autoFormatRules={store.autoFormatRules}
        statRules={store.statRules}
        paragraphSpacing={store.paragraphSpacing}
        dialogueOwnLine={store.dialogueOwnLine}
        smartTypography={store.smartTypography}
        styleQuotes={store.styleQuotes}
        substituteNames={store.substituteNames}
        characterName={store.currentStory?.characterName}
        userName={store.currentStory?.userName}
        showImages={store.showImages}
        swipeSelections={store.swipeSelections}
        activeRef={activeRef}
        /* Where the magnifier looks. The streaming passage while one is
         * revealing, and otherwise the last one the reader reached — so the
         * light does not go out the moment playback stops. */
        revealEdge={isStreamingMsg || (!store.streamingMessage && msg.id === lastReadId)}
        onMessageClick={handleMessageClick}
        onImageClick={setLightbox}
        onShowDialogueTip={showDialogueTip}
        onHideDialogueTip={hideDialogueTip}
        markLore={markLore}
        onSelectSwipe={store.selectSwipe}
      />
    );
  };

  // A custom content width (px) overrides the theme's default column width.
  const customWidth = store.contentWidth > 0;
  const maxWidth = customWidth
    ? ''
    : themeDef.maxWidth ?? (store.viewMode === 'storybook' ? 'max-w-[65ch]' : 'max-w-4xl');

  return (
    <>
    <SceneAtmosphere scene={scene} activeId={activeSceneId} enabled={atmosphereOn} />
    {weather && <SceneFx fx={weather.fx} level={weather.level} fixed />}
    <SceneVfx kind={vfx} beatKey={weatherMsg?.id ?? 'x'} />
    {store.sceneTheming && !store.isAutofocusMode && (
      <SceneSpine scenes={scenes} activeSceneId={scene?.id} />
    )}

    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onMouseUp={handleTextMouseUp}
      className={cn(
        'relative z-10 flex-1 min-h-0 overflow-y-auto pb-44 transition-all duration-500',
        store.isAutofocusMode && 'overflow-x-hidden pb-[45vh]',
      )}
      style={{ fontSize: `${store.fontSize * (store.isAutofocusMode ? store.autofocusZoom : 1)}px` }}
    >
      {store.isAutofocusMode && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-40 flex gap-2">
          <div className="bg-amber-500 text-black px-4 py-1.5 rounded-full shadow-lg text-xs font-bold tracking-widest uppercase animate-pulse">
            Autofocus (W/S zoom · A/D pan · Q/E speed)
          </div>
          {store.isHighlightMode && (
            <div className="bg-blue-500 text-white px-4 py-1.5 rounded-full shadow-lg text-xs font-bold tracking-widest uppercase">
              Highlighting
            </div>
          )}
          {store.isBoxMode && (
            <div className="bg-accent text-white px-4 py-1.5 rounded-full shadow-lg text-xs font-bold tracking-widest uppercase">
              Framing
            </div>
          )}
        </div>
      )}

      <div
        className={cn('reader-page mx-auto pt-8 px-4 min-h-[80vh]', maxWidth,
          `view-${store.viewMode}`,
          // Expressive typography intensity drives shout/scene-break/key-line
          // scaling through CSS vars; drop caps flag the opening of AI passages.
          store.expressiveText && `expr-${store.expressiveIntensity}`,
          store.dropCaps && 'drop-caps',
          (store.theme === 'book' || store.theme === 'essay') && 'py-12',
          store.theme === 'phone' && 'border-x border-app-border shadow-2xl min-h-screen pt-4 bg-app-bg',
        )}
        style={{
          transform: store.isAutofocusMode && store.autofocusPanX
            ? `translateX(${store.autofocusPanX}px)`
            : 'none',
          transition: 'transform 0.3s ease-out',
          transformOrigin: 'top center',
          ...(customWidth ? { maxWidth: `${store.contentWidth}px` } : null),
        }}
      >
        {store.layoutMode === 'paginated' && (
          <div className="flex items-center justify-between mb-8 pb-4 border-b border-app-border sticky top-0 bg-app-bg/90 z-10 pt-4 backdrop-blur-sm">
            <button
              onClick={() => store.prevPage()}
              disabled={store.currentChainIndex === 0}
              className="flex items-center gap-1 opacity-70 hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-full hover:bg-app-text/5 transition-colors"
            >
              <ChevronLeft size={20} /> Prev
            </button>
            <span className="text-sm font-mono opacity-50 tracking-widest">
              PAGE {store.currentChainIndex + 1} / {store.chains.length}
            </span>
            <button
              onClick={() => store.nextPage()}
              disabled={store.currentChainIndex >= store.chains.length - 1}
              className="flex items-center gap-1 opacity-70 hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1.5 rounded-full hover:bg-app-text/5 transition-colors"
            >
              Next <ChevronRight size={20} />
            </button>
          </div>
        )}

        {store.layoutMode === 'continuous' ? (
          <>
            {store.visibleMessages.filter(matchesSearch).map(msg =>
              renderBlock(msg, resolveContent(msg, overrides, lensOn)))}
            {store.streamingMessage && matchesSearch(store.streamingMessage) &&
              renderBlock(store.streamingMessage, store.streamedText, true)}
            <div ref={bottomRef} className="h-10" />
          </>
        ) : (
          <div className="perspective-[2000px] w-full">
            <AnimatePresence mode="wait" custom={direction}>
              <motion.div
                key={store.currentChainIndex}
                custom={direction}
                variants={{
                  enter: (dir: number) =>
                    store.viewMode === 'storybook'
                      ? { opacity: 0, rotateY: dir > 0 ? 90 : -90, transformOrigin: dir > 0 ? 'left' : 'right', scale: 0.95 }
                      : { opacity: 0, x: dir > 0 ? 20 : -20, scale: 1 },
                  center: { opacity: 1, rotateY: 0, x: 0, scale: 1, transformOrigin: 'center' },
                  exit: (dir: number) =>
                    store.viewMode === 'storybook'
                      ? { opacity: 0, rotateY: dir > 0 ? -90 : 90, transformOrigin: dir > 0 ? 'left' : 'right', scale: 0.95 }
                      : { opacity: 0, x: dir > 0 ? -20 : 20, scale: 1 },
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
                className="min-h-[50vh]"
              >
                {store.visibleMessages.filter(matchesSearch).map(msg =>
                  renderBlock(msg, resolveContent(msg, overrides, lensOn)))}
                {store.streamingMessage && matchesSearch(store.streamingMessage) &&
                  renderBlock(store.streamingMessage, store.streamedText, true)}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>

    {/* The frame tool's surface. Above the prose and below the card it produces,
      * so the card it opens is immediately clickable. */}
    {store.isBoxMode && (
      <BoxSelect rootRef={scrollRef} onCapture={onFramed} onCancel={onFrameCancel} />
    )}

    {selPopover && (
      <SelectionPopover
        sel={selPopover}
        prefer={selPopover.framed ? 'below' : 'above'}
        noteDraft={noteDraft}
        setNoteDraft={setNoteDraft}
        onClose={() => setSelPopover(null)}
        onHighlight={(color) => saveHighlight(color)}
        onNote={() => saveAnnotation()}
        onPin={() => {
          if (!selPopover.messageId) return;
          pinContent(selPopover.messageId, selPopover.text, 'markdown');
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
        }}
        onAskAi={() => {
          setThreadOpen({ messageId: selPopover.messageId, anchorText: selPopover.text });
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
          setNoteDraft('');
        }}
        onRewrite={store.aiBaseUrl && store.aiModel ? () => {
          if (!selPopover.messageId) return;
          store.sendToRewrite(selPopover.messageId, selPopover.text);
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
        } : undefined}
        onPerform={store.scenePerformance ? (kind) => {
          if (storyId && selPopover.messageId) {
            const text = selPopover.text.trim();
            if (kind) v2.addPerformMark(storyId, selPopover.messageId, { text, kind });
            else v2.clearPerformMarkFor(storyId, selPopover.messageId, text);
          }
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
        } : undefined}
        performKind={storyId && selPopover.messageId
          ? v2.performMarksByStory[storyId]?.[selPopover.messageId]
            ?.find(m => m.text === selPopover.text.trim())?.kind ?? null
          : null}
        onEmphasis={(mark) => {
          if (storyId && selPopover.messageId) {
            const text = selPopover.text.trim();
            if (mark) v2.addEmphasisMark(storyId, selPopover.messageId, { ...mark, text });
            else v2.clearEmphasisMarkFor(storyId, selPopover.messageId, text);
          }
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
        }}
        emphasis={storyId && selPopover.messageId
          ? v2.emphasisMarksByStory[storyId]?.[selPopover.messageId]
            ?.find(m => m.text === selPopover.text.trim()) ?? null
          : null}
        onSfx={store.audioCuesEnabled ? (prompt, slow) => {
          if (storyId && selPopover.messageId) {
            v2.addSfxMark(storyId, selPopover.messageId, { text: selPopover.text.trim(), prompt, slow });
          }
          window.getSelection()?.removeAllRanges();
          setSelPopover(null);
        } : undefined}
      />
    )}

    {threadOpen && (
      <AnnotationThread
        messageId={threadOpen.messageId}
        anchorText={threadOpen.anchorText}
        onClose={() => setThreadOpen(null)}
      />
    )}

    {/* Anchored to the beat on screen — the streaming one while it reads, else
      * the last one the reader has arrived at. Scroll back and the interview you
      * had at that beat is the one that reopens. */}
    {imageFor && <SceneImageModal messageId={imageFor} onClose={() => setImageFor(null)} />}

    {/* Reading with someone. Mounted beside Ask Character, and reader-only on
      * the same terms: nothing it produces is canon or reaches an export. */}
    <LiveReactor />

    <AskCharacter
      messageId={askAnchorId}
      mood={storyId && askAnchorId ? v2.sceneByStory[storyId]?.[askAnchorId]?.mood : undefined}
    />

    {toast && (
      <div className="fixed bottom-48 left-1/2 -translate-x-1/2 z-[75] px-4 py-2 rounded-full bg-app-text text-app-bg text-sm font-medium shadow-xl pointer-events-none">
        {toast}
      </div>
    )}

    {dialogueTip && (
      <div
        className="fixed z-[80] w-64 max-w-[70vw] px-3 py-2 rounded-xl bg-app-text text-app-bg text-xs leading-relaxed shadow-2xl pointer-events-none"
        style={{
          left: Math.min(Math.max(dialogueTip.x, 140), window.innerWidth - 140),
          top: dialogueTip.placement === 'top' ? dialogueTip.y - 8 : dialogueTip.y + 8,
          transform: dialogueTip.placement === 'top'
            ? 'translate(-50%, -100%)'
            : 'translate(-50%, 0)',
        }}
      >
        {dialogueTip.text}
      </div>
    )}

    {lightbox && (
      <div
        className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm flex items-center justify-center p-6 cursor-zoom-out"
        onClick={() => setLightbox(null)}
      >
        <img
          src={lightbox}
          alt=""
          className="max-w-full max-h-full rounded-lg shadow-2xl object-contain"
          referrerPolicy="no-referrer"
        />
      </div>
    )}
    </>
  );
};
