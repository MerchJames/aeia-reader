/**
 * The preview a blend has to get past.
 *
 * Nothing is kept until the reader has seen the diff. That is the whole
 * arrangement: `readBlend` refuses the failures it can measure — a summary, an
 * invention, a passage with the reader written out of it — and this shows what
 * is left to the person whose scene it is, because the failures that remain are
 * the ones only they can see.
 *
 * ── Why the diff and not just the new text ─────────────────────────────────
 *
 * A well-written passage reads as correct. Set beside what it replaced, with
 * every removal struck through, the missing sentence is the thing you notice
 * first. Same reason the Lens shows a diff before applying a rewrite.
 *
 * Accepting makes a `LensChain` and selects it. It does not touch the story,
 * and the Overview's own switcher puts the original back in one click.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, RefreshCw, X } from 'lucide-react';
import type { Chain } from '../types';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { blendDiff, describeBlend, makeLensChain } from '../utils/chatterBlend';
import type { BlendRun } from '../hooks/useChatterBlend';
import { DiffView } from './DiffView';

interface BlendModalProps {
  chain: Chain;
  run: BlendRun;
  onRetry: () => void;
  onClose: () => void;
}

export const BlendModal = ({ chain, run, onRetry, onClose }: BlendModalProps) => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const addLensChain = useAuraV2Store(s => s.addLensChain);
  const [label, setLabel] = useState('Blended');

  const accept = () => {
    if (!storyId || !run.source || !run.result?.text) return;
    addLensChain(storyId, makeLensChain(run.source, run.result.text, chain, label.trim() || 'Blended'));
    onClose();
  };

  const ready = !!run.result?.text;

  /*
   * Portalled to the body, and it has to be.
   *
   * This is rendered from inside a chain card in the Overview, and every card
   * is a dnd-kit sortable — which sets `transform` on it so reordering can
   * animate, including when nothing is being dragged. A transformed ancestor
   * becomes the containing block for `position: fixed`, so the overlay stopped
   * covering the viewport and started covering ONE CARD: no backdrop over the
   * page, a dialog laid out inside a hundred pixels of list item, and controls
   * that are not where they appear to be. Every other modal in this app is
   * mounted at the App root, which is why none of them hit it.
   */
  return createPortal((
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-app-border bg-app-bg shadow-2xl"
        data-testid="blend-modal"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border/60 shrink-0">
          <h2 className="text-sm font-semibold flex-1">Chatter Blend</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {run.running && (
            <p className="flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" />
              Weaving the two halves together…
            </p>
          )}

          {run.error && <p className="text-[12px] text-red-500">{run.error}</p>}

          {run.result?.rejected && (
            <div className="space-y-2">
              {/* The refusal in the model's place, not a generic failure. The
                  reader is being told what came back was wrong and why, which
                  is also the information they need to decide whether trying
                  again is worth anything. */}
              <p className="text-[12px] text-amber-500">{run.result.rejected}</p>
              <p className="text-[11px] text-muted">
                Nothing has been changed. A different model, or a second try, often does better
                on this — it is a rearranging job, and some models will not do one.
              </p>
            </div>
          )}

          {ready && run.source && (
            <>
              <p className="text-[11px] text-muted" data-testid="blend-stats">
                {describeBlend(run.result!)}
              </p>
              {run.result!.notes.map(note => (
                <p key={note} className="text-[11px] text-amber-500">{note}</p>
              ))}
              <div className="rounded-lg border border-app-border p-3 bg-app-text/[0.02]">
                <DiffView parts={blendDiff(run.source, run.result!.text)} />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-app-border/60 shrink-0">
          {ready && (
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              aria-label="Name for this version"
              maxLength={24}
              className="text-[11px] rounded-md border border-app-border bg-transparent px-2 py-1 w-32"
            />
          )}
          <div className="flex-1" />
          <button
            onClick={onRetry}
            disabled={run.running}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40"
          >
            <RefreshCw size={11} /> Try again
          </button>
          <button
            onClick={accept}
            disabled={!ready}
            data-testid="blend-accept"
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
          >
            <Check size={11} /> Keep as a version
          </button>
        </div>
      </div>
    </div>
  ), document.body);
};
