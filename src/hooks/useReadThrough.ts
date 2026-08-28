import { useMemo } from 'react';
import { useAppStore } from '../store';
import { balanceEmphasis, truncateToWord } from '../utils/textProcessor';

export interface ReadThrough {
  /** Every passage the reader has reached, in order, plus the one arriving. */
  ids: string[];
  /** Fast membership test for the views that lay the whole story out. */
  has: (id: string) => boolean;
  /** The passage currently revealing, if any. */
  streamingId?: string;
  /** As much of it as has arrived — already balanced and word-truncated. */
  partial: string;
  /** The reader is at the very end of the story. */
  atEnd: boolean;
}

/**
 * How far the reader has got — for views that lay out the WHOLE story.
 *
 * ReaderDisplay, Stage, VN and RPG all show one passage at a time, so "where am
 * I" is simply which passage they are drawing. The Script, Panels and Atlas
 * views draw everything at once, and without this they drew the ending before
 * the reader had read the opening — which is not a stylistic difference, it is
 * a spoiler.
 *
 * The truncation rule is the one every other view already follows: hide the
 * in-progress last word WHILE revealing, and show the passage whole once it is
 * committed, so the end of a passage never looks cut off during the hold.
 */
export const useReadThrough = (): ReadThrough => {
  const visible = useAppStore(s => s.visibleMessages);
  const streaming = useAppStore(s => s.streamingMessage);
  const streamedText = useAppStore(s => s.streamedText);
  const revealComplete = useAppStore(s => s.revealComplete);
  const chains = useAppStore(s => s.chains);

  return useMemo(() => {
    const ids = visible.map(m => m.id);
    if (streaming && !ids.includes(streaming.id)) ids.push(streaming.id);
    const set = new Set(ids);
    const total = chains.reduce((n, c) => n + c.messages.length, 0);
    return {
      ids,
      has: (id: string) => set.has(id),
      streamingId: streaming?.id,
      partial: streaming
        ? balanceEmphasis(revealComplete ? streamedText : truncateToWord(streamedText))
        : '',
      atEnd: !streaming && ids.length >= total,
    };
  }, [visible, streaming, streamedText, revealComplete, chains]);
};
