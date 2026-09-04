/**
 * Somewhere for bad news to go.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * This app had no way to tell the reader anything. Every failure path ended at
 * `console.error`, which no reader has ever opened. That is survivable for a
 * cosmetic glitch and not survivable for the two failures this app can actually
 * have, both of which are about the reader's work:
 *
 *   **The library could not be read.** `loadV2` catches, logs, and returns an
 *   empty bag — so a reader whose IndexedDB is unreadable sees an empty app and
 *   is told nothing. Every highlight and note they ever made appears to be
 *   gone, and the true cause never reaches them.
 *
 *   **A write did not land.** Quota exceeded, storage evicted, a transaction
 *   aborted. The reader carries on annotating a story that is no longer being
 *   saved, and finds out on the next reload.
 *
 * Both are silent, both look exactly like the app losing their work, and
 * neither can be fixed by a reader who is not told. So: a place to say so.
 *
 * ── Three rules the shape enforces ─────────────────────────────────────────
 *
 * **Anything about work not being saved is sticky.** A four-second toast for
 * "your notes are not being saved" is worse than saying nothing, because it
 * gives the appearance of having been told. `danger` never auto-dismisses.
 *
 * **Repeats collapse.** A failing write fires on every keystroke. Without
 * collapsing, the first real message is buried under four hundred copies of
 * itself — so a `key` replaces its predecessor in place and counts up.
 *
 * **Nothing here throws, and nothing here is required.** A subscriber that
 * throws cannot take down the caller, because the callers are storage writes in
 * the middle of saving the reader's work.
 *
 * Pure list operations, plus a small emitter. No React, no store, no DOM — so
 * `lib/` and `store.ts` can both report through it without a cycle.
 */

export type AlertTone = 'info' | 'warn' | 'danger';

export interface Alert {
  id: string;
  tone: AlertTone;
  /** One line, in the reader's terms. */
  title: string;
  /** Optional second line: what to do about it. */
  detail?: string;
  /**
   * Collapse key. A second alert with the same key replaces the first and
   * increments `count` rather than stacking.
   */
  key?: string;
  count: number;
  at: number;
  /** Never auto-dismisses. Always true for `danger`. */
  sticky: boolean;
}

export interface AlertSpec {
  tone: AlertTone;
  title: string;
  detail?: string;
  key?: string;
  /** Force stickiness on a non-danger alert. Danger is sticky regardless. */
  sticky?: boolean;
}

/**
 * How many alerts are kept at once.
 *
 * Small on purpose. This is a notification surface, not a log: if seven things
 * have gone wrong the reader needs the most recent one legible, not all seven
 * competing. The oldest DISMISSIBLE one is dropped first, so a sticky warning
 * about unsaved work cannot be pushed out by a run of routine notices.
 */
export const MAX_ALERTS = 4;

/** How long a dismissible alert stays up. */
export const ALERT_TTL_MS = 6000;

let seq = 0;
const newId = () => `a${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Add an alert to a list, collapsing a repeat of the same `key`.
 *
 * Returns a NEW list; the input is never mutated. A collapsed repeat keeps its
 * original id — the row on screen is the same row, so it does not re-animate in
 * and re-draw the reader's eye every time a failing write retries.
 */
export const pushAlert = (list: readonly Alert[], spec: AlertSpec): Alert[] => {
  const sticky = spec.tone === 'danger' || spec.sticky === true;

  if (spec.key) {
    const at = list.findIndex(a => a.key === spec.key);
    if (at !== -1) {
      const prev = list[at];
      const next = [...list];
      next[at] = {
        ...prev,
        tone: spec.tone,
        title: spec.title,
        detail: spec.detail,
        count: prev.count + 1,
        at: Date.now(),
        sticky,
      };
      return next;
    }
  }

  const added: Alert = {
    id: newId(),
    tone: spec.tone,
    title: spec.title,
    detail: spec.detail,
    key: spec.key,
    count: 1,
    at: Date.now(),
    sticky,
  };
  return trimAlerts([...list, added]);
};

/**
 * Enforce the cap, dropping the oldest DISMISSIBLE alert first.
 *
 * A sticky alert is only ever dropped when there is nothing else to drop, and
 * even then the newest sticky ones are kept — an unheeded warning about unsaved
 * work must outlive a stack of "exported" notices.
 */
export const trimAlerts = (list: readonly Alert[]): Alert[] => {
  if (list.length <= MAX_ALERTS) return [...list];
  const next = [...list];
  while (next.length > MAX_ALERTS) {
    const victim = next.findIndex(a => !a.sticky);
    next.splice(victim === -1 ? 0 : victim, 1);
  }
  return next;
};

export const dropAlert = (list: readonly Alert[], id: string): Alert[] =>
  list.filter(a => a.id !== id);

/**
 * Drop everything that has timed out. Sticky alerts never time out.
 *
 * `now` is a parameter so this is testable without waiting six seconds, and so
 * a caller can sweep on a timer it already owns rather than one per alert.
 */
export const expireAlerts = (list: readonly Alert[], now = Date.now()): Alert[] =>
  list.filter(a => a.sticky || now - a.at < ALERT_TTL_MS);

/* ------------------------------------------------------------------ */
/* The emitter                                                         */
/* ------------------------------------------------------------------ */

type Listener = (spec: AlertSpec) => void;
const listeners = new Set<Listener>();

/**
 * Raise an alert from anywhere, including code that must not know about React.
 *
 * With nothing listening this is a no-op that still logs, so a failure during
 * startup — before the host has mounted — is not lost entirely.
 */
export const raiseAlert = (spec: AlertSpec): void => {
  if (spec.tone !== 'info') {
    const line = spec.detail ? `${spec.title} — ${spec.detail}` : spec.title;
    if (spec.tone === 'danger') console.error(`[aeia] ${line}`);
    else console.warn(`[aeia] ${line}`);
  }
  for (const fn of listeners) {
    // A broken listener must not propagate. These calls happen inside storage
    // writes; throwing here would turn "we could not tell you" into "and the
    // save that was trying to tell you also failed".
    try { fn(spec); } catch { /* a listener is not allowed to break a save */ }
  }
};

export const onAlert = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** Test seam. Never called by the app. */
export const _resetAlertListeners = (): void => { listeners.clear(); };

/* ------------------------------------------------------------------ */
/* The two that matter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Named helpers for the storage failures, so the wording is written once.
 *
 * These are the sentences a reader actually sees at the worst moment they will
 * have with this app, and they are worth getting right in one place rather than
 * approximating at each of the dozen call sites. Each says what happened, what
 * it means for their work, and what to do — in that order.
 */
export const alertSaveFailed = (what: string): void => raiseAlert({
  tone: 'danger',
  title: 'Your work is not being saved',
  detail: `This device would not store ${what}. Back up your library from Settings, `
    + 'then free some space or allow this site to keep data.',
  key: 'save-failed',
});

export const alertLoadFailed = (): void => raiseAlert({
  tone: 'danger',
  title: 'Your library could not be read',
  detail: 'Nothing has been deleted — this device would not open its own storage. '
    + 'Reload before importing anything, so a restore does not write over what is there.',
  key: 'load-failed',
});

export const alertEvictable = (): void => raiseAlert({
  tone: 'warn',
  title: 'This browser may delete your library',
  detail: 'It has not been granted permanent storage, so it can be cleared when the '
    + 'device runs low on space. Keep a backup from Settings.',
  key: 'not-persisted',
});
