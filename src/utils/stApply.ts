/**
 * Bringing SillyTavern's side of a sync back INTO the story.
 *
 * `stSync.ts` does two thirds of the job: it aligns our messages against the
 * file and it writes our edits back out. The third — taking what ST has gained
 * or changed and making it part of the story here — is this file. Without it a
 * sync is one-directional and the reader has to re-import to see anything they
 * wrote in ST since, which throws away every highlight, note, pin and Lens edit
 * attached to the messages they already had.
 *
 * Three rules carry it, and all three are about not losing things.
 *
 * **Nothing is ever deleted.** A message we hold that ST no longer does is
 * KEPT, in place, and merely reported. In ST, "gone" is usually not a decision:
 * rewinding a few messages to regenerate is the single most common thing anyone
 * does there, and a sync that mirrored it would take the reader's highlights,
 * notes and scene art down with messages that are about to come back. If the
 * reader genuinely wants them gone they can delete them here, deliberately,
 * with the message in front of them.
 *
 * **A message that exists on both sides keeps its identity.** Highlights,
 * annotations, Lens overrides, generated art and pins are all keyed by
 * `Message.id`. So a paired row reuses the existing message's id even when
 * every other field is replaced — rebuilding it fresh would silently orphan
 * everything the reader had attached to it, which looks exactly like the app
 * losing their work.
 *
 * **Taking THEIR version of a conflict must also drop OUR override.** This one
 * is not obvious and it is the reason this file has tests. If the reader picks
 * "theirs" on a message they had also rewritten, and we update `content` but
 * leave the Lens override alone, the Lens is on so the reader still sees their
 * own old text: the button they just pressed appears to have done nothing at
 * all. The override has to go with it.
 *
 * Pure: no store, no React, no DOM. The caller applies the plan.
 */

import type { Message } from '../types';
import { messageFromStObject } from './parser';
import type { SyncRow } from './stSync';

/**
 * What a pull would do, computed before anything is written.
 *
 * The panel shows these counts and the reader presses the button; nothing here
 * touches the store, so a plan can be built, displayed and thrown away.
 */
export interface PullPlan {
  /** The story's complete new message list, in reading order. */
  messages: Message[];
  /** Messages ST has that we did not. */
  added: number;
  /** Messages whose text we are taking from ST. */
  updated: number;
  /** Ours that ST no longer has. Kept, never removed — reported only. */
  keptMissing: number;
  /**
   * Message ids whose Lens override must be dropped as part of this.
   *
   * Only ever a conflict the reader resolved as "theirs": they have chosen
   * ST's wording over their own, so the override that would keep showing
   * their own is no longer something they asked for.
   */
  clearOverrides: string[];
  /** True when applying this would change nothing. */
  empty: boolean;
}

/** Names to fall back on for a message ST left unnamed. */
export interface PullNames {
  characterName?: string;
  userName?: string;
}

/**
 * Should this row's text come across?
 *
 * `theirs` is ST changing something we had not touched — a re-swipe, an edit
 * made over there. `conflict` only crosses when the reader has explicitly said
 * so. Everything else stays as it is: `ours` goes the other way, `pushed` is
 * already agreed, and `same` is same.
 */
const takesTheirs = (row: SyncRow): boolean =>
  row.status === 'theirs'
  || (row.status === 'conflict' && row.resolution === 'theirs');

/**
 * Build the story's new message list from an alignment.
 *
 * Row order IS reading order — `alignSync` walks both sides forward — so this
 * rebuilds the list by walking the rows once, which places a message ST
 * inserted in the middle where ST has it rather than at the end.
 *
 * `newId` mints ids for messages we have never seen. It is a parameter rather
 * than an import so a test can make the output deterministic, and so the caller
 * can use whatever id scheme the rest of the story is using.
 */
export const planPull = (
  rows: readonly SyncRow[],
  /**
   * The story's messages as they stand. Rows carry only the two strings a
   * comparison needs, so the real message — with its images, swipes and, above
   * all, its id — is looked up here by `OurMessage.id`.
   */
  existing: readonly Message[],
  newId: () => string,
  names: PullNames = {},
): PullPlan => {
  const byId = new Map(existing.map(m => [m.id, m]));
  const messages: Message[] = [];
  const clearOverrides: string[] = [];
  let added = 0;
  let updated = 0;
  let keptMissing = 0;

  for (const row of rows) {
    if (row.status === 'added-there') {
      const built = row.theirs?.obj
        ? messageFromStObject(row.theirs.obj, newId(), names)
        : null;
      // `messageLines` already refused the empty ones, so a null here means the
      // row was built from something that is not a message at all. Skipping is
      // right: inventing a blank message would put a gap in the reader's story.
      if (built) { messages.push(built); added++; }
      continue;
    }

    if (row.status === 'missing-there') {
      const kept = row.ours ? byId.get(row.ours.id) : undefined;
      if (kept) { messages.push(kept); keptMissing++; }
      continue;
    }

    const mine = row.ours ? byId.get(row.ours.id) : undefined;
    if (!mine) continue;

    if (!takesTheirs(row) || !row.theirs?.obj) {
      messages.push(mine);
      continue;
    }

    const built = messageFromStObject(row.theirs.obj, mine.id, names);
    if (!built) { messages.push(mine); continue; }

    messages.push({
      ...built,
      // Identity is ours to keep — see the note at the top of this file.
      id: mine.id,
      // Not something ST models. It is set by the document importer to start a
      // new page, and rebuilding from an ST line would quietly drop it.
      startsChain: mine.startsChain,
    });
    updated++;
    if (row.status === 'conflict') clearOverrides.push(mine.id);
  }

  return {
    messages,
    added,
    updated,
    keptMissing,
    clearOverrides,
    empty: added === 0 && updated === 0,
  };
};

/**
 * A one-line account of what a pull will do, for the button that does it.
 *
 * Says "keeping" rather than "deleting" for the missing ones on purpose: it is
 * the reassurance a reader looking at "8 messages are no longer in SillyTavern"
 * actually needs before pressing anything.
 */
export const describePull = (plan: PullPlan): string => {
  const parts: string[] = [];
  if (plan.added) parts.push(`${plan.added} new message${plan.added === 1 ? '' : 's'}`);
  if (plan.updated) parts.push(`${plan.updated} updated`);
  if (!parts.length) return 'Nothing to bring in.';
  let s = `Bring in ${parts.join(' and ')}.`;
  if (plan.keptMissing) {
    s += ` ${plan.keptMissing} message${plan.keptMissing === 1 ? '' : 's'} here `
      + `${plan.keptMissing === 1 ? 'is' : 'are'} no longer in SillyTavern; `
      + 'keeping them.';
  }
  return s;
};
