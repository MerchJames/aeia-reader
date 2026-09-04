/**
 * The gate between a suggested rewrite and the reader's story.
 *
 * `lens.propose` cannot write; all it can do is put a row here. This panel is
 * the only place in the app where a proposal becomes a `setOverride`, and it
 * only does that under a click.
 *
 * What it has to get right is that the reader can actually JUDGE the change:
 * the diff, the instruction that produced it, and — because a model asked to
 * make a line colder will sometimes hand back a rewritten paragraph — how much
 * of the passage moved, stated up front rather than left to be discovered.
 */

import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2, Trash2, Wand2, X } from 'lucide-react';
import { DiffMeter, DiffView } from './DiffView';
import {
  pendingProposals, proposalDiff, summarizeProposal, type LensProposal,
} from '../utils/lensProposal';
import { cn } from '../utils/cn';

interface ProposalReviewProps {
  proposals: readonly LensProposal[];
  onApply: (p: LensProposal) => void;
  onDiscard: (p: LensProposal) => void;
  /** Apply every pending one, in reading order. */
  onApplyAll: () => void;
  busy?: boolean;
  onClose: () => void;
}

export const ProposalReview = ({
  proposals, onApply, onDiscard, onApplyAll, busy, onClose,
}: ProposalReviewProps) => {
  const pending = pendingProposals(proposals);
  const settled = proposals.filter(p => p.state !== 'pending').slice(-6).reverse();

  return (
    <div className="absolute inset-0 z-20 bg-surface flex flex-col" data-testid="proposal-review">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border shrink-0">
        <Wand2 size={15} className="text-accent" />
        <span className="text-sm font-medium">
          Suggested edits{pending.length ? ` (${pending.length})` : ''}
        </span>
        <div className="flex-1" />
        {pending.length > 1 && (
          <button
            onClick={onApplyAll}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40"
            title="Apply every suggestion below"
          >
            Apply all
          </button>
        )}
        <button onClick={onClose} className="p-1 rounded hover:bg-app-text/10" title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!pending.length && (
          <div className="text-center py-8 space-y-1">
            <p className="text-xs text-muted">Nothing waiting on you.</p>
            <p className="text-[11px] text-muted/70">
              Ask the assistant to rewrite a passage, or use the Lens edit button.
            </p>
          </div>
        )}

        {pending.map(p => (
          <ProposalCard
            key={p.id}
            proposal={p}
            busy={busy}
            onApply={() => onApply(p)}
            onDiscard={() => onDiscard(p)}
          />
        ))}

        {settled.length > 0 && (
          <div className="pt-2 border-t border-app-border/60 space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted px-0.5">Recently decided</p>
            {settled.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-[11px] px-0.5 py-1">
                <span className={cn(
                  'shrink-0',
                  p.state === 'applied' ? 'text-emerald-500' : 'text-muted',
                )}>
                  {p.state === 'applied' ? <Check size={12} /> : <Trash2 size={12} />}
                </span>
                <span className="font-mono text-muted shrink-0">#{p.index}</span>
                <span className="truncate opacity-70">{p.instruction || p.name}</span>
                <span className="ml-auto text-muted shrink-0">
                  {p.state === 'applied' ? 'applied' : 'discarded'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const ProposalCard = ({
  proposal, busy, onApply, onDiscard,
}: {
  proposal: LensProposal;
  busy?: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) => {
  const parts = proposalDiff(proposal);
  const summary = summarizeProposal(proposal);
  /**
   * Big changes open expanded, small ones open compact.
   *
   * A one-word swap inside four hundred words is unreadable at full length —
   * the highlight is a speck. A wholesale rewrite compacted is worse: the […]
   * hides most of what is being agreed to. So the default follows the change.
   */
  const [expanded, setExpanded] = useState(summary.ratio > 0.5 || proposal.kind === 'branch');

  return (
    <div className="rounded-lg border border-app-border overflow-hidden" data-testid="proposal-card">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-app-text/[0.03] border-b border-app-border/60">
        <span className="text-[10px] font-mono text-muted shrink-0">#{proposal.index}</span>
        <span className="text-[11px] font-bold truncate">{proposal.name}</span>
        {proposal.kind === 'branch' && (
          <span className="text-[9px] uppercase tracking-wide text-emerald-400 shrink-0">new</span>
        )}
        <span className="text-[10px] text-muted ml-auto shrink-0">{summary.line}</span>
        <button
          onClick={() => setExpanded(v => !v)}
          className="p-0.5 rounded hover:bg-app-text/10 opacity-60 hover:opacity-100 shrink-0"
          title={expanded ? 'Show only what changed' : 'Show the whole passage'}
          aria-label={expanded ? 'Show only what changed' : 'Show the whole passage'}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {proposal.instruction && (
        <p className="px-2.5 pt-2 text-[11px] text-muted italic truncate" title={proposal.instruction}>
          “{proposal.instruction}”
        </p>
      )}

      <div className="px-2.5 py-2 max-h-64 overflow-y-auto">
        <DiffView parts={parts} compact={!expanded} />
      </div>

      <div className="px-2.5 pb-2">
        <DiffMeter parts={parts} />
      </div>

      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-app-border/60">
        <span className="text-[10px] text-muted min-w-0 flex-1">
          {proposal.source === 'ai' ? 'Suggested by the assistant' : 'Your rewrite'}
        </span>
        <button
          onClick={onDiscard}
          disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded-md hover:bg-app-text/10 opacity-70 hover:opacity-100 disabled:opacity-30"
        >
          Discard
        </button>
        <button
          onClick={onApply}
          disabled={busy}
          data-testid="proposal-apply"
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Apply
        </button>
      </div>
    </div>
  );
};
