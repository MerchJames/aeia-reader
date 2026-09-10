/**
 * Where the reader's attention is, without looking at the screen.
 *
 * ── Why no vision, and why this is enough ──────────────────────────────────
 *
 * The obvious way to let an assistant know what the reader is looking at is to
 * screenshot the app. That is expensive, slow, needs a multimodal model, and
 * hands a picture of somebody's private story to a service every time they ask
 * a question.
 *
 * It is also unnecessary here, because this app already labels its own
 * interface. The guided tours anchor on `data-tour` attributes, which exist on
 * every part worth pointing at and are MAINTAINED — a part that gets renamed
 * breaks a tour, so they stay honest. That is a semantic map of the UI, kept up
 * to date for another reason entirely, and reading it costs nothing.
 *
 * ── Sampled, never streamed ────────────────────────────────────────────────
 *
 * `watchPointer` records only the last place the pointer rested, in a module
 * variable, and only while the guide is switched on. Nothing is sent anywhere
 * until a tool asks — a feature that shipped the reader's cursor to a model
 * continuously would be both wasteful and unpleasant, and this is the version
 * that is neither.
 */

/** How long the pointer has to rest before it counts as "looking at". */
const SETTLE_MS = 220;

export interface UiSpot {
  /** The `data-tour` anchor — the app's own name for that part. */
  anchor?: string;
  /** Something a person would call it: the accessible name, or the text on it. */
  label?: string;
  /** What kind of thing it is, when it is obvious. */
  role?: string;
}

let spot: UiSpot | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Name an element the way the reader would.
 *
 * The anchor is the app's own word for the region; the label is what is written
 * on the control under the pointer. Both, because "settings-sync" tells the
 * assistant where they are and "Two-way sync" tells it what they are touching.
 */
export const describeSpot = (el: Element | null): UiSpot | null => {
  if (!el) return null;
  const anchorEl = el.closest('[data-tour]');
  const anchor = anchorEl?.getAttribute('data-tour') ?? undefined;

  // The nearest thing that is actually a control, so hovering a button's icon
  // reports the button.
  const control = el.closest('button, a, input, select, textarea, [role="button"], label');
  const named = (control ?? el) as HTMLElement;
  const label = (
    named.getAttribute?.('aria-label')
    || named.getAttribute?.('title')
    || named.innerText?.trim().split('\n')[0]
    || ''
  ).slice(0, 60) || undefined;

  const role = control
    ? (control.getAttribute('role') ?? control.tagName.toLowerCase())
    : undefined;

  if (!anchor && !label) return null;
  return { ...(anchor ? { anchor } : {}), ...(label ? { label } : {}), ...(role ? { role } : {}) };
};

/** What the pointer last settled on, or null. */
export const pointingAt = (): UiSpot | null => spot;

/**
 * Start watching. Returns the stop function.
 *
 * Settled position only — following every mousemove would record whatever the
 * pointer crossed on its way somewhere, which is noise dressed as intent.
 */
export const watchPointer = (target: Document | HTMLElement = document): (() => void) => {
  const onMove = (e: Event) => {
    if (timer) clearTimeout(timer);
    const el = e.target as Element | null;
    timer = setTimeout(() => { spot = describeSpot(el); }, SETTLE_MS);
  };
  // Focus counts too: a keyboard reader never moves a pointer, and they are
  // exactly as entitled to be asked "what is this".
  const onFocus = (e: Event) => { spot = describeSpot(e.target as Element | null); };

  target.addEventListener('mousemove', onMove, { passive: true });
  target.addEventListener('focusin', onFocus, { passive: true } as AddEventListenerOptions);
  return () => {
    if (timer) clearTimeout(timer);
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('focusin', onFocus);
    spot = null;
  };
};

/** For tests, and for switching the guide off. */
export const resetPointer = (): void => { spot = null; };
