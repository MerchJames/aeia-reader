/**
 * A pin with pages: the dock's answer to "these forty notes are one thing".
 *
 * ── Why pages, when pins already have versions ─────────────────────────────
 *
 * They answer different questions, and conflating them was the temptation
 * worth resisting. A VERSION is the same document, again — the second draft of
 * one note, with the first still reachable. A PAGE is a different document that
 * belongs with the others: entry eleven of a journal, the third of five charts,
 * one summary in a run of them. Nobody wants the tenth journal entry to be
 * "version 10" of the first, because that says the first was superseded, and it
 * was not — it was Tuesday.
 *
 * So a pin becomes a small book, and every page keeps its own history. The
 * reader's answer when asked (see the session that introduced this): pages own
 * their versions.
 *
 * ── Back-compatibility, which is the whole design constraint ───────────────
 *
 * Every pin in every reader's library today is a single `content` string with
 * an optional `versions` array. Nothing may migrate, because a migration that
 * runs on load is a migration that can lose a reader's notes on a bad day.
 *
 * So a pin WITHOUT `pages` is a one-page book, and `pageAt(pin, 0)` reads it
 * out of the legacy fields. `pages` appears only when a second page is added,
 * and even then `pin.content` keeps mirroring the ACTIVE page — so the dock's
 * renderer, the AI context builder, the export and the Cut all keep working
 * without knowing pages exist. The one place that had to learn is the thing
 * that shows a book AS a book.
 *
 * Pure: no store, no React, no IDB.
 */

import type { Pin, PinVersion } from '../types';

/** Pages past this and the dock card is a filing cabinet, not a note. */
export const MAX_PIN_PAGES = 60;

