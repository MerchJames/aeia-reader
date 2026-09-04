/**
 * Picking what to rewrite, before anything is rewritten.
 *
 * The composer's old Lens strip asked for a message NUMBER. That works when you
 * already know it, and is useless the rest of the time — which is most of the
 * time, because a reader thinks "the bit where she finds the letter", not
 * "message 43". So: search the story, see the passages, tick the ones you mean.
 *
 * Two ways out, which is the point of the modal existing at all:
 *
 *   **Ask the assistant** arms the chat (see `toolArm.ts`) and hands the
 *   selection to the model — the reader then talks about the change in the
 *   conversation, with the targets already locked in.
 *
 *   **Rewrite now** skips the conversation for the common case where the
 *   instruction is one line and there is nothing to discuss.
 *
 * Either way the result is a PROPOSAL, never an edit. Nothing in this file
 * writes to the Lens layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, Sparkles, Wand2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { flatWithIndex } from '../utils/contextZone';
import { resolveContent } from '../utils/lens';
import { clampTargets, MAX_ARM_TARGETS } from '../utils/toolArm';
import { cn } from '../utils/cn';

export interface LensPick {
  index: number;
  messageId: string;
  name: string;
  content: string;
  /** True when this message already shows a Lens rewrite. */
  edited: boolean;
}

interface LensEditModalProps {
  /** Pre-tick these reading positions — the composer's current target, usually. */
  initial?: number[];
  /** Hand the selection to the assistant and close. */
  onArm: (picks: LensPick[], instruction: string) => void;
  /** Rewrite them directly, without a conversation. */
  onRunNow: (picks: LensPick[], instruction: string) => void;
  busy?: boolean;
  onClose: () => void;
}

/** How many rows the list renders before asking the reader to narrow it down. */
const MAX_ROWS = 120;

