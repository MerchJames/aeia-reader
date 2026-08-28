import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { useSceneVfx, useSceneWeather } from '../hooks/useSceneWeather';
import { SceneFx } from './SceneFx';
import { SceneVfx } from './SceneVfx';
import { processText, balanceEmphasis, truncateToWord } from '../utils/textProcessor';
import { renderWithEmphasis } from './StageView';
import { MarkupRenderContext } from '../utils/bookLayout';
import { resolveCharColors } from '../utils/markupStyles';
import { readerEmphasis } from '../utils/performMarkup';
import { mergePerformCues, performMatcher } from '../utils/scenePerform';
import { bucketFor } from '../lib/spriteStorage';
import { spriteFor, useSpriteStore } from '../stores/useSpriteStore';
import { backdropForScene, useBackdropStore } from '../stores/useBackdropStore';
import { HudScene, STAGE_SIZE, gauge, hourOf, partyFrom, placeOf, progressLabel } from '../utils/rpgHud';
import { Message } from '../types';
import { cn } from '../utils/cn';
import { useArtUrls } from '../hooks/useArtUrls';
import { latestImages } from '../utils/storyImages';

/**
 * RPG mode — the story as a game you are sitting in front of.
 *
 * The Stage is an RPG-FLAVOURED reading surface: portraits and a dialogue
 * window, but still a page that scrolls itself past you. This is the other
 * thing — the whole interface. A framed screen with a heads-up display, a party
 * panel, a command row, and a text window that stops at the end of every
 * passage and waits for you.
 *
 * That wait is the point. Every RPG and visual novel ever made shares one
 * contract — *the text arrives, and it waits* — and no amount of window skin
 * substitutes for it. So this view turns `pressToAdvance` on while it is open
 * and puts it back the way it was on the way out: the feel belongs to the view,
 * not to the reader's settings.
 *
 * Everything in the HUD is derived from what the app actually knows (see
 * `utils/rpgHud.ts`). No invented hit points, no level, no stat block. Where
 * the Director has not read a passage the panels show "—", because a HUD that
 * makes something up when it does not know is one you cannot trust the rest of
 * the time.
 *
 * Presentation ideas after the genre's conventions — a delimited text box, a
 * speaker plate, an advance indicator (see the design notes in the v3 plan);
 * all code original.
 */
