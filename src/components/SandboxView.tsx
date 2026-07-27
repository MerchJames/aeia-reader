import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Wand2, RefreshCw, Type, Loader2, Plus, X, Sparkles, Pencil, Palette, ScrollText, BookOpen, Clapperboard,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { samplerParamsFrom } from '../utils/aiClient';
import { buildDoc, buildSpeakerMap, escapeHtml, formatBody, ThemeVars } from '../utils/sandboxTheme';
import { generateTreatment, resolveCues } from '../utils/sandboxDirector';
import { playSound } from '../utils/sandboxAudio';
import { audioAssetUrl } from '../utils/audioLibrary';
import { SandboxStudioModal } from './SandboxStudioModal';
import { SceneDirectorModal } from './SceneDirectorModal';
import { FxKind, Message, SandboxScope, SceneCue, StyleConfig } from '../types';
import { cn } from '../utils/cn';

/**
 * Sandbox — AI-designed presentation mode + Studio.
 *
 * Rides the app's own playback engine: it renders the playback-gated messages
 * (so pagination is honored) and the streaming message types in live — like
 * every other view. A *theme* styles the message cards; a *view* takes the whole
 * screen and shows one message at a time, advanced by the normal controls. The
 * model authors the CSS; Aura injects the VERBATIM text.
 */

const useThemeVars = (): ThemeVars => {
  const themeKey = useAppStore(s => `${s.theme}|${s.textColor}|${s.bgColor}|${s.accentColor}`);
  const [vars, setVars] = useState<ThemeVars>({
    bg: '#0f172a', surface: '#1e293b', text: '#d1d5db', border: '#3f3f46', accent: '#8b5cf6',
  });
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const r = getComputedStyle(document.documentElement);
      const v = (name: string, fb: string) => r.getPropertyValue(name).trim() || fb;
      setVars({
        bg: v('--app-bg', '#0f172a'), surface: v('--app-surface', '#1e293b'),
        text: v('--app-text', '#d1d5db'), border: v('--app-border', '#3f3f46'),
        accent: v('--app-accent', '#8b5cf6'),
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey]);
  return vars;
};

