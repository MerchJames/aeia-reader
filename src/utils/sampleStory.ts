/**
 * A short story that exists so the tours have something to point at.
 *
 * ── Why this is here ───────────────────────────────────────────────────────
 *
 * Four of the seven guided tours are about reading, the Lens, the workspace and
 * the passages themselves, and none of them mean anything without a story open.
 * The picker used to grey those out with "Open a story first", which is a
 * correct sentence and a dead end: the reader who most needs the tour of the
 * Lens is the one who has not imported anything yet and cannot see what any of
 * it is for.
 *
 * So there is a sample. It is a real story object through the real pipeline —
 * the same chains, the same reveal, the same Lens, the same Overview — because
 * a fake screen would teach the reader where the fake screen's buttons are.
 *
 * ── What makes it never touch their library ────────────────────────────────
 *
 * One id and one guard. `persistNow` in the store writes the open story to
 * IndexedDB from twenty-odd call sites — every pause, every setting, every
 * close — and every one of those would otherwise deposit this in somebody's
 * shelf as if they had imported it. The guard is on the write, not on the call
 * sites, because there is no version of this where remembering to check at
 * twenty places is the safe design.
 *
 * ── Why the middle exchange is written the way it is ───────────────────────
 *
 * It is the Chatter Blend example, and it has to be a genuine one: three things
 * done in one turn, answered all at once in the reply, in the order they were
 * done. That is the shape the feature exists to fix, so the tour stop that
 * points at Blend has a passage the feature can actually improve rather than a
 * demonstration that quietly does nothing.
 *
 * Pure: no store, no React, no storage.
 */

import type { Message, Story } from '../types';

/** Recognised by the store's save guard. Never collides: real ids carry a timestamp. */
export const SAMPLE_STORY_ID = 'aeia-sample-story';

export const isSampleStory = (id: string | undefined | null): boolean =>
  id === SAMPLE_STORY_ID;

const CHARACTER = 'Mara';
const USER = 'You';

const msg = (n: number, role: 'user' | 'ai', content: string): Message => ({
  id: `${SAMPLE_STORY_ID}-m${n}`,
  role,
  name: role === 'user' ? USER : CHARACTER,
  content,
});

/**
 * Six messages, three chains.
 *
 * Three, because the Overview needs a list rather than a single row, the
 * reading tour needs somewhere to play from, and the blend tour needs a chain
 * that is not the one the reader happens to be standing on.
 */
const MESSAGES: Message[] = [
  msg(1, 'user', 'I push the door open with my shoulder. *"Anyone home?"*'),

  msg(2, 'ai',
    'The hinges give with a sound like something waking up. Inside, the hearth has '
    + 'burned down to a red seam, and the room smells of wet wool and old smoke.\n\n'
    + '*"Shut it behind you,"* Mara says from the far chair, without turning round. '
    + '*"You are letting the weather in."*'),

  // The Chatter Blend example: three beats in one turn, answered in a block.
  msg(3, 'user',
    'I shoulder the door closed and drop the satchel by the step. I cross to the '
    + 'hearth and crouch to feed it a handful of kindling. *"The bridge is out at '
    + 'Cawley,"* I say, *"and nobody at the mill would tell me why."*'),

  msg(4, 'ai',
    '*"Good. It sticks."* Mara watches the satchel land and says nothing about it. '
    + 'The kindling catches, and for a moment there is more light in the room than '
    + 'there has been all week. *"The bridge went in the spring flood. It has been '
    + 'out for a month."* She finally turns. *"And they would not tell you because '
    + 'the last person who asked went to look."*'),

  msg(5, 'user', '*"Went to look, or went and looked?"*'),

  msg(6, 'ai',
    'Mara does not answer that. She reaches down beside the chair, and what she '
    + 'puts on the table between them is a boot — one boot, river-black, the '
    + 'leather gone soft as cloth.\n\n'
    + '*"Ask me again in the morning,"* she says.'),
];

/**
 * The story, built fresh each time.
 *
 * Not a module constant: the reader can highlight it, rewrite it through the
 * Lens and blend a passage of it during a tour, and the next tour should start
 * from the same clean page rather than from whatever the last one left behind.
 */
export const buildSampleStory = (): Story => ({
  id: SAMPLE_STORY_ID,
  title: 'A sample chat',
  format: 'sillytavern',
  characterName: CHARACTER,
  userName: USER,
  messageCount: MESSAGES.length,
  importedAt: Date.now(),
  messages: MESSAGES.map(m => ({ ...m })),
  highlights: [],
  // No progress: a tour of the reading controls should start at the beginning,
  // not halfway through wherever the last one got to.
  progress: null,
});
