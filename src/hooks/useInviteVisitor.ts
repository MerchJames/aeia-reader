import { useCallback, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { samplerParamsFrom } from '../utils/aiClient';
import { askText } from '../utils/aiCall';
import { getStory } from '../lib/storage';
import { parseCompanionCard } from '../utils/parser';
import {
  buildDossier, emptyFields, historyFrom, type DossierScope, type Visitor,
} from '../utils/visitor';

const newId = () => `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export interface InviteRequest {
  sourceId: string;
  character: string;
  /** 1-based beat in THEIR story. */
  beat: number;
  scope: DossierScope;
}

/**
 * Bringing someone in, from anywhere that offers it.
 *
 * The panel and the two cast strips all need this and none of them should own
 * it: the generation, the clamp and the record shape are the same wherever the
 * reader happens to be standing when they decide they want company.
 *
 * `progress` is reported because the `whole` scope can be a dozen model calls
 * on a long story, and a reader who is not told that is a reader watching a
 * button do nothing.
 */
export const useInviteVisitor = () => {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = useCallback(async (req: InviteRequest): Promise<Visitor | null> => {
    const store = useAppStore.getState();
    const storyId = store.currentStory?.id;
    if (!storyId) return null;
    setBusy(true); setError(null); setProgress(null);
    try {
      const source = await getStory(req.sourceId);
      if (!source) throw new Error('That story could not be loaded.');
      const history = historyFrom(source.messages);
      const beat = Math.min(Math.max(1, req.beat), history.length);
      const anchor = history[beat - 1];
      if (!anchor) throw new Error('That story has no readable messages.');

      const { fields, quotes } = await buildDossier(
        {
          characterName: req.character,
          storyTitle: source.title,
          userName: source.userName,
          card: source.card,
          messages: history,
          anchorMessageId: anchor.id,
          hostName: store.currentStory?.characterName,
          scope: req.scope,
        },
        // `askText`, not the raw client: a brief is READ by the reader before it
        // is ever sent anywhere, and a chain of thought landing in the WHAT THEY
        // DO NOT KNOW field would be both nonsense and, worse, believable.
        async (messages) => askText(
          { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
          messages,
          {
            label: `Reading ${req.character}'s story`,
            params: { temperature: 0.3 },
            reader: samplerParamsFrom(store.aiAdvanced),
          },
        ),
        (done, total) => setProgress({ done, total }),
      );

      const visitor: Visitor = {
        id: newId(),
        name: req.character,
        sourceStoryId: req.sourceId,
        sourceStoryTitle: source.title,
        anchorMessageId: anchor.id,
        anchorBeat: beat,
        fields,
        quotes,
        met: false,
        active: true,
        scope: req.scope,
        createdAt: Date.now(),
      };
      useAuraV2Store.getState().addVisitor(storyId, visitor);
      return visitor;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false); setProgress(null);
    }
  }, []);

  /**
   * A card, with no story behind it.
   *
   * No source, no anchor, no model call — the card IS the brief. This is the
   * one path that can be instant, and it did not exist at all: the panel could
   * only bring in someone who already had a chat in the library.
   */
  const inviteCard = useCallback(async (file: File): Promise<Visitor | null> => {
    const storyId = useAppStore.getState().currentStory?.id;
    if (!storyId) return null;
    setBusy(true); setError(null);
    try {
      const card = await parseCompanionCard(file);
      const info = card.info;
      const fields = {
        ...emptyFields(),
        who: [info.description, info.personality].filter(Boolean).join(' ').slice(0, 1200)
          || `${card.name}, from a character card.`,
        where: info.scenario?.slice(0, 600) ?? '',
        // Load-bearing, and the reason a card can skip the model entirely: the
        // absence has to be IN the payload or the host story invents a history.
        doesNotKnow: 'They have no history in this story and know nothing that has happened in it.',
        voice: info.personality?.slice(0, 800) ?? '',
      };
      const visitor: Visitor = {
        id: newId(),
        name: card.name,
        sourceStoryId: '',
        sourceStoryTitle: 'a character card',
        anchorMessageId: '',
        anchorBeat: 0,
        fields,
        quotes: [],
        met: false,
        active: true,
        fromCard: true,
        avatar: card.avatar,
        createdAt: Date.now(),
      };
      useAuraV2Store.getState().addVisitor(storyId, visitor);
      return visitor;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { invite, inviteCard, busy, progress, error, setError };
};
