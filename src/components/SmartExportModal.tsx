/**
 * Smart Export: say what goes in the file, then pick the file.
 *
 * The five export buttons in Settings each took the whole story and each had
 * its own idea of what "the story" was. That is right for a backup and wrong
 * for almost every reason somebody actually wants a file: the character's lines
 * without your prompts, one chapter to send to a friend, the prose with the
 * out-of-character asides taken out.
 *
 * So the choosing happens ONCE, here, and every format below is handed the same
 * selection. "Just the character" means the same thing in the markdown, the
 * page and the chat file, because all three are built from one list.
 *
 * ── Nothing here touches the story ─────────────────────────────────────────
 *
 * A selection is a filter applied on the way out. Dropping your own turns from
 * an export does not drop them from the library, and the panel says so, because
 * a control that looks like it might delete half a story is a control nobody
 * touches.
 *
 * ── The optional AI pass ───────────────────────────────────────────────────
 *
 * A tidy-up before the file is written — closing broken quotes and emphasis,
 * the same repair the Director offers on the page. It writes into the EXPORT
 * only; the story keeps its own text. Off unless asked for, and absent
 * entirely without an endpoint.
 */

import { useMemo, useState } from 'react';
import {
  BookOpen, Check, Download, FileJson, FileText, Loader2, Sparkles, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { accentHex, resolveTheme } from '../themes';
import { customFamilyFor, useFontStore } from '../stores/useFontStore';
import { embedFontsFor, resolveExportFont } from '../utils/fontEmbed';
import { artDataUri } from '../lib/artStorage';
import { downloadText, safeFilename, storyToMarkdown } from '../utils/exporter';
import { exportStoryHtml } from '../utils/htmlExport';
import { attachSceneArt, walkStory } from '../utils/storyWalk';
import { repairFormatting } from '../utils/textProcessor';
import { askText } from '../utils/aiCall';
import { samplerParamsFrom } from '../utils/aiClient';
import {
  DEFAULT_SELECTION, applySelection, chaptersOf, coverSubtitle, describeSelection,
  type ExportSelection, type SpeakerFilter,
} from '../utils/smartExport';
import type { Message, Story } from '../types';
import { cn } from '../utils/cn';

type Format = 'page' | 'markdown' | 'jsonl';

const FORMATS: { id: Format; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: 'page',
    label: 'Readable page',
    hint: 'One self-contained .html with your theme and a title page. Print it to get a PDF.',
    icon: <BookOpen size={15} />,
  },
  {
    id: 'markdown',
    label: 'Markdown',
    hint: 'Plain text with speakers as headings.',
    icon: <FileText size={15} />,
  },
  {
    id: 'jsonl',
    label: 'SillyTavern chat',
    hint: 'A .jsonl you can drop back into SillyTavern.',
    icon: <FileJson size={15} />,
  },
];

const SPEAKERS: { id: SpeakerFilter; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'ai', label: 'Character only' },
  { id: 'user', label: 'My turns only' },
];

/** One ST chat line, from a message. Mirrors what `exporter.ts` writes. */
const toStLine = (m: Message): string => JSON.stringify({
  name: m.name,
  is_user: m.role === 'user',
  is_system: m.hidden ?? false,
  send_date: Date.now(),
  mes: m.content,
  ...(m.swipes?.length ? { swipes: m.swipes } : {}),
});

