import { create } from 'zustand';
import { deleteFont, getAllFonts, putFont, StoredFont } from '../lib/fontStorage';

export interface CustomFontMeta {
  id: string;
  name: string;
  family: string;
}

interface FontState {
  fonts: CustomFontMeta[];
  loaded: boolean;
  error: string | null;
  loadFonts: () => Promise<void>;
  addFont: (file: File) => Promise<void>;
  removeFont: (id: string) => Promise<void>;
}

/** Live FontFace handles, so a removed font can be unregistered from the doc. */
const registered = new Map<string, FontFace>();

const register = async (family: string, data: ArrayBuffer): Promise<void> => {
  if (typeof FontFace === 'undefined') return;
  // Clone the buffer — FontFace may detach it, which would break persistence.
  const face = new FontFace(family, data.slice(0));
  await face.load();
  document.fonts.add(face);
  registered.set(family, face);
};

const niceName = (fileName: string): string =>
  fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Custom font';

/**
 * User-uploaded fonts. Loaded once at startup (each registered with the FontFace
 * API and persisted in IndexedDB), then offered in the font picker. Purely local.
 */
export const useFontStore = create<FontState>((set, get) => ({
  fonts: [],
  loaded: false,
  error: null,

  loadFonts: async () => {
    if (get().loaded) return;
    try {
      const stored = await getAllFonts();
      await Promise.all(stored.map(f => register(f.family, f.data).catch(() => {})));
      set({ fonts: stored.map(({ id, name, family }) => ({ id, name, family })), loaded: true });
    } catch (e: any) {
      set({ error: e?.message ?? 'Failed to load fonts', loaded: true });
    }
  },

  addFont: async (file) => {
    try {
      const data = await file.arrayBuffer();
      const id = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const family = `aura-font-${id}`;
      const name = niceName(file.name);
      await register(family, data); // throws if the file isn't a usable font
      const rec: StoredFont = { id, name, family, data, addedAt: Date.now() };
      await putFont(rec);
      set({ fonts: [...get().fonts, { id, name, family }], error: null });
    } catch (e: any) {
      set({ error: `Couldn't load "${file.name}" — is it a valid .ttf/.otf/.woff font?` });
      throw e;
    }
  },

  removeFont: async (id) => {
    const meta = get().fonts.find(f => f.id === id);
    if (meta) {
      const face = registered.get(meta.family);
      if (face) {
        try { document.fonts.delete(face); } catch { /* already gone */ }
        registered.delete(meta.family);
      }
    }
    await deleteFont(id);
    set({ fonts: get().fonts.filter(f => f.id !== id) });
  },
}));

/** Resolve a `custom:<id>` font setting to its CSS family, or null if not custom. */
export const customFamilyFor = (
  fontFamily: string, fonts: CustomFontMeta[],
): string | null => {
  if (!fontFamily.startsWith('custom:')) return null;
  const id = fontFamily.slice('custom:'.length);
  return fonts.find(f => f.id === id)?.family ?? null;
};
