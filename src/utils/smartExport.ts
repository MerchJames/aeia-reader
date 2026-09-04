/**
 * Choosing what goes into an export, and putting a cover on it.
 *
 * ── Why a selection step exists at all ─────────────────────────────────────
 *
 * Every export in this app took the whole story. That is right for a backup and
 * wrong for nearly everything else somebody actually wants a file for: the
 * character's lines without your own prompts, a single chapter to send someone,
 * the story with the out-of-character asides taken out. Doing any of those
 * meant exporting everything and editing it by hand afterwards, which is a
 * strange place to leave a reader who has spent an hour marking the text up.
 *
 * So: one description of WHAT, applied identically by every format. The same
 * selection produces the markdown, the page and the chat file, so "just the
 * character" means the same thing in all three rather than three times.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 *
 * It does not touch the story. A selection is a filter applied on the way out;
 * nothing here writes, and dropping the user's turns from an export does not
 * drop them from the library. That is the whole reason it is safe to offer.
 *
 * Pure: no store, no React, no DOM, no fetch. The AI reformat pass and the file
 * writing live with their callers.
 */

import type { Message, Story } from '../types';

/** Whose turns to keep. */
export type SpeakerFilter = 'all' | 'ai' | 'user';

export interface ExportSelection {
  speakers: SpeakerFilter;
  /** Keep the entries SillyTavern marked `/hide` or system. */
  includeHidden: boolean;
  /** Keep `[OOC: …]` / `((OOC: …))` asides. */
  includeOoc: boolean;
  /** Keep the model's chain of thought, where the chat file recorded one. */
  includeReasoning: boolean;
  /**
   * Chapters to keep, by index, or null for all of them.
   *
   * Indices rather than ids because the reader picks them off a numbered list,
   * and a chapter has no identity of its own that survives a re-import.
   */
  chapters: number[] | null;
}

export const DEFAULT_SELECTION: ExportSelection = {
  speakers: 'all',
  includeHidden: false,
  includeOoc: true,
  includeReasoning: false,
  chapters: null,
};

/* ------------------------------------------------------------------ */
/* Choosing                                                            */
/* ------------------------------------------------------------------ */

/** Every `[OOC: …]`, `((OOC: …))` or `(OOC: …)` aside, whole. */
const OOC_RE = /\(\(\s*OOC[:\s][\s\S]*?\)\)|\[\s*OOC[:\s][\s\S]*?\]|\(\s*OOC[:\s][^)]*\)/gi;

/** Is there anything left of this passage once the asides are gone? */
export const stripOoc = (text: string): string =>
  text.replace(OOC_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * The messages an export should contain, in order.
 *
 * A message dropped for one reason is dropped once — the filters are applied in
 * a single pass, and a passage that becomes empty because its only content was
 * an OOC aside is dropped rather than exported blank. The alternative is a file
 * with a speaker name and nothing under it, which reads as a bug in the export
 * rather than as the reader's own choice.
 */
export const selectMessages = (
  messages: readonly Message[], selection: ExportSelection,
): Message[] => {
  const out: Message[] = [];
  for (const msg of messages) {
    if (!selection.includeHidden && msg.hidden) continue;
    if (selection.speakers === 'ai' && msg.role !== 'ai') continue;
    if (selection.speakers === 'user' && msg.role !== 'user') continue;

    const content = selection.includeOoc ? msg.content : stripOoc(msg.content);
    // Nothing but an aside, and the asides are off: there is no passage here.
    if (!content.trim() && !(msg.images?.length)) continue;

    out.push({
      ...msg,
      content,
      reasoning: selection.includeReasoning ? msg.reasoning : undefined,
    });
  }
  return out;
};

/** Chapter boundaries, as the reader sees them numbered in the picker. */
export interface ChapterRef {
  index: number;
  title: string;
  from: number;
  to: number;
  count: number;
}

/**
 * The story's chapters, derived the way `buildChains` derives them.
 *
 * Duplicated deliberately rather than imported: `buildChains` lives in the
 * store, needs a format and star settings, and returns render-ready chains. All
 * this needs is "where does each chapter start", and importing the store into a
 * pure module to get it would make this untestable for one boolean.
 */
export const chaptersOf = (story: Pick<Story, 'messages' | 'format'>): ChapterRef[] => {
  const out: ChapterRef[] = [];
  story.messages.forEach((msg, i) => {
    const starts = i === 0 || msg.role === 'user' || story.format === 'kobold' || msg.startsChain;
    if (starts || !out.length) {
      out.push({
        index: out.length,
        title: (msg.content.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? msg.name ?? '').trim()
          || `Chapter ${out.length + 1}`,
        from: i,
        to: i,
        count: 1,
      });
      return;
    }
    const last = out[out.length - 1];
    last.to = i;
    last.count++;
  });
  return out;
};

/** The story narrowed to the chosen chapters, before the message filters. */
export const selectChapters = (
  messages: readonly Message[], chapters: ChapterRef[], wanted: number[] | null,
): Message[] => {
  if (!wanted) return [...messages];
  const keep = new Set(wanted);
  const out: Message[] = [];
  chapters.forEach(c => {
    if (!keep.has(c.index)) return;
    for (let i = c.from; i <= c.to; i++) out.push(messages[i]);
  });
  return out;
};

/** Everything a selection produces, applied in the right order. */
export const applySelection = (
  story: Pick<Story, 'messages' | 'format'>, selection: ExportSelection,
): Message[] => selectMessages(
  selectChapters(story.messages, chaptersOf(story), selection.chapters),
  selection,
);

/** A line the reader can read before they commit: what is in, what is out. */
export const describeSelection = (
  total: number, kept: readonly Message[], selection: ExportSelection,
): string => {
  const parts = [`${kept.length} of ${total} passage${total === 1 ? '' : 's'}`];
  if (selection.speakers === 'ai') parts.push('the character only');
  if (selection.speakers === 'user') parts.push('your turns only');
  if (!selection.includeOoc) parts.push('OOC removed');
  if (selection.includeHidden) parts.push('hidden included');
  if (selection.includeReasoning) parts.push('thinking included');
  if (selection.chapters) {
    parts.push(`${selection.chapters.length} chapter${selection.chapters.length === 1 ? '' : 's'}`);
  }
  const words = kept.reduce((n, m) => n + (m.content.trim() ? m.content.trim().split(/\s+/).length : 0), 0);
  parts.push(`~${words.toLocaleString()} words`);
  return parts.join(' · ');
};

/* ------------------------------------------------------------------ */
/* The cover                                                           */
/* ------------------------------------------------------------------ */

/*
 * There is no cover builder here, and that is deliberate.
 *
 * `htmlExport.ts` already renders one: a full-height title page in the
 * storybook layout, with the Aeia mark, the cover art or a lettered plate, the
 * byline, the measure of the story and a dateline — and a `break-after: page`
 * under `@media print`, so Print → Save as PDF already produces a real title
 * page rather than a heading with prose under it.
 *
 * A second cover written here would have been a rival to it: two title pages
 * to keep in step, diverging the first time either was touched. The only thing
 * the reader could not say was a line of their own under the title, so that is
 * the only thing that was added — `coverSubtitle`, over there, where the cover
 * lives.
 */

/** A line of the reader's own for the title page, trimmed and bounded. */
export const coverSubtitle = (raw: string): string | undefined => {
  const text = raw.trim().replace(/\s+/g, ' ');
  // Long enough for a real subtitle, short enough that it cannot push the
  // title off a printed page.
  return text ? text.slice(0, 120) : undefined;
};