const SandboxCard = ({ doc, title, toolbar, liveHtml, fill, minHeight = 120, fx }: {
  doc: string; title: string; toolbar?: React.ReactNode; liveHtml?: string; fill?: boolean; minHeight?: number;
  /** A bumped-seq signal telling the frame to fire a transient scene effect. */
  fx?: { seq: number; fx: FxKind; ms?: number } | null;
}) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const loaded = useRef(false);
  const live = useRef(liveHtml);
  live.current = liveHtml;

  const push = useCallback(() => {
    const w = ref.current?.contentWindow;
    if (w && live.current != null) w.postMessage({ t: 'aura-sandbox-set', html: live.current }, '*');
  }, []);

  // Fire a scene-cue effect into the frame when the signal's seq changes.
  useEffect(() => {
    if (!fx || !loaded.current) return;
    ref.current?.contentWindow?.postMessage({ t: 'aura-sandbox-fx', fx: fx.fx, ms: fx.ms }, '*');
  }, [fx?.seq]);

  useEffect(() => {
    if (fill) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      if (e.data?.t === 'aura-sandbox-h' && typeof e.data.h === 'number') {
        setHeight(Math.max(minHeight, Math.min(12000, Math.ceil(e.data.h))));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [minHeight, fill]);

  useEffect(() => { if (loaded.current) push(); }, [liveHtml, push]);

  return (
    <div className={cn('relative group', fill && 'h-full')}>
      <iframe ref={ref} sandbox="allow-scripts" srcDoc={doc} title={title} loading="lazy"
        onLoad={() => { loaded.current = true; push(); }}
        style={{ width: '100%', height: fill ? '100%' : height, border: 'none', display: 'block' }} />
      {toolbar && (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {toolbar}
        </div>
      )}
    </div>
  );
};

const ToolBtn = ({ onClick, title, disabled, children }: {
  onClick: () => void; title: string; disabled?: boolean; children: React.ReactNode;
}) => (
  <button onClick={onClick} title={title} disabled={disabled}
    className={cn('p-1.5 rounded-md bg-app-bg/80 backdrop-blur border border-app-text/15 text-app-text/80',
      'hover:text-accent hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed')}>
    {children}
  </button>
);

interface ModalState { scope: SandboxScope; targetKey?: string; editConfig?: StyleConfig }

export const SandboxView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  const baseVars = useThemeVars();
  const reduceMotion = !store.themeEffects;
  const paged = store.layoutMode === 'paginated';

  const treatments = storyId ? v2.sandboxByStory[storyId] : undefined;
  const descriptors = storyId ? v2.sceneByStory[storyId] : undefined;
  const cuesByMsg = storyId ? v2.sandboxCuesByStory[storyId] : undefined;
  const configs = (storyId && v2.sandboxConfigs[storyId]) || [];
  const active = (storyId && v2.sandboxActive[storyId]) || {};
  const enabled = storyId ? (v2.sandboxEnabledByStory[storyId] ?? true) : true;
  const palette = (storyId && v2.sandboxPaletteByStory[storyId]) || {};
  const aiReady = !!store.aiBaseUrl && !!store.aiModel;

  const vars = useMemo<ThemeVars>(() => ({
    ...baseVars,
    text: palette.text || baseVars.text,
    accent: palette.accent || baseVars.accent,
    bg: palette.bg || baseVars.bg,
  }), [baseVars, palette.text, palette.accent, palette.bg]);
  const forceText = !!palette.text;

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [textHidden, setTextHidden] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [fxSig, setFxSig] = useState<{ seq: number; fx: FxKind; ms?: number } | null>(null);
  const firedRef = useRef<Set<string>>(new Set());
  const lastLenRef = useRef(0);
  const fxSeq = useRef(0);
  const origSpeedRef = useRef<number | null>(null);
  const prevSceneRef = useRef<string | null>(null);
  // A looping ambience/music "bed" from the audio library plays until the beat
  // changes; one-shot SFX just play out. Both are gated on audioCuesEnabled.
  const bedRef = useRef<{ el: HTMLAudioElement; id: string } | null>(null);
  const stopBed = useCallback(() => {
    if (bedRef.current) { bedRef.current.el.pause(); bedRef.current.el.src = ''; bedRef.current = null; }
  }, []);
  const playAssetCue = useCallback((cue: SceneCue) => {
    if (!cue.assetId) return;
    const url = audioAssetUrl(store.audioBaseUrl, cue.assetId);
    if (cue.loop) {
      if (bedRef.current?.id === cue.id) return; // this bed is already playing
      stopBed();
      const el = new Audio(url);
      el.loop = true; el.volume = 0.6;
      void el.play().catch(() => {});
      bedRef.current = { el, id: cue.id };
    } else {
      const el = new Audio(url);
      void el.play().catch(() => {});
    }
  }, [store.audioBaseUrl, stopBed]);

  // A scene cue can retime the reveal ("time slows"); remember the reader's own
  // speed so we can hand it back when the beat ends.
  const applyPace = useCallback((p: 'slow' | 'normal' | 'fast') => {
    const app = useAppStore.getState();
    if (origSpeedRef.current == null) origSpeedRef.current = app.playbackSpeed;
    const base = origSpeedRef.current;
    app.setPlaybackSpeed(p === 'slow' ? Math.min(base, 12) : p === 'fast' ? Math.max(base, 88) : base);
  }, []);
  const restoreSpeed = useCallback(() => {
    if (origSpeedRef.current != null) { useAppStore.getState().setPlaybackSpeed(origSpeedRef.current); origSpeedRef.current = null; }
  }, []);
  useEffect(() => () => restoreSpeed(), [restoreSpeed]); // hand speed back on leave
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(t); }, [notice]);

  const byId = useMemo(() => Object.fromEntries(configs.map(c => [c.id, c])), [configs]);

  const msgChain = useMemo(() => {
    const map: Record<string, string> = {};
    store.chains.forEach(c => c.messages.forEach(m => { map[m.id] = c.id; }));
    return map;
  }, [store.chains]);

  // Allowlisted intent bus — the only actions an in-frame trinket can drive.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.t !== 'aura-intent') return;
      const app = useAppStore.getState();
      switch (e.data.action) {
        case 'toggle-playback': app.setIsStreaming(!app.isStreaming); break;
        case 'next': app.advanceMessage(); break;
        case 'restart': app.resetPlayback(); break;
        case 'prev': {
          const flat = app.chains.flatMap(c => c.messages);
          const cur = app.streamingMessage ?? app.visibleMessages[app.visibleMessages.length - 1];
          const i = flat.findIndex(m => m.id === cur?.id);
          if (i > 0) app.jumpToMessage(flat[i - 1].id);
          break;
        }
        case 'toggle-text': setTextHidden(v => !v); break;
        case 'set-text-visibility': setTextHidden(!(e.data.payload?.visible ?? true)); break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const colorMap = useMemo(
    () => buildSpeakerMap(store.chains.flatMap(c => c.messages).map(m => m.name), vars.surface),
    [store.chains, vars.surface],
  );
  const colorFor = useCallback((name: string) => colorMap[name.trim().toLowerCase()] ?? vars.accent, [colorMap, vars.accent]);

  const themeFor = useCallback((m: Message, chainId?: string) => {
    if (!enabled) return undefined;
    const t = treatments?.[m.id];
    if (t) return { css: t.css, skeleton: t.skeleton };
    const pick = (id?: string) => (id ? byId[id] : undefined);
    const c = pick(active.messages?.[m.id]) ?? pick(chainId ? active.chains?.[chainId] : undefined) ?? pick(active.chat);
    return c && c.kind === 'theme' ? { css: c.css, skeleton: c.skeleton } : undefined;
  }, [enabled, treatments, active, byId]);

  // The message the reader is on (streaming one, else the last shown).
  const current: Message | undefined = store.streamingMessage ?? store.visibleMessages[store.visibleMessages.length - 1];
  const currentChainId = current ? msgChain[current.id] : store.chains[0]?.id;
  const streamingCurrent = !!store.streamingMessage && current?.id === store.streamingMessage.id;
  const currentContent = current ? resolveContent(current, overrides, lensOn) : '';

  /* Scene director. A message's cue track is a PERFORMANCE: `scene` cues cut the
   * text into shots — each scene owns only its slice (its anchor → the next
   * scene's), so the words are segmented, not all crammed on screen. `fx`/`audio`
   * cues are point events. A scene is a named, toggleable thing (like a View);
   * when off, the beat reads plain — no restart needed. */
  const sceneByMsg = storyId ? v2.sandboxSceneByStory[storyId] : undefined;
  const sceneMeta = current ? sceneByMsg?.[current.id] : undefined;
  const sceneOn = enabled && !!sceneMeta?.enabled;

  const resolvedCues = useMemo(
    () => (current ? resolveCues(cuesByMsg?.[current.id] ?? [], currentContent) : []),
    [cuesByMsg, current?.id, currentContent],
  );
  const scenes = useMemo(() => resolvedCues.filter(r => r.cue.kind === 'theme'), [resolvedCues]);
  const revealed = streamingCurrent ? store.streamedText.length : currentContent.length;

  // The scene governing the reader's current position. Scene 0 covers from the
  // very start (so the opening is staged); each later scene opens at its anchor.
  const activeScene = useMemo(() => {
    if (!sceneOn || !scenes.length) return null;
    let idx = -1;
    for (let i = 0; i < scenes.length; i++) {
      const effStart = i === 0 ? 0 : scenes[i].start;
      if (effStart <= revealed) idx = i; else break;
    }
    if (idx < 0) return null;
    const s = scenes[idx].cue;
    const start = idx === 0 ? 0 : scenes[idx].start;
    const end = idx < scenes.length - 1 ? scenes[idx + 1].start : currentContent.length;
    return { id: s.id, css: s.css!, skeleton: s.skeleton, fx: s.fx, pace: s.pace, start, end };
  }, [sceneOn, scenes, revealed, currentContent.length]);

  useEffect(() => {
    firedRef.current = new Set(); lastLenRef.current = 0; prevSceneRef.current = null;
    stopBed(); // silence any looping ambience/music bed from the previous beat
    restoreSpeed(); // a new beat starts at the reader's own pace
    return stopBed; // also stop on unmount / leaving the view
  }, [current?.id, restoreSpeed, stopBed]);

  // Scene ENTRY (live only): punch the entry fx and retime the reveal; a scene
  // without a pace hands the speed back.
  useEffect(() => {
    if (!activeScene) { prevSceneRef.current = null; return; }
    if (activeScene.id === prevSceneRef.current) return;
    prevSceneRef.current = activeScene.id;
    if (!streamingCurrent) return;
    if (activeScene.fx) { fxSeq.current += 1; setFxSig({ seq: fxSeq.current, fx: activeScene.fx }); }
    if (activeScene.pace) applyPace(activeScene.pace); else restoreSpeed();
  }, [activeScene?.id, streamingCurrent, applyPace, restoreSpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Point cues (fx/audio) fire as the reveal crosses their anchor — live only.
  useEffect(() => {
    if (!current) return;
    const points = resolvedCues.filter(r => r.cue.kind !== 'theme');
    if (revealed < lastLenRef.current) firedRef.current = new Set(); // rewound
    lastLenRef.current = revealed;
    if (!streamingCurrent || !points.length) return;
    for (const { at, cue } of points) {
      if (at > revealed || firedRef.current.has(cue.id)) continue;
      firedRef.current.add(cue.id);
      if (cue.kind === 'audio') {
        if (cue.assetId && store.audioCuesEnabled) playAssetCue(cue);
        else if (cue.sound) playSound(cue.sound);
      } else if (cue.kind === 'fx' && cue.fx) { fxSeq.current += 1; setFxSig({ seq: fxSeq.current, fx: cue.fx, ms: cue.ms }); }
    }
  }, [current?.id, streamingCurrent, revealed, resolvedCues]);

  // A *view* (shell) takes over the screen for the current beat. Most specific
  // wins: this message's view → this chapter's → the whole chat's.
  const activeView = useMemo(() => {
    if (!enabled || !current) return undefined;
    const msg = byId[active.messages?.[current.id] ?? ''];
    const chain = currentChainId ? byId[active.chains?.[currentChainId] ?? ''] : undefined;
    const chat = byId[active.chat ?? ''];
    return [msg, chain, chat].find(c => c?.kind === 'shell');
  }, [enabled, current?.id, currentChainId, active.messages, active.chains, active.chat, byId]);

  // Full-frame takeover when a scene is active (it wins — it's this beat's
  // performance) or a saved View is. A scene shows ONLY its own slice of text.
  const viewDoc = useMemo(() => {
    if ((!activeView && !activeScene) || !current) return null;
    const css = activeScene?.css ?? activeView!.css;
    const skeleton = (activeScene?.skeleton ?? activeView?.skeleton)?.replace(/\{\{\s*title\s*\}\}/g, escapeHtml(activeView?.title ?? ''));
    const content = streamingCurrent ? '' : (activeScene ? currentContent.slice(activeScene.start, activeScene.end) : currentContent);
    return buildDoc({
      name: current.name, isUser: current.role === 'user', content,
      color: colorFor(current.name), vars, index: 0, reduceMotion,
      images: store.showImages ? current.images : undefined,
      treatment: { css, skeleton }, textHidden, forceText, fullFrame: true,
    });
  }, [activeView, activeScene, current?.id, streamingCurrent, currentContent, colorFor, vars, reduceMotion, store.showImages, textHidden, forceText]);

  // Only the active scene's slice of streamed text (segmented, not the whole msg).
  const sceneLiveHtml = activeScene
    ? formatBody(store.streamedText.slice(activeScene.start, revealed))
    : formatBody(store.streamedText);

  const style = useCallback(async (m: Message, content: string) => {
    if (!aiReady || !storyId) return;
    setBusy(b => ({ ...b, [m.id]: true }));
    try {
      const d = descriptors?.[m.id];
      const t = await generateTreatment(
        { name: m.name, isUser: m.role === 'user', content, mood: d?.mood, tension: d?.tension },
        { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel, params: samplerParamsFrom(store.aiAdvanced) },
      );
      if (t) v2.setSandboxTreatment(storyId, m.id, { css: t.css, skeleton: t.skeleton, createdAt: Date.now() });
      else setNotice('The model didn’t return a usable style for that message.');
    } catch (e: any) {
      setNotice(e?.message ? `Styling failed: ${e.message}` : 'Styling failed.');
    } finally { setBusy(b => ({ ...b, [m.id]: false })); }
  }, [aiReady, storyId, descriptors, store.aiBaseUrl, store.aiApiKey, store.aiModel, store.aiAdvanced, v2]);

  const directorInput = useMemo(() => current ? {
    name: current.name, content: currentContent,
    mood: descriptors?.[current.id]?.mood, tension: descriptors?.[current.id]?.tension,
    // The whole cast, so the director can attribute quoted lines to whoever
    // actually speaks them — not blanket the message in the author's identity.
    cast: [...new Set(store.chains.flatMap(c => c.messages).map(m => m.name))],
  } : null, [current?.id, current?.name, currentContent, descriptors, store.chains]);

  // Cards for the playback-gated messages; the streaming one types in live.
  const committed = useMemo(() => store.visibleMessages.map((m, i) => {
    const content = resolveContent(m, overrides, lensOn);
    return {
      m, content,
      doc: buildDoc({
        name: m.name, isUser: m.role === 'user', content, color: colorFor(m.name),
        vars, index: i, reduceMotion, images: store.showImages ? m.images : undefined,
        treatment: themeFor(m, msgChain[m.id]), textHidden, forceText,
      }),
    };
  }), [store.visibleMessages, overrides, lensOn, colorFor, vars, reduceMotion, store.showImages, themeFor, msgChain, textHidden, forceText]);

  const sm = store.streamingMessage;
  const streamDoc = useMemo(() => sm ? buildDoc({
    name: sm.name, isUser: sm.role === 'user', content: '', color: colorFor(sm.name),
    vars, index: store.visibleMessages.length, reduceMotion, treatment: themeFor(sm, msgChain[sm.id]), textHidden, forceText,
  }) : null, [sm?.id, sm?.name, sm?.role, colorFor, vars, reduceMotion, store.visibleMessages.length, themeFor, msgChain, textHidden, forceText]);

  if (store.chains.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-app-text/50">Nothing to render yet.</div>;
  }

  const samples = () => store.chains.flatMap(c => c.messages).filter(m => m.role !== 'user').slice(0, 6).map(m => resolveContent(m, overrides, lensOn));
  const cast = () => [...new Set(store.chains.flatMap(c => c.messages).map(m => m.name))];
  const targetFor = (scope: SandboxScope) => scope === 'message' ? current?.id : scope === 'chain' ? currentChainId : undefined;
  const applyChat = (id: string | null) => {
    if (!storyId) return;
    if (id) { const c = byId[id]; v2.setSandboxActive(storyId, c.scope, id, targetFor(c.scope)); }
    else {
      v2.clearSandboxActive(storyId, 'chat');
      if (currentChainId) v2.clearSandboxActive(storyId, 'chain', currentChainId);
      if (current) v2.clearSandboxActive(storyId, 'message', current.id);
    }
  };
  // Most-specific style active on the current beat.
  const activeId = (current && active.messages?.[current.id]) || (currentChainId && active.chains?.[currentChainId]) || active.chat;
  const currentCues = (current && cuesByMsg?.[current.id]) || [];
  const clearCues = () => storyId && current && v2.clearSandboxCues(storyId, current.id);
  // Chips: chat + chapter styles always, plus the current beat's own message style.
  const chips = configs.filter(c => c.scope !== 'message' || (current && active.messages?.[current.id] === c.id));
  const setColor = (key: 'text' | 'accent' | 'bg', val?: string) => storyId && v2.setSandboxPalette(storyId, { [key]: val });
  const hasPalette = !!(palette.text || palette.accent || palette.bg);
  const widthStyle = store.contentWidth > 0 ? { maxWidth: store.contentWidth } : undefined;
  const widthCls = store.contentWidth > 0 ? '' : 'max-w-3xl';

  const header = (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-app-text/10 bg-app-surface/50 backdrop-blur z-20">
      <button onClick={() => storyId && v2.setSandboxEnabled(storyId, !enabled)}
        title={enabled ? 'Sandbox styling on' : 'Sandbox styling off'}
        className={cn('flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border',
          enabled ? 'text-accent border-accent/40 bg-accent/10' : 'text-app-text/50 border-app-text/15')}>
        <Sparkles size={13} /> {enabled ? 'On' : 'Off'}
      </button>

      <div className="flex items-center gap-1 overflow-x-auto flex-1">
        <button onClick={() => applyChat(null)}
          className={cn('text-xs px-2 py-1 rounded-md whitespace-nowrap border',
            !activeId ? 'bg-accent/15 text-accent border-accent/40' : 'text-app-text/60 border-transparent hover:border-app-text/15')}>
          Plain
        </button>
        {chips.map(c => (
          <span key={c.id} className={cn('group/chip flex items-center rounded-md border whitespace-nowrap',
            activeId === c.id ? 'bg-accent/15 text-accent border-accent/40' : 'text-app-text/70 border-transparent hover:border-app-text/15')}>
            <button onClick={() => applyChat(c.id)} className="text-xs pl-2 py-1" title={c.intent || c.name}>
              {c.kind === 'shell' ? '▦ ' : ''}{c.name}{c.scope === 'chain' ? ' ·ch' : c.scope === 'message' ? ' ·msg' : ''}
            </button>
            <button onClick={() => setModal({ scope: c.scope, editConfig: c })}
              className="px-0.5 opacity-0 group-hover/chip:opacity-60 hover:!opacity-100" title="Edit style"><Pencil size={11} /></button>
            <button onClick={() => storyId && v2.deleteSandboxConfig(storyId, c.id)}
              className="pr-1.5 pl-0.5 opacity-0 group-hover/chip:opacity-60 hover:!opacity-100" title="Delete style"><X size={11} /></button>
          </span>
        ))}
        {sceneMeta && current && (
          <span className={cn('group/scene flex items-center rounded-md border whitespace-nowrap',
            sceneOn ? 'bg-accent/15 text-accent border-accent/40' : 'text-app-text/60 border-transparent hover:border-app-text/15')}>
            <button onClick={() => storyId && v2.toggleSandboxScene(storyId, current.id, !sceneMeta.enabled)}
              className="text-xs pl-2 py-1 flex items-center gap-1"
              title={sceneOn ? 'Scene on — click to read this beat plain' : 'Scene off — click to perform it'}>
              <Clapperboard size={11} /> {sceneMeta.name}
            </button>
            <button onClick={clearCues}
              className="pr-1.5 pl-0.5 opacity-0 group-hover/scene:opacity-60 hover:!opacity-100" title="Delete scene"><X size={11} /></button>
          </span>
        )}
      </div>

      <button onClick={() => store.setLayoutMode(paged ? 'continuous' : 'paginated')}
        title={paged ? 'Paginated by chapter — click for one long scroll' : 'Continuous — click to paginate by chapter'}
        className="p-1.5 rounded-md border border-app-text/15 text-app-text/60 hover:text-accent hover:border-accent/40">
        {paged ? <BookOpen size={15} /> : <ScrollText size={15} />}
      </button>
      <div className="relative">
        <button onClick={e => { e.stopPropagation(); setShowColors(s => !s); }} title="Recolour"
          className={cn('p-1.5 rounded-md border', hasPalette ? 'text-accent border-accent/40' : 'text-app-text/60 border-app-text/15 hover:text-accent hover:border-accent/40')}>
          <Palette size={15} />
        </button>
        {showColors && (
          <div className="absolute right-0 mt-1 z-30 w-52 rounded-lg bg-app-surface border border-app-text/15 shadow-xl p-3 space-y-2" onClick={e => e.stopPropagation()}>
            {([['text', 'Text'], ['accent', 'Accent'], ['bg', 'Background']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center justify-between text-xs text-app-text/70">
                {label}
                <span className="flex items-center gap-2">
                  <input type="color" value={(palette as any)[k] || (k === 'text' ? baseVars.text : k === 'accent' ? baseVars.accent : baseVars.bg)}
                    onChange={e => setColor(k, e.target.value)} className="h-6 w-8 rounded cursor-pointer bg-transparent" />
                  {(palette as any)[k] && <button onClick={() => setColor(k, undefined)} className="text-app-text/40 hover:text-app-text"><X size={12} /></button>}
                </span>
              </label>
            ))}
            {hasPalette && (
              <button onClick={() => storyId && v2.setSandboxPalette(storyId, { text: undefined, accent: undefined, bg: undefined })}
                className="w-full text-xs text-app-text/60 hover:text-app-text pt-1">Reset colours</button>
            )}
          </div>
        )}
      </div>

      {current && (
        <span className={cn('flex items-center rounded-md border whitespace-nowrap',
          currentCues.length ? 'text-accent border-accent/40 bg-accent/10' : 'border-app-text/15')}>
          <button onClick={() => setDirectorOpen(true)} disabled={!aiReady}
            title={!aiReady ? 'Connect an AI endpoint in Settings'
              : currentCues.length ? 'Re-direct this beat' : 'Direct this beat — plan & stage scenes as it reads'}
            className={cn('flex items-center gap-1 text-xs px-2 py-1 disabled:opacity-40',
              currentCues.length ? '' : 'text-app-text/70 hover:text-accent')}>
            <Clapperboard size={13} />
            {currentCues.length ? `${currentCues.length} cue${currentCues.length > 1 ? 's' : ''}` : 'Direct beat'}
          </button>
          {currentCues.length > 0 && (
            <button onClick={clearCues} title="Clear cues" className="pr-1.5 pl-0.5 opacity-60 hover:opacity-100"><X size={11} /></button>
          )}
        </span>
      )}

      <button onClick={() => setModal({ scope: 'chat' })} title="New style"
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-accent text-white hover:bg-accent/90">
        <Plus size={13} /> New style
      </button>
    </div>
  );

  const toolbarFor = (m: Message, content: string) => {
    const has = !!themeFor(m, msgChain[m.id]);
    const isBusy = !!busy[m.id];
    return (
      <>
        <ToolBtn title={!aiReady ? 'Connect an AI endpoint in Settings' : has ? 'Restyle this message' : 'Style this message with AI'}
          disabled={!aiReady || isBusy} onClick={() => style(m, content)}>
          {isBusy ? <Loader2 size={15} className="animate-spin" /> : has ? <RefreshCw size={15} /> : <Wand2 size={15} />}
        </ToolBtn>
        {treatments?.[m.id] && (
          <ToolBtn title="Plain card" disabled={isBusy} onClick={() => storyId && v2.clearSandboxTreatment(storyId, m.id)}>
            <Type size={15} />
          </ToolBtn>
        )}
      </>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="sandbox"
      onClick={() => showColors && setShowColors(false)}>
      {header}
      {viewDoc ? (
        <div data-testid="sandbox-shell" className="flex-1 min-h-0">
          <SandboxCard doc={viewDoc} title="Sandbox view" fill fx={fxSig}
            liveHtml={streamingCurrent ? sceneLiveHtml : undefined} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className={cn('mx-auto w-full px-4 py-6', widthCls)} style={widthStyle}>
            {committed.map(({ m, content, doc }) => (
              <SandboxCard key={m.id} doc={doc} title={`${m.name} — sandbox`} toolbar={toolbarFor(m, content)} />
            ))}
            {sm && streamDoc && (
              <SandboxCard key={sm.id} doc={streamDoc} title={`${sm.name} — sandbox`} fx={fxSig} liveHtml={formatBody(store.streamedText)} />
            )}
          </div>
        </div>
      )}

      {notice && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-lg bg-red-500/90 text-white text-sm shadow-lg">
          {notice}
        </div>
      )}

      {modal && storyId && (
        <SandboxStudioModal
          storyId={storyId}
          initialScope={modal.scope}
          currentChainId={currentChainId}
          currentMessageId={current?.id}
          editConfig={modal.editConfig}
          samples={samples()}
          cast={cast()}
          onClose={() => setModal(null)}
        />
      )}

      {directorOpen && storyId && current && directorInput && (
        <SceneDirectorModal
          storyId={storyId}
          messageId={current.id}
          input={directorInput}
          onClose={() => { setDirectorOpen(false); firedRef.current = new Set(); }}
        />
      )}
    </div>
  );
};
