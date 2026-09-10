/**
 * Run: npx tsx src/utils/sampleStory.test.ts
 *
 * The sample is not decoration — it is what four of the seven guided tours are
 * pointed at, and it goes through the real reading pipeline. Two things can go
 * wrong with it and neither throws:
 *
 *   1. it stops having the STRUCTURE the tours assume (enough chains to make a
 *      list, a passage the Blend tour can actually blend), so a stop explains a
 *      feature over a screen where that feature does nothing;
 *   2. its id drifts from the one the store's save guard checks, and the sample
 *      quietly lands in somebody's library as though they had imported it.
 *
 * The second is the one worth being careful about: it is a write, it is
 * permanent, and the reader has no reason to expect it.
 */

import { blendProblem, blendSource } from './chatterBlend';
import { SAMPLE_STORY_ID, buildSampleStory, isSampleStory } from './sampleStory';
import type { Chain, Message } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++; else { fail++; console.error('✗', msg); }
};
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const story = buildSampleStory();

/* ── The guard that keeps it out of the library ──────────────────────────── */

ok(isSampleStory(story.id), 'the sample recognises itself');
ok(!isSampleStory('st-abc-1'), 'and an imported story is not it');
ok(!isSampleStory(undefined) && !isSampleStory(null), 'neither is nothing');
ok(
  story.messages.every(m => m.id.startsWith(SAMPLE_STORY_ID)),
  // So that a v2 slice written during a tour — a pin, a blend, a highlight —
  // is recognisable as the sample's afterwards.
  'and every message it holds is named after it',
);

/* ── Enough shape for the tours to point at ──────────────────────────────── */

eq(story.messageCount, story.messages.length, 'the count matches what is in it');
ok(story.messages.length >= 6, 'there is enough of it to read');
eq(story.progress, null,
  // A tour of the playback controls that opens halfway through has already
  // skipped past the thing it is about to explain.
  'and it always opens at the beginning');

const roles = story.messages.map(m => m.role).join(',');
ok(/^user,ai(,user,ai)+$/.test(roles), `it alternates turns properly (${roles})`);

// A chain here is one user turn plus the reply to it, which is what the store
// builds. Three of them, because the Overview needs a list rather than one row.
const chains = story.messages.reduce<Chain[]>((acc, m) => {
  if (m.role === 'user' || !acc.length) {
    acc.push({ id: `chain-${m.id}`, messages: [m], starred: false });
  } else {
    acc[acc.length - 1].messages.push(m);
  }
  return acc;
}, []);
ok(chains.length >= 3, `it makes ${chains.length} passages, enough for the Overview to be a list`);

/* ── The one the Blend tour points at ────────────────────────────────────── */

/*
 * The middle exchange has to be a genuine example of the problem: several
 * things done in one turn, answered all at once. Without it the Blend stop
 * explains a feature that, run on this story, would correctly refuse to do
 * anything — which is a worse demonstration than not having one.
 */
const blendable = chains.filter(c => !blendProblem(c));
ok(blendable.length > 0, 'at least one passage can actually be blended');

const multiBeat = chains
  .map(c => blendSource(c))
  .filter((s): s is NonNullable<typeof s> => !!s)
  // Two sentences of the reader doing things, and dialogue in the same turn.
  .filter(s => s.userText.split(/(?<=\.)\s+/).length >= 3 && s.userText.includes('"'));
ok(
  multiBeat.length > 0,
  'and one of them is the real case: several things done in one turn, answered in a block',
);

/* ── Fresh every time ────────────────────────────────────────────────────── */

const second = buildSampleStory();
ok(story !== second && story.messages !== second.messages, 'each call builds its own copy');
(story.messages[0] as Message).content = 'scribbled on';
ok(
  second.messages[0].content !== 'scribbled on',
  // The reader can highlight it, rewrite it through the Lens and blend a
  // passage of it during a tour. The next tour should start from a clean page.
  'so a tour that edits it cannot leave marks on the next one',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
