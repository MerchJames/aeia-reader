import React, { useEffect, useRef, useState } from 'react';
import { FileJson, ImagePlus, Loader2, Upload, X } from 'lucide-react';
import { cn } from '../utils/cn';

interface CardPreview {
  file: File;
  url: string;
}

/**
 * Import confirmation shown when story files are picked. Purely optional
 * step: hit Import straight away for the classic flow, or drop character
 * card PNG(s) first — each card auto-maps to its story by character name
 * and brings its portrait, description, tags, and embedded lorebook along.
 */
export const ImportModal = ({
  storyFiles, initialCards, importing, onImport, onCancel,
}: {
  storyFiles: File[];
  /** Card PNGs that came in the same drop/selection. */
  initialCards: File[];
  importing: boolean;
  onImport: (cards: File[]) => void;
  onCancel: () => void;
}) => {
  const [cards, setCards] = useState<CardPreview[]>([]);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<CardPreview[]>([]);
  urlsRef.current = cards;

  useEffect(() => {
    setCards(initialCards.map(file => ({ file, url: URL.createObjectURL(file) })));
    // Object URLs are tiny but still leak if never revoked — clean up the
    // ones still alive when the modal unmounts (removals revoke their own).
    return () => urlsRef.current.forEach(c => URL.revokeObjectURL(c.url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addCards = (files: File[]) => {
    const pngs = files.filter(f => f.name.toLowerCase().endsWith('.png'));
    setCards(prev => [
      ...prev,
      ...pngs
        .filter(f => !prev.some(p => p.file.name === f.name && p.file.size === f.size))
        .map(file => ({ file, url: URL.createObjectURL(file) })),
    ]);
  };

  const removeCard = (i: number) => {
    setCards(prev => {
      URL.revokeObjectURL(prev[i].url);
      return prev.filter((_, j) => j !== i);
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      // stopPropagation: the library behind this modal is itself a drop
      // zone — while the modal is open, any dropped PNG becomes a card
      // instead of restarting the import flow.
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        addCards(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[3px]" onClick={onCancel} />
      {/* max-h + scroll: a centred panel taller than the screen overflows in
        * BOTH directions, so its buttons end up above and below the viewport
        * with no way to scroll to them. On a phone that made importing — the
        * first thing anyone does — impossible. */}
      <div className="relative w-full max-w-md max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl bg-surface border border-app-border shadow-2xl p-6 space-y-4">
        <button
          onClick={onCancel}
          className="absolute top-3 right-3 p-2 rounded-full hover:bg-app-text/10 transition-colors"
          title="Cancel"
        >
          <X size={15} />
        </button>

        <div>
          <h2 className="text-lg font-bold leading-tight">Import stories</h2>
          <p className="text-xs text-muted mt-0.5">
            {storyFiles.length} file{storyFiles.length === 1 ? '' : 's'} ready
          </p>
        </div>

        <div className="space-y-1.5 max-h-32 overflow-y-auto">
          {storyFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-app-text/5">
              <FileJson size={14} className="text-accent shrink-0" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
            Character cards <span className="font-medium normal-case tracking-normal">(optional)</span>
          </p>
          <div
            onClick={() => cardInputRef.current?.click()}
            className={cn(
              'rounded-xl border-2 border-dashed border-app-border p-3 cursor-pointer',
              'hover:border-accent/60 hover:bg-app-text/5 transition-colors',
            )}
          >
            {cards.length === 0 ? (
              <div className="flex items-center gap-2.5 text-xs text-muted py-1">
                <ImagePlus size={18} className="shrink-0 opacity-60" />
                Drop card PNG(s) here — the portrait becomes the profile picture,
                and its description, tags &amp; lorebook enrich the codex and AI.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {cards.map((c, i) => (
                  <div key={i} className="relative group" onClick={(e) => e.stopPropagation()}>
                    <img
                      src={c.url}
                      alt={c.file.name}
                      title={c.file.name}
                      className="w-14 h-14 rounded-lg object-cover ring-1 ring-app-border"
                    />
                    <button
                      onClick={() => removeCard(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-app-text text-app-bg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove card"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={(e) => { e.stopPropagation(); cardInputRef.current?.click(); }}
                  className="w-14 h-14 rounded-lg border border-dashed border-app-border flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity"
                  title="Add another card"
                >
                  <ImagePlus size={16} />
                </button>
              </div>
            )}
          </div>
          <input
            ref={cardInputRef}
            type="file"
            accept=".png"
            multiple
            className="hidden"
            onChange={(e) => {
              addCards(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>

        <button
          onClick={() => onImport(cards.map(c => c.file))}
          disabled={importing}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent text-white font-bold text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {importing ? 'Importing…' : cards.length > 0 ? `Import with ${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Import'}
        </button>
      </div>
    </div>
  );
};