export const SmartExportModal = ({ onClose }: { onClose: () => void }) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const customFonts = useFontStore(f => f.fonts);
  const story = store.currentStory;

  const [selection, setSelection] = useState<ExportSelection>(DEFAULT_SELECTION);
  const [format, setFormat] = useState<Format>('page');
  const [subtitle, setSubtitle] = useState('');
  const [withCover, setWithCover] = useState(true);
  const [tidy, setTidy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showChapters, setShowChapters] = useState(false);

  const aiReady = !!(store.aiBaseUrl && store.aiModel);
  const chapters = useMemo(() => (story ? chaptersOf(story) : []), [story]);
  const kept = useMemo(
    () => (story ? applySelection(story, selection) : []),
    [story, selection],
  );

  if (!story) return null;

  const patch = (p: Partial<ExportSelection>) => setSelection(s => ({ ...s, ...p }));

  const toggleChapter = (index: number) => {
    const now = selection.chapters ?? chapters.map(c => c.index);
    const next = now.includes(index) ? now.filter(i => i !== index) : [...now, index].sort((a, b) => a - b);
    // Everything selected is the same as no selection, and saying it the second
    // way keeps the summary line honest.
    patch({ chapters: next.length === chapters.length ? null : next });
  };

  /**
   * The optional tidy-up, message by message.
   *
   * Local repair first — it closes a dangling quote or asterisk for nothing and
   * needs no endpoint. The model is only asked about passages that are still
   * broken after that, so a clean story costs no requests at all.
   */
  const tidyPass = async (messages: Message[]): Promise<Message[]> => {
    const out: Message[] = [];
    for (const m of messages) {
      const local = repairFormatting(m.content);
      const balanced = (local.match(/["“”]/g)?.length ?? 0) % 2 === 0;
      if (!aiReady || balanced) { out.push({ ...m, content: local }); continue; }
      try {
        const fixed = await askText(
          { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
          [
            {
              role: 'system',
              content: 'You repair broken punctuation in prose. Close unclosed quotation marks and '
                + 'emphasis markers. Change NOTHING else — not a word, not the order, not the '
                + 'spelling. Reply with the corrected passage and nothing else.',
            },
            { role: 'user', content: local },
          ],
          {
            label: 'Tidying for export',
            params: { temperature: 0 },
            reader: samplerParamsFrom(store.aiAdvanced),
            budget: Math.min(6000, Math.ceil(local.length / 3) + 512),
          },
        );
        // A reply that changed the LENGTH wildly rewrote the passage rather than
        // repairing it. Keep ours — a tidy-up that rewrites the story is worse
        // than a stray quotation mark.
        const sane = fixed.trim() && Math.abs(fixed.length - local.length) < local.length * 0.25;
        out.push({ ...m, content: sane ? fixed.trim() : local });
      } catch {
        out.push({ ...m, content: local });
      }
    }
    return out;
  };

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const messages = tidy ? await tidyPass(kept) : kept;
      const slice: Story = { ...story, messages, messageCount: messages.length };
      const base = safeFilename(story.title);

      if (format === 'markdown') {
        downloadText(`${base}.md`, storyToMarkdown(slice));
      } else if (format === 'jsonl') {
        const header = JSON.stringify({
          user_name: story.userName ?? 'You',
          character_name: story.characterName ?? story.title,
        });
        downloadText(`${base}.jsonl`, [header, ...messages.map(toStLine)].join('\n'));
      } else {
        const themeDef = resolveTheme(store.theme, store.bgColor, store.textColor);
        const font = resolveExportFont(
          store.theme,
          themeDef.font,
          store.fontFamily,
          customFamilyFor(store.fontFamily, customFonts),
        );
        // Chains are the READER's view of the story; this file is a slice of
        // it, so the walk is given the slice's own messages and no chains.
        const walked = await attachSceneArt(
          walkStory(slice, [], {
            overrides: v2.overridesByStory[story.id],
            lensOn: !!v2.lensOnByStory[story.id],
            hideMetadata: store.hideMetadata,
            fontColorMode: store.fontColorMode,
            substituteNames: store.substituteNames,
            oocHandling: store.oocHandling,
            smartTypography: store.smartTypography,
            includeHidden: selection.includeHidden,
          }),
          v2.artByStory[story.id],
          artDataUri,
        );
        // Only the alphabets this slice actually uses — a Latin chat has no
        // need of the Cyrillic faces.
        let sample = story.title;
        for (const m of walked.messages) {
          sample += ` ${m.name} ${m.text}`;
          if (sample.length > 200_000) break;
        }
        const faces = await embedFontsFor(font, sample);

        const { html } = exportStoryHtml(walked, {
          theme: themeDef,
          accent: accentHex(store.accentColor) || undefined,
          fontColorMode: store.fontColorMode,
          typography: {
            stack: font.stack,
            fontSize: store.fontSize,
            contentWidth: store.contentWidth,
            paragraphSpacing: store.paragraphSpacing,
            faceCss: faces.css,
          },
          layout: store.viewMode === 'chat' ? 'chat' : 'storybook',
          cover: withCover,
          coverSubtitle: coverSubtitle(subtitle),
          scenes: v2.sceneByStory[story.id],
          sceneMood: store.sceneTheming,
          highlights: story.highlights,
        });
        downloadText(`${base}.html`, html);
      }
      setNote(`Exported ${messages.length} passage${messages.length === 1 ? '' : 's'}.`);
    } catch (e: any) {
      setNote(`Export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean) => cn(
    'text-[11px] px-2.5 py-1 rounded-md border transition-colors',
    on ? 'border-accent bg-accent/10 text-accent font-bold' : 'border-app-border hover:bg-app-text/5',
  );

  return (
    <div className="fixed inset-0 z-[75] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col rounded-t-2xl sm:rounded-2xl border border-app-border bg-surface shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border shrink-0">
          <Download size={16} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold leading-tight">Smart Export</h2>
            <p className="text-[10px] text-muted leading-tight truncate">{story.title}</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-full hover:bg-app-text/10"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
          {/* ── What goes in ─────────────────────────────────────────────── */}
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted font-bold">What goes in</p>
            <div className="flex flex-wrap gap-1.5">
              {SPEAKERS.map(s => (
                <button
                  key={s.id}
                  onClick={() => patch({ speakers: s.id })}
                  aria-pressed={selection.speakers === s.id}
                  className={chip(selection.speakers === s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => patch({ includeOoc: !selection.includeOoc })}
                aria-pressed={!selection.includeOoc}
                title="Take [OOC: …] asides out of the exported text"
                className={chip(!selection.includeOoc)}
              >
                Remove OOC
              </button>
              <button
                onClick={() => patch({ includeHidden: !selection.includeHidden })}
                aria-pressed={selection.includeHidden}
                className={chip(selection.includeHidden)}
              >
                Hidden messages
              </button>
              <button
                onClick={() => patch({ includeReasoning: !selection.includeReasoning })}
                aria-pressed={selection.includeReasoning}
                className={chip(selection.includeReasoning)}
              >
                Thinking
              </button>
              {chapters.length > 1 && (
                <button
                  onClick={() => setShowChapters(v => !v)}
                  aria-expanded={showChapters}
                  className={chip(!!selection.chapters)}
                >
                  {selection.chapters
                    ? `${selection.chapters.length} of ${chapters.length} chapters`
                    : 'All chapters'}
                </button>
              )}
            </div>

            {showChapters && chapters.length > 1 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-app-border p-1.5 space-y-0.5">
                <button
                  onClick={() => patch({ chapters: null })}
                  className="w-full text-left text-[11px] px-2 py-1 rounded hover:bg-app-text/5 text-accent"
                >
                  Select all
                </button>
                {chapters.map(c => {
                  const on = !selection.chapters || selection.chapters.includes(c.index);
                  return (
                    <button
                      key={c.index}
                      onClick={() => toggleChapter(c.index)}
                      className="w-full flex items-center gap-2 text-left text-[11px] px-2 py-1 rounded hover:bg-app-text/5"
                    >
                      <span className={cn(
                        'w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0',
                        on ? 'bg-accent border-accent text-white' : 'border-app-border',
                      )}>
                        {on && <Check size={9} />}
                      </span>
                      <span className="truncate flex-1">{c.index + 1}. {c.title}</span>
                      <span className="text-muted tabular-nums shrink-0">{c.count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <p className="text-[11px] text-accent" data-testid="export-summary">
              {describeSelection(story.messages.length, kept, selection)}
            </p>
            <p className="text-[10px] text-muted leading-snug">
              A filter on the way out. Your library keeps every passage either way.
            </p>
          </div>

          {/* ── The file ─────────────────────────────────────────────────── */}
          <div className="space-y-2 border-t border-app-border/60 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted font-bold">The file</p>
            {FORMATS.map(f => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                aria-pressed={format === f.id}
                className={cn(
                  'w-full flex items-start gap-2 text-left px-2.5 py-2 rounded-lg border transition-colors',
                  format === f.id ? 'border-accent bg-accent/[0.07]' : 'border-app-border hover:bg-app-text/5',
                )}
              >
                <span className={cn('mt-0.5 shrink-0', format === f.id ? 'text-accent' : 'text-muted')}>
                  {f.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{f.label}</span>
                  <span className="block text-[10px] text-muted leading-snug">{f.hint}</span>
                </span>
              </button>
            ))}
          </div>

          {/* ── The title page ───────────────────────────────────────────── */}
          {format === 'page' && (
            <div className="space-y-2 border-t border-app-border/60 pt-3">
              <p className="text-[10px] uppercase tracking-wider text-muted font-bold">Title page</p>
              <button
                onClick={() => setWithCover(v => !v)}
                aria-pressed={withCover}
                className={chip(withCover)}
              >
                {withCover ? 'Cover on' : 'Cover off'}
              </button>
              {withCover && (
                <>
                  <input
                    value={subtitle}
                    onChange={e => setSubtitle(e.target.value)}
                    placeholder="A line under the title (optional)…"
                    maxLength={120}
                    className="w-full text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50"
                  />
                  <p className="text-[10px] text-muted leading-snug">
                    The page opens on a full title card — the name, who it is with, how long it is.
                    Print it and the cover takes a page of its own, so “Save as PDF” gives you a book.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ── The optional pass ────────────────────────────────────────── */}
          <div className="space-y-1.5 border-t border-app-border/60 pt-3">
            <button
              onClick={() => setTidy(v => !v)}
              aria-pressed={tidy}
              className={chip(tidy)}
              data-testid="export-tidy"
            >
              <Sparkles size={11} className="inline mr-1" />
              Tidy the punctuation first
            </button>
            <p className="text-[10px] text-muted leading-snug">
              Closes unclosed quotes and emphasis. Local repair for most of it;
              {aiReady
                ? ' the model is asked only about passages still broken after that.'
                : ' with no AI endpoint set, the local repair runs alone.'}
              {' '}The fix goes in the file, never into your story.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-app-border shrink-0">
          {note && <span className="text-[11px] text-muted flex-1 truncate">{note}</span>}
          {!note && <span className="flex-1" />}
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-lg hover:bg-app-text/5 text-muted"
          >
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy || !kept.length}
            data-testid="export-run"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
};
