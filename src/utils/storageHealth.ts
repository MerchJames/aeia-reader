/**
 * Whether this browser intends to keep the reader's library.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * Everything this app holds — stories, highlights, notes, pins, sheets, scene
 * art, Lens edits — lives in IndexedDB, and IndexedDB is *best-effort* storage
 * by default. That is not a figure of speech: when a device runs low on disk,
 * browsers evict best-effort origins, least recently used first, without asking
 * and without telling. The app's entire promise is "everything stays on this
 * device", and by default the device has made no such promise back.
 *
 * `navigator.storage.persist()` is the fix. A persisted origin is not evicted
 * under pressure; only the reader can clear it.
 *
 * ── Why this is not called on startup ──────────────────────────────────────
 *
 * It is tempting to request persistence the moment the app loads. Don't:
 * Firefox shows a permission prompt, and a permission prompt before the reader
 * has opened anything is a request to trust an app they have not used yet. The
 * predictable answer is no, and a refused permission is much harder to ask for
 * a second time than a deferred one.
 *
 * So the request is made at a moment when the reader has something to lose and
 * the ask makes obvious sense — after their first import succeeds, and from the
 * backup panel where the subject is already "keeping your work". Reading the
 * CURRENT state (`persisted()`, `estimate()`) prompts nothing and is safe
 * anywhere.
 *
 * Chrome grants silently on its own engagement heuristics and may say no today
 * and yes next week, which is another reason to treat a refusal as "ask again
 * later" rather than a settled answer.
 *
 * The pure half is here and tested; the two calls that touch `navigator` are
 * thin wrappers at the bottom.
 */

export type Durability =
  /** The browser has promised not to evict this origin. */
  | 'persisted'
  /** Storage works, but may be cleared when the device runs low. */
  | 'best-effort'
  /** No Storage API — an old browser, or a non-secure context. */
  | 'unsupported';

export type Pressure = 'fine' | 'tight' | 'full' | 'unknown';

export interface StorageReport {
  durability: Durability;
  /** Bytes used by this origin, as the browser reports them. */
  usage: number | null;
  /** Bytes this origin may use. Browsers report a share of free disk. */
  quota: number | null;
  pressure: Pressure;
}

/**
 * Where "running out" starts.
 *
 * Deliberately early. By the time a write actually fails the reader has already
 * lost the thing they were writing, so the useful warning is the one that
 * arrives while there is still room to export a backup — which itself needs
 * space to build.
 */
export const TIGHT_RATIO = 0.8;
export const FULL_RATIO = 0.95;

export const pressureOf = (usage: number | null, quota: number | null): Pressure => {
  if (usage === null || quota === null || !Number.isFinite(usage) || !Number.isFinite(quota)) {
    return 'unknown';
  }
  // A zero quota is not an empty disk, it is a browser declining to say. Some
  // report exactly this in private windows, where treating it as "100% full"
  // would put a permanent red warning in front of a reader with no problem.
  if (quota <= 0) return 'unknown';
  const ratio = usage / quota;
  if (ratio >= FULL_RATIO) return 'full';
  if (ratio >= TIGHT_RATIO) return 'tight';
  return 'fine';
};

/**
 * Bytes as a person would say them.
 *
 * Binary units, one decimal below 10 and none above, because "1.4 GB" is useful
 * and "1.42 GB" is noise on a number that moves. Returns "—" rather than "0 B"
 * for an unknown, so an unmeasured library never reads as an empty one.
 */
export const formatBytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/**
 * Should the reader be told something about storage right now?
 *
 * Only two cases are worth interrupting for: the browser has not promised to
 * keep the library, and the library is close to filling the space it has. An
 * app that warns about anything less trains people to dismiss it.
 */
export const shouldWarn = (r: StorageReport): boolean =>
  r.durability === 'best-effort' || r.pressure === 'tight' || r.pressure === 'full';

/**
 * One line for the settings row. States the situation, not the API.
 *
 * The measurement is a whole sentence or nothing at all. Interpolating an
 * unknown into the middle of a sentence is how you get "Using — of — available."
 * on screen, or a stray leading full stop when both halves are missing — and a
 * storage panel that renders visibly broken is the last place a reader will
 * believe what it says about their data being safe.
 */
export const describeStorage = (r: StorageReport): string => {
  const size = r.usage === null ? '' : `Using ${formatBytes(r.usage)}`;
  const of = r.quota === null || r.quota <= 0 ? '' : ` of ${formatBytes(r.quota)} available`;
  const measured = size ? `${size}${of}. ` : '';

  if (r.durability === 'unsupported') {
    return `${measured}This browser will not say whether it keeps stored data. Keep a backup.`;
  }
  if (r.durability === 'persisted') {
    return `${measured}This browser has been asked to keep your library and agreed — `
      + 'only you can clear it.';
  }
  return `${measured}This browser has NOT promised to keep your library: it can be `
    + 'cleared when the device runs low on space.';
};

/* ------------------------------------------------------------------ */
/* The two calls that touch the browser                                */
/* ------------------------------------------------------------------ */

const api = (): StorageManager | null => {
  try {
    return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
  } catch { return null; }
};

/**
 * Read the current state. Prompts nothing; safe to call on load.
 *
 * Every branch is guarded because this runs in a Tauri webview, a private
 * window, and an http:// dev server, and the Storage API is absent or partial
 * in all three. A report that could throw would take down whatever rendered it.
 */
export const readStorageReport = async (): Promise<StorageReport> => {
  const storage = api();
  if (!storage) return { durability: 'unsupported', usage: null, quota: null, pressure: 'unknown' };

  let durability: Durability = 'best-effort';
  try {
    durability = typeof storage.persisted === 'function' && await storage.persisted()
      ? 'persisted'
      : 'best-effort';
  } catch { durability = 'unsupported'; }

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (typeof storage.estimate === 'function') {
      const e = await storage.estimate();
      usage = typeof e.usage === 'number' ? e.usage : null;
      quota = typeof e.quota === 'number' ? e.quota : null;
    }
  } catch { /* an estimate is a nicety; its absence is not a failure */ }

  return { durability, usage, quota, pressure: pressureOf(usage, quota) };
};

/**
 * Ask the browser to keep this library. May prompt — call it on a real moment.
 *
 * Returns the durability AFTER asking, so a caller can report the outcome
 * honestly instead of assuming the request worked. A `false` here is not a
 * permanent no: Chrome re-evaluates as the reader uses the app more.
 */
export const askForPersistence = async (): Promise<Durability> => {
  const storage = api();
  if (!storage || typeof storage.persist !== 'function') return 'unsupported';
  try {
    return await storage.persist() ? 'persisted' : 'best-effort';
  } catch {
    return 'unsupported';
  }
};
