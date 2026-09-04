import React, { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { SceneAtmosphere } from './SceneAtmosphere';
import { useSceneVfx, useSceneWeather } from '../hooks/useSceneWeather';
import { SceneSpine } from './SceneSpine';
import { processText, balanceEmphasis, truncateToWord } from '../utils/textProcessor';
import { MarkupRenderContext, renderInline } from '../utils/bookLayout';
import { useFontColor, type FontColorContext } from '../hooks/useFontColor';
import { resolveCharColors } from '../utils/markupStyles';
import { MOOD_COLOR, sceneAtmosphere } from '../utils/sceneMood';
import { bucketFor } from '../lib/spriteStorage';
import { spriteFor, useSpriteStore } from '../stores/useSpriteStore';
import { backdropForScene, useBackdropStore } from '../stores/useBackdropStore';
import { SceneFx } from './SceneFx';
import { SceneVfx } from './SceneVfx';
import { deriveVfx, emoteFor, stickyWeather } from '../utils/sceneVfx';
import { resolveWeather } from '../utils/sceneWeather';
import { Message, SceneEmphasis, ScenePerformCue } from '../types';
import { RunMatcher, mergePerformCues, performMatcher, performWordKinds } from '../utils/scenePerform';
import { emphasisClass, emphasisKindKey, markPerformHtml, readerEmphasis } from '../utils/performMarkup';
import { latestSpeech } from '../utils/dialogueSegments';
import { cn } from '../utils/cn';

/**
 * Render a paragraph with the Director's emphasis + performance spans woven
 * in: the verbatim substrings are fenced with private-use markers BEFORE the
 * inline markdown pass (so escaping can't break the match) and swapped for
 * styled spans after. Whispers shrink, shouts swell, beats pulse; performance
 * cues swell/tremble/drop/fade the words they mark.
 */
/** Kinds Stage dresses in its own type. Everything else shares the reader's. */
const STAGE_EMPHASIS: ReadonlySet<string> = new Set(['whisper', 'shout', 'beat', 'sfx']);

export const renderWithEmphasis = (
  para: string,
  emphasis: SceneEmphasis[] | undefined,
  images: boolean,
  perform?: ScenePerformCue[],
  /** Share one set across a message's paragraphs so a cue fires once. */
  claimed?: Set<string>,
  /**
   * Words whose treatment has already animated, kept ACROSS renders.
   *
   * This view rebuilds its markup on every reveal tick, so without it a marked
   * word in the already-revealed part of the passage restarted its animation
   * every tick — 268 restarts on one word in six seconds. A cue fires on the
   * reveal of its word; strobing afterwards reads as a fault.
   */
  played?: Map<string, number>,
  /** This message's cadence matcher, shared across its paragraphs — see runMatcher. */
  match?: RunMatcher,
  /** Channel colors/styles (+ resolved per-character color) — see MarkupRenderContext. */
  markupCtx?: MarkupRenderContext,
  /** How to paint the colours the author wrote — see `utils/fontColor`. */
  fontColor?: FontColorContext,
): string => {
  // Emphasis still fences whole spans — a whisper is a phrase, and shrinking
  // it word by word would read as a stutter. Performance does NOT: it marks
  // one word at a time, the same as the reader views, via `markPerformHtml`.
  // Wrapping the whole span here was why the same cue looked like two
  // different features depending on which view you were in.
  // The four vocal kinds have Stage-specific type; the typographic ones added
  // later wear the same classes as everywhere else, so a colour or a strike
  // looks the same on the stage as it does on the page.
  const marks: { text: string; cls: string }[] = (emphasis ?? [])
    .map(e => {
      const key = emphasisKindKey(e);
      return {
        text: e.text,
        cls: STAGE_EMPHASIS.has(key) ? `stage-emk-${key}` : emphasisClass(key),
      };
    });

  let html: string;
  if (!marks.length) {
    html = renderInline(para, { images, markupCtx, fontColor });
  } else {
    let marked = para;
    const used: number[] = [];
    marks.forEach((mk, i) => {
      if (!mk.text || !marked.includes(mk.text)) return;
      marked = marked.replace(mk.text, `\uE010${i}\uE011${mk.text}\uE014${i}\uE015`);
      used.push(i);
    });
    html = renderInline(marked, { images, markupCtx, fontColor });
    for (const i of used) {
      html = html
        .replace(`\uE010${i}\uE011`, `<span class="${marks[i].cls}">`)
        .replace(`\uE014${i}\uE015`, '</span>');
    }
  }
  return markPerformHtml(html, performWordKinds(perform), { claimed, played, match });
};

/**
 * Stage view — the story as a visual-novel / RPG scene (design cues from
 * classic VN engines; all code original). The two leads stand on stage as
 * portraits; whoever is speaking is IN FOCUS (bright, forward) while the
 * other waits in shadow. Their current spoken line pops as a speech bubble
 * over the portrait, and the FULL passage streams into the big textbox at
 * the bottom, JRPG style. Themes dress the stage: RPG Quest, Pixel RPG,
 * Pixel Chat, and Snek Comms each restyle box/portraits/bubble.
 */

/**
 * The line currently being spoken: the LAST quoted span in the text, still
 * open (mid-sentence while streaming) or just closed. Null when narration.
 */
export const latestDialogue = (text: string): string | null => {
  let open = -1;
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '“') open = i + 1;
    else if (c === '”') {
      if (open >= 0) { last = text.slice(open, i); open = -1; }
    } else if (c === '"') {
      if (open >= 0) { last = text.slice(open, i); open = -1; }
      else open = i + 1;
    }
  }
  if (open >= 0 && open < text.length) last = text.slice(open);
  // The bubble shows spoken words only — markdown markers stay in the box.
  const t = last?.replace(/[*_`]/g, '').trim();
  return t ? t : null;
};

/**
 * Director-driven portrait reactions: the speaker's read emotion animates
 * the focused portrait (anger shakes, joy bounces...) and — when the reader
 * has uploaded an expression set for the character — swaps the sprite too.
 */
export const reactionFor = (emotion?: string): string | null => {
  const bucket = bucketFor(emotion);
  return bucket === 'neutral' ? null : `stage-em-${bucket}`;
};

const Portrait = ({
  avatar, name, active, side, reaction, emote,
}: {
  avatar?: string; name: string; active: boolean; side: 'left' | 'right';
  reaction?: string | null; emote?: string | null;
}) => (
  <div
    className={cn(
      'stage-portrait', `stage-portrait-${side}`,
      active ? 'stage-focus' : 'stage-dim',
      active && reaction,
    )}
  >
    {avatar ? (
      <img src={avatar} alt={name} draggable={false} />
    ) : (
      <div className="stage-portrait-fallback">{(name[0] ?? '?').toUpperCase()}</div>
    )}
    {active && emote && <span className="stage-emote" aria-hidden="true">{emote}</span>}
  </div>
);

export const StageView = () => {
  const store = useAppStore();
  const fontColor = useFontColor();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  useSceneDirector();
  const { scenes, active: scene, activeId: activeSceneId } = useScenes();

  // The passage on stage: the streaming message, else the last one read.
  const current: Message | undefined =
    store.streamingMessage ?? store.visibleMessages[store.visibleMessages.length - 1];
  const isUser = current?.role === 'user';

  const rawText = store.streamingMessage
    // Hide the in-progress last word only WHILE revealing — once the passage is
    // committed (the end-of-message hold), show it whole so it never looks cut off.
    ? balanceEmphasis(store.revealComplete ? store.streamedText : truncateToWord(store.streamedText))
    : current
      ? processText(resolveContent(current, overrides, lensOn), {
          hideMetadata: store.hideMetadata && !current.hidden,
          fontColorMode: store.fontColorMode,
          oocHandling: store.oocHandling,
          autoFormat: store.autoFormat,
          autoFormatRules: store.autoFormatRules,
          paragraphSpacing: store.paragraphSpacing,
          smartTypography: store.smartTypography,
          substituteNames: store.substituteNames,
          characterName: store.currentStory?.characterName,
          userName: store.currentStory?.userName,
          styleQuotes: false,
          role: current.role,
        }).processedText
      : '';

  // Images never render inside the textbox — they belong ON the stage (CG).
  // The Director's whisper/shout/beat spans are woven into the words (the
  // Stage is a performance, so emphasis is always on here).
  const baseEmphasis = storyId && current
    ? v2.sceneByStory[storyId]?.[current.id]?.emphasis
    : undefined;
  // Reader-authored marks — sounds and typography — weave in alongside the
  // Director's, always on: this is the reader's own marking of the page.
  const sfxMarks = storyId && current ? v2.sfxMarksByStory[storyId]?.[current.id] : undefined;
  const emphasis = readerEmphasis(
    baseEmphasis, sfxMarks,
    storyId && current ? v2.emphasisMarksByStory[storyId]?.[current.id] : undefined,
  );
  // The performance track's visual half — the pacing half is the streamer's.
  const perform = store.scenePerformance && storyId && current
    ? mergePerformCues(
      v2.performMarksByStory[storyId]?.[current.id],
      v2.sceneByStory[storyId]?.[current.id]?.perform,
    )
    : undefined;
  // Survives re-renders, reset when the passage changes: a cue animates the
  // first time its word appears and holds still after.
  const playedRef = useRef<{ key: string; set: Map<string, number> }>({ key: '', set: new Map() });
  const playedKey = current?.id ?? '';
  if (playedRef.current.key !== playedKey) playedRef.current = { key: playedKey, set: new Map() };

  // Stage shows one passage at a time, so its speaker (for per-character
  // color) is simply that message's own name.
  const markupCtx: MarkupRenderContext = useMemo(() => ({
    dialogueColor: store.dialogueColor,
    dialogueStyle: store.dialogueStyle,
    dialogueAnimation: store.dialogueAnimation,
    markup: store.markupPresets,
    charColors: resolveCharColors(
      current?.name, store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
    ),
    animate: !store.streamingMessage,
  }), [
    store.dialogueColor, store.dialogueStyle, store.dialogueAnimation, store.markupPresets,
    store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
    current?.name, store.streamingMessage,
  ]);

  const bodyHtml = useMemo(
    () => {
      // One claimed set for the whole passage: a cue marks its word once per
      // message, not once per paragraph.
      const claimed = new Set<string>();
      // One matcher too — a cadence run can straddle a paragraph break.
      const match = performMatcher(perform);
      return rawText
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${renderWithEmphasis(p, emphasis, false, perform, claimed, playedRef.current.set, match, markupCtx, fontColor)}</p>`)
        .join('');
    },
    [rawText, emphasis, perform, markupCtx],
  );

  // The stage CG: like a VN, the most recent image (attached OR inline in
  // the prose) takes center stage and STAYS until a newer one replaces it.
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
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  // The Director's read of the passage animates the speaker (when effects on)
  // and picks the character's expression sprite when one is uploaded.
  const descriptor = storyId && current ? v2.sceneByStory[storyId]?.[current.id] : undefined;
  const reaction = store.themeEffects ? reactionFor(descriptor?.speaker?.emotion) : null;
  const emote = store.themeEffects ? emoteFor(descriptor?.speaker?.emotion) : null;
  const bucket = bucketFor(descriptor?.speaker?.emotion);

  // Screen special effect for this passage — the Director's vfx, else a mood
  // punch (heuristic scene mood/tension when there's no AI descriptor, so it
  // works AI-off). `shake` moves the stage itself (root class); rest is overlay.
  const vfx = useSceneVfx(scene, current?.id);
  const [shakeNow, setShakeNow] = React.useState(false);
  const shakenMsg = useRef('');
  useEffect(() => {
    if (vfx !== 'shake' || !current) return;
    if (shakenMsg.current === current.id) return;
    shakenMsg.current = current.id;
    setShakeNow(true);
    const t = setTimeout(() => setShakeNow(false), 520);
    return () => clearTimeout(t);
  }, [vfx, current?.id]);

  // Weather lingers across the scene, then this passage's own fx wins.
  const weather = useSceneWeather(scene, current ? { id: current.id, content: rawText } : undefined);
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);

  // The scene's location dresses the stage (keyword-matched backdrop).
  const backdrops = useBackdropStore(s => s.backdrops);
  const backdropUrls = useBackdropStore(s => s.urls);
  const backdrop = store.showImages
    ? backdropForScene(storyId, scene?.location, scene?.mood, backdrops, backdropUrls)
    : null;

  // The scene's mood reaches the stage itself (glow + tinted chrome).
  const atmo = scene ? sceneAtmosphere(scene.mood, scene.tensionById[scene.endId] ?? scene.peakTension, scene.timeOfDay) : null;
  const tintVars = (store.sceneTheming && store.themeEffects && scene && atmo
    ? { '--scene-tint': MOOD_COLOR[scene.mood], '--scene-tint-a': String(atmo.washOpacity) }
    : {}) as React.CSSProperties;

  // Portrait sources — the story's lead on the left, the reader on the right.
  const story = store.currentStory;
  const aiName = !current || isUser
    ? (story?.characterName ?? 'Story')
    : current.name;
  const aiAvatar = (!isUser ? current?.avatar : undefined)
    ?? story?.characterAvatars?.[aiName]
    ?? story?.characterAvatar
    ?? story?.avatar;
  const userName = story?.userName ?? 'You';
  const userAvatar = story?.userAvatar;

  // Known names for attribution: the two leads plus every character that has
  // ever sent a message or owns an avatar. NPCs the author only voices in the
  // prose aren't here — the speech-verb guess in latestSpeech catches those.
  const cast = useMemo(
    () => [...new Set([
      story?.characterName, story?.userName,
      ...Object.keys(story?.characterAvatars ?? {}),
      ...store.chains.flatMap(c => c.messages).map(m => m.name),
    ].filter(Boolean) as string[])],
    [story?.id, store.chains],
  );

  // Who actually speaks the current line — attributed from the prose so an NPC
  // the author voices reads as its own speaker, not the lead. Narration and
  // unattributed lines fall back to the message's own character.
  const speech = useMemo(
    () => latestSpeech(rawText, { author: current?.name ?? aiName, cast, dialogue: descriptor?.dialogue }),
    [rawText, current?.name, aiName, cast, descriptor?.dialogue],
  );
  const dialogue = speech?.line ?? null;
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const bubbleOwner: 'user' | 'char' | 'other' =
    !speech ? (isUser ? 'user' : 'char')
    : norm(speech.speaker) === norm(userName) ? 'user'
    : !speech.attributed ? (isUser ? 'user' : 'char')
    : norm(speech.speaker) === norm(aiName) ? 'char'
    : 'other';
  // Tag the bubble only when the line belongs to someone other than the
  // portrait it would sit under (a voiced third party).
  const bubbleSpeaker = bubbleOwner === 'other' ? speech?.speaker : undefined;

  // Keep the textbox pinned to the newest line while it streams.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bodyHtml]);

  const togglePlay = () => store.setIsStreaming(!store.isStreaming);

  const atmosphereOn = store.sceneTheming && store.themeEffects;

  if (store.chains.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-50">
        <p className="text-lg">This story is empty.</p>
      </div>
    );
  }

  const aiSprite = spriteFor(storyId, aiName, !isUser ? bucket : 'neutral', sprites, spriteUrls);
  // The reader's own sprites live ONLY under the namespaced key — a plain-name
  // fallback here can collide with a character set when names overlap.
  const userSprite = spriteFor(storyId, `user:${userName}`, isUser ? bucket : 'neutral', sprites, spriteUrls);

  return (
    <div
      className={cn('stage relative z-10 flex-1 min-h-0 flex flex-col', shakeNow && 'fx-shake', store.isAutofocusMode && 'stage-autofocus')}
      style={tintVars}
    >
      <SceneAtmosphere scene={scene} activeId={activeSceneId} enabled={atmosphereOn} />
      {store.sceneTheming && <SceneSpine scenes={scenes} activeSceneId={scene?.id} />}

      {/* The stage: both leads stand here; the speaker takes the light. */}
      <div className="stage-scene relative flex-1 min-h-0">
        {backdrop && (
          <div key={backdrop.id} className="stage-backdrop" aria-hidden="true">
            <img src={backdrop.url} alt="" />
          </div>
        )}
        {/* Director-called particle weather — lingers across the scene. */}
        {store.themeEffects && <SceneFx fx={weather?.fx} level={weather?.level} />}
        {/* Screen special effect (flash / vignette / desaturate / glitch / bloom). */}
        <SceneVfx kind={vfx} beatKey={current?.id ?? 'x'} />
        {/* RPG HUD (game themes only, via CSS): the Director's read on screen. */}
        {scene && (
          <div className="stage-hud" aria-hidden="true">
            <span className="stage-hud-scene">Scene {scene.index + 1}</span>
            {scene.location && <span className="stage-hud-loc">{scene.location}</span>}
            <span className="stage-hud-mood">{scene.mood}</span>
            <div
              className="stage-hud-tension"
              title="Scene tension"
            >
              <i style={{ width: `${Math.round((scene.tensionById[current?.id ?? ''] ?? scene.peakTension) * 100)}%` }} />
            </div>
          </div>
        )}
        {/* Keyed per passage so the emotion animation replays on every line,
            not only when the reaction class happens to change. */}
        <Portrait
          key={`l-${current?.id ?? 'x'}-${reaction ?? ''}`}
          avatar={aiSprite ?? aiAvatar} name={aiName} active={!isUser} side="left"
          reaction={reaction} emote={emote}
        />
        <Portrait
          key={`r-${current?.id ?? 'x'}-${reaction ?? ''}`}
          avatar={userSprite ?? userAvatar} name={userName} active={isUser} side="right"
          reaction={reaction} emote={emote}
        />

        {sceneImages.length > 0 && (
          <div className="stage-cg" onClick={() => setLightbox(sceneImages[0])}>
            <img src={sceneImages[0]} alt="" loading="lazy" referrerPolicy="no-referrer" />
            {sceneImages.length > 1 && (
              <span className="stage-cg-count">+{sceneImages.length - 1}</span>
            )}
          </div>
        )}

        {dialogue && (
          <div
            key={`${current?.id}-${dialogue.length < 8 ? dialogue : ''}`}
            className={cn('stage-bubble',
              bubbleOwner === 'user' ? 'stage-bubble-right'
                : bubbleOwner === 'other' ? 'stage-bubble-npc'
                  : 'stage-bubble-left')}
          >
            {bubbleSpeaker && <span className="stage-bubble-name">{bubbleSpeaker}</span>}
            {dialogue}
          </div>
        )}
      </div>

      {/* The main textbox: the whole passage, streamed. Click = play/pause. */}
      <div className="stage-boxwrap shrink-0 px-4 pb-36 pt-1">
        <div
          className={cn('stage-box relative mx-auto w-full', isUser && 'stage-box-cmd')}
          onClick={togglePlay}
        >
          <div className="stage-nameplate">{current?.name ?? '…'}</div>
          <div
            ref={boxRef}
            className="stage-text markdown-body"
            /* Where the magnifier looks. The stage box is the only place words
             * appear in this view, streaming or not. */
            data-reveal-edge=""
            style={{ fontSize: `${store.fontSize}px` }}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          {store.isStreaming && <span className="stage-cursor" aria-hidden="true">▼</span>}
        </div>
      </div>

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
    </div>
  );
};
