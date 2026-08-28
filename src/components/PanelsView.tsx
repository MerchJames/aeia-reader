import React, { useMemo, useRef, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { useArtUrls } from '../hooks/useArtUrls';
import { useReadThrough } from '../hooks/useReadThrough';
import { revealClass, revealWords } from '../utils/wordReveal';
import { heuristicRead, tensionAt } from '../utils/sceneSegment';
import type { Mood } from '../types';
import { resolveContent } from '../utils/lens';
import { MOOD_COLOR } from '../utils/sceneMood';
import { attributeSpeaker, aiSpeakerFor } from '../utils/dialogueSegments';
import { plainProse } from '../utils/screenplay';
import { imagesOf } from '../utils/storyImages';
import {
  Beat, ComicPage, GRID_LABEL, pagesFor, splitLong,
} from '../utils/comicLayout';
import { cn } from '../utils/cn';

/**
 * The Panels view — the story as comic pages.
 *
 * Every layout decision is in `utils/comicLayout`, which is where the craft
 * rules live (one beat per panel; grid and gutter chosen by mood and tension).
 * What is here is the drawing: caption boxes, balloons with tails, the art when
 * a beat has some, and a typographic panel when it does not.
 *
 * ── It streams, a beat at a time ──────────────────────────────────────────
 *
 * One panel is one beat, and a beat is a unit of TIME as much as of space — so
 * the panels arrive one at a time as the story plays, and the newest one draws
 * itself in: the rule first, then what is inside it. Panels the reader has not
 * reached yet are still on the page, ruled and empty, because that is what a
 * comic page does — you see the shape of the page before you read it, and the
 * layout must not jump under the reader as each beat lands.
 *
 * ── Why a panel without a picture is still a panel ─────────────────────────
 *
 * Almost no beat in an ordinary library has generated art attached, and a comic
 * view that only worked once you had run an image model would be a view nobody
 * ever saw. But the caption box is a real comics device on its own — a whole
 * tradition of comics is captions over colour — so a panel with no art is drawn
 * as a mood-washed field with the caption on it, and it reads as a panel rather
 * than as a missing image. Art, where it exists, fills the same box behind the
 * same caption.
 */

/** Split one passage into beats — the unit that gets exactly one panel. */
const beatsFor = (
  msg: { id: string; name: string; role: string; content: string },
  opts: {
    cast: string[]; dialogue?: { text: string; speaker: string }[];
    art?: string[]; establish: boolean; mood: Mood; tension: number;
  },
): Beat[] => {
  const prose = plainProse(msg.content);
  if (!prose) return [];
  const author = (msg.name || '').trim() || (msg.role === 'user' ? 'You' : 'Narrator');
  const out: Beat[] = [];

  // Same split the script uses: quoted speech, and the narration around it.
  const quote = /[“"]([^“”"]+)[”"]/g;
  const spans: { text: string; spoken: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(prose)) !== null) {
    if (m.index > last) spans.push({ text: prose.slice(last, m.index), spoken: false });
    spans.push({ text: m[1], spoken: true });
    last = m.index + m[0].length;
  }
  if (last < prose.length) spans.push({ text: prose.slice(last), spoken: false });

  spans.forEach((span, i) => {
    if (span.spoken) {
      const line = span.text.trim();
      if (!line) return;
      const before = spans[i - 1] && !spans[i - 1].spoken ? spans[i - 1].text.slice(-160) : '';
      const after = spans[i + 1] && !spans[i + 1].spoken ? spans[i + 1].text.slice(0, 160) : '';
      const speaker = aiSpeakerFor(line, opts.dialogue)
        ?? attributeSpeaker(before, after, opts.cast) ?? author;
      // One person's consecutive lines are one beat — they said them in one go.
      const prev = out[out.length - 1];
      if (prev?.kind === 'speech' && prev.speaker === speaker) {
        prev.text = `${prev.text} ${line}`;
        return;
      }
      out.push({
        kind: 'speech', text: line, speaker, messageId: msg.id,
        mood: opts.mood, tension: opts.tension,
      });
      return;
    }
    for (const para of span.text.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      for (const chunk of splitLong(t)) {
        out.push({
          kind: 'caption', text: chunk, messageId: msg.id,
          mood: opts.mood, tension: opts.tension,
        });
      }
    }
  });

  /* A quoted line's trailing comma exists only to attach the "she said" that
   * followed it, and a balloon has replaced that clause with a tail. Left in,
   * half the balloons on the page end in a comma leading nowhere. Only the
   * comma goes — every other mark still means what it meant. */
  for (const b of out) if (b.kind === 'speech') b.text = b.text.replace(/,\s*$/, '');

  if (opts.establish && out.length) out[0] = { ...out[0], kind: 'establish' };
  // Art belongs to the passage, not to a beat, so it goes on the beats from the
  // front — the establishing panel first, which is where a picture does the most.
  opts.art?.forEach((src, i) => { if (out[i]) out[i].art = src; });
  return out;
};

