import React, { useMemo, useRef, useState } from 'react';
import { BookOpen, Check, FileJson, FileText, Image, MessageSquare, Settings, Sparkles, Tag, Trash2, Upload, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { StoryFormat, StoryMeta } from '../types';
import { ImportModal } from './ImportModal';
import { Onboarding } from './Onboarding';
import { DeepSearch, LibraryToolbar } from './LibraryToolbar';
import { cn } from '../utils/cn';
import { AEIA_MARK } from '../assets/aeiaMark';
import {
  LibrarySort, allTags, filterStories, sortStories, tagsFor,
} from '../utils/librarySearch';

const FORMAT_LABEL: Record<StoryFormat, string> = {
  sillytavern: 'SillyTavern',
  kobold: 'Kobold',
  card: 'Character Card',
  document: 'Document',
};

const FORMAT_ICON: Record<StoryFormat, React.ReactNode> = {
  sillytavern: <MessageSquare size={13} />,
  kobold: <FileJson size={13} />,
  card: <Image size={13} />,
  document: <FileText size={13} />,
};

const COVER_GRADIENTS = [
  'from-indigo-500 to-purple-600',
  'from-rose-500 to-orange-500',
  'from-emerald-500 to-teal-600',
  'from-sky-500 to-blue-600',
  'from-amber-500 to-red-500',
];

/**
 * "2d ago" rather than a date: on the library the useful question is how long
 * it has been since you last touched a story, not which Tuesday it was.
 */
const sinceLabel = (at: number | undefined): string | null => {
  if (!at) return null;
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

const coverGradient = (id: string) => {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
};

const StoryCard = ({ story, suggestions }: { story: StoryMeta; suggestions: string[] }) => {
  const openStory = useAppStore(s => s.openStory);
  const deleteStoryById = useAppStore(s => s.deleteStoryById);
  const userTags = useAuraV2Store(s => s.libraryTagsByStory);
  const setStoryTags = useAuraV2Store(s => s.setStoryTags);
  const lastReadAt = useAuraV2Store(s => s.statsByStory[story.id]?.lastReadAt);
  const [editingTags, setEditingTags] = useState(false);
  const [draftTag, setDraftTag] = useState('');
  const pct = story.progressPct ?? 0;
  const tags = tagsFor(story, userTags);
  const since = sinceLabel(lastReadAt);

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setStoryTags(story.id, [...tags, tag]);
    setDraftTag('');
  };

  return (
    <div
      onClick={() => void openStory(story.id)}
      data-testid="story-card"
      className="group relative rounded-2xl border border-app-border bg-surface shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer overflow-hidden"
    >
      <div className="flex items-stretch gap-0">
        <div className={cn(
          'w-24 shrink-0 flex items-center justify-center overflow-hidden',
          !story.avatar && `bg-gradient-to-br ${coverGradient(story.id)}`,
        )}>
          {story.avatar ? (
            <img src={story.avatar} alt={story.title} className="w-full h-full object-cover" />
          ) : (
            <span className="text-3xl font-serif font-bold text-white/90">
              {story.title.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0 p-4">
          <h3 className="font-bold truncate pr-6" data-testid="card-title">{story.title}</h3>
          <div className="flex items-center gap-1.5 text-xs text-muted mt-1">
            {FORMAT_ICON[story.format]}
            <span>{FORMAT_LABEL[story.format]}</span>
            <span>·</span>
            <span>{story.messageCount} messages</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {since
              ? `Last read ${since}`
              : `Imported ${new Date(story.importedAt).toLocaleDateString()}`}
          </div>
          {/* Tags are the library's organising axis, so they are editable
            * here rather than buried in a menu. Clicks inside must not open
            * the story — the whole card is the open target. */}
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {(editingTags ? tags : tags.slice(0, 3)).map(tag => (
              <span
                key={tag}
                className="flex items-center gap-1 pl-1.5 rounded-full bg-app-text/5 border border-app-border/60 text-[10px] text-muted"
              >
                {tag}
                {editingTags && (
                  <button
                    onClick={e => { e.stopPropagation(); setStoryTags(story.id, tags.filter(t => t !== tag)); }}
                    aria-label={`Remove tag ${tag}`}
                    className="flex items-center justify-center min-h-7 min-w-7 rounded-full hover:text-red-500"
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
            {!editingTags && tags.length > 3 && (
              <span className="text-[10px] text-muted">+{tags.length - 3}</span>
            )}

            {editingTags ? (
              <>
                <input
                  autoFocus
                  value={draftTag}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setDraftTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); addTag(draftTag); }
                    if (e.key === 'Escape') { setDraftTag(''); setEditingTags(false); }
                  }}
                  list={`tags-${story.id}`}
                  placeholder="add tag…"
                  aria-label="Add a tag"
                  data-testid="tag-input"
                  className="w-24 px-1.5 min-h-7 text-[10px] bg-app-text/5 border border-app-border rounded-full outline-none focus:border-accent/50"
                />
                {/* Suggestions come from tags already in use, so the library
                  * converges on one spelling instead of five near-misses. */}
                <datalist id={`tags-${story.id}`}>
                  {suggestions.map(t => <option key={t} value={t} />)}
                </datalist>
                <button
                  onClick={e => { e.stopPropagation(); addTag(draftTag); setEditingTags(false); }}
                  aria-label="Done editing tags"
                  className="flex items-center justify-center min-h-7 min-w-7 rounded-full text-accent"
                >
                  <Check size={12} />
                </button>
              </>
            ) : (
              <button
                onClick={e => { e.stopPropagation(); setEditingTags(true); }}
                aria-label={`Edit tags for ${story.title}`}
                data-testid="edit-tags"
                className="flex items-center gap-1 px-1.5 min-h-7 rounded-full border border-dashed border-app-border/60 text-[10px] text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 touch:opacity-100 transition-opacity"
              >
                <Tag size={9} /> {tags.length ? 'edit' : 'tag'}
              </button>
            )}
          </div>

          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-app-text/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[11px] text-muted mt-1">
              {pct > 0 ? `${pct}% read — click to continue` : 'Not started'}
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${story.title}" from your library?`)) {
            void deleteStoryById(story.id);
          }
        }}
        title="Delete story"
        className="absolute top-2.5 right-2.5 p-1.5 rounded-md text-red-500 opacity-0 group-hover:opacity-100 hover:bg-red-500/10 transition-all"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
};

export const Library = () => {
  const library = useAppStore(s => s.library);
  const libraryLoaded = useAppStore(s => s.libraryLoaded);
  const importFiles = useAppStore(s => s.importFiles);
  const setSettingsOpen = useAppStore(s => s.setSettingsOpen);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const onboarded = useAppStore(s => s.onboarded);
  const setOnboarded = useAppStore(s => s.setOnboarded);
  // Opens itself exactly once. Someone who has just installed this has no way to
  // know nine views and a Scene Director are in here; someone on their tenth
  // session should never see it again unless they ask.
  const [tourOpen, setTourOpen] = useState(!onboarded);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, setPending] = useState<{ stories: File[]; cards: File[] } | null>(null);

  const userTags = useAuraV2Store(s => s.libraryTagsByStory);
  const stats = useAuraV2Store(s => s.statsByStory);
  const jumpToMessage = useAppStore(s => s.jumpToMessage);
  const openStory = useAppStore(s => s.openStory);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('lastRead');
  const [format, setFormat] = useState<StoryFormat | 'all'>('all');
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const tagOptions = useMemo(() => allTags(library, userTags), [library, userTags]);
  const tagSuggestions = useMemo(() => tagOptions.map(t => t.tag), [tagOptions]);
  const shown = useMemo(
    () => sortStories(filterStories(library, { query, tags: activeTags, format }, userTags), sort, stats),
    [library, query, activeTags, format, userTags, sort, stats],
  );

  const toggleTag = (tag: string) => setActiveTags(prev =>
    prev.some(t => t.toLowerCase() === tag.toLowerCase())
      ? prev.filter(t => t.toLowerCase() !== tag.toLowerCase())
      : [...prev, tag]);

  /** A deep-search hit: open the story, then land on the exact message. */
  const openAt = async (storyId: string, messageId: string) => {
    await openStory(storyId);
    jumpToMessage(messageId);
  };

  const runImport = async (stories: File[], cards: File[]) => {
    setImporting(true);
    try {
      const result = await importFiles(stories, cards);
      setErrors(result.errors);
      setNotes(result.notes);
      setPending(null);
    } finally {
      setImporting(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const stories = files.filter(f => /\.(jsonl?|json|txt|md|markdown|docx)$/i.test(f.name));
    const cards = files.filter(f => /\.png$/i.test(f.name));
    // Story files get the import modal (attach cards up front); a pure
    // card drop keeps the classic instant flow (card becomes a story).
    if (stories.length > 0) {
      setPending({ stories, cards });
    } else {
      await runImport(files, []);
    }
  };

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto flex flex-col"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void handleFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept=".jsonl,.json,.png,.txt,.md,.markdown,.docx"
        multiple
        onChange={(e) => {
          void handleFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-5 sm:px-10 pt-6 sm:pt-8 pb-5 sm:pb-6 max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-3 min-w-0">
          {/* The mark lives here and nowhere else in the app — the library is
            * the front door, and a logo over the reading column would be a
            * brand sitting in the middle of someone's story.
            * `alt=""`: the h1 beside it already says the name, and a screen
            * reader hearing it twice is noise, not access. */}
          <img
            src={AEIA_MARK}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-9 sm:h-11 w-auto shrink-0 select-none"
          />
          <div className="min-w-0">
            <h1 className="text-3xl font-serif font-bold">Aeia Reader</h1>
            <p className="text-sm text-muted mt-1">
              Relive your SillyTavern &amp; Kobold stories.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* The tour is opt-in after the first run — it shows itself once, then
            * lives here so it stays findable without nagging. */}
          <button
            onClick={() => setTourOpen(true)}
            title="Take the tour — what Aeia can do"
            data-testid="tour-button"
            className="flex items-center justify-center gap-1.5 px-3 min-h-11 rounded-lg border border-app-border text-sm text-app-text/70 hover:text-app-text hover:bg-app-text/5 transition-colors"
          >
            <Sparkles size={15} /> Tour
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="flex items-center justify-center gap-2 px-4 min-h-11 flex-1 sm:flex-none rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity shadow-sm"
          >
            <Upload size={16} />
            {importing ? 'Importing…' : 'Import'}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-app-border hover:bg-app-text/5 transition-colors"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {errors.length > 0 && (
        <div className="max-w-5xl w-full mx-auto px-6 sm:px-10 mb-4">
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm relative">
            <button
              onClick={() => setErrors([])}
              className="absolute top-2 right-2 p-1 opacity-60 hover:opacity-100"
            >
              <X size={14} />
            </button>
            <p className="font-bold mb-1">Some files could not be imported:</p>
            {errors.map((err, i) => <p key={i} className="text-muted">{err}</p>)}
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="max-w-5xl w-full mx-auto px-6 sm:px-10 mb-4">
          <div className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm relative">
            <button
              onClick={() => setNotes([])}
              className="absolute top-2 right-2 p-1 opacity-60 hover:opacity-100"
            >
              <X size={14} />
            </button>
            <p className="font-bold mb-1">Branches attached:</p>
            {notes.map((n, i) => <p key={i} className="text-muted">{n}</p>)}
          </div>
        </div>
      )}

      <main className="flex-1 max-w-5xl w-full mx-auto px-6 sm:px-10 pb-16">
        {!libraryLoaded ? null : library.length === 0 ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'mt-8 rounded-3xl border-2 border-dashed p-16 text-center cursor-pointer transition-colors',
              dragging
                ? 'border-accent bg-accent/10'
                : 'border-app-border hover:border-accent/60 hover:bg-app-text/5',
            )}
          >
            <BookOpen size={48} className="mx-auto mb-4 opacity-40" />
            <p className="text-lg font-bold">Your library is empty</p>
            <p className="text-sm text-muted mt-2">
              Drop files here or click to import — SillyTavern chats (.jsonl),
              Kobold saves (.json), documents (.txt, .md, .docx), or character
              cards (.png).
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <LibraryToolbar
              query={query}
              onQuery={setQuery}
              sort={sort}
              onSort={setSort}
              format={format}
              onFormat={setFormat}
              tags={tagOptions}
              activeTags={activeTags}
              onToggleTag={toggleTag}
              shown={shown.length}
              total={library.length}
            />

            {shown.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-app-border p-10 text-center">
                <p className="text-sm font-medium">Nothing matches those filters.</p>
                <button
                  onClick={() => { setQuery(''); setActiveTags([]); setFormat('all'); }}
                  className="mt-3 px-3 min-h-10 rounded-lg border border-app-border text-xs hover:bg-app-text/5"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {shown.map(story => (
                  <StoryCard key={story.id} story={story} suggestions={tagSuggestions} />
                ))}
              </div>
            )}

            {/* Titles and tags are searched as you type; the text inside the
              * stories costs a read of the whole library, so it is asked for. */}
            <DeepSearch query={query} onOpen={(sid, mid) => void openAt(sid, mid)} />
          </div>
        )}
      </main>

      {tourOpen && (
        <Onboarding onClose={() => { setTourOpen(false); if (!onboarded) setOnboarded(true); }} />
      )}

      {pending && (
        <ImportModal
          storyFiles={pending.stories}
          initialCards={pending.cards}
          importing={importing}
          onImport={(cards) => void runImport(pending.stories, cards)}
          onCancel={() => setPending(null)}
        />
      )}

      {dragging && library.length > 0 && (
        <div className="fixed inset-0 z-50 bg-accent/20 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl bg-surface border-2 border-dashed border-accent px-10 py-8 text-xl font-bold shadow-2xl">
            Drop to import
          </div>
        </div>
      )}
    </div>
  );
};
