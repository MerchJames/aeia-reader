/**
 * A Lens edit the assistant wants to make, waiting on the reader's yes.
 *
 * ── Why this is a staging area and not a write ─────────────────────────────
 *
 * Every other agent tool changes something the reader can shrug at. A pin is
 * additive and versioned; a bad one is noise. A Lens override is different — it
 * changes what the story SAYS on the page, silently, everywhere, and the reader
 * may not reread that passage for an hour. "The assistant rewrote message 40
 * while you were talking about something else" is not a feature.
 *
 * So `lens.propose` cannot write. It can only put a proposal here, and the only
 * thing that turns a proposal into an override is a person clicking Apply. That
 * is enforced by the tool surface rather than by the panel remembering to ask:
 * there is no code path from a model's reply to `setOverride`, and there is no
 * way to add one without deleting this module.
 *
 * ── Revision vs. new writing ───────────────────────────────────────────────
 *
 * A proposal knows which of the two it is, because they deserve different
 * colours in the preview. Revising an existing passage is a diff — the reader
 * needs to see the eleven words that moved inside four hundred that didn't.
 * Writing a NEW branch has no before, so a diff is all-green noise; what the
 * reader needs there is simply the new text, marked as new.
 *
 * Proposals are deliberately NOT persisted. An unapproved edit that survives a
 * reload is an edit nobody remembers agreeing to.
 *
 * Pure: no store, no React.
 */

import { changeRatio, diffStats, diffWords, isNoopChange, type DiffPart } from './textDiff';

/** What the proposal does to the passage — decides how the preview reads. */
export type ProposalKind = 'revision' | 'branch';

export type ProposalState = 'pending' | 'applied' | 'discarded';

export interface LensProposal {
  id: string;
  messageId: string;
  /** 1-based reading position — the number the rest of the app shows. */
  index: number;
  /** Speaker, for the header. */
  name: string;
  /** What the message shows RIGHT NOW, resolved through any existing override. */
  before: string;
  /** What it would show. */
  after: string;
  kind: ProposalKind;
  /** The instruction that produced it, shown so the reader can judge the result against the ask. */
  instruction?: string;
  /** 'ai' when a tool call staged it, 'user' when the modal did. */
  source: 'ai' | 'user';
  createdAt: number;
  state: ProposalState;
}

let seq = 0;
/** Ids are per-session and never stored, so a counter is enough and is stable in tests. */
export const proposalId = (): string => `lp${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface ProposalInput {
  messageId: string;
  index: number;
  name: string;
  before: string;
  after: string;
  kind?: ProposalKind;
  instruction?: string;
  source?: 'ai' | 'user';
}

/**
 * Build a proposal, deciding for itself whether it is a revision or new writing.
 *
 * The caller may say, but usually doesn't need to: an empty `before` is new
 * writing by definition, and anything else is a revision.
 */
export const makeProposal = (input: ProposalInput): LensProposal => ({
  id: proposalId(),
  messageId: input.messageId,
  index: input.index,
  name: input.name,
  before: input.before,
  after: input.after,
  kind: input.kind ?? (input.before.trim() ? 'revision' : 'branch'),
  instruction: input.instruction,
  source: input.source ?? 'ai',
  createdAt: Date.now(),
  state: 'pending',
});

/** The parts a preview renders. A new branch has no before worth diffing. */
export const proposalDiff = (p: LensProposal): DiffPart[] =>
  p.kind === 'branch'
    ? (p.after ? [{ type: 'add' as const, text: p.after }] : [])
    : diffWords(p.before, p.after);

export interface ProposalSummary {
  added: number;
  removed: number;
  /** 0..1 — how much of the passage the highlight covers. */
  ratio: number;
  /** True when applying this would change nothing a reader could see. */
  empty: boolean;
  /** One line for the review header. */
  line: string;
}

/** What the review header says about a proposal, without rendering it. */
export const summarizeProposal = (p: LensProposal): ProposalSummary => {
  const parts = proposalDiff(p);
  const { added, removed } = diffStats(parts);
  const empty = p.kind === 'revision'
    ? isNoopChange(p.before, p.after)
    : !p.after.trim();
  const word = (n: number) => `${n} word${n === 1 ? '' : 's'}`;
  const line = empty
    ? 'No change — the rewrite matches what is already there.'
    : p.kind === 'branch'
      ? `New passage, ${word(added)}.`
      : removed === 0 ? `+${word(added)}.`
        : added === 0 ? `−${word(removed)}.`
          : `+${word(added)}, −${word(removed)}.`;
  return { added, removed, ratio: changeRatio(parts), empty, line };
};

/**
 * Reject a proposal that would be pointless or destructive to apply.
 *
 * A blank `after` is the one that matters. `resolveContent` already refuses to
 * show a blank override — so applying one would leave the reader with an edit
 * badge on a message that reads exactly as it did, and no way to understand
 * why. Better to never make it.
 */
export const proposalProblem = (p: LensProposal): string | null => {
  if (!p.after.trim()) return 'The rewrite is empty, so there is nothing to apply.';
  if (p.kind === 'revision' && isNoopChange(p.before, p.after)) {
    return 'The rewrite is the same as the passage it replaces.';
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

/**
 * Add a proposal, replacing any earlier pending one for the same message.
 *
 * Two pending edits to message 12 is not a choice a reader wants to make — the
 * second one was asked for BECAUSE the first was wrong, so the first is dead.
 * Applied and discarded ones stay put; they are history, not a queue.
 */
export const queueProposal = (
  queue: readonly LensProposal[],
  next: LensProposal,
): LensProposal[] => [
  ...queue.filter(p => !(p.state === 'pending' && p.messageId === next.messageId)),
  next,
];

/** Mark one proposal, leaving the rest alone. */
export const settleProposal = (
  queue: readonly LensProposal[],
  id: string,
  state: ProposalState,
): LensProposal[] => queue.map(p => (p.id === id ? { ...p, state } : p));

/** The ones still waiting, oldest first — the order the reader reviews them in. */
export const pendingProposals = (queue: readonly LensProposal[]): LensProposal[] =>
  queue.filter(p => p.state === 'pending').sort((a, b) => a.index - b.index || a.createdAt - b.createdAt);

/**
 * Drop the settled ones once they are no longer interesting.
 *
 * Kept small on purpose: this lives in component state for one session, and the
 * applied ones are already visible as Lens edits in the manager, which is the
 * real record.
 */
export const KEEP_SETTLED = 12;
export const trimProposals = (queue: readonly LensProposal[]): LensProposal[] => {
  const settled = queue.filter(p => p.state !== 'pending');
  if (settled.length <= KEEP_SETTLED) return queue as LensProposal[];
  const drop = new Set(settled.slice(0, settled.length - KEEP_SETTLED).map(p => p.id));
  return queue.filter(p => !drop.has(p.id));
};