/** Text with its newest words animating — the reader's effect, per word. */
const Lettered = ({ text, effect }: { text: string; effect: string | null }) => {
  const words = useMemo(() => revealWords(text), [text]);
  if (!effect) return <>{text}</>;
  return (
    <>
      {words.map((w, i) => (
        <React.Fragment key={i}>
          <span
            className={revealClass(w, effect)}
            style={w.delay ? { animationDelay: `${w.delay}ms` } : undefined}
          >
            {w.text}
          </span>
          {/* Outside the span on purpose — see RevealWord.after. */}
          {w.after}
        </React.Fragment>
      ))}
    </>
  );
};

const Balloon = ({ speaker, text, effect }: {
  speaker?: string; text: string; effect: string | null;
}) => (
  <div className="comic-balloon">
    {speaker && <span className="comic-speaker">{speaker}</span>}
    <span>&ldquo;<Lettered text={text} effect={effect} />&rdquo;</span>
  </div>
);

const PanelBody = ({ panel, effect }: {
  panel: ComicPage['panels'][number]; effect: string | null;
}) => (
  <>
    {panel.art && <img src={panel.art} alt="" className="comic-art" loading="lazy" />}
    {panel.kind === 'speech'
      ? <Balloon speaker={panel.speaker} text={panel.text} effect={effect} />
      : <div className={cn('comic-caption', panel.kind === 'establish' && 'comic-caption-establish')}>
        <Lettered text={panel.text} effect={effect} />
      </div>}
  </>
);