export const RpgView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const story = store.currentStory;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  useSceneDirector();
  // Two reads, deliberately. The SEGMENT carries place, hour and mood across a
  // whole scene, so the HUD does not blank out on the one paragraph that named
  // no location; the DESCRIPTOR is this passage's own — who spoke, what was
  // quoted, what to perform.
  const { active: segment } = useScenes();

  const [panel, setPanel] = useState<'none' | 'log' | 'party'>('none');
  const currentId = store.streamingMessage?.id
    ?? store.visibleMessages[store.visibleMessages.length - 1]?.id;
  const descriptor = storyId && currentId ? v2.sceneByStory[storyId]?.[currentId] : undefined;

  /* ---- the genre's contract: the text waits for you --------------------- */
  const setViewHold = store.setViewHold;
  const advanceOnInput = store.advanceOnInput;
  const awaitingInput = store.awaitingInput;
  // A TRANSIENT hold that belongs to this view, never the reader's persisted
  // setting. Writing the real setting on mount and restoring it on unmount
  // looks equivalent and is not: reload inside this view and the value it
  // "restores" is the one it set itself, so leaving would hand the hold to all
  // nine other views, where nothing would ever advance again.
  useEffect(() => {
    setViewHold(true);
    return () => {
      const st = useAppStore.getState();
      st.setViewHold(false);
      // If the story was being HELD when the reader left, let it go. Clearing
      // the flag alone leaves the reveal parked at a passage nothing will ever
      // advance again — the next view just sits there, and it looks like the
      // reader broke their app by visiting this one.
      if (st.awaitingInput) st.advanceOnInput();
    };
  }, [setViewHold]);

  /** Is the story waiting for the reader, from either source? */
  const holding = store.viewHold || store.pressToAdvance;



  // Space is handled by the app's own shortcut layer, which knows about the
  // hold — see `useKeyboardShortcuts`. Enter is handled on the window element
  // itself, where focus already is after a click.


  /* ---- the passage on screen ------------------------------------------- */
  const current: Message | undefined =
    store.streamingMessage ?? store.visibleMessages[store.visibleMessages.length - 1];

  const rawText = store.streamingMessage
    ? balanceEmphasis(store.revealComplete ? store.streamedText : truncateToWord(store.streamedText))
    : current
      ? processText(resolveContent(current, overrides, lensOn), {
        hideMetadata: store.hideMetadata && !current.hidden,
        oocHandling: store.oocHandling,
        autoFormat: store.autoFormat,
        autoFormatRules: store.autoFormatRules,
        paragraphSpacing: store.paragraphSpacing,
        smartTypography: store.smartTypography,
      }).processedText
      : '';

  const emphasis = useMemo(
    () => (store.sceneEmphasis || storyId
      ? readerEmphasis(
        store.sceneEmphasis ? descriptor?.emphasis : undefined,
        storyId && current ? v2.sfxMarksByStory[storyId]?.[current.id] : undefined,
        storyId && current ? v2.emphasisMarksByStory[storyId]?.[current.id] : undefined,
      )
      : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [descriptor?.emphasis, store.sceneEmphasis, storyId, current?.id, v2.sfxMarksByStory, v2.emphasisMarksByStory],
  );

  const perform = store.scenePerformance && storyId && current
    ? mergePerformCues(v2.performMarksByStory[storyId]?.[current.id], descriptor?.perform)
    : undefined;

  // Same trap the Stage and VN hit: this view rebuilds its markup on every
  // reveal tick, so a treatment restarts on every one of them without a map
  // that outlives the render.
  const playedRef = useRef<{ key: string; set: Map<string, number> }>({ key: '', set: new Map() });
  if (playedRef.current.key !== (current?.id ?? '')) {
    playedRef.current = { key: current?.id ?? '', set: new Map() };
  }
  const claimed = useMemo(() => new Set<string>(), [current?.id, rawText]);
  const paragraphs = useMemo(
    () => rawText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean),
    [rawText],
  );
  // Rpg shows one passage at a time, so its speaker (for per-character
  // color) is simply that message's own name — same as Stage.
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
    () => paragraphs.map(p => renderWithEmphasis(
      p, emphasis, false, perform, claimed, playedRef.current.set, performMatcher(perform), markupCtx,
    )).join('<br/><br/>'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paragraphs, emphasis, perform, markupCtx],
  );

  /**
   * The window follows the words down.
   *
   * A game's text box is a FIXED box — it does not grow, so a passage longer
   * than four lines streams straight out of sight and the reader watches an
   * empty frame while the story happens below the fold. Pinned to the bottom
   * while it reveals, and left alone the moment the reader scrolls up
   * themselves: yanking someone back down mid-reread is worse than the
   * overflow was.
   */
  const textRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /**
   * The scroll position this component last wrote.
   *
   * ── Why the flag alone is not enough ────────────────────────────────────
   *
   * Writing `scrollTop` fires a scroll event, and so does the reader dragging
   * the bar — but the event arrives on a later frame, while a React effect runs
   * synchronously after commit. So the ordering is: reader scrolls up → the
   * next word arrives → the effect runs with `pinnedRef` STILL TRUE → the
   * window yanks itself back to the bottom mid-reread → the reader's scroll
   * event finally lands and measures at-bottom, agreeing with itself.
   *
   * No amount of cleverness in the scroll handler fixes that, because the
   * handler has not run yet. The effect has to look at where the box ACTUALLY
   * is: if it is not where we left it, the reader moved it, event or no event.
   */
  const wroteRef = useRef(-1);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // The reader's position wins, whether or not their event has arrived.
    if (wroteRef.current >= 0 && Math.abs(el.scrollTop - wroteRef.current) > 2) {
      pinnedRef.current = false;
    }
    if (!pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
    wroteRef.current = el.scrollTop;
  }, [bodyHtml]);

  // A new passage starts at the top, and re-pins whatever the reader did on the
  // last one.
  useEffect(() => {
    pinnedRef.current = true;
    if (textRef.current) {
      textRef.current.scrollTop = 0;
      wroteRef.current = 0;
    }
  }, [current?.id]);

  /* ---- the HUD ---------------------------------------------------------- */
  const flat = useMemo(() => store.chains.flatMap(c => c.messages), [store.chains]);
  const recent = useMemo(() => {
    const idx = current ? flat.findIndex(mm => mm.id === current.id) : -1;
    return idx < 0 ? flat.slice(-6) : flat.slice(Math.max(0, idx - 5), idx + 1);
  }, [flat, current?.id]);

  // Has the Director read ANY of this story? The scene segmenter always
  // produces a span — with a heuristic mood and tension when it has nothing to
  // go on — and piping that into a game HUD would put confident-looking numbers
  // on a story nobody has read. So the panels stay empty until there is a real
  // read behind them.
  const directed = !!storyId && Object.keys(v2.sceneByStory[storyId] ?? {}).length > 0;

  const hud = useMemo<HudScene>(() => (directed ? {
    // Place, hour and mood fall back to the SEGMENT because the Director states
    // them only when they change — the span is how a read carries forward.
    mood: descriptor?.mood ?? segment?.mood,
    location: descriptor?.location || segment?.location,
    timeOfDay: descriptor?.timeOfDay ?? segment?.timeOfDay,
    // Tension does NOT fall back: it is a per-passage judgement, and borrowing
    // a neighbour's would be the gauge showing a number about a different beat.
    tension: descriptor?.tension,
    speaker: descriptor?.speaker,
    dialogue: descriptor?.dialogue,
  } : {}), [directed, descriptor, segment]);

  const party = useMemo(() => partyFrom({
    recent,
    scene: hud,
    userName: story?.userName,
    characterName: story?.characterName,
  }), [recent, hud, story?.userName, story?.characterName]);

  const place = placeOf(hud);
  const hour = hourOf(hud);
  const filled = gauge(hud.tension);
  const chapterIndex = store.currentChainIndex + 1;
  // Everything up to and including the passage on screen.
  const read = useMemo(() => {
    const idx = current ? flat.findIndex(mm => mm.id === current.id) : -1;
    return idx < 0 ? flat : flat.slice(0, idx + 1);
  }, [flat, current?.id]);
  const position = current ? flat.findIndex(mm => mm.id === current.id) + 1 : 0;

  /* ---- the scene behind it ---------------------------------------------- */
  const backdrops = useBackdropStore(s => s.backdrops);
  const backdropUrls = useBackdropStore(s => s.urls);
  const artUrls = useArtUrls();
  /**
   * What stands behind the interface.
   *
   * A picture from the story itself wins over a keyword-matched backdrop —
   * attached, inline, or generated for the beat. It is a picture of THIS scene,
   * where a backdrop is a stock plate matched on a location word, and a game
   * would use the real art every time. The backdrop is the fallback, and the
   * mood-tinted ground is the fallback for that.
   *
   * `latestImages` rather than "this passage's": a scene picture holds until a
   * newer one replaces it, so the world does not blink out between two lines of
   * dialogue. Stage and VN already read it this way.
   */
  const sceneImage = useMemo(() => {
    if (!store.showImages) return undefined;
    const timeline = [
      ...store.visibleMessages,
      ...(store.streamingMessage ? [store.streamingMessage] : []),
    ];
    return latestImages(timeline, m => artUrls[m.id])[0];
  }, [store.showImages, store.visibleMessages, store.streamingMessage, artUrls]);

  const backdrop = useMemo(
    () => sceneImage ?? backdropForScene(storyId, place, hud.mood, backdrops, backdropUrls),
    [sceneImage, backdrops, backdropUrls, storyId, place, hud.mood],
  );
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);
  const speaking = party.find(p => p.speaking);

  /**
   * A picture for each person on stage.
   *
   * Sprite first, because it is a standing figure drawn for exactly this; then
   * the reader's own profile pictures, which every story has and which the
   * chat view already uses. Somebody with neither simply is not drawn — a
   * placeholder silhouette on a stage is worse than an empty mark.
   */
  const cast = useMemo(() => party.slice(0, STAGE_SIZE).map(p => {
    const bucket = bucketFor(
      (p.speaking ? hud.speaker?.emotion : undefined) ?? hud.mood ?? 'neutral',
    );
    const sprite = spriteFor(storyId, p.name, bucket, sprites, spriteUrls);
    const pfp = p.you
      ? story?.userAvatar
      : story?.characterAvatars?.[p.name] ?? story?.characterAvatar ?? story?.avatar;
    return { ...p, src: sprite ?? pfp, isSprite: !!sprite };
  }), [party, storyId, sprites, spriteUrls, hud.speaker?.emotion, hud.mood,
    story?.userAvatar, story?.characterAvatars, story?.characterAvatar, story?.avatar]);
  /**
   * The head in the text window.
   *
   * Sprites only, deliberately. A sprite is a full standing figure, so a
   * cropped head beside the words adds something the stage does not show —
   * that pairing is the genre's own (a portrait in the box, the figure on
   * screen). A profile picture is ALREADY a head, so repeating it here would
   * put the same image on screen twice, six inches apart.
   */
  const portrait = useMemo(() => spriteFor(
    storyId, speaking?.name ?? current?.name ?? '',
    bucketFor(hud.speaker?.emotion ?? hud.mood ?? 'neutral'),
    sprites, spriteUrls,
  ), [sprites, spriteUrls, storyId, speaking?.name, current?.name, hud.speaker?.emotion, hud.mood]);

  const weather = useSceneWeather(segment, current ? { id: current.id, content: rawText } : undefined);
  const vfx = useSceneVfx(segment, current?.id);

  if (!story) return null;
  const waiting = awaitingInput;

  return (
    <div
      className={cn(
        'rpg-screen flex-1 min-h-0 relative overflow-hidden',
        // Autofocus in a GAME means the game gets out of the way: the HUD, the
        // party and the command row fall back, the text window comes forward
        // and grows. The chrome is what a game interface has instead of a
        // margin, so hiding it outright would leave the words floating in a
        // black field — it recedes instead.
        store.isAutofocusMode && 'rpg-autofocus',
      )}
      data-testid="rpg-view"
      data-autofocus={store.isAutofocusMode ? 'true' : 'false'}
      style={{
        // W/S in autofocus. The window scales, not the page: everything else on
        // screen is fixed chrome that would be cropped by a page zoom.
        ['--rpg-zoom' as string]: String(store.isAutofocusMode ? store.autofocusZoom : 1),
        ['--rpg-pan' as string]: `${store.isAutofocusMode ? store.autofocusPanX : 0}px`,
      }}
    >
      {/* The world behind the interface.
        *
        * With no backdrop this used to be a black void above the text box,
        * which reads as an unfinished screen rather than a scene. So the field
        * is always SOMETHING: a mood-tinted ground, and the speaker standing in
        * it at full height when they have a sprite — which is where an RPG
        * puts them anyway. */}
      <div className="absolute inset-0 rpg-field" aria-hidden>
        {backdrop ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${backdrop})` }}
          />
        ) : (
          <div className="absolute inset-0 rpg-ground" data-mood={hud.mood ?? 'neutral'} />
        )}
        {/* The cast, standing at their marks. Whoever is speaking is at the
          * front — bigger, brighter, in focus — and the others sit back, dimmer
          * and slightly cooler, the way distance actually looks. It is one
          * transition on one element, so stepping forward is a MOVE rather than
          * a swap. */}
        <div className="rpg-stage" data-testid="rpg-stage">
          {cast.map(c => c.src && (
            <img
              key={c.name}
              src={c.src}
              alt=""
              className={cn('rpg-stand', c.isSprite ? 'is-sprite' : 'is-pfp', c.speaking && 'is-speaking')}
              style={{ '--depth': c.depth } as React.CSSProperties}
              data-testid="rpg-stand"
              data-depth={c.depth}
              data-name={c.name}
            />
          ))}
        </div>
        {store.themeEffects && <SceneFx fx={weather?.fx} level={weather?.level} />}
        <SceneVfx kind={vfx} beatKey={current?.id} />
      </div>

      {/* Top HUD — place, hour, and the Director's own tension. */}
      <div className="rpg-hud absolute top-0 inset-x-0 flex items-start justify-between gap-2 p-2 sm:p-3">
        <div className="rpg-plate" data-testid="rpg-place">
          <span className="rpg-plate-label">Place</span>
          <span className="rpg-plate-value">{place || '—'}</span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="rpg-plate" data-testid="rpg-hour">
            <span className="rpg-plate-label">Hour</span>
            <span className="rpg-plate-value">{hour || '—'}</span>
          </div>
          <div className="rpg-gauge" title="How charged the Director read this beat" data-testid="rpg-gauge">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className={cn('rpg-gauge-seg', i < filled && 'is-on')} />
            ))}
          </div>
        </div>
      </div>

      {/* Party — who is actually in this scene. */}
      <div className="rpg-party absolute left-2 sm:left-3 top-20 flex flex-col gap-1.5" data-testid="rpg-party">
        {party.map(p => (
          <div key={p.name} className={cn('rpg-card', p.speaking && 'is-speaking')}>
            <span className="rpg-card-name">
              {p.name}
              {p.you && <span className="rpg-card-you"> ▸you</span>}
            </span>
            <span className="rpg-card-condition">{p.condition}</span>
          </div>
        ))}
      </div>

      {/* The scrollback and the fuller party sheet, as menu panels. */}
      {panel !== 'none' && (
        <div className="rpg-panel" data-testid="rpg-panel">
          <div className="rpg-panel-head">
            <span>{panel === 'log' ? 'Log' : 'Party'}</span>
            <button onClick={() => setPanel('none')} className="rpg-key">Close</button>
          </div>
          <div className="rpg-panel-body">
            {panel === 'log'
              // The story so far, not the committed list: with the reader
              // driving, the passage on screen has not been committed yet, so a
              // log built from `visibleMessages` is empty exactly when it is
              // first opened.
              ? read.slice(-40).reverse().map(mm => (
                <p key={mm.id} className="rpg-log-line">
                  <b>{mm.name}</b>{' '}
                  {resolveContent(mm, overrides, lensOn).replace(/\s+/g, ' ').slice(0, 220)}
                </p>
              ))
              : party.map(p => (
                <p key={p.name} className="rpg-log-line">
                  <b>{p.name}</b> — {p.condition}
                  {p.you ? ' · you' : ''}
                </p>
              ))}
          </div>
        </div>
      )}

      {/* The text window. Clicking it is the advance, as it is in the genre. */}
      <div className="absolute inset-x-0 bottom-0 p-2 sm:p-3 flex flex-col gap-1.5">
        <div
          className={cn('rpg-window', waiting && 'is-waiting')}
          onClick={() => advanceOnInput()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') advanceOnInput(); }}
          data-testid="rpg-window"
          data-waiting={waiting ? 'true' : 'false'}
        >
          <div className="rpg-nameplate" data-testid="rpg-nameplate">
            {speaking?.name ?? current?.name ?? story.title}
          </div>
          <div className="rpg-window-body">
            {portrait && (
              <img src={portrait} alt="" className="rpg-portrait" data-testid="rpg-portrait" />
            )}
            <div
              ref={textRef}
              className="rpg-text"
              data-testid="rpg-text"
              onScroll={(e) => {
                const el = e.currentTarget;
                // Our own write catching up says nothing about intent; the
                // effect above has already decided whether the reader moved it.
                if (Math.abs(el.scrollTop - wroteRef.current) < 2) return;
                // Scrolled back to the bottom by hand: start following again.
                // Within a line of the bottom counts as "still following".
                pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                wroteRef.current = pinnedRef.current ? el.scrollTop : -1;
              }}
              /* Where the magnifier looks in this view. The text window is the
               * only place words appear, so it is the reveal edge whether or
               * not a passage is currently streaming. */
              data-reveal-edge=""
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          </div>
          <span className="rpg-caret" aria-hidden data-testid="rpg-caret">▼</span>
        </div>

        {/* The command row. Every one of these does something real. */}
        <div className="rpg-menu" data-testid="rpg-menu">
          <button
            className={cn('rpg-key', panel === 'log' && 'is-on')}
            onClick={() => setPanel(panel === 'log' ? 'none' : 'log')}
          >
            Log
          </button>
          <button
            className={cn('rpg-key', panel === 'party' && 'is-on')}
            onClick={() => setPanel(panel === 'party' ? 'none' : 'party')}
          >
            Party
          </button>
          <button
            className={cn('rpg-key', !holding && 'is-on')}
            onClick={() => {
              // The button reflects the EFFECTIVE state, so turning it off has
              // to turn off whatever is causing the hold — including the
              // reader's own global setting, if that is what is doing it.
              // Otherwise the control looks dead for exactly the readers who
              // went looking for it.
              if (holding) {
                setViewHold(false);
                store.setPressToAdvance(false);
                advanceOnInput();
              } else {
                setViewHold(true);
              }
            }}
            title={holding
              ? 'The story waits for you at the end of each passage'
              : 'The story reads itself onward'}
            data-testid="rpg-auto"
          >
            {holding ? 'Wait' : 'Auto'}
          </button>
          <button
            className="rpg-key"
            onClick={() => store.resetPlayback()}
            title="Read it again from the beginning"
          >
            Again
          </button>
          <button
            className="rpg-key"
            onClick={() => store.fastForward()}
            title="Skip ahead"
            data-testid="rpg-skip"
          >
            Skip
          </button>
          <button className="rpg-key" onClick={() => store.setSettingsOpen(true)}>Menu</button>
          <span className="rpg-progress" data-testid="rpg-progress">
            {progressLabel(chapterIndex, store.chains.length, position, flat.length)}
          </span>
        </div>
      </div>
    </div>
  );
};
