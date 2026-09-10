/**
 * Peek — reading the small print, at reading speed.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * Settings is full of long explanations set at 11px in muted grey, because
 * anything louder competes with the control it belongs to. So the longest and
 * most useful text in the app is the text least likely to be read.
 *
 * ── Why a mode and not a button per paragraph ─────────────────────────────
 *
 * The first cut put a small reader under each paragraph. That worked and was
 * wrong: it changed the SPACING of the thing it was helping with, so the help
 * no longer looked like the help beside it, and it only ever covered the three
 * paragraphs somebody had wrapped by hand.
 *
 * A mode fixes both. Nothing about the text changes — it is not wrapped, not
 * marked, not moved — and "eligible" is decided by looking at what was clicked
 * rather than by a list somebody has to maintain. Any block of real prose
 * anywhere in the app qualifies, which is what "eventually all text" means
 * without a migration.
 *
 * Framework-free, same shape as `aiActivity` and `proxyLink`: a snapshot, a
 * publish, a subscribe.
 */

export interface PeekState {
  /** Is peek mode on? While it is, clicking prose reads it. */
  active: boolean;
  /** What is being read right now. */
  text: string;
}

let snapshot: PeekState = { active: false, text: '' };
const listeners = new Set<(s: PeekState) => void>();

const publish = (next: PeekState) => {
  snapshot = next;
  for (const l of listeners) l(snapshot);
};

export const peekState = (): PeekState => snapshot;

export const subscribePeek = (fn: (s: PeekState) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const setPeekActive = (active: boolean): void => {
  publish(active ? { ...snapshot, active } : { active: false, text: '' });
};

export const showPeek = (text: string): void => {
  publish({ active: true, text });
};

/** Shortest run of text worth opening a panel for. */
const MIN_CHARS = 40;

/** Things whose text is a label, not prose. */
const CONTROL = 'button, a, input, select, textarea, [role="button"], [contenteditable]';

/**
 * The prose the reader just clicked, or null.
 *
 * Walks UP from the clicked node looking for the first element that holds a
 * real run of text. Upward rather than down, because a click lands on the
 * deepest node — often a `<b>` in the middle of a sentence — and the thing the
 * reader meant is the sentence.
 *
 * Refuses controls outright. A button's text is its name; reading it aloud in a
 * panel is answering a question nobody asked, and it would make every click in
 * peek mode do something.
 */
export const proseAt = (start: Element | null): string | null => {
  let el: Element | null = start;
  for (let hops = 0; el && hops < 6; hops++, el = el.parentElement) {
    if (el.closest(CONTROL)) return null;
    const text = (el as HTMLElement).innerText?.trim() ?? '';
    if (text.length >= MIN_CHARS) return text;
  }
  return null;
};
