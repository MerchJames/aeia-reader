/**
 * Local storage for user-uploaded fonts. Kept in its own IndexedDB database
 * (separate from stories) so the font bytes never bloat the story records and
 * the two schemas can version independently. Everything stays on the device.
 */

/** A stored font: its display name, CSS family, and the raw file bytes. */
export interface StoredFont {
  id: string;
  /** Human label shown in the picker (derived from the file name). */
  name: string;
  /** Unique CSS font-family this font is registered under. */
  family: string;
  /** The .ttf/.otf/.woff(2) file contents. */
  data: ArrayBuffer;
  addedAt: number;
}

const DB_NAME = 'aura-reader-fonts';
const DB_VERSION = 1;
const STORE = 'fonts';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const store = async (mode: IDBTransactionMode) =>
  (await openDB()).transaction(STORE, mode).objectStore(STORE);

export const getAllFonts = async (): Promise<StoredFont[]> => {
  const all: StoredFont[] = await request((await store('readonly')).getAll());
  return all.sort((a, b) => a.addedAt - b.addedAt);
};

export const putFont = async (font: StoredFont): Promise<void> => {
  await request((await store('readwrite')).put(font));
};

export const deleteFont = async (id: string): Promise<void> => {
  await request((await store('readwrite')).delete(id));
};