export const LensEditModal = ({ initial, onArm, onRunNow, busy, onClose }: LensEditModalProps) => {
  const chains = useAppStore(s => s.chains);
  const storyId = useAppStore(s => s.currentStory?.id);
  const currentChainIndex = useAppStore(s => s.currentChainIndex);
  const currentMessageIndex = useAppStore(s => s.currentMessageIndex);
  const overrides = useAuraV2Store(s => (storyId ? s.overridesByStory[storyId] : undefined));
  const lensOn = useAuraV2Store(s => (storyId ? !!s.lensOnByStory[storyId] : false));

  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number[]>(() => clampTargets(initial ?? []));
  const [instruction, setInstruction] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Every message, resolved the way the reader sees it.
   *
   * Through `resolveContent` on purpose: a passage already rewritten once must
   * show its CURRENT text here, or the reader ticks what they can see and the
   * model is handed the imported original to work from.
   */
  const all = useMemo<LensPick[]>(() => {
    const edited = new Set((overrides ?? []).map(o => o.messageId));
    return flatWithIndex(chains).map(f => ({
      index: f.index,
      messageId: f.msg.id,
      name: f.msg.name,
      content: resolveContent(f.msg, overrides, lensOn),
      edited: edited.has(f.msg.id),
    }));
  }, [chains, overrides, lensOn]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // A bare number is a jump, not a search — "43" means message 43, which is
    // what someone who already knows the number will type.
    const asNumber = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : null;
    if (asNumber !== null) return all.filter(r => r.index === asNumber);
    return all.filter(r =>
      r.content.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  }, [all, query]);

  const shown = rows.slice(0, MAX_ROWS);
  const picks = useMemo(
    () => picked.map(i => all.find(r => r.index === i)).filter((r): r is LensPick => !!r),
    [picked, all],
  );
  const atCap = picked.length >= MAX_ARM_TARGETS;

  const toggle = (index: number) => {
    setPicked(prev => (prev.includes(index)
      ? prev.filter(i => i !== index)
      : clampTargets([...prev, index])));
  };

  // Land on what the reader is reading. Opening at message 1 of four hundred
  // is the same as opening on nothing.
  useEffect(() => {
    if (query || picked.length) return;
    const hereId = chains[currentChainIndex]?.messages[currentMessageIndex]?.id;
    const here = all.find(r => r.messageId === hereId);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${here?.index}"]`);
    el?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const canRun = picks.length > 0 && !!instruction.trim() && !busy;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="lens-edit-modal"
    >
      <div className="w-full max-w-3xl max-h-[calc(100dvh-2rem)] flex flex-col rounded-2xl bg-surface border border-app-border shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border shrink-0">
          <Wand2 size={16} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold leading-tight">Lens edit</h2>
            <p className="text-[11px] text-muted leading-tight">
              Pick the passages to rewrite. Nothing changes until you approve it.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-lg hover:bg-app-text/10 opacity-70 hover:opacity-100"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-2.5 border-b border-app-border/60 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-50" size={14} />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search the story, or type a message number…"
              aria-label="Search messages"
              data-testid="lens-search"
              className="w-full pl-8 pr-3 py-2 text-sm bg-app-text/5 border border-transparent rounded-lg outline-none focus:border-accent/50"
            />
          </div>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {!shown.length && (
            <p className="text-xs text-muted text-center py-8">
              {query ? 'Nothing in the story matches that.' : 'This story has no messages yet.'}
            </p>
          )}
          {shown.map(row => {
            const on = picked.includes(row.index);
            return (
              <button
                key={row.messageId}
                data-row={row.index}
                onClick={() => toggle(row.index)}
                disabled={!on && atCap}
                className={cn(
                  'w-full text-left flex gap-2.5 px-2.5 py-2 rounded-lg transition-colors',
                  on ? 'bg-accent/10' : 'hover:bg-app-text/5',
                  !on && atCap && 'opacity-40 cursor-not-allowed',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center',
                    on ? 'bg-accent border-accent text-white' : 'border-app-border',
                  )}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] font-mono text-muted shrink-0">#{row.index}</span>
                    <span className="text-[11px] font-bold truncate">{row.name}</span>
                    {row.edited && (
                      <span
                        className="text-[9px] uppercase tracking-wide text-amber-500 shrink-0"
                        title="This passage already shows a Lens rewrite"
                      >
                        edited
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] leading-snug opacity-70 line-clamp-2">
                    {row.content.replace(/\s+/g, ' ').slice(0, 220)}
                  </span>
                </span>
              </button>
            );
          })}
          {rows.length > MAX_ROWS && (
            <p className="text-[11px] text-muted text-center py-3">
              {rows.length - MAX_ROWS} more — narrow the search to see them.
            </p>
          )}
        </div>

        <div className="border-t border-app-border p-3 space-y-2.5 shrink-0">
          {picks.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="lens-picks">
              {picks.map(p => (
                <button
                  key={p.messageId}
                  onClick={() => toggle(p.index)}
                  title={p.content.replace(/\s+/g, ' ').slice(0, 200)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-accent/15 text-accent hover:bg-accent/25"
                >
                  #{p.index} {p.name}
                  <X size={10} />
                </button>
              ))}
              {atCap && (
                <span className="text-[10px] text-muted self-center">
                  {MAX_ARM_TARGETS} at a time — more than that and the assistant runs out of steps.
                </span>
              )}
            </div>
          )}

          <textarea
            rows={2}
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) onRunNow(picks, instruction.trim());
            }}
            placeholder="What should change? e.g. “make her colder”, “cut the last paragraph”, “rewrite in past tense”"
            aria-label="What should change"
            data-testid="lens-instruction"
            className="w-full resize-none bg-app-text/5 border border-app-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/50"
          />

          <div className="flex items-center gap-2">
            <p className="text-[11px] text-muted min-w-0 flex-1">
              {picks.length === 0
                ? 'Nothing selected yet.'
                : `${picks.length} passage${picks.length === 1 ? '' : 's'} — you'll see every rewrite before it goes in.`}
            </p>
            <button
              onClick={() => onArm(picks, instruction.trim())}
              disabled={!picks.length || busy}
              title="Hand the selection to the assistant and talk about the change first"
              data-testid="lens-arm"
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-app-border hover:bg-app-text/5 disabled:opacity-40"
            >
              <Sparkles size={13} /> Ask the assistant
            </button>
            <button
              onClick={() => onRunNow(picks, instruction.trim())}
              disabled={!canRun}
              data-testid="lens-run"
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-accent text-white disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              Rewrite now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