export interface PinPage {
  id: string;
  /** The reader's name for this page. Falls back to a number in the UI. */
  title?: string;
  /** What the page currently shows — mirrors `versions[activeVersion]`. */
  content: string;
  /** Version history for THIS page. Absent until it is first edited. */
  versions?: PinVersion[];
  activeVersion?: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Reading a pin as a book                                             */
/* ------------------------------------------------------------------ */

/** Is this pin a book, or a single note? */
export const isBook = (pin: Pin): boolean => (pin.pages?.length ?? 0) > 1;

/**
 * The pin's pages, whether or not it has any.
 *
 * A pin with no `pages` is not page-less — it is a book of one, whose single
 * page lives in the legacy fields. Every reader below goes through here so
 * that "has pages" is never a branch anyone has to remember to write.
 */
export const pagesOf = (pin: Pin): PinPage[] =>
  pin.pages?.length
    ? pin.pages
    : [{
      id: `${pin.id}-p0`,
      content: pin.content,
      versions: pin.versions,
      activeVersion: pin.activeVersion,
      createdAt: pin.createdAt,
    }];

/** Which page is showing, clamped — a stored index can outlive its page. */
export const activePageIndex = (pin: Pin): number => {
  const n = pagesOf(pin).length;
  const at = pin.activePage ?? 0;
  return Number.isInteger(at) && at >= 0 && at < n ? at : 0;
};

export const activePage = (pin: Pin): PinPage => pagesOf(pin)[activePageIndex(pin)];

/** A page's display name: what the reader called it, else its number. */
export const pageLabel = (page: PinPage, index: number): string =>
  page.title?.trim() || `Page ${index + 1}`;

/**
 * The whole book as one document, for anything that reads a pin as TEXT.
 *
 * The AI context is the case that matters: a journal put in context should be
 * the journal, not whichever entry the reader happens to be looking at. Pages
 * are separated by a rule and headed by their name, so the model can tell
 * eleven entries from one long one — the same reason the transcript blocks in
 * `contextZone` carry their own headings.
 */
export const bookText = (pin: Pin): string => {
  const pages = pagesOf(pin);
  if (pages.length === 1) return pages[0].content;
  return pages
    .map((p, i) => `## ${pageLabel(p, i)}\n\n${p.content}`)
    .join('\n\n---\n\n');
};

/* ------------------------------------------------------------------ */
/* Editing a page by hand                                              */
/* ------------------------------------------------------------------ */

/** Versions past this are dropped, oldest first — but never the original. */
export const MAX_PAGE_VERSIONS = 12;

/**
 * A hand edit, folded into the page's history.
 *
 * ── Why this is not just "append a version" ────────────────────────────────
 *
 * Because typing is not drafting. An AI revision is a discrete act — you asked
 * for a rewrite, you got one, and being able to step back to the one before it
 * is the whole point of keeping them. Hand-editing is not like that: it is
 * fiddling with a sentence, saving, reading it, fixing a word, saving again. A
 * version per save turns a twelve-slot history into twelve near-identical
 * copies of the last five minutes and pushes everything worth keeping off the
 * end of it.
 *
 * So a hand edit does exactly one thing that grows the history, and only ever
 * once: it PRESERVES what was there before it. After that, editing by hand
 * writes over your own working copy.
 *
 *   nothing yet   → seed `original` from the current text, then add the edit.
 *                   Two versions, and the pin as it arrived is safe for good.
 *   on a `manual` → overwrite it. This is the same edit, continued.
 *   on `original`
 *   or an `ai`    → add a `manual` version. Neither the pin as it arrived nor a
 *                   revision you asked for is ever written over by typing.
 *
 * An edit that changes nothing does nothing at all, so clicking into a page and
 * back out cannot spend a version slot.
 */
export const applyManualEdit = (
  page: PinPage, content: string, now = Date.now(),
): PinPage => {
  if (content === page.content) return page;

  const at = page.activeVersion ?? ((page.versions?.length ?? 1) - 1);
  const current = page.versions?.[at];

  // Continuing your own edit: replace it where it stands.
  if (page.versions?.length && current?.source === 'manual') {
    const versions = page.versions.map((v, i) =>
      (i === at ? { ...v, content, createdAt: now } : v));
    return { ...page, versions, activeVersion: at, content };
  }

  /*
   * Writing a blank page for the first time is not an edit of anything.
   *
   * "Add page" hands the reader an empty one, so banking its emptiness as the
   * `original` would give every written-from-scratch page a version history
   * whose first entry is nothing — and a version switcher offering to go back
   * to it. A page gains a history when there is something to preserve.
   */
  if (!page.versions?.length && !page.content.trim()) {
    return { ...page, content };
  }

  // First edit of a page that has no history: the text it has now becomes the
  // original, and is never written over again.
  const base: PinVersion[] = page.versions?.length
    ? page.versions
    : [{ content: page.content, source: 'original', createdAt: page.createdAt }];

  const all: PinVersion[] = [...base, { content, source: 'manual', createdAt: now }];
  // Trim to the cap but always keep the original (index 0) — it is the one
  // version that cannot be reproduced by editing.
  const versions = all.length > MAX_PAGE_VERSIONS
    ? [all[0], ...all.slice(all.length - (MAX_PAGE_VERSIONS - 1))]
    : all;
  return { ...page, versions, activeVersion: versions.length - 1, content };
};

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The pin with `pages` made explicit — the one-time promotion to a book.
 *
 * Idempotent, and never called on read: a pin is promoted the moment the reader
 * does something that only a book can express, and not before, so a library of
 * plain notes stays a library of plain notes on disk.
 */
export const withPages = (pin: Pin): Pin =>
  (pin.pages?.length ? pin : { ...pin, pages: pagesOf(pin), activePage: 0 });

/**
 * Put `content` and the legacy version fields back in step with the active page.
 *
 * This is the compatibility contract in one function. Everything that reads a
 * pin without knowing about pages — the dock renderer, `pinsToPromptBlock`, the
 * Cut, the export — reads `content`, so it must always BE something true.
 * Forgetting this is silent: the reader turns a page and the dock keeps
 * rendering the old one.
 */
export const syncActive = (pin: Pin): Pin => {
  const pages = pagesOf(pin);
  const at = activePageIndex(pin);
  const page = pages[at];
  return {
    ...pin,
    activePage: pin.pages?.length ? at : pin.activePage,
    content: page.content,
    versions: page.versions,
    activeVersion: page.activeVersion,
  };
};

/** Replace one page, keeping the mirrored fields honest. */
export const patchPage = (
  pin: Pin, index: number, patch: Partial<PinPage>,
): Pin => {
  const promoted = withPages(pin);
  const pages = (promoted.pages ?? []).map((p, i) => (i === index ? { ...p, ...patch } : p));
  return syncActive({ ...promoted, pages });
};

/** Add a page after the last one and turn to it. */
export const addPage = (
  pin: Pin, page: { id: string; title?: string; content: string; createdAt: number },
): Pin => {
  const promoted = withPages(pin);
  const pages = [...(promoted.pages ?? []), page];
  if (pages.length > MAX_PIN_PAGES) pages.splice(0, pages.length - MAX_PIN_PAGES);
  return syncActive({ ...promoted, pages, activePage: pages.length - 1 });
};

/**
 * Remove a page.
 *
 * Removing the last remaining page is refused rather than emptying the pin: a
 * pin with no pages has nothing to render and no way back, and "delete the
 * pin" is a different, clearly-labelled action the reader already has.
 */
export const removePage = (pin: Pin, index: number): Pin => {
  const promoted = withPages(pin);
  const pages = (promoted.pages ?? []).filter((_, i) => i !== index);
  if (!pages.length) return pin;
  const at = activePageIndex(promoted);
  return syncActive({
    ...promoted,
    pages,
    // Stay where the reader was looking: on the page that slid into this slot,
    // or the new last one if they deleted the end.
    activePage: Math.min(at > index ? at - 1 : at, pages.length - 1),
  });
};

/** Move a page one place through the book, following it with the view. */
export const movePage = (pin: Pin, index: number, direction: -1 | 1): Pin => {
  const promoted = withPages(pin);
  const pages = [...(promoted.pages ?? [])];
  const to = index + direction;
  if (to < 0 || to >= pages.length) return pin;
  [pages[index], pages[to]] = [pages[to], pages[index]];
  return syncActive({ ...promoted, pages, activePage: to });
};

/** Turn to a page. Out-of-range indexes are ignored, not clamped silently. */
export const turnTo = (pin: Pin, index: number): Pin => {
  const pages = pagesOf(pin);
  if (index < 0 || index >= pages.length) return pin;
  return syncActive({ ...withPages(pin), activePage: index });
};

/**
 * Fold one pin into another as extra pages.
 *
 * The "toss a bunch of journal entries into one pin" move. The source's pages
 * arrive in order and keep their own histories; its title becomes the heading
 * of its first page, because a note that was called something is a page that
 * should still be called it.
 *
 * The caller deletes the source — this is pure, and a merge that consumed its
 * argument would be untestable and unpickable-apart.
 */
export const mergeInto = (target: Pin, source: Pin, nextId: () => string): Pin => {
  const incoming = pagesOf(source).map((p, i) => ({
    ...p,
    id: nextId(),
    title: p.title ?? (i === 0 ? source.title : undefined),
  }));
  const promoted = withPages(target);
  const pages = [...(promoted.pages ?? []), ...incoming].slice(0, MAX_PIN_PAGES);
  return syncActive({ ...promoted, pages, activePage: (promoted.pages ?? []).length });
};

/**
 * Hand-edit the page currently on show.
 *
 * The pin-level door to `applyManualEdit`, so the store never has to know
 * which page is active or how to keep the mirrored fields honest.
 */
export const editActivePage = (pin: Pin, content: string, now = Date.now()): Pin => {
  const at = activePageIndex(pin);
  const edited = applyManualEdit(activePage(pin), content, now);
  if (edited === activePage(pin)) return pin;
  return patchPage(pin, at, edited);
};
