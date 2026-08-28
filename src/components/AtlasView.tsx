import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Minus, Plus, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { useReadThrough } from '../hooks/useReadThrough';
import { useArtUrls } from '../hooks/useArtUrls';
import { imagesOf } from '../utils/storyImages';
import { renderInline } from '../utils/bookLayout';
import { resolveCharColors } from '../utils/markupStyles';
import { resolveContent } from '../utils/lens';
import { MOOD_COLOR } from '../utils/sceneMood';
import {
  AtlasTile, DEFAULT_ZOOM, ZOOM_STEPS, atlasStats, buildAtlas, fieldArea, fitTile, levelFor,
  progressOf, wordLabel,
} from '../utils/atlas';
import { cn } from '../utils/cn';

/**
 * The Atlas — the whole story as a field you can zoom into.
 *
 * The layout rules and every judgement they need are in `utils/atlas`. What is
 * here is the field itself, the zoom control, and the legend.
 *
 * ── Why the zoom is one slider and not three buttons ───────────────────────
 *
 * Semantic zoom works because the reader controls ONE continuous quantity and
 * the representation changes along it. Three named modes would make the reader
 * choose a mode — which is a decision about the interface — instead of just
 * looking closer, which is a decision about the story.
 *
 * ── It streams, and the map fills in ───────────────────────────────────────
 *
 * A map of a story you have not read yet is a spoiler with a legend. So the
 * whole field is always THERE — the shape of the thing is what the view is for,
 * and hiding it would be hiding the view — but the country beyond where the
 * reader has got to is unsurveyed: dim, desaturated, and holding no words. It
 * lights up as they read, and the scene being read now is swept by a surveying
 * line, which is this view's own reveal. There is no prose here to letter, so
 * the per-word effects have nothing to act on; the sweep is what streaming
 * looks like on a map.
 *
 * ── Opening a scene ────────────────────────────────────────────────────────
 *
 * A map you can only look at is half a tool. Even at the closest zoom a tile
 * holds an opening line, because a tile is sized by how LONG its scene is and a
 * short scene's tile is physically small — so the text was always going to be
 * clipped, and no amount of zooming was ever going to fix that.
 *
 * So a tile opens. Clicking one slides out the scene itself: its cover, where
 * and when, who is in it, how long it runs, and the whole of its prose — and a
 * Read from here that puts the reader into the story at that passage. The field
 * answers *what is the shape of this*; the sheet answers *what happens here*;
 * the button hands you back to the reader.
 *
 * ── Autofocus ──────────────────────────────────────────────────────────────
 *
 * W/S moves the zoom itself rather than a scale factor, because on a map
 * zooming IS the interaction — scaling the tiles would give the reader a
 * blurrier version of the same detail level instead of a closer look.
 */

const TIME_MARK: Record<string, string> = {
  dawn: '☀', day: '☀', dusk: '◑', night: '☾',
};

