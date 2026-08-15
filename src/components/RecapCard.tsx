import React, { useEffect, useMemo, useState, useTransition } from 'react';
import { BookOpen, Loader2, Play, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../store';
import { wordsPerSecond } from '../hooks/useStreamer';
import {
  committedCount, flatMessages, useAuraV2Store, visibleEntities,
} from '../stores/useAuraV2Store';
import { chatCompletion, listModels } from '../utils/aiClient';
import { cardToPromptBlock } from '../utils/cardContext';
import { plainTextForSpeech } from '../utils/textProcessor';
import { segmentScenes } from '../utils/sceneSegment';
import { MOOD_COLOR } from '../utils/sceneMood';
import { Mood } from '../types';

const RECAP_SYSTEM =
  'Write a warm, spoiler-free "previously on…" recap of the story excerpt, in 3-4 sentences. '
  + 'Mention only events inside the excerpt. No preamble, no meta commentary.';

/**
 * "Previously…" card, shown once when resuming a story mid-way — the
 * feature readers ask for most after long breaks. Everything on it is
 * built from text already read (never ahead), with an optional one-tap
 * AI recap when an endpoint is configured.
 */
export const RecapCard = () => {
  const story = useAppStore(s => s.currentStory);
  const screen = useAppStore(s => s.screen);
  const seen = useAuraV2Store(s => (story ? s.recapSeen[story.id] : true));
  const markRecapSeen = useAuraV2Store(s => s.markRecapSeen);
  const [aiRecap, setAiRecap] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [generating, startGenerate] = useTransition();
  const aiConfigured = useAppStore(s => !!(s.aiBaseUrl && s.aiModel));

  // Snapshot the resume position once per story open; the card describes
  // "where you left off", not the live cursor.
  const [snapshot, setSnapshot] = useState<{
    storyId: string; readCount: number; lastRead: string; minutesLeft: number;
    arc: { mood: Mood; label: string }[];
  } | null>(null);

  useEffect(() => {
    setAiRecap(null);
    setAiError(null);
    if (!story || screen !== 'reader') { setSnapshot(null); return; }
    const s = useAppStore.getState();
    const readCount = s.chains.length === 0
      ? 0
      : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage);
    const messages = flatMessages(s.chains);
    // Only worth a recap if there's real history behind and story ahead.
    if (readCount < 10 || readCount >= messages.length) { setSnapshot(null); return; }

    const lastMsg = messages[readCount - 1];
    const remainingWords = messages.slice(readCount)
      .reduce((n, m) => n + m.content.split(/\s+/).length, 0);
    const wps = wordsPerSecond(s.playbackSpeed);

    // The mood journey through what's been read — the last few scenes, so the
    // reader re-enters with a feel for the arc, not just the last line.
    const descriptors = useAuraV2Store.getState().sceneByStory[story.id];
    const readInputs = messages.slice(0, readCount)
      .map(m => ({ id: m.id, role: m.role, content: m.content, startsChain: m.startsChain }));
    const arc = segmentScenes(readInputs, descriptors)
      .slice(-4)
      .map(sc => ({ mood: sc.mood, label: sc.location ?? sc.mood }));

    setSnapshot({
      storyId: story.id,
      readCount,
      lastRead: plainTextForSpeech(lastMsg?.content ?? '').slice(0, 260),
      minutesLeft: Math.round(remainingWords / (wps * 60)),
      arc: arc.length >= 2 ? arc : [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, screen]);

  const codex = useAuraV2Store(s =>
    (snapshot ? s.codexByStory[snapshot.storyId] : undefined));
  const cast = useMemo(() => {
    if (!snapshot || !codex) return [];
    return visibleEntities(codex, snapshot.readCount)
      .filter(e => e.kind === 'character')
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 5);
  }, [codex, snapshot]);

  if (!story || screen !== 'reader' || seen || !snapshot) return null;

  const dismiss = (play: boolean) => {
    markRecapSeen(story.id);
    if (play) useAppStore.getState().setIsStreaming(true);
  };

  const generate = () => {
    setAiError(null);
    startGenerate(async () => {
      try {
        const s = useAppStore.getState();
        const messages = flatMessages(s.chains);
        const excerpt = messages
          .slice(Math.max(0, snapshot.readCount - 14), snapshot.readCount)
          .map(m => `${m.name}: ${plainTextForSpeech(m.content)}`)
          .join('\n')
          .slice(-7000);
        const { base } = await listModels(s.aiBaseUrl, s.aiApiKey);
        // Card data (when attached) grounds names/relationships in the recap.
        const cardBlock = cardToPromptBlock(s.currentStory?.card);
        // Reader tracking sheets give the recap extra grounding.
        const sheets = s.currentStory
          ? useAuraV2Store.getState().sheetsByStory[s.currentStory.id] ?? []
          : [];
        const sheetBlock = sheets.length
          ? [
              '',
              "--- READER'S TRACKING SHEETS ---",
              ...sheets.map(sh => {
                const cols = sh.columns.length ? sh.columns : ['Name', 'Note'];
                return `## ${sh.title}\n${sh.rows.map(r =>
                  cols.map(c => `${c}: ${r[c] ?? ''}`).join(' | '),
                ).join('\n')}`;
              }),
            ].join('\n')
          : '';
        const system = [RECAP_SYSTEM, cardBlock, sheetBlock].filter(Boolean).join('\n\n');
        const text = await chatCompletion(base, s.aiApiKey, s.aiModel, [
          { role: 'system', content: system },
          { role: 'user', content: excerpt },
        ]);
        setAiRecap(text.trim());
      } catch (e: any) {
        setAiError(e?.message ?? 'Recap failed');
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[3px]" onClick={() => dismiss(false)} />
      <div className="relative w-full max-w-md max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl bg-surface border border-app-border shadow-2xl p-6 space-y-4">
        <button
          onClick={() => dismiss(false)}
          className="absolute top-3 right-3 p-2 rounded-full hover:bg-app-text/10 transition-colors"
          title="Dismiss"
        >
          <X size={15} />
        </button>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent mb-1">
            Previously…
          </p>
          <h2 className="text-lg font-bold leading-tight">{story.title}</h2>
          <p className="text-xs text-muted mt-0.5">
            {snapshot.readCount} of {story.messageCount} messages read
            {snapshot.minutesLeft > 0 && ` · ~${snapshot.minutesLeft} min left`}
          </p>
        </div>

        {aiRecap ? (
          <p className="text-sm leading-relaxed border-l-2 border-accent/60 pl-3 italic opacity-90">
            {aiRecap}
          </p>
        ) : (
          <div className="text-sm leading-relaxed opacity-80">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1">
              Where you left off
            </p>
            <p className="italic">“{snapshot.lastRead}…”</p>
          </div>
        )}

        {snapshot.arc.length >= 2 && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
              The story so far
            </p>
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              {snapshot.arc.map((sc, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="text-muted/50" aria-hidden>→</span>}
                  <span className="inline-flex items-center gap-1.5 capitalize">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: MOOD_COLOR[sc.mood] }}
                      aria-hidden
                    />
                    {sc.label}
                  </span>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {cast.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {cast.map(e => (
              <span
                key={e.id}
                title={e.summary}
                className="px-2 py-0.5 rounded-full bg-app-text/5 border border-app-border/60 text-xs cursor-help"
              >
                {e.name}
              </span>
            ))}
          </div>
        )}

        {aiError && <p className="text-xs text-red-500">{aiError}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => dismiss(true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent text-white font-bold text-sm hover:opacity-90 transition-opacity"
          >
            <Play size={15} /> Continue reading
          </button>
          {aiConfigured && !aiRecap && (
            <button
              onClick={generate}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-app-border text-sm hover:bg-app-text/5 disabled:opacity-50 transition-colors"
              title="Generate a spoiler-free AI recap"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Recap
            </button>
          )}
          <button
            onClick={() => dismiss(false)}
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-app-border text-sm hover:bg-app-text/5 transition-colors"
            title="Just browse"
          >
            <BookOpen size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
