/**
 * A rewrite, shown as what it does rather than as two blocks of prose.
 *
 * The reader is being asked to approve a change to their own story, so the
 * question in front of them is "what moved?", not "read these four hundred
 * words twice and spot it". Removed text is struck through in red, new text is
 * highlighted, and everything untouched sits there plainly so the change has
 * something to be a change *against*.
 *
 * New writing — a branch, a message that had no previous version — uses the
 * SAME highlight as added text rather than a colour of its own. It is the same
 * fact from the reader's side ("this is the new material"), and a third colour
 * would be one more thing to learn for no extra meaning.
 *
 * Rendered as plain text, deliberately: markdown, perform marks and scene cues
 * are all part of what is being changed, and rendering them would hide the
 * asterisks and brackets that a revision often exists to move.
 */

import { changeRatio, type DiffPart } from '../utils/textDiff';
import { cn } from '../utils/cn';

interface DiffViewProps {
  parts: readonly DiffPart[];
  /** Show only what changed, with the untouched runs shortened. */
  compact?: boolean;
  className?: string;
}

/**
 * How much untouched text to keep either side of a change in compact mode.
 *
 * Enough to place the edit in its sentence — a highlight with no surroundings
 * is unjudgeable, since "cold" is right or wrong depending entirely on what it
 * is next to.
 */
const CONTEXT_CHARS = 90;

/** Shorten a long unchanged run to its two ends, keeping the paragraph shape. */
const clipSame = (text: string): { text: string; clipped: boolean } => {
  if (text.length <= CONTEXT_CHARS * 2 + 20) return { text, clipped: false };
  return {
    text: `${text.slice(0, CONTEXT_CHARS)}\n\n […] \n\n${text.slice(-CONTEXT_CHARS)}`,
    clipped: true,
  };
};

export const DiffView = ({ parts, compact, className }: DiffViewProps) => (
  <div
    className={cn(
      'whitespace-pre-wrap break-words text-[13px] leading-relaxed font-serif',
      className,
    )}
    data-testid="diff-view"
  >
    {parts.map((part, i) => {
      if (part.type === 'same') {
        const { text, clipped } = compact ? clipSame(part.text) : { text: part.text, clipped: false };
        return (
          <span key={i} className={cn('opacity-60', clipped && 'opacity-40')}>{text}</span>
        );
      }
      if (part.type === 'del') {
        return (
          <span
            key={i}
            data-diff="del"
            className="bg-red-500/15 text-red-400 line-through decoration-red-500/60 rounded-[3px]"
          >
            {part.text}
          </span>
        );
      }
      return (
        <span
          key={i}
          data-diff="add"
          className="bg-emerald-500/20 text-emerald-300 rounded-[3px] underline decoration-emerald-500/40 decoration-1 underline-offset-2"
        >
          {part.text}
        </span>
      );
    })}
  </div>
);

/**
 * The one-line "how much of this moved" bar.
 *
 * A number is easier to disbelieve than a bar. A reader who asked for one word
 * changed and sees three quarters of the passage lit up knows to look properly
 * before approving, and that is the entire job of this strip.
 */
export const DiffMeter = ({ parts }: { parts: readonly DiffPart[] }) => {
  const ratio = changeRatio(parts);
  const pct = Math.round(ratio * 100);
  return (
    <div className="flex items-center gap-2" title={`${pct}% of the passage is different`}>
      <div className="h-1 flex-1 rounded-full bg-app-text/10 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            ratio > 0.6 ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <span className="text-[10px] text-muted tabular-nums shrink-0">{pct}%</span>
    </div>
  );
};