const Tile = ({
  tile, level, here, surveyed, live, edge, onClick,
}: {
  tile: AtlasTile; level: ReturnType<typeof levelFor>; here: boolean;
  /** The reader has reached this scene. */
  surveyed: boolean;
  /** This is the scene arriving now — it gets the surveying sweep. */
  live: boolean;
  /** Nothing is arriving, and this is where the reader is: the magnifier's mark. */
  edge: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    data-testid="atlas-tile"
    data-scene={tile.id}
    data-level={level}
    data-surveyed={surveyed ? 'true' : 'false'}
    data-reveal-edge={live || (edge && !live) ? '' : undefined}
    className={cn(
      'atlas-tile',
      here && 'atlas-tile-here',
      !surveyed && 'atlas-tile-unread',
      live && 'atlas-tile-live',
    )}
    data-cover={tile.cover && surveyed ? 'true' : undefined}
    style={{
      gridColumn: `span ${tile.span}`,
      gridRow: `span ${tile.rows}`,
      // Mood is the fill; tension is how hard the rim burns. One custom property
      // each, so the same tile markup draws every zoom level.
      ['--tile-mood' as string]: MOOD_COLOR[tile.mood],
      ['--tile-tension' as string]: String(tile.tension),
    }}
    title={`Scene ${tile.index}${tile.location ? ` — ${tile.location}` : ''} · ${wordLabel(tile.words)}`}
  >
    {/* The scene's own picture, as the tile's ground. Only where the reader has
      * been — an unsurveyed tile showing a picture from a scene they have not
      * read is the same spoiler the words would be. */}
    {tile.cover && surveyed && (
      <img src={tile.cover} alt="" className="atlas-cover" loading="lazy" />
    )}
    {/* Far: the tile IS the information. No text at all — at this size a label
      * would be unreadable noise over the one thing you came here to see, which
      * is the shape of the whole story. */}
    {level !== 'far' && surveyed && (
      <span className="atlas-head">
        <span className="atlas-index">{tile.index}</span>
        {tile.timeOfDay && <span className="atlas-time">{TIME_MARK[tile.timeOfDay]}</span>}
        {/* The place if the story establishes one, and the mood otherwise —
          * which is real information the tile already carries, and reads better
          * than a row of em dashes on every scene in a library nobody has run
          * the Director over. */}
        <span className="atlas-place">{tile.location || tile.mood}</span>
      </span>
    )}
    {level !== 'far' && surveyed && (
      <span className="atlas-meta">
        {tile.passages} · {wordLabel(tile.words)}
      </span>
    )}
    {level === 'near' && surveyed && (
      <>
        <span className="atlas-cast">{tile.cast.join(' · ')}</span>
        <span className="atlas-opening">{tile.opening}</span>
      </>
    )}
  </button>
);

export const AtlasView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  useSceneDirector();
  const { scenes, activeId } = useScenes();
  const read = useReadThrough();

  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  const descriptors = storyId ? v2.sceneByStory[storyId] : undefined;

  const messages = useMemo(() => store.chains.flatMap(c => c.messages).map(m => ({
    id: m.id, name: m.name, role: m.role, images: m.images,
    content: resolveContent(m, overrides, lensOn),
  })), [store.chains, overrides, lensOn]);

  const artUrls = useArtUrls();
  const tiles = useMemo(
    () => buildAtlas(scenes, messages, descriptors, store.showImages ? artUrls : undefined),
    [scenes, messages, descriptors, artUrls, store.showImages],
  );

  /** The scene the reader has opened to read, if any. */
  const [openId, setOpenId] = useState<string | null>(null);
  const openTile = useMemo(() => tiles.find(t => t.id === openId) ?? null, [tiles, openId]);
  const openBody = useMemo(() => {
    if (!openTile) return [];
    const byId = new Map(messages.map(m => [m.id, m]));
    return openTile.messageIds.map(id => byId.get(id)).filter(Boolean) as typeof messages;
  }, [openTile, messages]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);
  const stats = useMemo(() => atlasStats(tiles), [tiles]);

  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  /* Autofocus moves the zoom itself. The store's `autofocusZoom` runs 0.5..3
   * with 1 at rest, so it is mapped onto the step ladder rather than used as a
   * scale — W walks in towards the prose, S walks out towards the whole
   * country, which is what zooming means on a map. */
  const auto = store.isAutofocusMode;
  const effZoom = auto
    ? Math.max(0, Math.min(ZOOM_STEPS.length - 1,
      Math.round(zoom + (store.autofocusZoom - 1) * 2)))
    : zoom;
  const step = ZOOM_STEPS[effZoom] ?? ZOOM_STEPS[DEFAULT_ZOOM];

  /* The coarsest step promises the whole story on one screen, so it has to know
   * how big the screen is. Everything else is a fixed size and needs no
   * measurement at all — which is why this is a ResizeObserver on one element
   * rather than a layout pass on every tile. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.clientWidth - 40, h: el.clientHeight - 48 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitted = step.fit && box.w > 0 ? fitTile(fieldArea(tiles), box.w, box.h) : null;
  const tileSize = fitted?.tile ?? step.tile;
  const level = levelFor(tileSize);

  const here = useMemo(
    () => tiles.find(t => activeId && t.messageIds.includes(activeId))?.id,
    [tiles, activeId],
  );

  /* Surveyed country. A scene counts the moment the reader reaches ANY of its
   * passages — a scene half-read is a scene you have been in, and greying out
   * the tile you are standing on would be absurd. */
  const surveyed = useMemo(() => {
    const out = new Set<string>();
    for (const t of tiles) if (t.messageIds.some(id => read.has(id))) out.add(t.id);
    return out;
  }, [tiles, read]);

  /* The tile being surveyed. The streaming scene while one streams, and
   * otherwise the scene the reader is standing in — the magnifier must have
   * somewhere to look even when playback has stopped. */
  const liveTile = useMemo(
    () => (read.streamingId
      ? tiles.find(t => t.messageIds.includes(read.streamingId!))?.id
      : undefined),
    [tiles, read.streamingId],
  );
  const progress = useMemo(() => progressOf(tiles, here), [tiles, here]);


  // Keep the reader's own scene in view as the zoom changes — the point of
  // zooming out is to see where you are, and losing your place while doing it
  // is the one thing a map must not do.
  useEffect(() => {
    if (!here) return;
    fieldRef.current?.querySelector(`[data-scene="${here}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [zoom, here]);

  if (!tiles.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm opacity-60" data-testid="atlas-view">
        Nothing to map yet.
      </div>
    );
  }

  return (
    <div
      className={cn('flex-1 min-h-0 flex flex-col', auto && 'atlas-autofocus')}
      data-testid="atlas-view"
      data-level={level}
      data-autofocus={auto ? 'true' : 'false'}
    >
      <div
        ref={fieldRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-6"
      >
        <div
          className="atlas-field mx-auto"
          style={{
            ['--tile' as string]: `${tileSize}px`,
            ...(fitted ? { gridTemplateColumns: `repeat(${fitted.columns}, minmax(0, 1fr))` } : {}),
          }}
        >
          {tiles.map(t => (
            <Tile
              key={t.id}
              tile={t}
              level={level}
              here={t.id === here}
              surveyed={surveyed.has(t.id)}
              live={t.id === liveTile}
              edge={!liveTile && t.id === here}
              onClick={() => setOpenId(t.id)}
            />
          ))}
        </div>
      </div>

      {/* The scene, opened. This is what makes the Atlas a way to READ rather
        * than only a way to look — a tile is sized by how long its scene is, so
        * a short scene's tile is small and its text was always going to be
        * clipped however far you zoomed in. */}
      {openTile && (
        <div
          className="atlas-sheet"
          data-testid="atlas-sheet"
          role="dialog"
          aria-label={`Scene ${openTile.index}`}
        >
          <div className="atlas-sheet-head">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] opacity-50 tabular-nums">
                  {openTile.index}
                </span>
                <h2 className="font-bold text-sm truncate">
                  {openTile.location || openTile.mood}
                </h2>
              </div>
              <p className="text-[11px] opacity-60 font-mono tabular-nums">
                {openTile.passages} passages · {wordLabel(openTile.words)}
                {openTile.timeOfDay ? ` · ${openTile.timeOfDay}` : ''}
                {openTile.cast.length ? ` · ${openTile.cast.join(', ')}` : ''}
              </p>
            </div>
            <button
              onClick={() => setOpenId(null)}
              className="p-1.5 rounded-lg hover:bg-app-text/10 opacity-70 hover:opacity-100 shrink-0"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>

          <div className="atlas-sheet-body">
            {openTile.cover && store.showImages && (
              <img src={openTile.cover} alt="" className="atlas-sheet-cover" />
            )}
            {/* The WHOLE scene, not a clipped preview. Anything less and the
              * complaint that opened this — "it doesn't show me the full text"
              * — is still true, just one click deeper. */}
            {openBody.map(m => {
              const pics = store.showImages ? imagesOf(m, artUrls[m.id]) : [];
              const markupCtx = {
                dialogueColor: store.dialogueColor,
                dialogueStyle: store.dialogueStyle,
                dialogueAnimation: store.dialogueAnimation,
                markup: store.markupPresets,
                charColors: resolveCharColors(
                  m.name, store.characterColors, store.characterChannelColors, store.characterColorsEnabled,
                ),
                animate: true,
              };
              return (
                <article key={m.id} className="atlas-passage" data-role={m.role}>
                  <h3 className="atlas-passage-name">{m.name}</h3>
                  {pics.map(src => (
                    <img key={src} src={src} alt="" className="atlas-passage-img" loading="lazy" />
                  ))}
                  {/* Rendered, not printed raw. The first version dropped the
                    * source straight in and the reader was shown `## The Gate`
                    * and `****RUN****` — which is the opposite of "let me read
                    * this scene". `renderInline` is the same pass Book and the
                    * HTML export use, so emphasis survives and the markers go.
                    * Headings are stripped first: an inline pass has no idea
                    * what a leading `#` is. */}
                  {m.content.split(/\n{2,}/).map((para, i) => {
                    const text = para.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
                    if (!text) return null;
                    return (
                      <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(text, { markupCtx }) }} />
                    );
                  })}
                </article>
              );
            })}
          </div>

          <div className="atlas-sheet-foot">
            <button
              onClick={() => {
                store.jumpToMessage(openTile.messageIds[0]);
                setOpenId(null);
              }}
              data-testid="atlas-read-here"
              className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90"
            >
              <BookOpen size={14} /> Read from here
            </button>
          </div>
        </div>
      )}

      <div
        className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-app-border text-[11px]"
        data-testid="atlas-bar"
      >
        <button
          onClick={() => setZoom(z => Math.max(0, z - 1))}
          disabled={zoom === 0}
          className="p-1 rounded hover:bg-app-text/10 disabled:opacity-30"
          title="Zoom out"
        >
          <Minus size={13} />
        </button>
        <input
          type="range"
          min={0}
          max={ZOOM_STEPS.length - 1}
          step={1}
          value={effZoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label="Zoom"
          data-testid="atlas-zoom"
          className="w-32 accent-accent"
        />
        <button
          onClick={() => setZoom(z => Math.min(ZOOM_STEPS.length - 1, z + 1))}
          disabled={zoom === ZOOM_STEPS.length - 1}
          className="p-1 rounded hover:bg-app-text/10 disabled:opacity-30"
          title="Zoom in"
        >
          <Plus size={13} />
        </button>
        <span className="font-mono tabular-nums opacity-60 w-28 shrink-0">{step.label}</span>

        {/* The legend only lists the moods the story actually contains — a key
          * with ten entries for a story that uses three is a key you stop
          * reading. */}
        <div className="hidden sm:flex items-center gap-2 min-w-0 overflow-x-auto">
          {stats.moods.map(m => (
            <span key={m} className="flex items-center gap-1 shrink-0 opacity-70">
              <i className="w-2.5 h-2.5 rounded-sm" style={{ background: MOOD_COLOR[m] }} />
              {m}
            </span>
          ))}
        </div>

        <span className="ml-auto font-mono tabular-nums opacity-60 shrink-0">
          {surveyed.size < stats.scenes && `${surveyed.size}/`}{stats.scenes} scenes
          {' · '}{wordLabel(stats.words)}
          {here && ` · ${Math.round(progress * 100)}% in`}
        </span>
      </div>
    </div>
  );
};
