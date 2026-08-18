import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';
import { emphasisWordKinds, markSceneHtml, readerEmphasis } from '../utils/performMarkup';
import { RunMatcher, mergePerformCues, performMatcher, performWordKinds } from '../utils/scenePerform';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { useScenes } from '../hooks/useScenes';
import { useSceneDirector } from '../hooks/useSceneDirector';
import { SceneAtmosphere } from './SceneAtmosphere';
import { SceneSpine } from './SceneSpine';
import { MOOD_COLOR, sceneAtmosphere } from '../utils/sceneMood';
import { processText, balanceEmphasis, truncateToWord } from '../utils/textProcessor';
import {
  BookBlock, BookPage, attachedPlateBlock, chapterBlock, inkWrapTail, pageHtml, paginate,
  paginateTail, paragraphBlocks,
} from '../utils/bookLayout';
import { cn } from '../utils/cn';

/** ms between tail re-flows while text streams in. */
const TAIL_THROTTLE = 180;
const FLIP_MS = 650;

interface Dims {
  /** Page outer size. */
  pw: number; ph: number;
  /** Text column size (page minus padding — must match .book-page-body). */
  bodyW: number; bodyH: number;
  single: boolean;
}

/** Page padding — keep in sync with the .book-page-body CSS. */
const PAD_X = 44;
const PAD_TOP = 40;
const PAD_BOTTOM = 52;

const spreadOf = (page: number): number => Math.ceil(page / 2);

