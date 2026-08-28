/**
 * Opening a Cut — the impure half of `utils/cut.ts`.
 *
 * The story goes into the library like any other import; its direction layer
 * goes into the v2 store beside it. The one thing this must get right is the
 * ID: a Cut cannot carry the sender's story id and have it mean anything here,
 * because two readers can hold the same Cut and a second copy would land on
 * top of the first. So the library assigns a fresh id and the direction is
 * re-keyed to it before it is stored.
 */

import { useAuraV2Store } from '../stores/useAuraV2Store';
import { putStory } from '../lib/storage';
import type { Story } from '../types';
import { Cut, directionFor } from './cut';

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Put a Cut into this library and return the story it became. */
export const openCut = async (cut: Cut): Promise<Story> => {
  const id = newId();
  const story: Story = {
    ...cut.story,
    id,
    importedAt: Date.now(),
    // Someone else's reading position is not this reader's, and the notes never
    // travelled in the first place — start them at the beginning, unmarked.
    progress: null,
    highlights: [],
  };
  await putStory(story);
  useAuraV2Store.getState().adoptCut(id, directionFor(cut, id));
  return story;
};
