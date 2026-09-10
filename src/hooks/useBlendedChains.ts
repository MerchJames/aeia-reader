/**
 * Mirroring the reader's blends into the chains they actually read.
 *
 * ── Why a hook and not a store call ────────────────────────────────────────
 *
 * The blends live in the v2 store and the chains live in the app store, and the
 * app store must never import the v2 one — the dependency runs the other way,
 * everywhere, on purpose. A component effect is the one place both are legally
 * in scope, so this is where the two meet.
 *
 * ── Why the substitution happens in the store at all ───────────────────────
 *
 * It could have been done at render time, the way Lens overrides are. It is
 * not, because a blend changes how many messages a chain HAS. `visibleThrough`,
 * `nextPosition`, the reveal, the progress percentage and the exporters all
 * count them, so a chain that renders one message while the store believes it
 * holds two leaves the reader stepping through a passage that is not there.
 * One array is the truth; this keeps it current.
 */

import { useEffect } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { blendMap } from '../utils/chatterBlend';

export const useBlendedChains = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const applyBlends = useAppStore(s => s.applyBlends);
  const lensChains = useAuraV2Store(s => (storyId ? s.lensChainsByStory[storyId] : undefined));
  const active = useAuraV2Store(s => (storyId ? s.activeLensChainByStory[storyId] : undefined));

  useEffect(() => {
    // `applyBlends` compares before it rebuilds, so the ordinary case — no
    // blends anywhere — costs one object allocation and returns.
    applyBlends(blendMap(lensChains, active));
  }, [applyBlends, lensChains, active, storyId]);
};
