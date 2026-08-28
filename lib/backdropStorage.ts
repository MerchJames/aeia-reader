/**
 * Local storage for Stage backdrops — scene images keyed by a location word.
 * The zero-config idea: name a backdrop "forest" and any scene the Director
 * places in a forest gets it (concept inspired by VN engines' asset folders;
 * implementation original). Own IndexedDB database; stays on the device.
 * Backdrops are scoped to ONE chat via storyId — they never cross chats.
 */

export interface StoredBackdrop {
  id: string;
  /** The chat this backdrop belongs to — backdrops never cross chats. */
  storyId: string;
  /** Lowercased keyword matched against the scene's location (or mood). */
  keyword: string;
  data: ArrayBuffer;
  type: string;
  addedAt: number;
}

const DB_NAME = 'aura-reader-backdrops';
const DB_VERSION = 1;
const STORE = 'backdrops';

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

export const getAllBackdrops = async (): Promise<StoredBackdrop[]> => {
  const all: StoredBackdrop[] = await request((await store('readonly')).getAll());
  return all.sort((a, b) => a.addedAt - b.addedAt);
};

export const putBackdrop = async (b: StoredBackdrop): Promise<void> => {
  await request((await store('readwrite')).put(b));
};

export const deleteBackdrop = async (id: string): Promise<void> => {
  await request((await store('readwrite')).delete(id));
};
