import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clapperboard, Clock, Film } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { useReadThrough } from '../hooks/useReadThrough';
import { resolveContent } from '../utils/lens';
import { cn } from '../utils/cn';
import { revealClass, revealWords } from '../utils/wordReveal';
import { imagesAcross } from '../utils/storyImages';
import { useArtUrls } from '../hooks/useArtUrls';
import {
  LINES_PER_PAGE, ScriptLine, ScriptScene, buildScript, eighthsLabel, lineHeight, scriptStats,
} from '../utils/screenplay';

/**
 * The Script view — the story as a screenplay, typing itself.
 *
 * The formatting rules and every judgement they need are in `utils/screenplay`.
 * What is here is the page.
 *
 * ── It streams, and it types ───────────────────────────────────────────────
 *
 * The first build of this view rendered the finished document and hid the
 * playback bar, on the theory that a script is something you scan rather than
 * something you watch. That was wrong in a way worth writing down: Aeia's whole
 * premise is that a stored log becomes a performance, and a screenplay
 * assembling itself line by line — sluglines dropping in, cues appearing above
 * their dialogue — is one of the better performances the format can give. The
 * scanning is still there; it is what the pager and the scene list are for.
 *
 * Its signature reveal is the TYPEWRITER, which is not decoration either:
 * screenplay format is a description of a typewriter's behaviour — the whole
 * character grid exists because that is what a typebar could do — so a
 * screenplay that fades its words in is using the wrong machine.
 *
 * ── Autofocus ──────────────────────────────────────────────────────────────
 *
 * The scene list falls away, the page scales with W/S and pans with A/D, and
 * the typing line carries `data-reveal-edge` so the magnifier finds it exactly
 * as it does in every other view.
 */

const KIND_CLASS: Record<ScriptLine['kind'], string> = {
  slug: 'script-slug',
  action: 'script-action',
  character: 'script-character',
  parenthetical: 'script-parenthetical',
  dialogue: 'script-dialogue',
};

/** This view's own reveal, used unless the reader has turned theme effects off. */
const SIGNATURE_EFFECT = 'type';

