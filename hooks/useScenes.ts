import { useMemo } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { indexScenes, Scene, SceneInput, segmentScenes } from '../utils/sceneSegment';

/**
 * Derives the open story's SCENES (contiguous mood/place/time spans) and the one
 * the reader is currently in. Segmentation is memoised on the message stream and
 * the Director's descriptors, so it only recomputes when the story or its
 * enrichment changes — not on every scroll. The active-scene lookup is O(1).
 *
 * Shared by the reading surface (adaptive wash) and the ambient bed so both read
 * the same spans and the mood/soundscape stay stable across a scene.
 */
export const useScenes = (): { scenes: Scene[]; active?: Scene; activeId?: string } => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const chains = useAppStore(s => s.chains);
  const activeId = useAppStore(s =>
    s.streamingMessage?.id ?? s.visibleMessages[s.visibleMessages.length - 1]?.id);
  const descriptors = useAuraV2Store(s => (storyId ? s.sceneByStory[storyId] : undefined));

  const inputs = useMemo<SceneInput[]>(
    () => chains.flatMap(c => c.messages).map(m => ({
      id: m.id, role: m.role, content: m.content, startsChain: m.startsChain,
    })),
    [chains],
  );

  const scenes = useMemo(() => segmentScenes(inputs, descriptors), [inputs, descriptors]);
  const map = useMemo(() => indexScenes(scenes), [scenes]);
  const active = activeId ? map[activeId] : undefined;

  return { scenes, active, activeId };
};
