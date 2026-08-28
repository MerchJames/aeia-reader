import { create } from 'zustand';

/**
 * Ephemeral runtime state for a Scene Director enrichment run — progress for
 * the status readout + a "busy" flag so only one run happens at a time. Not
 * persisted (the descriptors themselves live in useAuraV2Store.sceneByStory).
 * The actual run is driven by utils/sceneDirectorRunner.
 */
interface SceneDirectorState {
  running: boolean;
  /** Story the current run belongs to. */
  storyId: string | null;
  /** Unique passages read so far this run. */
  done: number;
  /** Passages requested this run. */
  total: number;
  /** Passages the model gave nothing usable for — a weak/overloaded model,
   *  not restraint. Surfaced so a silent no-op is never mistaken for taste. */
  unread: number;
  begin: (storyId: string, total: number) => void;
  advance: (done: number, unread?: number) => void;
  end: () => void;
}

export const useSceneDirectorStore = create<SceneDirectorState>((set) => ({
  running: false,
  storyId: null,
  done: 0,
  total: 0,
  unread: 0,
  begin: (storyId, total) => set({ running: true, storyId, done: 0, total, unread: 0 }),
  advance: (done, unread) => set(unread == null ? { done } : { done, unread }),
  end: () => set({ running: false }),
}));
