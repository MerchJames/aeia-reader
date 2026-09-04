import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Search, SlidersHorizontal, Tag, X } from 'lucide-react';
import { StoryFormat } from '../types';
import { cn } from '../utils/cn';
import {
  LIBRARY_SORTS, LibrarySort, StoryHits, searchAllStories,
} from '../utils/librarySearch';
import { forEachStory } from '../lib/storage';
import { MIN_QUERY } from '../utils/storySearch';

export type FormatFilter = StoryFormat | 'all' | 'synced';

const FORMATS: { id: FormatFilter; label: string }[] = [
  { id: 'all', label: 'All formats' },
  { id: 'sillytavern', label: 'SillyTavern' },
  { id: 'kobold', label: 'Kobold' },
  { id: 'card', label: 'Character card' },
  { id: 'document', label: 'Document' },
  // Not a file type: the chats kept in step with SillyTavern. Listed last
  // and only when the sync is on.
  { id: 'synced', label: 'Synced with ST' },
];

export interface ToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  format: FormatFilter;
  onFormat: (f: FormatFilter) => void;
  /** Show the "Synced" choice at all — the sync is off until asked for. */
  showSynced?: boolean;
  tags: { tag: string; count: number }[];
  activeTags: string[];
  onToggleTag: (tag: string) => void;
  shown: number;
  total: number;
}

export const LibraryToolbar = ({
  query, onQuery, sort, onSort, format, onFormat,
  tags, activeTags, onToggleTag, shown, total, showSynced,
}: ToolbarProps) => {
  const [showFilters, setShowFilters] = useState(false);
  const filtering = activeTags.length > 0 || format !== 'all';

  return (
    <div className="flex flex-col gap-2">
      {/* Search takes the whole width on a phone. Sharing a row with the sort
        * picker left it about eight characters wide, which is not a search
        * field so much as a rumour of one. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => onQuery(e.target.value)}
            placeholder="Search your library…"
            aria-label="Search your library"
            data-testid="library-search"
            className="w-full pl-9 pr-9 min-h-11 text-sm bg-app-text/5 border border-transparent rounded-xl focus:outline-none focus:border-accent/50 transition-colors"
          />
          {query && (
            <button
              onClick={() => onQuery('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-9 min-w-9 rounded-lg opacity-50 hover:opacity-100"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
        <select
          value={sort}
          onChange={e => onSort(e.target.value as LibrarySort)}
          aria-label="Sort stories"
          data-testid="library-sort"
          className="min-h-11 px-2.5 text-sm bg-app-text/5 border border-app-border rounded-xl outline-none focus:border-accent/50 flex-1 sm:flex-none"
        >
          {LIBRARY_SORTS.map(s => (
            <option key={s.id} value={s.id} className="text-black bg-white">{s.label}</option>
          ))}
        </select>

        <button
          onClick={() => setShowFilters(v => !v)}
          aria-label="Filters"
          aria-expanded={showFilters}
          data-testid="library-filters"
          className={cn(
            'flex items-center justify-center min-h-11 min-w-11 rounded-xl border transition-colors shrink-0',
            filtering || showFilters
              ? 'border-accent/50 text-accent bg-accent/10'
              : 'border-app-border text-muted hover:text-app-text',
          )}
        >
          <SlidersHorizontal size={16} />
        </button>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-col gap-2 rounded-xl border border-app-border bg-app-text/[0.03] p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-muted">Format</span>
            {FORMATS.filter(f => f.id !== 'synced' || showSynced).map(f => (
              <button
                key={f.id}
                onClick={() => onFormat(f.id)}
                className={cn(
                  'px-2.5 min-h-9 rounded-full border text-xs transition-colors',
                  format === f.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-app-border text-muted hover:text-app-text',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {tags.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-muted flex items-center gap-1">
                <Tag size={11} /> Tags
              </span>
              {tags.map(({ tag, count }) => {
                const on = activeTags.some(t => t.toLowerCase() === tag.toLowerCase());
                return (
                  <button
                    key={tag}
                    onClick={() => onToggleTag(tag)}
                    data-testid={`library-tag-${tag}`}
                    className={cn(
                      'px-2.5 min-h-9 rounded-full border text-xs transition-colors',
                      on ? 'border-accent bg-accent/10 text-accent'
                        : 'border-app-border text-muted hover:text-app-text',
                    )}
                  >
                    {tag} <span className="opacity-50">{count}</span>
                  </button>
                );
              })}
              {/* Tags narrow rather than widen, so more chips means fewer
                * results — worth saying out loud the first time it surprises. */}
              {activeTags.length > 1 && (
                <span className="text-[11px] text-muted">showing stories with all {activeTags.length}</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="text-[11px] text-muted" data-testid="library-count">
        {shown === total ? `${total} ${total === 1 ? 'story' : 'stories'}` : `${shown} of ${total} stories`}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */

interface DeepSearchProps {
  query: string;
  onOpen: (storyId: string, messageId: string) => void;
}

/**
 * Searching the *text* of every story, on request.
 *
 * Kept behind a button rather than run on every keystroke because it reads the
 * whole library off disk. It streams results in as each story is scanned, and
 * a new query or an unmount aborts the one in flight — a scan of several
 * hundred chats must never be something you have to sit and wait out.
 */
export const DeepSearch = ({ query, onOpen }: DeepSearchProps) => {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<StoryHits[]>([]);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  // A stale scan writing into a new query's results would be worse than no
  // results at all, so the query owns the lifetime of its scan.
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    ctrl.current?.abort();
    setResults([]);
    setDone(false);
    setProgress(0);
    setRunning(false);
  }, [query]);

  const run = async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setRunning(true);
    setResults([]);
    setDone(false);
    try {
      await searchAllStories(forEachStory, query, {
        signal: c.signal,
        onResult: r => { if (!c.signal.aborted) setResults(prev => [...prev, r]); },
        onProgress: scanned => { if (!c.signal.aborted) setProgress(scanned); },
      });
    } finally {
      if (!c.signal.aborted) { setRunning(false); setDone(true); }
    }
  };

  if (query.trim().length < MIN_QUERY) return null;

  return (
    <div className="rounded-xl border border-app-border bg-app-text/[0.03] p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted min-w-0 flex-1">
          {done && !results.length
            ? `Nothing inside your stories matches “${query}”.`
            : 'Not what you were after? Search the text inside every story.'}
        </span>
        {running ? (
          <button
            onClick={() => { ctrl.current?.abort(); setRunning(false); setDone(true); }}
            className="flex items-center gap-1.5 px-3 min-h-9 rounded-lg border border-app-border text-xs shrink-0"
          >
            <Loader2 size={13} className="animate-spin" /> Scanning {progress}… cancel
          </button>
        ) : (
          <button
            onClick={() => void run()}
            data-testid="library-deep-search"
            className="px-3 min-h-9 rounded-lg bg-accent text-white text-xs font-medium shrink-0 hover:opacity-90"
          >
            {done ? 'Search again' : 'Search inside stories'}
          </button>
        )}
      </div>

      {results.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          {results.map(r => (
            <div key={r.storyId}>
              <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{r.title}</div>
              {r.hits.map(h => (
                <button
                  key={h.id}
                  onClick={() => onOpen(r.storyId, h.id)}
                  data-testid="deep-hit"
                  className="w-full text-left px-2.5 py-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors"
                >
                  <span className="block text-[11px] font-medium">{h.name}</span>
                  <span className="block text-[11px] leading-snug opacity-80 line-clamp-2">
                    {h.pre}
                    <mark className="bg-accent/30 text-app-text rounded-sm px-0.5">{h.hit}</mark>
                    {h.post}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
