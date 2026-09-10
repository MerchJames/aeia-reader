import React from 'react';
import { Download, LocateFixed, StickyNote, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import { HIGHLIGHT_COLORS } from '../types';
import { downloadText, safeFilename } from '../utils/exporter';
import { cn } from '../utils/cn';

const colorBg = (key?: string) =>
  HIGHLIGHT_COLORS.find(c => c.key === key)?.bg ?? HIGHLIGHT_COLORS[0].bg;

export const HighlightsMode = () => {
  const store = useAppStore();
  const highlights = store.currentStory?.highlights ?? [];

  if (highlights.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center opacity-50 h-[80vh]">
        <div className="text-center space-y-2 max-w-md px-6">
          <p className="text-xl font-bold">No highlights yet.</p>
          <p className="text-sm">
            Turn on Autofocus mode, hold <kbd className="px-1.5 py-0.5 rounded bg-app-text/10 font-mono">F</kbd> and
            select text to save it here.
          </p>
        </div>
      </div>
    );
  }

  const exportHighlights = () => {
    const title = store.currentStory?.title ?? 'story';
    const md = [
      `# Highlights — ${title}`, '',
      ...highlights.map(h => `> ${h.text}\n${h.note ? `\n**Note:** ${h.note}\n` : ''}`),
    ].join('\n');
    downloadText(`${safeFilename(title)}-highlights.md`, md);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-8 pb-40" data-tour="highlights-view">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-app-border pb-4 mb-8">
          <h2 className="text-2xl font-serif font-bold">Your Highlights</h2>
          <button
            onClick={exportHighlights}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border border-app-border hover:bg-app-text/5 transition-colors"
          >
            <Download size={15} /> Export
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {highlights.map((highlight) => (
            <div
              key={highlight.id}
              className="p-6 rounded-2xl border border-app-border bg-surface shadow-sm relative group transition-all hover:shadow-md"
            >
              <div className="flex justify-between items-start mb-4">
                <span className="text-xs text-muted font-mono">
                  {new Date(highlight.timestamp).toLocaleDateString()}{' '}
                  {new Date(highlight.timestamp).toLocaleTimeString()}
                </span>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {highlight.messageId && (
                    <button
                      onClick={() => store.jumpToMessage(highlight.messageId!)}
                      title="Jump to this point in the story"
                      className="p-1.5 hover:bg-accent/10 text-accent rounded-md"
                    >
                      <LocateFixed size={16} />
                    </button>
                  )}
                  <button
                    onClick={() => store.removeHighlight(highlight.id)}
                    title="Delete highlight"
                    className="p-1.5 hover:bg-red-500/10 text-red-500 rounded-md"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <blockquote
                className="text-lg font-medium italic pl-4 py-1 rounded-sm"
                style={{ borderLeft: '4px solid transparent', background: colorBg(highlight.color) }}
              >
                "{highlight.text}"
              </blockquote>

              <div className="mt-3 flex items-start gap-2">
                <StickyNote size={15} className="mt-2 opacity-50 shrink-0" />
                <textarea
                  defaultValue={highlight.note ?? ''}
                  onBlur={(e) => {
                    const note = e.target.value.trim();
                    if (note !== (highlight.note ?? '')) {
                      store.updateHighlight(highlight.id, { note: note || undefined });
                    }
                  }}
                  placeholder="Add a note / annotation…"
                  rows={highlight.note ? 2 : 1}
                  className="flex-1 resize-y bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50 min-w-0"
                />
              </div>

              <div className="mt-2 flex gap-1.5">
                {HIGHLIGHT_COLORS.map(c => (
                  <button
                    key={c.key}
                    title={c.label}
                    onClick={() => store.updateHighlight(highlight.id, { color: c.key })}
                    className={cn(
                      'w-5 h-5 rounded-full border transition-transform hover:scale-110',
                      (highlight.color ?? 'yellow') === c.key ? 'ring-2 ring-app-text scale-110' : 'border-app-border',
                    )}
                    style={{ background: c.bg }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
