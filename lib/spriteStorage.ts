/**
 * Local storage for character expression sprites (Stage view). Own IndexedDB
 * database so image bytes never bloat the story records. Everything stays on
 * the device. Sprites are scoped to ONE chat: keyed by (storyId, character
 * NAME) so a set uploaded in one chat never shows up in another. Legacy records
 * saved before scoping (no storyId) simply no longer match — re-upload per chat.
 */

/** The emotion buckets an expression image can be filed under. */
export const EMOTION_BUCKETS = ['neutral', 'anger', 'fear', 'joy', 'sad', 'shock'] as const;
export type EmotionBucket = (typeof EMOTION_BUCKETS)[number];

/** Map the Director's free-text emotion word onto an expression bucket. */
export const bucketFor = (emotion?: string): EmotionBucket => {
  if (!emotion) return 'neutral';
  if (/anger|angry|furious|rage|wrath|irritat|annoy/i.test(emotion)) return 'anger';
  if (/fear|afraid|terrif|scared|panic|nervous|anxi/i.test(emotion)) return 'fear';
  if (/joy|happy|excit|delight|glee|laugh|cheer|playful/i.test(emotion)) return 'joy';
  if (/sad|sorrow|grief|melanchol|despair|cry|mourn/i.test(emotion)) return 'sad';
  if (/surpris|shock|astonish|stunned/i.test(emotion)) return 'shock';
  return 'neutral';
};

export interface StoredSprite {
  id: string;
  /** The chat this sprite belongs to — sprites never cross chats. */
  storyId: string;
  /** Lowercased character name this sprite belongs to. */
  character: string;
  emotion: EmotionBucket;
  /** The image file contents. */
  data: ArrayBuffer;
  /** MIME type, for the object URL. */
  type: string;
  addedAt: number;
}

const DB_NAME = 'aura-reader-sprites';
const DB_VERSION = 1;
const STORE = 'sprites';

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

export const getAllSprites = async (): Promise<StoredSprite[]> => {
  const all: StoredSprite[] = await request((await store('readonly')).getAll());
  return all.sort((a, b) => a.addedAt - b.addedAt);
};

export const putSprite = async (sprite: StoredSprite): Promise<void> => {
  await request((await store('readwrite')).put(sprite));
};

export const deleteSprite = async (id: string): Promise<void> => {
  await request((await store('readwrite')).delete(id));
};
