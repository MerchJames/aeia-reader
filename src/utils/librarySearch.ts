/**
 * Finding a story again, once there are hundreds of them.
 *
 * Two searches, deliberately separate, because they cost wildly different
 * amounts:
 *
 *  - **Shallow** (`filterStories`) runs on every keystroke over the library's
 *    metadata — titles, characters, tags. All of it is already in memory, so
 *    this is free.
 *  - **Deep** (`searchAllStories`) reads the message text of every story out of
 *    IndexedDB one at a time. That is the expensive thing this module exists to
 *    keep OFF the boot path and off the keystroke path: it runs only when asked
 *    for, streams its results, and stops the moment it is cancelled.
 *
 * The deep search reuses `buildSearchIndex`/`searchStory` per story rather than
 * inventing a second matching rule, so a hit found from the library and a hit
 * found inside the reader mean the same thing.
 */

import type { Story, StoryFormat, StoryMeta } from '../types';
import { MIN_QUERY, SearchHit, buildSearchIndex, searchStory } from './storySearch';

export type LibrarySort = 'lastRead' | 'imported' | 'title' | 'progress';

export const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: 'lastRead', label: 'Last read' },
  { id: 'imported', label: 'Recently added' },
  { id: 'title', label: 'Title' },
  { id: 'progress', label: 'Progress' },
];

/** Just the bit of `StoryStats` sorting needs, so this module stays pure. */
export interface ReadStamp { lastReadAt?: number }

export interface LibraryFilter {
  query?: string;
  /** Every tag here must be present (AND) — narrowing, not widening. */
  tags?: string[];
  /**
   * `'synced'` is not a format — it is the stories kept in step with a
   * SillyTavern chat, which is a RELATIONSHIP rather than a file type. It sits
   * in the same control because from the reader's side it answers the same
   * question ("which of these are which?"), and because a synced chat is always
   * `sillytavern` anyway, so a second filter alongside would only ever be used
   * one at a time.
   */
  format?: StoryFormat | 'all' | 'synced';
}

/** Is this story kept in step with a SillyTavern chat? */
export const isSynced = (meta: StoryMeta): boolean => !!meta.stChatId;

/** Tags shown for a story: the reader's if they have set any, else the card's. */
export const tagsFor = (
  meta: StoryMeta,
  userTags: Record<string, string[]> | undefined,
): string[] => userTags?.[meta.id] ?? meta.tags ?? [];

/** Every tag in use across the library, most-used first, for the filter bar. */
export const allTags = (
  metas: StoryMeta[],
  userTags: Record<string, string[]> | undefined,
): { tag: string; count: number }[] => {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const m of metas) {
    for (const t of tagsFor(m, userTags)) {
      const key = t.toLowerCase();
      const found = counts.get(key);
      if (found) found.count++;
      else counts.set(key, { tag: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

/**
 * The instant pass. Matches a title, a character or user name, or a tag —
 * everything the library already holds. Message text needs the deep search.
 */
export const filterStories = (
  metas: StoryMeta[],
  filter: LibraryFilter,
  userTags?: Record<string, string[]>,
): StoryMeta[] => {
  const q = (filter.query ?? '').trim().toLowerCase();
  const wanted = (filter.tags ?? []).map(t => t.toLowerCase());
  const format = filter.format ?? 'all';

  return metas.filter(m => {
    if (format === 'synced') { if (!isSynced(m)) return false; }
    else if (format !== 'all' && m.format !== format) return false;

    if (wanted.length) {
      const have = new Set(tagsFor(m, userTags).map(t => t.toLowerCase()));
      if (!wanted.every(t => have.has(t))) return false;
    }

    if (!q) return true;
    if (m.title.toLowerCase().includes(q)) return true;
    if (m.characterName?.toLowerCase().includes(q)) return true;
    if (m.userName?.toLowerCase().includes(q)) return true;
    return tagsFor(m, userTags).some(t => t.toLowerCase().includes(q));
  });
};

/**
 * Sorting is stable and never leaves a story unreachable at the bottom of an
 * arbitrary order: every comparator falls back to `importedAt`.
 */
export const sortStories = (
  metas: StoryMeta[],
  sort: LibrarySort,
  stats?: Record<string, ReadStamp>,
): StoryMeta[] => {
  // Tie-break on id. A batch import stamps every story with the same
  // `Date.now()`, and without a tie-break their order came out of whatever the
  // input array happened to be — which differs between the in-memory list and
  // the one read back from IndexedDB, so the shelf reshuffled on reload.
  const byImport = (a: StoryMeta, b: StoryMeta) =>
    b.importedAt - a.importedAt || a.id.localeCompare(b.id);
  const copy = [...metas];

  switch (sort) {
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title) || byImport(a, b));
    case 'progress':
      return copy.sort((a, b) => (b.progressPct ?? 0) - (a.progressPct ?? 0) || byImport(a, b));
    case 'lastRead':
      // Never-opened stories sort below every story that has been read, rather
      // than jumbling in among them with a timestamp of 0.
      return copy.sort((a, b) => {
        const ra = stats?.[a.id]?.lastReadAt ?? 0;
        const rb = stats?.[b.id]?.lastReadAt ?? 0;
        if (ra !== rb) return rb - ra;
        return byImport(a, b);
      });
    case 'imported':
    default:
      return copy.sort(byImport);
  }
};

/* ------------------------------------------------------------------ */
/* Deep search                                                         */
/* ------------------------------------------------------------------ */

export interface StoryHits {
  storyId: string;
  title: string;
  hits: SearchHit[];
}

export interface DeepSearchOptions {
  /** Called as each story finishes, so results appear while the scan runs. */
  onResult?: (result: StoryHits) => void;
  /** Called after every story, matched or not, to drive a progress bar. */
  onProgress?: (scanned: number, total: number) => void;
  signal?: AbortSignal;
  /** Stop early once this many stories have matched. */
  maxStories?: number;
  /** Hits kept per story — the library lists, it does not read. */
  perStory?: number;
}

/**
 * Search the full text of every story.
 *
 * `visitAll` is the storage cursor (`forEachStory`), injected so this module
 * stays pure and testable. Each story is indexed, searched, and dropped before
 * the next is read — the index is never held for the whole library, which is
 * the entire reason this is a stream and not a `getAll()`.
 */
export const searchAllStories = async (
  visitAll: (visit: (story: Story) => void, signal?: AbortSignal) => Promise<void>,
  query: string,
  opts: DeepSearchOptions = {},
): Promise<StoryHits[]> => {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];

  const { onResult, onProgress, signal, maxStories = 50, perStory = 5 } = opts;
  const results: StoryHits[] = [];
  let scanned = 0;
  let total = 0;

  await visitAll((story) => {
    total++;
    if (signal?.aborted || results.length >= maxStories) return;
    scanned++;

    const items = story.messages.map((m, i) => ({
      id: m.id,
      name: m.name,
      content: m.content,
      // The library has no chain structure to hand — chains are derived at
      // open time, not stored. A flat index is enough to jump by message id.
      chainIndex: 0,
      messageIndex: i,
    }));
    const hits = searchStory(buildSearchIndex(items), q, perStory);
    if (hits.length) {
      const result: StoryHits = { storyId: story.id, title: story.title, hits };
      results.push(result);
      onResult?.(result);
    }
    onProgress?.(scanned, total);
  }, signal);

  return results;
};
