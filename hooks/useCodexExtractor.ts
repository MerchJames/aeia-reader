import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import {
  committedCount, flatMessages, useAuraV2Store,
} from '../stores/useAuraV2Store';
import {
  cardToEntities, countMentions, createLLMExtractor, EntityExtractor, heuristicExtract,
} from '../utils/codexExtractor';

/**
 * Messages scanned per idle slice — keeps low-end machines smooth while
 * reading live; larger bites when catching up on a big already-read backlog.
 */
const sliceSize = (backlog: number) => (backlog > 200 ? 32 : 4);
/** New messages between (optional) AI refinement passes. */
const AI_BATCH = 12;

const idle = (cb: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(cb, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(cb, 200);
  return () => clearTimeout(id);
};

/**
 * The proactive auto-codex. Watches the reading position; whenever the
 * reader commits new messages, the text they just read is scanned for
 * entities during browser idle time. Everything is derived strictly from
 * *already read* text, so the codex can never spoil what's ahead.
 *
 * Extraction is heuristic by default (runs on anything, no network).
 * When "AI codex" is enabled and an endpoint is configured, batches are
 * additionally refined through the LLM extractor.
 */
export const useCodexExtractor = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const readCount = useAppStore(s =>
    s.chains.length === 0
      ? 0
      : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage));
  const codexEnabled = useAuraV2Store(s => s.codexEnabled);
  const codexUseAI = useAuraV2Store(s => s.codexUseAI);
  // clearCodex resets scanProgress — subscribing re-triggers a full rescan.
  const scanned = useAuraV2Store(s => (storyId ? s.scanProgress[storyId] ?? 0 : 0));

  // Serialize work: one scan pipeline at a time, cancelled on story change.
  const epochRef = useRef(0);
  const busyRef = useRef(false);
  const aiExtractorRef = useRef<{ key: string; fn: EntityExtractor } | null>(null);
  const aiPendingFromRef = useRef<number | null>(null);
  const aiBusyRef = useRef(false);

  useEffect(() => {
    epochRef.current++;
    aiPendingFromRef.current = null;
  }, [storyId]);

  // Seed the codex from an attached character card (author-written entries
  // beat anything extracted, and upsert dedupes, so re-seeding is safe —
  // this also re-applies after a "Rebuild").
  useEffect(() => {
    if (!codexEnabled || !storyId) return;
    const card = useAppStore.getState().currentStory?.card;
    if (!card) return;
    const v2 = useAuraV2Store.getState();
    // Already seeded (any card-sourced entry present) — don't re-merge, it
    // would inflate mention counts on every open.
    if ((v2.codexByStory[storyId] ?? []).some(e => e.source === 'card')) return;
    const seeded = cardToEntities(card);
    if (seeded.length) v2.upsertEntities(storyId, seeded);
  }, [codexEnabled, storyId, scanned === 0]);

  useEffect(() => {
    if (!codexEnabled || !storyId || readCount <= scanned || busyRef.current) return;

    // Story-scoped epoch: invalidates in-flight work only on story change.
    const epoch = epochRef.current;
    busyRef.current = true;

    const cancel = idle(() => {
      busyRef.current = false;
      if (epoch !== epochRef.current) return;

      const app = useAppStore.getState();
      const v2 = useAuraV2Store.getState();
      if (app.currentStory?.id !== storyId) return;

      const messages = flatMessages(app.chains);
      const from = v2.scanProgress[storyId] ?? 0;
      const to = Math.min(readCount, from + sliceSize(readCount - from), messages.length);
      if (to <= from) return;

      const slice = messages.slice(from, to);
      const chunk = slice.map(m => m.content).join('\n\n');
      const known = v2.codexByStory[storyId] ?? [];

      // 1. Mentions of what we already know, so the codex ranks by relevance.
      v2.addMentions(storyId, countMentions(chunk, known));

      // 2. New entities via the local heuristic pass.
      const knownNames = known.flatMap(e => [e.name, ...e.aliases]);
      const found = heuristicExtract(chunk, {
        knownNames,
        characterName: app.currentStory?.characterName,
        userName: app.currentStory?.userName,
      });
      // Anchor "first seen" to the message inside the slice that names it.
      v2.upsertEntities(storyId, found.map(f => {
        const at = slice.findIndex(m =>
          m.content.toLowerCase().includes(f.name.toLowerCase()));
        const anchor = at === -1 ? 0 : at;
        return {
          ...f,
          firstSeenIndex: from + anchor,
          firstSeenMessageId: slice[anchor]?.id ?? '',
        };
      }));

      v2.setScanProgress(storyId, to);
      if (aiPendingFromRef.current === null) aiPendingFromRef.current = from;

      // 3. Optional AI refinement, batched so it stays cheap and quiet.
      const aiCfg = { baseUrl: app.aiBaseUrl, apiKey: app.aiApiKey, model: app.aiModel };
      const aiReady = codexUseAI && aiCfg.baseUrl && aiCfg.model;
      const batchedEnough = to - (aiPendingFromRef.current ?? to) >= AI_BATCH || to >= messages.length;
      if (aiReady && batchedEnough && !aiBusyRef.current) {
        const aiFrom = aiPendingFromRef.current ?? from;
        aiPendingFromRef.current = to;
        aiBusyRef.current = true;

        const key = `${aiCfg.baseUrl}|${aiCfg.model}`;
        if (aiExtractorRef.current?.key !== key) {
          aiExtractorRef.current = { key, fn: createLLMExtractor(aiCfg) };
        }
        const aiChunk = messages.slice(aiFrom, to).map(m => m.content).join('\n\n');

        aiExtractorRef.current.fn(aiChunk, {
          knownNames: (useAuraV2Store.getState().codexByStory[storyId] ?? [])
            .flatMap(e => [e.name, ...e.aliases]),
          characterName: app.currentStory?.characterName,
          userName: app.currentStory?.userName,
        }).then(aiFound => {
          if (epoch !== epochRef.current || aiFound.length === 0) return;
          const batch = messages.slice(aiFrom, to);
          useAuraV2Store.getState().upsertEntities(storyId, aiFound.map(f => {
            const at = batch.findIndex(m =>
              m.content.toLowerCase().includes(f.name.toLowerCase()));
            const anchor = at === -1 ? 0 : at;
            return {
              ...f,
              firstSeenIndex: aiFrom + anchor,
              firstSeenMessageId: batch[anchor]?.id ?? '',
            };
          }));
        }).catch(e => {
          // The heuristic pass already covered this text — AI is best-effort.
          console.warn('AI codex extraction failed', e);
        }).finally(() => { aiBusyRef.current = false; });
      }
    });

    return () => { cancel(); busyRef.current = false; };
  }, [codexEnabled, codexUseAI, storyId, readCount, scanned]);
};
