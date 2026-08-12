import React, { useState } from 'react';
import { Bot, Clapperboard, MessageSquare, Pin, X, Volume2 } from 'lucide-react';
import { HIGHLIGHT_COLORS, ScenePerformKind } from '../types';

/**
 * The performance verbs a reader can put on a span by hand — the same
 * vocabulary the Scene Director works in, so a hand-marked span plays exactly
 * like a directed one. Each label says what the READER will see, not what the
 * engine calls it.
 */
const PERFORM_CHOICES: { kind: ScenePerformKind; label: string; hint: string }[] = [
  { kind: 'slow', label: 'Slow', hint: 'Drag the words out' },
  { kind: 'rush', label: 'Rush', hint: 'Tumble them out fast' },
  { kind: 'stagger', label: 'Stagger', hint: 'One. Word. At. A. Time.' },
  { kind: 'hold', label: 'Hold', hint: 'A silence before this lands' },
  { kind: 'swell', label: 'Swell', hint: 'Bloom larger, then settle back' },
  { kind: 'tremble', label: 'Tremble', hint: 'Shaking — fear, fury' },
  { kind: 'drop', label: 'Drop', hint: 'Each word lands heavy' },
  { kind: 'fade', label: 'Fade', hint: 'Arrives faint, stays quiet' },
  { kind: 'cut', label: 'Cut off', hint: 'Race at the break, then dead air' },
  { kind: 'unwrite', label: 'Unwrite', hint: 'Written, then dissolves away' },
];

interface SelectionPopoverProps {
  sel: { x: number; y: number; text: string; messageId?: string };
  noteDraft: string;
  setNoteDraft: (v: string) => void;
  onClose: () => void;
  onHighlight: (color: string) => void;
  onNote: () => void;
  onAskAi: () => void;
  onPin: () => void;
  /** Attach a reader-authored SFX to the selected span (audio service on). */
  onSfx?: (prompt: string, slow: boolean) => void;
  /** Direct how the selected span performs as it streams; null clears it. */
  onPerform?: (kind: ScenePerformKind | null) => void;
  /** The direction already on this span, if any (so it reads as selected). */
  performKind?: ScenePerformKind | null;
}

export const SelectionPopover = ({
  sel, noteDraft, setNoteDraft, onClose, onHighlight, onNote, onAskAi, onPin, onSfx,
  onPerform, performKind,
}: SelectionPopoverProps) => {
  const [sfxOpen, setSfxOpen] = useState(false);
  const [performOpen, setPerformOpen] = useState(false);
  const [sfxPrompt, setSfxPrompt] = useState('');
  const [sfxSlow, setSfxSlow] = useState(true);
  const commitSfx = () => {
    const p = sfxPrompt.trim();
    if (!p || !onSfx) return;
    onSfx(p, sfxSlow);
    setSfxPrompt(''); setSfxOpen(false);
  };
  return (
  <div
    className="fixed z-[70] -translate-x-1/2 -translate-y-full flex flex-col gap-2 p-2.5 rounded-xl bg-surface border border-app-border shadow-2xl w-64"
    style={{ left: sel.x, top: sel.y - 10 }}
    onMouseUp={(e) => e.stopPropagation()}
  >
    <div className="flex items-center gap-1.5">
      {HIGHLIGHT_COLORS.map(c => (
        <button
          key={c.key}
          title={`Highlight ${c.label}`}
          onClick={() => onHighlight(c.key)}
          className="w-6 h-6 rounded-full border border-app-border hover:scale-110 transition-transform"
          style={{ background: c.bg }}
        />
      ))}
      <button
        onClick={onPin}
        disabled={!sel.messageId}
        className="ml-auto p-1 opacity-60 hover:opacity-100 disabled:opacity-30"
        title="Pin this passage to the side dock"
      >
        <Pin size={14} />
      </button>
      <button
        onClick={onClose}
        className="p-1 opacity-60 hover:opacity-100"
        title="Cancel"
      >
        <X size={15} />
      </button>
    </div>

    <input
      type="text"
      autoFocus
      value={noteDraft}
      onChange={(e) => setNoteDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onNote();
      }}
      placeholder="Add a note…"
      className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
    />

    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onNote}
        disabled={!sel.messageId}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-40"
      >
        <MessageSquare size={13} /> Note
      </button>
      <button
        onClick={onAskAi}
        disabled={!sel.messageId}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
      >
        <Bot size={13} /> Ask AI
      </button>
    </div>

    {onPerform && (
      performOpen ? (
        <div className="flex flex-col gap-1.5 border-t border-app-border pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">How should this read?</span>
            {performKind && (
              <button
                onClick={() => { onPerform(null); setPerformOpen(false); }}
                className="text-[11px] text-muted hover:text-app-text underline underline-offset-2"
              >
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {PERFORM_CHOICES.map(c => (
              <button
                key={c.kind}
                title={c.hint}
                onClick={() => { onPerform(c.kind); setPerformOpen(false); }}
                className={`px-2 py-1 rounded-md text-[11px] text-left border transition-colors ${
                  performKind === c.kind
                    ? 'border-accent/60 bg-accent/15 text-accent font-medium'
                    : 'border-app-border hover:bg-app-text/5'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setPerformOpen(true)}
          disabled={!sel.messageId}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
        >
          <Clapperboard size={13} />
          {performKind ? `Performing: ${PERFORM_CHOICES.find(c => c.kind === performKind)?.label}` : 'Perform this span'}
        </button>
      )
    )}

    {onSfx && (
      sfxOpen ? (
        <div className="flex flex-col gap-1.5 border-t border-app-border pt-2">
          <input
            type="text"
            autoFocus
            value={sfxPrompt}
            onChange={(e) => setSfxPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSfx(); }}
            placeholder="Describe the sound… (e.g. a door slamming)"
            className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted flex-1 cursor-pointer">
              <input type="checkbox" checked={sfxSlow} onChange={(e) => setSfxSlow(e.target.checked)} className="accent-current" />
              Slow the reveal here
            </label>
            <button onClick={commitSfx} disabled={!sfxPrompt.trim()}
              className="px-2.5 py-1 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 disabled:opacity-40">Add</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setSfxOpen(true)}
          disabled={!sel.messageId}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
        >
          <Volume2 size={13} /> Add sound effect
        </button>
      )
    )}
  </div>
  );
};
