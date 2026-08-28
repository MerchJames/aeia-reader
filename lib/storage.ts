import { Story, StoryMeta } from '../types';

const DB_NAME = 'aura-reader';
/**
 * v2 added the `metas` store.
 *
 * v1 kept only whole `Story` records, so listing the library meant `getAll()`
 * over every story — pulling every message of every chat into memory on boot
 * purely to throw the text away and keep the title. With a handful of imports
 * that is invisible; with the few hundred a SillyTavern user accumulates it is
 * the slowest thing the app does. `metas` holds the stripped record so the
 * library never touches message text at all.
 */
const DB_VERSION = 2;
const STORE = 'stories';
const METAS = 'metas';

let dbPromise: Promise<IDBDatabase> | null = null;

/** Everything a `Story` carries that the library list has no use for. */
export const metaOf = (story: Story): StoryMeta => {
  const { messages: _m, highlights: _h, stars: _s, timelines: _t, card: _c, ...meta } = story;
  return meta;
};

const openDB = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(METAS)) {
          db.createObjectStore(METAS, { keyPath: 'id' });
          // Backfill from the stories already on disk. This is the one full
          // read that remains, and it happens once, on the upgrade boot.
          if ((event.oldVersion ?? 0) >= 1 && req.transaction) {
            const src = req.transaction.objectStore(STORE);
            const dst = req.transaction.objectStore(METAS);
            const all = src.getAll();
            all.onsuccess = () => {
              for (const story of all.result as Story[]) dst.put(metaOf(story));
            };
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('aura-reader upgrade blocked by another tab'));
    });
  }
  return dbPromise;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Both records in ONE transaction, so a story can never outlive its meta. */
export const putStory = async (story: Story): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE, METAS], 'readwrite');
    t.objectStore(STORE).put(story);
    t.objectStore(METAS).put(metaOf(story));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

/**
 * Patch just the library-visible fields of a story.
 *
 * The reader writes progress on a debounce as you read; going through
 * `putStory` for that would rewrite every message each time. This touches the
 * small record only.
 */
export const patchStoryMeta = async (
  id: string,
  patch: Partial<StoryMeta>,
): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(METAS, 'readwrite');
    const store = t.objectStore(METAS);
    const get = store.get(id);
    get.onsuccess = () => {
      const current = get.result as StoryMeta | undefined;
      if (current) store.put({ ...current, ...patch, id });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

export const getStory = async (id: string): Promise<Story | undefined> => {
  const db = await openDB();
  return request(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
};

export const deleteStory = async (id: string): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE, METAS], 'readwrite');
    t.objectStore(STORE).delete(id);
    t.objectStore(METAS).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

export const getAllStoryMetas = async (): Promise<StoryMeta[]> => {
  const db = await openDB();
  const metas: StoryMeta[] = await request(
    db.transaction(METAS, 'readonly').objectStore(METAS).getAll(),
  );
  return metas.sort((a, b) => b.importedAt - a.importedAt);
};

/**
 * Stream every story past a visitor, one at a time, for the library's deep
 * search. A cursor rather than `getAll()`: the whole point is not to hold the
 * entire library in memory at once, and an aborted search should stop reading.
 */
export const forEachStory = async (
  visit: (story: Story) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      if (signal?.aborted) { resolve(); return; }
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      // Visitors are sync in practice; a promise here would outlive the
      // transaction, so the result is deliberately not awaited.
      void visit(cursor.value as Story);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
};
