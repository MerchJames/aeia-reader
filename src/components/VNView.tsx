import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { SceneAtmosphere } from './SceneAtmosphere';
import { useSceneVfx, useSceneWeather } from '../hooks/useSceneWeather';
import { processText, balanceEmphasis, truncateToWord } from '../utils/textProcessor';
import { MOOD_COLOR, sceneAtmosphere } from '../utils/sceneMood';
import { bucketFor } from '../lib/spriteStorage';
import { spriteFor, useSpriteStore } from '../stores/useSpriteStore';
import { backdropForScene, useBackdropStore } from '../stores/useBackdropStore';
import { reactionFor, renderWithEmphasis } from './StageView';
import { MarkupRenderContext } from '../utils/bookLayout';
import { resolveCharColors } from '../utils/markupStyles';
import { latestSpeech } from '../utils/dialogueSegments';
import { readerEmphasis } from '../utils/performMarkup';
import { mergePerformCues, performMatcher } from '../utils/scenePerform';
import { SceneFx } from './SceneFx';
import { SceneVfx } from './SceneVfx';
import { deriveStaging } from '../utils/vnStaging';
import { deriveVfx, emoteFor, stickyWeather } from '../utils/sceneVfx';
import { resolveWeather } from '../utils/sceneWeather';
import { Message } from '../types';
import { cn } from '../utils/cn';

/**
 * Visual Novel mode — the story as a full-bleed staged scene (its own mode,
 * distinct from the RPG-flavored Stage; presentation ideas after classic VN
 * engines, all code original). The area backdrop fills the screen and
 * announces itself with a title card when the story moves somewhere new; the
 * ACTIVE speaker's sprite stands in focus with a slow camera push-in while
 * they speak; high tension closes cinematic letterbox bars; the dialogue box
 * floats over the scene, VN style.
 */
