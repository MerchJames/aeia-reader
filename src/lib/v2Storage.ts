/**
 * IndexedDB for the v2 store's reader-side data (codex, Lens overrides, sheets,
 * annotations, marks, pins, zones, threads, scene descriptors, sandbox work).
 *
 * Replaces a single debounced localStorage blob that re-serialized everything on
 * every `set()` and, at the ~5MB ceiling, failed by silently dropping the write
 * (`catch { /* quota *\/ }`). Records are sharded per slice and per story, so a
 * scene-descriptor write costs one small record instead of the whole library.
 *
 * Same shape as the other three IDB stores in this app (fonts, sprites,
 * backdrops) so there's one pattern to learn.
 */

import {
  DiffOp, SliceBag, V2Record, assembleSlices, explodeSlices,
} from '../utils/v2Persist';

const DB_NAME = 'aura-reader-v2';
const DB_VERSION = 1;
const STORE = 'chunks';
/** The blob this replaced. Kept readable for one release as a fallback. */
export const LEGACY_KEY = 'aura-reader-v2';

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

const tx = async (mode: IDBTransactionMode) =>
  (await openDB()).transaction(STORE, mode).objectStore(STORE);

const getAllRecords = async (): Promise<V2Record[]> =>
  request<V2Record[]>((await tx('readonly')).getAll());

/** Apply a batch of writes/deletes in ONE transaction, so a crash can't tear it. */
export const applyOps = async (ops: readonly DiffOp[]): Promise<void> => {
  if (!ops.length) return;
  const store = await tx('readwrite');
  await new Promise<void>((resolve, reject) => {
    for (const op of ops) {
      if (op.op === 'put') store.put({ id: op.id, value: op.value });
      else store.delete(op.id);
    }
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
    store.transaction.onabort = () => reject(store.transaction.error);
  });
};

/** The old whole-blob value, if this device still has one. */
const readLegacyBlob = (): SliceBag | null => {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: SliceBag };
    return parsed?.state && typeof parsed.state === 'object' ? parsed.state : null;
  } catch {
    return null;
  }
};

export interface LoadResult {
  state: SliceBag;
  /** True when this load came from the old localStorage blob. */
  migrated: boolean;
}

/**
 * Everything the reader has saved.
 *
 * On a device that has never used IndexedDB, the old blob is imported once and
 * left in place — NOT deleted. If this build has to be rolled back, the reader's
 * codex and Lens edits are still where the previous build looks for them. It
 * costs one stale copy of the data for one release; losing a reader's
 * annotations to a rollback costs rather more.
 */
export const loadV2 = async (): Promise<LoadResult> => {
  let records: V2Record[] = [];
  try {
    records = await getAllRecords();
  } catch (e) {
    console.error('v2 store: could not read IndexedDB', e);
  }
  if (records.length) return { state: assembleSlices(records), migrated: false };

  const legacy = readLegacyBlob();
  if (!legacy) return { state: {}, migrated: false };

  const exploded = explodeSlices(legacy);
  try {
    await applyOps(exploded.map(r => ({ op: 'put' as const, id: r.id, value: r.value })));
  } catch (e) {
    // The reader still gets their data this session even if the write failed.
    console.error('v2 store: migration write failed, running from the old blob', e);
  }
  return { state: assembleSlices(exploded), migrated: true };
};

/** Wipe every record. Used by tests and a future "reset reader data". */
export const clearV2 = async (): Promise<void> => {
  await request((await tx('readwrite')).clear());
};
