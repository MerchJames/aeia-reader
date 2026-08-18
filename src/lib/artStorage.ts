/**
 * Local storage for generated scene images.
 *
 * Its own IndexedDB database, mirroring `spriteStorage.ts`, and for the same
 * reason with sharper teeth: a 1024² PNG is well over a megabyte, while the v2
 * slice store rewrites a whole record on a 400ms debounce. Ten pictures in a
 * slice would mean rewriting twelve megabytes every time the reader changed a
 * tag. So the bytes live here, keyed by id, and the slice holds only the small
 * metadata that describes them.
 *
 * Scoped to one chat, like sprites: art generated for one story never surfaces
 * in another.
 */

export interface StoredArt {
  id: string;
  /** The chat this image belongs to — art never crosses chats. */
  storyId: string;
  /** The beat it was generated for. */
  messageId: string;
  /** The image file contents. */
  data: ArrayBuffer;
  /** MIME type, for the object URL and for the export's data URI. */
  type: string;
  createdAt: number;
}

const DB_NAME = 'aura-reader-art';
const DB_VERSION = 1;
const STORE = 'art';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          const os = req.result.createObjectStore(STORE, { keyPath: 'id' });
          // Deleting a story has to be able to find its art without reading
          // every image in the database into memory first.
          os.createIndex('storyId', 'storyId', { unique: false });
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

export const putArt = async (art: StoredArt): Promise<void> => {
  await request((await store('readwrite')).put(art));
};

export const getArt = async (id: string): Promise<StoredArt | undefined> =>
  request<StoredArt | undefined>((await store('readonly')).get(id));

export const deleteArt = async (id: string): Promise<void> => {
  await request((await store('readwrite')).delete(id));
};

/** Every image for a story, via the index — never a full-table read. */
export const artForStory = async (storyId: string): Promise<StoredArt[]> => {
  const os = await store('readonly');
  const rows: StoredArt[] = await request(os.index('storyId').getAll(storyId));
  return rows.sort((a, b) => a.createdAt - b.createdAt);
};

/** Drop a whole story's art — called when the story itself is deleted. */
export const deleteArtForStory = async (storyId: string): Promise<number> => {
  const os = await store('readwrite');
  const keys: IDBValidKey[] = await request(os.index('storyId').getAllKeys(storyId));
  for (const k of keys) await request(os.delete(k));
  return keys.length;
};

/**
 * A blob URL for an image, cached per id.
 *
 * Cached because these are handed to `<img src>` on every render, and a fresh
 * `createObjectURL` per render leaks one URL per frame — the reveal alone would
 * make thousands. Revoked only when the art is deleted.
 */
const urls = new Map<string, string>();

export const artUrl = async (id: string): Promise<string | null> => {
  const cached = urls.get(id);
  if (cached) return cached;
  const row = await getArt(id);
  if (!row) return null;
  const url = URL.createObjectURL(new Blob([row.data], { type: row.type || 'image/png' }));
  urls.set(id, url);
  return url;
};

export const releaseArtUrl = (id: string): void => {
  const url = urls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  urls.delete(id);
};

/** The bytes as a `data:` URI — the only form the HTML export will accept. */
export const artDataUri = async (id: string): Promise<string | null> => {
  const row = await getArt(id);
  if (!row) return null;
  const blob = new Blob([row.data], { type: row.type || 'image/png' });
  return new Promise<string | null>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
};
