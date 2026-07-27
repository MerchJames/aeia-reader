import { create } from 'zustand';
import {
  StoredBackdrop, deleteBackdrop, getAllBackdrops, putBackdrop,
} from '../lib/backdropStorage';

interface BackdropState {
  backdrops: StoredBackdrop[];
  urls: Record<string, string>;
  loaded: boolean;
  error: string | null;
  loadBackdrops: () => Promise<void>;
  addBackdrop: (storyId: string, keyword: string, file: File) => Promise<void>;
  removeBackdrop: (id: string) => Promise<void>;
}

const urlFor = (b: StoredBackdrop): string =>
  URL.createObjectURL(new Blob([b.data], { type: b.type || 'image/png' }));

export const useBackdropStore = create<BackdropState>()((set, get) => ({
  backdrops: [],
  urls: {},
  loaded: false,
  error: null,

  loadBackdrops: async () => {
    if (get().loaded) return;
    try {
      const backdrops = await getAllBackdrops();
      const urls: Record<string, string> = {};
      for (const b of backdrops) urls[b.id] = urlFor(b);
      set({ backdrops, urls, loaded: true });
    } catch (e: any) {
      set({ error: e?.message ?? 'Failed to load backdrops', loaded: true });
    }
  },

  addBackdrop: async (storyId, keyword, file) => {
    const key = keyword.trim().toLowerCase();
    if (!key || !storyId) return;
    try {
      const data = await file.arrayBuffer();
      // One image per (story, keyword) — replacing is the intuitive flow.
      const existing = get().backdrops.find(b => b.storyId === storyId && b.keyword === key);
      const backdrop: StoredBackdrop = {
        id: existing?.id ?? `bd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        storyId,
        keyword: key,
        data,
        type: file.type || 'image/png',
        addedAt: existing?.addedAt ?? Date.now(),
      };
      await putBackdrop(backdrop);
      const urls = { ...get().urls };
      if (existing && urls[existing.id]) URL.revokeObjectURL(urls[existing.id]);
      urls[backdrop.id] = urlFor(backdrop);
      set({
        backdrops: [...get().backdrops.filter(b => b.id !== backdrop.id), backdrop],
        urls,
        error: null,
      });
    } catch (e: any) {
      set({ error: e?.message ?? `Could not add ${file.name}` });
    }
  },

  removeBackdrop: async (id) => {
    try {
      await deleteBackdrop(id);
    } catch { /* fine */ }
    const url = get().urls[id];
    if (url) URL.revokeObjectURL(url);
    const { [id]: _gone, ...urls } = get().urls;
    set({ backdrops: get().backdrops.filter(b => b.id !== id), urls });
  },
}));

/**
 * Pick the backdrop for a scene: a keyword found inside the Director's
 * location wins, then a keyword equal to the mood, then "default".
 */
export const backdropForScene = (
  storyId: string | undefined,
  location: string | undefined,
  mood: string | undefined,
  backdrops: StoredBackdrop[],
  urls: Record<string, string>,
): { id: string; url: string } | null => {
  if (!storyId) return null;
  // Only this chat's backdrops are in play — they never cross chats.
  const pool = backdrops.filter(b => b.storyId === storyId);
  const loc = (location ?? '').toLowerCase();
  // NOTE: never mix && into a ?? chain here — an empty string short-circuits
  // the whole chain ('' is falsy but not nullish) and kills the fallback.
  const byLocation = loc
    ? pool.find(b => b.keyword !== 'default' && loc.includes(b.keyword))
    : undefined;
  const byMood = mood
    ? pool.find(b => b.keyword === mood.toLowerCase())
    : undefined;
  const hit = byLocation ?? byMood ?? pool.find(b => b.keyword === 'default');
  return hit && urls[hit.id] ? { id: hit.id, url: urls[hit.id] } : null;
};