export const PanelsView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  useSceneDirector();
  const { scenes, activeId } = useScenes();

  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  const descriptors = storyId ? v2.sceneByStory[storyId] : undefined;
  const artUrls = useArtUrls();
  const read = useReadThrough();
  const showImages = store.showImages;

  /* The whole story, always — the PAGE has to be laid out before the reader
   * reaches it, or every beat that lands reflows the panels around it. What the
   * reader has reached is carried separately, and decides which panels have
   * anything drawn in them. */
  const messages = useMemo(() => store.chains.flatMap(c => c.messages).map(m => ({
    id: m.id, name: m.name, role: m.role as string,
    content: resolveContent(m, overrides, lensOn),
  })), [store.chains, overrides, lensOn]);

  const cast = useMemo(() => {
    const names = new Set<string>();
    for (const m of messages) if (m.name) names.add(m.name);
    if (store.currentStory?.characterName) names.add(store.currentStory.characterName);
    if (store.currentStory?.userName) names.add(store.currentStory.userName);
    return [...names];
  }, [messages, store.currentStory]);

  const pages = useMemo(() => {
    const byId = new Map(messages.map(m => [m.id, m]));
    const out: ComicPage[] = [];
    scenes.forEach((scene, si) => {
      const beats: Beat[] = [];
      scene.messageIds.forEach((id, mi) => {
        const msg = byId.get(id);
        if (!msg) return;
        beats.push(...beatsFor(msg, {
          cast,
          dialogue: descriptors?.[id]?.dialogue,
          /* Every picture the passage has, not just the generated ones: a
           * story that arrived with its own images had them dropped on the
           * floor here, which made the comic view look like it only worked
           * for people running an image model. */
          art: showImages ? imagesOf(msg, artUrls[id]) : undefined,
          // The first passage of a scene opens it — that is the establishing shot.
          establish: mi === 0,
          /* Per PASSAGE, so a quiet stretch inside a loud scene gets its own
           * page shape rather than inheriting the scene's label. The Director's
           * read where there is one, and the assetless heuristic where there is
           * not — the same fallback `sceneSegment` itself uses, so the view
           * works with no endpoint configured. */
          mood: descriptors?.[id]?.mood ?? heuristicRead(msg.content).mood,
          tension: descriptors?.[id]?.tension ?? tensionAt(scene, id),
        }));
      });
      if (!beats.length) return;
      // The scene's peak is what decides whether this run has earned a splash;
      // a run of one beat at peak tension is the only thing that gets one.
      out.push(...pagesFor({
        sceneId: scene.id,
        sceneIndex: si + 1,
        mood: scene.mood,
        tension: scene.peakTension,
        beats,
      }));
    });
    return out;
  }, [messages, scenes, descriptors, cast, artUrls, showImages]);

  const pageRef = useRef<HTMLDivElement>(null);
  const currentScene = useMemo(
    () => scenes.find(s => activeId && s.messageIds.includes(activeId))?.id,
    [scenes, activeId],
  );

  /* How much of the streaming passage has arrived, as a beat count — so the
   * panels of one passage fill in one at a time rather than all at once when
   * the passage commits. Measured in WORDS against the passage's full text,
   * which is stable, rather than by re-splitting the partial into beats on
   * every keystroke. */
  const liveBeats = useMemo(() => {
    if (!read.streamingId) return 0;
    const full = messages.find(m => m.id === read.streamingId)?.content ?? '';
    const total = (full.match(/\S+/g) ?? []).length;
    const done = (read.partial.match(/\S+/g) ?? []).length;
    return total ? done / total : 0;
  }, [messages, read.streamingId, read.partial]);

  /** Which panels have anything in them, and which is the one arriving. */
  const drawn = useMemo(() => {
    const state = new Map<string, 'done' | 'live' | 'empty'>();
    for (const p of pages) {
      // Beats of the streaming passage, in order, so a fraction can pick out
      // how many of them have been reached.
      const live = p.panels.filter(x => x.messageId === read.streamingId);
      live.forEach((panel, i) => {
        const at = live.length ? (i + 1) / live.length : 1;
        state.set(`${p.id}:${p.panels.indexOf(panel)}`,
          liveBeats >= at ? 'done' : liveBeats > i / live.length ? 'live' : 'empty');
      });
    }
    return state;
  }, [pages, read.streamingId, liveBeats]);

  const panelState = (page: ComicPage, i: number): 'done' | 'live' | 'empty' => {
    const panel = page.panels[i];
    if (panel.messageId === read.streamingId) return drawn.get(`${page.id}:${i}`) ?? 'empty';
    return read.has(panel.messageId) ? 'done' : 'empty';
  };

  /* ── Pages ────────────────────────────────────────────────────────────── */
  const paginated = store.layoutMode === 'paginated';
  const [pageNo, setPageNo] = useState(0);
  const pageCount = pages.length;

  // Follow the story: the page holding the newest drawn panel is the one on
  // screen. A comic that carries on drawing itself on a page the reader is not
  // looking at is a comic that has lost them.
  const livePage = useMemo(() => {
    const at = pages.findIndex(p => p.panels.some(x => x.messageId === read.streamingId));
    if (at >= 0) return at;
    const last = [...pages].reverse().find(p => p.panels.some(x => read.has(x.messageId)));
    return last ? pages.indexOf(last) : 0;
  }, [pages, read]);

  useEffect(() => { if (paginated) setPageNo(livePage); }, [paginated, livePage]);

  useEffect(() => {
    if (!paginated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); setPageNo(p => Math.min(pageCount - 1, p + 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPageNo(p => Math.max(0, p - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paginated, pageCount]);

  // Open where the reader is, like every other view.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !currentScene || paginated) return;
    landed.current = true;
    pageRef.current?.querySelector(`[data-scene="${currentScene}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [currentScene, paginated]);

  /* Where the magnifier looks. The panel being drawn while one is drawing, and
   * otherwise the last panel that HAS been drawn — the light must not go out
   * the moment playback stops, which is the same rule ReaderDisplay follows. */
  const edgeKey = useMemo(() => {
    let live: string | null = null;
    let last: string | null = null;
    for (const p of pages) {
      p.panels.forEach((panel, i) => {
        const st = panelState(p, i);
        if (st === 'live') live = `${p.id}:${i}`;
        if (st !== 'empty') last = `${p.id}:${i}`;
      });
    }
    return live ?? last;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, drawn, read]);

  const effect = (store.themeEffects && 'fade') || store.streamEffect;
  const wordEffect = read.streamingId ? effect : null;
  const auto = store.isAutofocusMode;

  if (!pages.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm opacity-60" data-testid="panels-view">
        Nothing to panel yet.
      </div>
    );
  }

  const shown = paginated ? [pages[Math.min(pageNo, pageCount - 1)]] : pages;

  return (
    <div
      className={cn('flex-1 min-h-0 flex flex-col comic-view', auto && 'comic-autofocus')}
      data-testid="panels-view"
      data-autofocus={auto ? 'true' : 'false'}
    >
      <div ref={pageRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          className="mx-auto max-w-5xl px-4 py-8 flex flex-col gap-10"
          style={auto ? {
            // W/S scales the page, A/D slides it. The grid is a proportion, so
            // scaling the whole board keeps the panel shapes exactly as drawn.
            transform: `scale(${store.autofocusZoom}) translateX(${store.autofocusPanX}px)`,
            transformOrigin: 'top center',
          } : undefined}
        >
          {shown.map(page => (
            <figure
              key={page.id}
              data-scene={page.sceneId}
              data-grid={page.grid}
              data-testid="comic-page"
              className={cn('comic-page', page.sceneId === currentScene && 'comic-page-here')}
              style={{
                // The layout's own gutter, and the scene's mood as the page's ink.
                ['--gutter' as string]: `${page.gutter}rem`,
                ['--mood' as string]: MOOD_COLOR[page.mood],
              }}
            >
              <div className="comic-grid">
                {page.panels.map((panel, i) => {
                  const state = panelState(page, i);
                  return (
                    <div
                      key={i}
                      className={cn(
                        'comic-panel',
                        panel.splash && 'comic-panel-splash',
                        `is-${state}`,
                      )}
                      data-kind={panel.kind}
                      data-art={panel.art ? 'true' : 'false'}
                      data-state={state}
                      /* The panel being drawn is where the words are arriving,
                       * so it is what the magnifier looks at — and the last one
                       * drawn when nothing is arriving. */
                      data-reveal-edge={`${page.id}:${i}` === edgeKey ? '' : undefined}
                      style={{
                        gridColumn: `span ${panel.span}`,
                        gridRow: `span ${panel.rows}`,
                      }}
                      onClick={() => store.jumpToMessage(panel.messageId)}
                      title="Go to this passage"
                    >
                      {/* An unreached panel is ruled and empty — which is what a
                        * comic page looks like before you read it, and keeps the
                        * layout from jumping as each beat lands. */}
                      {state !== 'empty' && (
                        <PanelBody panel={panel} effect={state === 'live' ? wordEffect : null} />
                      )}
                    </div>
                  );
                })}
              </div>
              <figcaption className="comic-caption-bar">
                <span className="opacity-50">Scene {page.sceneIndex}</span>
                <span className="opacity-40">·</span>
                <span className="opacity-50">{GRID_LABEL[page.grid]}</span>
                {paginated && (
                  <span className="ml-auto flex items-center gap-1" data-testid="comic-pager">
                    <button
                      onClick={(e) => { e.stopPropagation(); setPageNo(p => Math.max(0, p - 1)); }}
                      disabled={pageNo === 0}
                      className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
                      title="Previous page"
                    >
                      <ChevronLeft size={12} />
                    </button>
                    <span className="tabular-nums">{Math.min(pageNo, pageCount - 1) + 1}/{pageCount}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPageNo(p => Math.min(pageCount - 1, p + 1)); }}
                      disabled={pageNo >= pageCount - 1}
                      className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
                      title="Next page"
                    >
                      <ChevronRight size={12} />
                    </button>
                  </span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
};