export const BookView = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  useSceneDirector();
  const { scenes, active: scene, activeId: activeSceneId } = useScenes();

  const containerRef = useRef<HTMLDivElement>(null);
  const measurerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<Dims | null>(null);

  // ----- geometry ---------------------------------------------------------
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw < 80 || ch < 80) return;
      const single = cw < 700;
      const pw = single
        ? Math.min(cw - 24, 540)
        : Math.min((cw - 96) / 2, 560);
      const ph = Math.min(ch - 16, pw * 1.6);
      setDims({
        pw: Math.floor(pw), ph: Math.floor(ph),
        bodyW: Math.floor(pw - PAD_X * 2), bodyH: Math.floor(ph - PAD_TOP - PAD_BOTTOM),
        single,
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ----- content → blocks -------------------------------------------------
  const procOpts = useMemo(() => ({
    oocHandling: store.oocHandling,
    autoFormat: store.autoFormat,
    autoFormatRules: store.autoFormatRules,
    paragraphSpacing: store.paragraphSpacing,
    dialogueOwnLine: store.dialogueOwnLine,
    smartTypography: store.smartTypography,
    substituteNames: store.substituteNames,
    characterName: store.currentStory?.characterName,
    userName: store.currentStory?.userName,
    // The book styles dialogue itself (.book-say) — skip the *quote* pass.
    styleQuotes: false,
  }), [
    store.oocHandling, store.autoFormat, store.autoFormatRules, store.paragraphSpacing,
    store.dialogueOwnLine, store.smartTypography, store.substituteNames,
    store.currentStory?.characterName, store.currentStory?.userName,
  ]);

  // Rough character budget per page so an oversized paragraph is pre-split
  // at sentences and can never outgrow a page.
  const maxParaChars = useMemo(() => {
    if (!dims) return 900;
    const lineH = store.fontSize * 1.75;
    const lines = Math.max(4, Math.floor(dims.bodyH / lineH));
    const perLine = Math.max(12, Math.floor(dims.bodyW / (store.fontSize * 0.5)));
    return Math.max(240, Math.floor(lines * perLine * 0.7));
  }, [dims, store.fontSize]);

  // Scene starts become chapter openings (only when there is more than one).
  const chapterByStartId = useMemo(() => {
    const m = new Map<string, { html: string; label: string }>();
    if (scenes.length < 2) return m;
    scenes.forEach((s, i) => {
      const label = `Chapter ${i + 1}`;
      m.set(s.startId, {
        label,
        html: chapterBlock({
          title: label,
          subtitle: s.location ?? (s.mood !== 'neutral' ? s.mood : undefined),
          color: MOOD_COLOR[s.mood],
        }),
      });
    });
    return m;
  }, [scenes]);

  // The book always holds the WHOLE story up to the reading position —
  // continuous semantics regardless of layoutMode. (visibleMessages is
  // per-chain in paginated mode and clears at chain boundaries, which made
  // the book collapse to a blank page whenever streaming crossed a chain.)
  const committedMsgs = useMemo(() => {
    const { chains, currentChainIndex: ci, currentMessageIndex: mi, streamingMessage } = store;
    const out: typeof store.visibleMessages = [];
    for (let c = 0; c < ci; c++) out.push(...(chains[c]?.messages ?? []));
    // While a message streams, indices point AT it — commit only what's before.
    const upto = streamingMessage ? mi : mi + 1;
    out.push(...(chains[ci]?.messages.slice(0, upto) ?? []));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.chains, store.currentChainIndex, store.currentMessageIndex, !!store.streamingMessage]);

  /**
   * The Director's performance cues, per message.
   *
   * Marked HERE rather than at render: a page is paginated from many messages,
   * so by the time `renderBody` sees it the words have lost the message they
   * came from — and a cue on one passage would mark words in another. At this
   * point identity is still known, and the marked spans survive pagination
   * because pagination only measures and splits blocks, never rewrites them.
   */
  /** See markSceneHtml: a cue animates once per word, not once per reveal tick. */
  const livePlayed = useRef<{ key: string; set: Set<string> }>({ key: '', set: new Set() });

  /** The word map AND this message's cadence matcher — see performMatcher. */
  const performFor = (messageId: string): { kinds: ReturnType<typeof performWordKinds>; match?: RunMatcher } => {
    if (!store.scenePerformance || !storyId) return { kinds: null };
    const cues = mergePerformCues(
      v2.performMarksByStory[storyId]?.[messageId],
      v2.sceneByStory[storyId]?.[messageId]?.perform,
    );
    return { kinds: performWordKinds(cues), match: performMatcher(cues) };
  };

  /**
   * The Director's EMPHASIS cues, per message — shouts, whispers, sfx marks.
   *
   * Book had the performance track and not this one. Storybook, Chat, Stage and
   * VN all dress emphasised words; Book alone left them plain, which made the
   * same reading mode look like a different feature depending on which view you
   * happened to be in. Gated on `sceneEmphasis` and `expressiveText` exactly as
   * the React path is, so Book never dresses a word Storybook leaves alone.
   */
  const emphasisFor = (messageId: string) => {
    if (!storyId) return null;
    // Reader-authored marks are not gated on `sceneEmphasis`: that setting says
    // whether the DIRECTOR may dress the page, and it was never a reason to
    // hide something the reader marked themselves.
    return emphasisWordKinds(
      readerEmphasis(
        store.sceneEmphasis ? v2.sceneByStory[storyId]?.[messageId]?.emphasis : undefined,
        v2.sfxMarksByStory[storyId]?.[messageId],
        v2.emphasisMarksByStory[storyId]?.[messageId],
      ),
      store.expressiveText,
    );
  };

  const committedBlocks = useMemo(() => {
    const blocks: BookBlock[] = [];
    for (const msg of committedMsgs) {
      const ch = chapterByStartId.get(msg.id);
      if (ch) blocks.push({ html: ch.html, chapter: ch.label });
      const text = processText(resolveContent(msg, overrides, lensOn), {
        ...procOpts,
        hideMetadata: store.hideMetadata && !msg.hidden,
        role: msg.role,
      }).processedText;
      const { kinds, match } = performFor(msg.id);
      const emph = emphasisFor(msg.id);
      // One `claimed` set across both tracks and every paragraph of the
      // message: one mark stays one mark. The cadence matcher spans them the
      // same way — a run can straddle a paragraph break.
      const claimed = new Set<string>();
      blocks.push(...paragraphBlocks(text, msg.id, msg.role === 'user', maxParaChars, store.showImages)
        .map(b => (kinds || match || emph || store.expressiveText
          ? { ...b, html: markSceneHtml(b.html, emph, kinds, claimed, store.expressiveText, undefined, match) }
          : b)));
      // Images ATTACHED to the message (not inline in its text) get plates too.
      if (store.showImages) {
        for (const src of msg.images ?? []) blocks.push(attachedPlateBlock(src, msg.id));
      }
    }
    return blocks;
  }, [
    committedMsgs, overrides, lensOn, procOpts, store.hideMetadata,
    chapterByStartId, maxParaChars, store.showImages,
    store.scenePerformance, store.sceneEmphasis, store.expressiveText, storyId,
    v2.performMarksByStory, v2.sceneByStory, v2.sfxMarksByStory, v2.emphasisMarksByStory,
  ]);

  // ----- pagination -------------------------------------------------------
  const [basePages, setBasePages] = useState<BookPage[]>([]);
  const [tailPages, setTailPages] = useState<BookPage[] | null>(null);

  useLayoutEffect(() => {
    const measurer = measurerRef.current;
    if (!measurer || !dims) return;
    const { pages } = paginate(measurer, committedBlocks, dims.bodyH);
    setBasePages(pages);
    setTailPages(null);
  }, [committedBlocks, dims]);

  // Streaming tail: re-flow only the live text (throttled), continuing on the
  // last committed page so the words land mid-page like real handwriting.
  const settledRef = useRef(0);
  const lastTailRun = useRef(0);
  const streamingId = store.streamingMessage?.id;
  useEffect(() => {
    settledRef.current = 0;
    // A new message's first words must land immediately, not a throttle later.
    lastTailRun.current = 0;
  }, [streamingId]);
  const streamedText = store.streamingMessage ? store.streamedText : '';
  useEffect(() => {
    const measurer = measurerRef.current;
    if (!measurer || !dims) return;
    if (!store.streamingMessage) { setTailPages(null); return; }

    const run = () => {
      lastTailRun.current = Date.now();
      const st = useAppStore.getState();
      const msg = st.streamingMessage;
      if (!msg) return;
      // Show the whole passage once committed; hide the last word only while
      // it's still being revealed, so a finished page never looks cut off.
      const live = balanceEmphasis(st.revealComplete ? st.streamedText : truncateToWord(st.streamedText));
      const tail: BookBlock[] = [];
      const ch = chapterByStartId.get(msg.id);
      if (ch) tail.push({ html: ch.html, chapter: ch.label });
      const { kinds: liveKinds, match: liveMatch } = performFor(msg.id);
      const liveEmph = emphasisFor(msg.id);
      const liveClaimed = new Set<string>();
      // The tail is rebuilt on every reveal tick; without a set that outlives
      // the render, every already-revealed marked word re-animates each time.
      if (livePlayed.current.key !== msg.id) livePlayed.current = { key: msg.id, set: new Set() };
      tail.push(...paragraphBlocks(live, msg.id, msg.role === 'user', maxParaChars)
        .map(b => (liveKinds || liveMatch || liveEmph || store.expressiveText
          ? {
            ...b,
            html: markSceneHtml(
              b.html, liveEmph, liveKinds, liveClaimed, store.expressiveText,
              livePlayed.current.set, liveMatch,
            ),
          }
          : b)));
      if (!tail.length) { setTailPages(null); return; }
      setTailPages(paginateTail(measurer, basePages[basePages.length - 1], tail, dims.bodyH));
    };

    const since = Date.now() - lastTailRun.current;
    if (since >= TAIL_THROTTLE) { run(); return; }
    const t = setTimeout(run, TAIL_THROTTLE - since);
    return () => clearTimeout(t);
  }, [streamedText, store.revealComplete, store.streamingMessage, basePages, dims, chapterByStartId, maxParaChars]);

  const pages = useMemo(() => (
    tailPages ? [...basePages.slice(0, -1), ...tailPages] : basePages
  ), [basePages, tailPages]);

  // ----- navigation & the flip --------------------------------------------
  const [spread, setSpread] = useState(0);
  const [flip, setFlip] = useState<1 | -1 | null>(null);
  const followRef = useRef(true);
  const single = dims?.single ?? false;
  const maxSpread = single
    ? Math.max(0, pages.length - 1)
    : spreadOf(Math.max(0, pages.length - 1));

  // Open the book at the bookmark — the last written page — not the cover.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || !pages.length) return;
    openedRef.current = true;
    setSpread(maxSpread);
  }, [pages.length, maxSpread]);

  // The in-flight flip is mirrored in a ref: the leaf fires MULTIPLE
  // animationend events (its ::after shade animates too, and pseudo-element
  // animations land on the host element), so the commit must be idempotent
  // or a single turn advances the spread twice and strands it past the book.
  const flipRef = useRef<1 | -1 | null>(null);
  const beginFlip = useCallback((dir: 1 | -1) => {
    flipRef.current = dir;
    setFlip(dir);
  }, []);
  const commitFlip = useCallback(() => {
    const f = flipRef.current;
    if (!f) return;
    flipRef.current = null;
    setSpread(s => s + f);
    setFlip(null);
  }, []);
  const onLeafAnimEnd = useCallback((e: React.AnimationEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!['bookLeafFwd', 'bookLeafBwd', 'bookSingleTurn'].includes(e.animationName)) return;
    commitFlip();
  }, [commitFlip]);

  const turn = useCallback((dir: 1 | -1) => {
    if (flip) return;
    const target = spread + dir;
    if (target < 0 || target > maxSpread) return;
    // Flipping back means the reader wants to reread — stop chasing the
    // stream until they return to the end (or press play again).
    if (dir === -1) followRef.current = false;
    else if (target === maxSpread) followRef.current = true;
    beginFlip(dir);
  }, [flip, spread, maxSpread, beginFlip]);

  // Follow the writing: while streaming, keep the book open at the last page.
  useEffect(() => {
    if (!store.isStreaming || !followRef.current || flip) return;
    if (spread >= maxSpread) return;
    if (spread === maxSpread - 1) beginFlip(1);
    else setSpread(maxSpread);
  }, [store.isStreaming, maxSpread, spread, flip, beginFlip]);

  // Pressing play resumes following.
  useEffect(() => {
    if (store.isStreaming) followRef.current = true;
  }, [store.isStreaming]);

  // Self-healing: never let the open spread point past the book (shrinking
  // pages, interrupted flips...). Depends on spread too so ANY bad state heals.
  useEffect(() => {
    if (spread > maxSpread) setSpread(maxSpread);
  }, [spread, maxSpread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') turn(1);
      else if (e.key === 'ArrowLeft') turn(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn]);

  // Click a paragraph to re-stream from its message (same as the chat view);
  // clicking an image plate opens it full-size instead.
  const [lightbox, setLightbox] = React.useState<string | null>(null);
  const onPageClick = useCallback((e: React.MouseEvent) => {
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLImageElement && target.closest('.book-plate')) {
      setLightbox(target.src);
      return;
    }
    const hit = target.closest('[data-msg]');
    if (!hit) return;
    const id = (hit as HTMLElement).dataset.msg!;
    const s = useAppStore.getState();
    if (id === s.streamingMessage?.id) s.setIsStreaming(!s.isStreaming);
    else s.restreamFromId(id);
  }, []);

  // ----- page lookup for the current spread -------------------------------
  const leftIdx = single ? -1 : spread * 2 - 1;
  const rightIdx = single ? spread : spread * 2;

  const page = (i: number): BookPage | undefined =>
    i >= 0 && i < pages.length ? pages[i] : undefined;

  // While a leaf is mid-air the static pages already show what the flip
  // reveals; the leaf carries the two faces that are visually in motion.
  const staticLeftIdx = flip === -1 ? leftIdx - 2 : leftIdx;
  const staticRightIdx = single
    ? rightIdx + (flip ?? 0)
    : flip === 1 ? rightIdx + 2 : rightIdx;
  const leafFrontIdx = flip === 1 ? rightIdx : rightIdx - 2;
  const leafBackIdx = flip === 1 ? rightIdx + 1 : leftIdx;

  const atmosphereOn = store.sceneTheming && store.themeEffects;
  const title = store.currentStory?.title ?? '';

  // Ink-wrap the streaming tail's words on the last page: words already shown
  // stay still, freshly streamed ones materialize.
  const renderBody = (p: BookPage | undefined, i: number) => {
    let html = pageHtml(p);
    if (html && store.streamingMessage && i === pages.length - 1) {
      const wrapped = inkWrapTail(html, settledRef.current);
      html = wrapped.html;
      settledRef.current = wrapped.totalWords;
    }
    return html;
  };

  const edgeW = (count: number) =>
    Math.max(count > 0 ? 3 : 0, Math.min(Math.round((count / Math.max(1, pages.length)) * 26), 26));

  if (store.chains.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-50">
        <p className="text-lg">This story is empty.</p>
      </div>
    );
  }

  const pageEl = (i: number, side: 'left' | 'right') => {
    const p = page(i);
    return (
      <div className={cn('book-page', side === 'left' ? 'book-page-left' : 'book-page-right')}>
        {p && (
          <>
            <div className="book-runhead">
              {side === 'left' ? title : (p.chapter ?? title)}
            </div>
            <div
              className="book-page-body"
              style={{ fontSize: `${store.fontSize}px` }}
              onClick={onPageClick}
              dangerouslySetInnerHTML={{ __html: renderBody(p, i) }}
            />
            <div className="book-folio">{i + 1}</div>
          </>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      // pb-36 on a phone: the playback bar is ~134px tall with its offset, and
      // pb-24 left it sitting on top of the last lines of the page.
      className="relative z-10 flex-1 min-h-0 flex items-center justify-center pb-36 sm:pb-24 pt-2"
    >
      <SceneAtmosphere scene={scene} activeId={activeSceneId} enabled={atmosphereOn} />
      {store.sceneTheming && <SceneSpine scenes={scenes} activeSceneId={scene?.id} />}

      {/* Offscreen column the paginator measures against. */}
      <div
        ref={measurerRef}
        aria-hidden="true"
        className="book-page-body book-measure"
        style={dims ? { width: dims.bodyW, fontSize: `${store.fontSize}px` } : undefined}
      />

      {dims && (
        <div
          className={cn('book', single && 'book-single', flip && 'book-flipping', store.isAutofocusMode && 'book-autofocus')}
          style={{
            width: single ? dims.pw : dims.pw * 2,
            height: dims.ph,
            // The scene's mood reaches the paper itself, not just the backdrop.
            ...(atmosphereOn && scene
              ? {
                  '--scene-tint': MOOD_COLOR[scene.mood],
                  '--scene-tint-a': String(
                    sceneAtmosphere(scene.mood, scene.peakTension, scene.timeOfDay).washOpacity),
                } as React.CSSProperties
              : null),
          }}
          data-pages={pages.length}
          data-spread={spread}
          data-flip={flip ?? 0}
        >
          {/* Stacked page edges — the "how far in am I" of a physical book. */}
          {!single && <div className="book-edges book-edges-l" style={{ width: edgeW(leftIdx) }} />}
          {!single && (
            <div className="book-edges book-edges-r" style={{ width: edgeW(pages.length - 1 - rightIdx) }} />
          )}

          {!single && pageEl(staticLeftIdx, 'left')}
          {pageEl(staticRightIdx, 'right')}

          {!single && <div className="book-spine" aria-hidden="true" />}

          {/* The leaf in motion. */}
          {flip && !single && (
            <div
              className={cn('book-leaf', flip === 1 ? 'book-leaf-fwd' : 'book-leaf-bwd')}
              style={{ animationDuration: `${FLIP_MS}ms` }}
              onAnimationEnd={onLeafAnimEnd}
            >
              <div className="book-leaf-face book-leaf-front">
                {pageEl(leafFrontIdx, 'right')}
              </div>
              <div className="book-leaf-face book-leaf-rear">
                {pageEl(leafBackIdx, 'left')}
              </div>
            </div>
          )}
          {flip && single && (
            <div
              className="book-single-turn"
              style={{ animationDuration: `${FLIP_MS}ms` }}
              onAnimationEnd={onLeafAnimEnd}
            />
          )}

          {/* Margin arrows for turning (arrow keys work too). */}
          <button
            className="book-nav book-nav-l"
            onClick={() => turn(-1)}
            disabled={spread <= 0}
            aria-label="Previous page"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            className="book-nav book-nav-r"
            onClick={() => turn(1)}
            disabled={spread >= maxSpread}
            aria-label="Next page"
          >
            <ChevronRight size={22} />
          </button>
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
    </div>
  );
};
