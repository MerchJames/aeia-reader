import { useCallback, useState } from 'react';
import { useAppStore } from '../store';
import { samplerParamsFrom } from '../utils/aiClient';
import { askText } from '../utils/aiCall';
import { getStory } from '../lib/storage';
import { historyBlock } from '../utils/askCharacter';
import { historyFrom, spreadHistory } from '../utils/visitor';
import { buildArcBriefMessages, parseArcBrief, type Protagonist } from '../utils/throughline';

/**
 * Compiling one arc's continuity brief.
 *
 * ── Why it reads the arc the way a visitor dossier does ────────────────────
 *
 * `spreadHistory` — the tail, plus an even sample of everything before it, in
 * one budget. That exists because of a real failure worth not repeating: a
 * brief written from the last twenty messages of a long chat came back as a
 * CARICATURE, because the last twenty messages of most chapters are somebody
 * grieving or furious. A person is the shape of their whole story, and a note
 * written from the end is a snapshot of a mood.
 *
 * The anchor is the arc's LAST message, not a beat the reader picks. A
 * throughline brief answers "what happened to me in that story", and that is a
 * question about the finished thing. A visitor's anchor exists because they are
 * walking in mid-life; an arc is behind you.
 *
 * `askText`, not the raw client, for the same reason the dossier uses it: this
 * is read by the reader before it is ever sent anywhere, and a chain of thought
 * landing in a continuity note would be both nonsense and, worse, believable.
 */

/** How much of an arc the brief is written from. Same budget as a dossier. */
export const ARC_BUDGET = 24_000;

export const useCompileArc = () => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const compile = useCallback(async (
    storyId: string,
    protagonist: Protagonist,
  ): Promise<string | null> => {
    const store = useAppStore.getState();
    setBusy(storyId); setError(null);
    try {
      const story = await getStory(storyId);
      if (!story) throw new Error('That story could not be loaded.');
      const history = historyFrom(story.messages);
      const last = history[history.length - 1];
      if (!last) throw new Error('That story has no readable messages.');

      const messages = buildArcBriefMessages({
        protagonist,
        title: story.title,
        character: story.characterName,
        history: historyBlock(spreadHistory(history, last.id, ARC_BUDGET)),
      });

      const raw = await askText(
        { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
        messages,
        {
          label: `Reading "${story.title}"`,
          // Low: this is a record of what happened, not a piece of writing.
          params: { temperature: 0.2 },
          reader: samplerParamsFrom(store.aiAdvanced),
        },
      );
      const brief = parseArcBrief(raw);
      if (!brief) throw new Error('The model returned nothing usable.');
      return brief;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  return { compile, busy, error, clearError: () => setError(null) };
};