export const VNView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  useSceneDirector();
  const { active: scene, activeId: activeSceneId } = useScenes();

  const current: Message | undefined =
    store.streamingMessage ?? store.visibleMessages[store.visibleMessages.length - 1];
  const isUser = current?.role === 'user';
  const story = store.currentStory;

  const rawText = store.streamingMessage
    // Hide the in-progress last word only WHILE revealing — show it whole once
    // the passage is committed so short lines never appear cut off on the hold.
    ? balanceEmphasis(store.revealComplete ? store.streamedText : truncateToWord(store.streamedText))
    : current
      ? processText(resolveContent(current, overrides, lensOn), {
          hideMetadata: store.hideMetadata && !current.hidden,
          oocHandling: store.oocHandling,
          autoFormat: store.autoFormat,
          autoFormatRules: store.autoFormatRules,
          paragraphSpacing: store.paragraphSpacing,
          smartTypography: store.smartTypography,
          substituteNames: store.substituteNames,
          characterName: story?.characterName,
          userName: story?.userName,
          styleQuotes: false,
          role: current.role,
        }).processedText
      : '';

  const descriptor = storyId && current ? v2.sceneByStory[storyId]?.[current.id] : undefined;
  const sfxMarks = storyId && current ? v2.sfxMarksByStory[storyId]?.[current.id] : undefined;
  const emphasis = readerEmphasis(
    descriptor?.emphasis, sfxMarks,
    storyId && current ? v2.emphasisMarksByStory[storyId]?.[current.id] : undefined,
  );
  const bucket = bucketFor(descriptor?.speaker?.emotion);

  // ADV-style box, like a real VN (and like the RPG / Text Message feel the
  // reader asked for): the CURRENT BEAT only — the spoken line front and
  // center, the narration around it as a quiet band. Falls back to the
  // latest narration paragraph when nobody is speaking.
  // Known names for attribution — leads, senders, avatar owners. Voiced NPCs
  // not in this list are still caught by the speech-verb guess in latestSpeech.
  const cast = useMemo(
    () => [...new Set([
      story?.characterName, story?.userName,
      ...Object.keys(story?.characterAvatars ?? {}),
      ...store.chains.flatMap(c => c.messages).map(m => m.name),
    ].filter(Boolean) as string[])],
    [story?.id, store.chains],
  );
  const speech = useMemo(
    () => latestSpeech(rawText, { author: current?.name ?? story?.characterName ?? 'Story', cast, dialogue: descriptor?.dialogue }),
    [rawText, current?.name, story?.characterName, cast, descriptor?.dialogue],
  );
  const dialogue = speech?.line ?? null;
  const beat = useMemo(() => {
    const paras = rawText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const lastPara = paras[paras.length - 1] ?? '';
    if (!dialogue) {
      return { primary: lastPara, primaryIsSpeech: false, aside: null as string | null };
    }
    // Narration living in the same paragraph as the speech becomes the aside.
    const aside = lastPara.includes(dialogue)
      ? lastPara.replace(dialogue, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim()
      : null;
    return { primary: dialogue, primaryIsSpeech: true, aside: aside || null };
  }, [rawText, dialogue]);

  const perform = store.scenePerformance && storyId && current
    ? mergePerformCues(v2.performMarksByStory[storyId]?.[current.id], descriptor?.perform)
    : undefined;
  // See StageView: this view rebuilds its markup every reveal tick, so without
  // a set that outlives the render a cue restarts on every one of them.
  const vnPlayedRef = useRef<{ key: string; set: Map<string, number> }>({ key: '', set: new Map() });
  const vnPlayedKey = current?.id ?? '';
  if (vnPlayedRef.current.key !== vnPlayedKey) {
    vnPlayedRef.current = { key: vnPlayedKey, set: new Map() };
  }
  // ----- the cast on stage --------------------------------------------------
  // The character HOLDS the scene (dimmed while the reader speaks — never a
  // bare stage during user turns); the reader joins beside them when they
  // have a sprite or picture of their own. Whoever speaks takes the light.
  // The name band shows who's actually speaking — a voiced NPC by name, not the
  // lead — falling back to the message's own character for narration.
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const speakerName = beat.primaryIsSpeech && speech?.attributed
    ? speech.speaker
    : (current?.name ?? story?.characterName ?? 'Story');

  // The dialogue box's speaker for per-character color: the same attributed
  // speaker the name band already shows, not just the message's own author —
  // a voiced NPC's line gets that NPC's color, not the lead's.
  const markupCtx: MarkupRenderContext = useMemo(() => ({
    dialogueColor: store.dialogueColor,
    dialogueStyle: store.dialogueStyle,
    dialogueAnimation: store.dialogueAnimation,
    markup: store.markupPresets,
    charColors: resolveCharColors(
      speakerName, store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
    ),
    animate: !store.streamingMessage,
  }), [
    store.dialogueColor, store.dialogueStyle, store.dialogueAnimation, store.markupPresets,
    store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
    speakerName, store.streamingMessage,
  ]);

  const primaryHtml = useMemo(
    () => renderWithEmphasis(
      beat.primary, emphasis, false, perform, undefined, vnPlayedRef.current.set,
      performMatcher(perform), markupCtx,
    ),
    [beat.primary, emphasis, perform, markupCtx],
  );

  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);

  const charName = useMemo(() => {
    if (current && !isUser) return current.name;
    for (let i = store.visibleMessages.length - 1; i >= 0; i--) {
      const m = store.visibleMessages[i];
      if (m.role !== 'user') return m.name;
    }
    return story?.characterName ?? 'Story';
  }, [current, isUser, store.visibleMessages, story?.characterName]);

  const charSprite = spriteFor(story?.id, charName, !isUser ? bucket : 'neutral', sprites, spriteUrls);
  const charPortrait = charSprite
    ?? (!isUser ? current?.avatar : undefined)
    ?? story?.characterAvatars?.[charName]
    ?? story?.characterAvatar
    ?? story?.avatar;
  const userSprite = spriteFor(
    story?.id, `user:${story?.userName ?? 'You'}`, isUser ? bucket : 'neutral', sprites, spriteUrls);
  const userPortrait = userSprite ?? story?.userAvatar;
  const bothOnStage = !!charPortrait && !!userPortrait;

  // ----- the area (backdrop + title card) ----------------------------------
  const backdrops = useBackdropStore(s => s.backdrops);
  const backdropUrls = useBackdropStore(s => s.urls);
  const backdrop = store.showImages
    ? backdropForScene(story?.id, scene?.location, scene?.mood, backdrops, backdropUrls)
    : null;

  const [areaCard, setAreaCard] = useState<string | null>(null);
  const lastAreaRef = useRef<string | null>(null);
  useEffect(() => {
    const area = scene?.location ?? null;
    if (!area || area === lastAreaRef.current) return;
    lastAreaRef.current = area;
    setAreaCard(area);
    const t = setTimeout(() => setAreaCard(null), 2600);
    return () => clearTimeout(t);
  }, [scene?.location]);

  // ----- the shot -----------------------------------------------------------
  // A VN scene shouldn't hold one frozen pose for a whole message: the camera
  // reads the CURRENT beat and reframes — pushing in on the talker, cutting
  // wide when we arrive somewhere new. Heuristic by default; the Director's
  // `shot`/tension sharpens it. (See utils/vnStaging.)
  // The reader takes the light when the line is theirs (even a rare user line
  // the author quotes); otherwise the character's side holds the speech.
  const speakerSide = beat.primaryIsSpeech
    ? (norm(speech?.speaker) === norm(story?.userName ?? 'You') ? 'user' : 'char')
    : null;
  const staging = useMemo(
    () => deriveStaging({
      primaryIsSpeech: beat.primaryIsSpeech,
      speakerSide,
      descriptor,
      locationJustChanged: !!areaCard,
      bothOnStage,
    }),
    [beat.primaryIsSpeech, speakerSide, descriptor, areaCard, bothOnStage],
  );

  // Screen special effect for this beat — the Director's vfx, else a mood punch
  // derived from the passage's read. Falls back to the ASSET-FREE heuristic
  // scene mood/tension when no AI descriptor exists, so effects work AI-off.
  const beatKey = `${current?.id ?? 'x'}:${beat.primary.slice(0, 32)}`;
  const vfx = useSceneVfx(scene, current?.id);

  // A `shake` moves the frame itself, so it rides a root class (not the overlay).
  const [shakeNow, setShakeNow] = useState(false);
  const shakenBeat = useRef('');
  useEffect(() => {
    if (vfx !== 'shake') return;
    if (shakenBeat.current === beatKey) return;
    shakenBeat.current = beatKey;
    setShakeNow(true);
    const t = setTimeout(() => setShakeNow(false), 520);
    return () => clearTimeout(t);
  }, [vfx, beatKey]);

  // Weather lingers across a scene (Fablekin's stickyUntil), then the current
  // passage's own fx wins.
  const weather = useSceneWeather(scene, current ? { id: current.id, content: rawText } : undefined);

  // A VN emote pop over the lit sprite at a loud emotion.
  const emote = store.themeEffects ? emoteFor(descriptor?.speaker?.emotion) : null;

  // ----- cinematics ---------------------------------------------------------
  const tension = scene
    ? (scene.tensionById[current?.id ?? ''] ?? scene.peakTension)
    : 0;
  const letterbox = store.themeEffects && tension >= 0.72;

  const atmo = scene
    ? sceneAtmosphere(scene.mood, tension, scene.timeOfDay)
    : null;
  const tintVars = (store.sceneTheming && store.themeEffects && scene && atmo
    ? { '--scene-tint': MOOD_COLOR[scene.mood], '--scene-tint-a': String(atmo.washOpacity) }
    : {}) as React.CSSProperties;

  const atmosphereOn = store.sceneTheming && store.themeEffects;
  const [lightbox, setLightbox] = useState<string | null>(null);

  // The most recent image stays on scene as a CG (VN persistence).
  const sceneImages = useMemo(() => {
    if (!store.showImages) return [] as string[];
    const INLINE_IMG = /!\[[^\]]*\]\(([^)\s]+)\)/g;
    const imagesOf = (m: Message): string[] => [
      ...(m.images ?? []),
      ...[...m.content.matchAll(INLINE_IMG)].map(match => match[1]),
    ];
    const timeline = [...store.visibleMessages, ...(store.streamingMessage ? [store.streamingMessage] : [])];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const imgs = imagesOf(timeline[i]);
      if (imgs.length > 0) return imgs;
    }
    return [] as string[];
  }, [store.showImages, store.visibleMessages, store.streamingMessage]);

  // CG choreography: a new picture shouldn't just float over the sprite. It
  // stands in CENTER STAGE for a beat (the sprite steps aside), then shrinks
  // and docks to the side so the sprite retakes the scene. A CG that's already
  // been revealed stays docked (no re-reveal on later beats).
  const cgSrc = sceneImages[0];
  const [cgPhase, setCgPhase] = useState<'reveal' | 'docked' | null>(null);
  const cgShownRef = useRef<string | null>(null);
  useEffect(() => {
    // No picture right now — hide it, but REMEMBER the last one shown so a
    // transient blip (streaming re-render) doesn't re-trigger the reveal.
    if (!cgSrc) { setCgPhase(null); return; }
    // Already revealed this exact picture — keep it docked, don't re-reveal.
    if (cgShownRef.current === cgSrc) { setCgPhase(p => (p === 'reveal' ? p : 'docked')); return; }
    cgShownRef.current = cgSrc;
    setCgPhase('reveal');
    const t = setTimeout(() => setCgPhase('docked'), 2600);
    return () => clearTimeout(t);
  }, [cgSrc]);

  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [primaryHtml]);

  const reaction = store.themeEffects ? reactionFor(descriptor?.speaker?.emotion) : null;

  if (store.chains.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-50">
        <p className="text-lg">This story is empty.</p>
      </div>
    );
  }

  return (
    <div
      className={cn('vn relative z-10 flex-1 min-h-0 overflow-hidden', shakeNow && 'fx-shake', store.isAutofocusMode && 'vn-autofocus')}
      style={tintVars}
    >
      <SceneAtmosphere scene={scene} activeId={activeSceneId} enabled={atmosphereOn} />

      {/* The area. */}
      {backdrop && (
        <div key={backdrop.id} className="vn-backdrop" aria-hidden="true">
          <img src={backdrop.url} alt="" />
        </div>
      )}
      <div className="vn-wash" aria-hidden="true" />

      {/* Director-called particle weather rides above the backdrop; it lingers
          across the scene until a new area or a fresh cue replaces it. */}
      {store.themeEffects && <SceneFx fx={weather?.fx} level={weather?.level} />}

      {/* The camera: reframes per beat — push in on the talker, wide on arrival. */}
      <div
        className={cn(
          'vn-camera',
          `vn-shot-${staging.shot}`,
          `vn-focus-${staging.focus}`,
          staging.dof && 'vn-dof',
          cgPhase === 'reveal' && 'vn-cg-revealing',
        )}
      >
        {charPortrait && (
          <div
            key={`c-${current?.id ?? 'x'}-${charSprite ? bucket : 'av'}`}
            className={cn(
              'vn-sprite',
              bothOnStage ? 'vn-sprite-left' : 'vn-sprite-solo',
              isUser && 'vn-dim',
            )}
          >
            {/* Reaction rides the IMG — the wrapper's centering transform
                must never be overridden by the emotion keyframes. */}
            <img
              src={charPortrait} alt={charName} draggable={false}
              className={cn(!isUser && reaction)}
            />
            {!isUser && emote && (
              <span key={beatKey} className="vn-emote" aria-hidden="true">{emote}</span>
            )}
          </div>
        )}
        {userPortrait && (
          <div
            key={`u-${current?.id ?? 'x'}-${userSprite ? bucket : 'av'}`}
            className={cn(
              'vn-sprite vn-sprite-user',
              bothOnStage ? 'vn-sprite-right' : 'vn-sprite-solo',
              !isUser && 'vn-dim',
            )}
          >
            <img
              src={userPortrait} alt={story?.userName ?? 'You'} draggable={false}
              className={cn(isUser && reaction)}
            />
            {isUser && emote && (
              <span key={beatKey} className="vn-emote" aria-hidden="true">{emote}</span>
            )}
          </div>
        )}
      </div>

      {/* Screen special effect (flash / vignette / desaturate / glitch / bloom). */}
      <SceneVfx kind={vfx} beatKey={beatKey} />

      {cgSrc && (
        <div
          className={cn('vn-cg', cgPhase === 'reveal' ? 'vn-cg-reveal' : 'vn-cg-docked')}
          onClick={() => setLightbox(cgSrc)}
        >
          <img src={cgSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </div>
      )}

      {/* Area title card. */}
      {areaCard && <div className="vn-area">{areaCard}</div>}

      {/* Cinematic letterbox under high tension. */}
      <div className={cn('vn-bar vn-bar-top', letterbox && 'vn-bar-on')} aria-hidden="true" />
      <div className={cn('vn-bar vn-bar-bottom', letterbox && 'vn-bar-on')} aria-hidden="true" />

      {/* The dialogue box floats over the scene. */}
      <div className="vn-boxwrap">
        <div
          className="vn-box"
          onClick={() => store.setIsStreaming(!store.isStreaming)}
        >
          {beat.primaryIsSpeech && <div className="vn-name">{speakerName}</div>}
          {beat.aside && <div className="vn-aside">{beat.aside}</div>}
          <div
            ref={boxRef}
            className={cn('vn-text markdown-body', !beat.primaryIsSpeech && 'vn-narration')}
            /* Where the magnifier looks — the dialogue box holds the words. */
            data-reveal-edge=""
            style={{ fontSize: `${store.fontSize}px` }}
            dangerouslySetInnerHTML={{ __html: primaryHtml }}
          />
          {store.isStreaming && <span className="vn-cursor" aria-hidden="true">▼</span>}
        </div>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-lg shadow-2xl object-contain" referrerPolicy="no-referrer" />
        </div>
      )}
    </div>
  );
};