/** One line's words, with the newest ones animating. */
const Typed = ({ text, effect }: { text: string; effect: string | null }) => {
  const words = useMemo(() => revealWords(text), [text]);
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

export const ScriptView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  useSceneDirector();
  const { scenes, activeId } = useScenes();
  const read = useReadThrough();

  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  const descriptors = storyId ? v2.sceneByStory[storyId] : undefined;

  /**
   * The Lens is honoured, and the story is cut off where the reader has got to.
   *
   * The streaming passage is passed through with only the words that have
   * arrived, so `buildScript` does all the work: a half-typed line of dialogue
   * is a half-typed line of dialogue, and the cue above it appears the moment
   * the quote opens.
   */
  const messages = useMemo(() => store.chains.flatMap(c => c.messages)
    .filter(m => read.has(m.id))
    .map(m => ({
      id: m.id,
      name: m.name,
      role: m.role,
      images: m.images,
      content: m.id === read.streamingId ? read.partial : resolveContent(m, overrides, lensOn),
    })), [store.chains, overrides, lensOn, read]);

  const cast = useMemo(() => {
    const names = new Set<string>();
    for (const m of store.chains.flatMap(c => c.messages)) if (m.name) names.add(m.name);
    if (store.currentStory?.characterName) names.add(store.currentStory.characterName);
    if (store.currentStory?.userName) names.add(store.currentStory.userName);
    return [...names];
  }, [store.chains, store.currentStory]);

  const script = useMemo(() => buildScript(messages, scenes, descriptors, {
    cast,
    characterName: store.currentStory?.characterName,
    userName: store.currentStory?.userName,
  }), [messages, scenes, descriptors, cast, store.currentStory]);

  const stats = useMemo(() => scriptStats(script), [script]);

  /**
   * Stills, per scene.
   *
   * A screenplay carries no pictures, and that is exactly why they go HERE
   * rather than in the body: a still belongs beside the scene heading the way a
   * storyboard panel is pinned to a slugline, not inside the action block where
   * it would break the character grid the whole format depends on. Small, in a
   * row, and only where the story actually has one.
   */
  const artUrls = useArtUrls();
  const stillsFor = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!store.showImages) return out;
    const byId = new Map(messages.map(m => [m.id, m]));
    for (const scene of script) {
      const shots = imagesAcross(
        scene.messageIds.map(id => byId.get(id)).filter(Boolean) as typeof messages,
        m => artUrls[m.id],
      );
      if (shots.length) out[scene.id] = shots;
    }
    return out;
  }, [script, messages, artUrls, store.showImages]);

  /* ── Pages ──────────────────────────────────────────────────────────────
   * A screenplay page is 55 lines of 12pt Courier. That is not a layout choice
   * this view invented — it is the unit the whole format is built on, which is
   * why a page is a minute of screen time — so paginating here means honouring
   * it rather than picking a number that fits the window. */
  const paginated = store.layoutMode === 'paginated';
  const pages = useMemo(() => {
    if (!paginated) return null;
    const out: { scene: ScriptScene; lines: ScriptLine[] }[][] = [];
    let page: { scene: ScriptScene; lines: ScriptLine[] }[] = [];
    let rows = 0;
    for (const scene of script) {
      for (const line of scene.lines) {
        const h = lineHeight(line);
        if (rows + h > LINES_PER_PAGE && page.length) { out.push(page); page = []; rows = 0; }
        const last = page[page.length - 1];
        if (last && last.scene.id === scene.id) last.lines.push(line);
        else page.push({ scene, lines: [line] });
        rows += h;
      }
    }
    if (page.length) out.push(page);
    return out.length ? out : [[]];
  }, [script, paginated]);

  const [page, setPage] = useState(0);
  const pageCount = pages?.length ?? 1;

  // The pages GROW as the story types itself, so the reader is carried to the
  // newest one — otherwise the script silently continues on a page they are not
  // looking at, which is the one failure a pager must not have.
  useEffect(() => {
    if (!pages) return;
    setPage(pages.length - 1);
  }, [pages?.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!paginated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); setPage(p => Math.min(pageCount - 1, p + 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPage(p => Math.max(0, p - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paginated, pageCount]);

  const shown = pages ? (pages[Math.min(page, pageCount - 1)] ?? []) : null;

  /** Which scene the reader is actually in, from where they are in the story. */
  const currentScene = useMemo(
    () => script.find(s => activeId && s.messageIds.includes(activeId))?.id,
    [script, activeId],
  );

  const pageRef = useRef<HTMLDivElement>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const pinnedRef = useRef(true);

  /* Follow the typing. Released the moment the reader scrolls up, so scanning
   * back through a scene is not fought by the stream. */
  useEffect(() => {
    const el = pageRef.current;
    if (!el || !pinnedRef.current || !store.isStreaming) return;
    el.scrollTop = el.scrollHeight;
  }, [read.partial, script.length, store.isStreaming]);

  const goTo = (id: string) => {
    if (pages) {
      const at = pages.findIndex(p => p.some(b => b.scene.id === id));
      if (at >= 0) setPage(at);
      return;
    }
    pageRef.current?.querySelector(`[data-scene="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const effect = (store.themeEffects && SIGNATURE_EFFECT) || store.streamEffect;
  const wordEffect = store.isStreaming || read.streamingId ? effect : null;
  const auto = store.isAutofocusMode;

  if (!script.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm opacity-60" data-testid="script-view">
        Nothing to script yet.
      </div>
    );
  }

  /** The blocks to draw: one page, or the whole thing. */
  const blocks = shown ?? script.map(scene => ({ scene, lines: scene.lines }));
  /** The very last line on screen is where the words are arriving. */
  const lastLine = blocks[blocks.length - 1]?.lines.length ?? 0;

  return (
    <div
      className={cn('flex-1 min-h-0 flex script-view', auto && 'script-autofocus')}
      data-testid="script-view"
      data-autofocus={auto ? 'true' : 'false'}
    >
      {/* The scene list. A script's real navigation is its scene numbers, and
        * the length beside each one is the whole point of the view: you can see
        * that scene 7 is three eighths of a page and scene 8 is four pages. */}
      {showSidebar && !auto && (
        <aside
          className="hidden md:flex w-56 shrink-0 flex-col border-r border-app-border overflow-y-auto"
          data-testid="script-scenes"
        >
          <div className="px-3 py-2 text-[10px] uppercase tracking-widest opacity-50 sticky top-0 bg-app-bg">
            {stats.scenes} scenes
          </div>
          {script.map(s => (
            <button
              key={s.id}
              onClick={() => goTo(s.id)}
              className={cn(
                'text-left px-3 py-2 border-l-2 hover:bg-app-text/5 transition-colors',
                s.id === currentScene ? 'border-accent bg-accent/5' : 'border-transparent',
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] opacity-50 tabular-nums">{s.number}</span>
                <span className="flex-1 min-w-0 truncate font-mono text-[11px]">{s.slug}</span>
              </div>
              <div className="pl-6 font-mono text-[10px] opacity-40 tabular-nums">
                {eighthsLabel(s.eighths)}
              </div>
            </button>
          ))}
        </aside>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        <div
          ref={pageRef}
          className="flex-1 min-h-0 overflow-y-auto pb-44"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          <div
            className="script-page mx-auto"
            style={auto ? {
              // W/S scales the page; A/D slides it. The 60ch block is the format
              // and must not change, so the TYPE scales and the column with it.
              fontSize: `${0.95 * store.autofocusZoom}rem`,
              transform: `translateX(${store.autofocusPanX}px)`,
            } : undefined}
          >
            {blocks.map((block, bi) => (
              <section key={`${block.scene.id}-${bi}`} data-scene={block.scene.id} className="script-scene">
                {block.lines.map((line, i) => {
                  // The newest line on the page is the one being typed.
                  const live = bi === blocks.length - 1 && i === lastLine - 1;
                  /* Stills go directly under the scene heading, where a
                   * storyboard panel is pinned — not at the foot of the scene,
                   * which is where they landed the first time and read as an
                   * appendix rather than as reference for what follows. */
                  const stills = line.kind === 'slug' ? stillsFor[block.scene.id] : undefined;
                  return (
                    <React.Fragment key={i}>
                    <div
                      className={cn(
                        KIND_CLASS[line.kind],
                        line.kind === 'slug' && block.scene.id === currentScene && 'script-slug-here',
                        live && store.isStreaming && 'script-live',
                      )}
                      data-kind={line.kind}
                      data-reveal-edge={live ? '' : undefined}
                      onClick={() => store.jumpToMessage(line.messageId)}
                      title="Go to this passage"
                    >
                      {line.kind === 'slug' && i === 0 && (
                        <span className="script-number">{block.scene.number}</span>
                      )}
                      {line.kind === 'parenthetical'
                        ? `(${line.text})`
                        : live
                          ? <Typed text={line.text} effect={wordEffect} />
                          : line.text}
                    </div>
                    {stills && (
                      <div className="script-stills" data-testid="script-stills">
                        {stills.map(src => (
                          <img key={src} src={src} alt="" loading="lazy" />
                        ))}
                      </div>
                    )}
                    </React.Fragment>
                  );
                })}
              </section>
            ))}
          </div>
        </div>

        {/* One page is one minute. That rule is why a screenplay's page count is
          * quoted at all, and it turns an RP log into a running time. */}
        <div
          className="shrink-0 flex items-center gap-4 px-4 py-2 border-t border-app-border text-[11px] font-mono tabular-nums opacity-70"
          data-testid="script-stats"
        >
          <button
            onClick={() => setShowSidebar(v => !v)}
            className="hidden md:flex items-center gap-1.5 hover:opacity-100 opacity-70"
            title="Show or hide the scene list"
          >
            <Clapperboard size={13} /> Scenes
          </button>
          <span className="flex items-center gap-1.5"><Film size={13} /> {stats.pages} pages</span>
          <span className="flex items-center gap-1.5"><Clock size={13} /> ~{stats.minutes} min</span>
          {paginated && (
            <span className="flex items-center gap-1" data-testid="script-pager">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="p-1 rounded hover:bg-app-text/10 disabled:opacity-30"
                title="Previous page"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="w-14 text-center">{Math.min(page, pageCount - 1) + 1}/{pageCount}</span>
              <button
                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                className="p-1 rounded hover:bg-app-text/10 disabled:opacity-30"
                title="Next page"
              >
                <ChevronRight size={13} />
              </button>
            </span>
          )}
          <span className="ml-auto opacity-60 hidden sm:inline">12pt Courier · 6&#8243; block</span>
        </div>
      </div>
    </div>
  );
};
