/**
 * Run: npx tsx src/utils/cut.test.ts
 *
 * The Cut — a story plus the way it was directed, in one file.
 *
 * The assertion this file exists for is the privacy one. A Cut is made to be
 * HANDED TO SOMEONE, and the reader's annotations, interviews, companion
 * reactions, borrowed visitors (who come from other people's private chats) and
 * taste log all live one keystroke away from the direction layer in the same
 * store. Shipping one of them by accident is not a bug report, it is a breach —
 * so the policy is two explicit lists and a test that every persisted slice is
 * named by exactly one of them. A slice added to the store with no decision
 * made about it fails here, loudly, before it can travel.
 */
import {
  CUT_MAGIC, CUT_SLICES, CUT_VERSION, NEVER_IN_A_CUT,
  buildCut, collectDirection, cutFilename, cutToText, describeCut, directionFor, parseCut,
} from './cut';
import { PERSISTED_SLICES } from './v2Persist';
import type { Story } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const STORY: Story = {
  id: 'story-1',
  title: 'A Night at the Hearth',
  format: 'sillytavern',
  characterName: 'Mara',
  userName: 'You',
  messages: [
    { id: 'm1', name: 'Mara', role: 'ai', content: 'The hearth crackled warm.' },
    { id: 'm2', name: 'You', role: 'user', content: 'I lean in.' },
  ],
  messageCount: 2,
  importedAt: 0,
  progress: null,
  highlights: [
    { id: 'h1', messageId: 'm1', text: 'hearth', color: 'amber', note: 'this is where I cried' },
  ],
} as unknown as Story;

const SLICES: Record<string, unknown> = {
  sceneByStory: { 'story-1': { m1: { mood: 'tender' } }, 'story-2': { z: 1 } },
  performMarksByStory: { 'story-1': { m1: [{ text: 'hearth', kind: 'swell' }] } },
  overridesByStory: { 'story-1': [{ messageId: 'm1', kind: 'rewrite', content: 'x' }] },
  // All of these are the reader's private business.
  annotationsByStory: { 'story-1': [{ note: 'I hate this bit' }] },
  askByStory: { 'story-1': [{ text: 'what were you thinking' }] },
  reactionsByStory: { 'story-1': { k: { lines: {} } } },
  visitorsByStory: { 'story-1': [{ name: 'Elara' }] },
  tasteMarks: [{ text: 'hearth', kind: 'swell', track: 'perform', at: 1 }],
};

// THE test. Every persisted slice has had a decision made about it.
{
  const named = new Set([...CUT_SLICES, ...NEVER_IN_A_CUT]);
  const undecided = PERSISTED_SLICES.map(s => s.slice).filter(s => !named.has(s));
  eq(undecided, [],
    'every persisted slice is either safe to share or explicitly private '
    + '(add it to CUT_SLICES or NEVER_IN_A_CUT — do not leave it undecided)');
  const both = CUT_SLICES.filter(s => NEVER_IN_A_CUT.includes(s));
  eq(both, [], 'and no slice is on both lists');
}

// Direction travels; the diary does not.
{
  const cut = buildCut(STORY, SLICES, { exportedAt: 1000 });
  const text = cutToText(cut);
  ok(!!cut.direction.sceneByStory, "the Director's read travels — it is the expensive part");
  ok(!!cut.direction.performMarksByStory, 'and so do the spans marked by hand');
  for (const secret of ['I hate this bit', 'what were you thinking', 'Elara', 'this is where I cried']) {
    ok(!text.includes(secret), `nothing private travels: "${secret}"`);
  }
  for (const slice of NEVER_IN_A_CUT) {
    ok(cut.direction[slice] === undefined, `${slice} is not in the file`);
  }
  eq(cut.story.highlights, [], "the reader's own highlights are stripped from the story record");
}

// Another reader's share of the same slice never rides along.
{
  const direction = collectDirection(SLICES, 'story-1');
  eq(direction.sceneByStory, { m1: { mood: 'tender' } },
    'only this story’s share of a slice is taken');
  ok(!JSON.stringify(direction).includes('story-2'), 'no other story is anywhere in it');
}

// Round trip.
{
  const cut = buildCut(STORY, SLICES, { note: ' for you ', exportedAt: 42 });
  const back = parseCut(cutToText(cut));
  ok(!!back.cut, 'a Cut reads back');
  eq(back.cut?.story.messages.length, 2, 'with its story intact');
  eq(back.cut?.direction.sceneByStory, { m1: { mood: 'tender' } }, 'and its direction');
  eq(back.cut?.note, 'for you', 'a note comes along, trimmed');
  eq(back.cut?.exportedAt, 42, 'and the date it was made');
}

// Fails closed.
{
  ok(!!parseCut('not json').error, 'garbage is refused');
  ok(!!parseCut('{"hello":1}').error, 'so is an ordinary JSON file');
  ok(!!parseCut(JSON.stringify({ magic: CUT_MAGIC, version: CUT_VERSION + 5, story: STORY })).error,
    'and a Cut from a newer build says so rather than half-reading it');
  ok(!!parseCut(JSON.stringify({ magic: CUT_MAGIC, version: 1, story: { ...STORY, messages: [] } })).error,
    'an empty Cut is not a Cut');
}

// A hand-edited file cannot smuggle a slice in.
{
  const forged = JSON.stringify({
    magic: CUT_MAGIC, version: 1, story: STORY,
    direction: {
      sceneByStory: { m1: { mood: 'tender' } },
      annotationsByStory: [{ note: 'planted' }],
      tasteMarks: [{ text: 'x' }],
    },
  });
  const { cut } = parseCut(forged);
  ok(!!cut, 'it still opens');
  ok(cut!.direction.annotationsByStory === undefined, 'but a private slice named in the file is dropped');
  ok(cut!.direction.tasteMarks === undefined, 'the reader on the RECEIVING end is protected too');
  eq(cut!.story.highlights, [], 'and highlights a file claims are dropped as well');
}

// Re-keying, so two copies of the same Cut cannot collide in one library.
{
  const cut = buildCut(STORY, SLICES);
  const wants = directionFor(cut, 'fresh-id');
  const scene = wants.find(w => w.slice === 'sceneByStory');
  ok(!!scene?.value['fresh-id'], "the direction is re-keyed to this machine's id");
  ok(!JSON.stringify(wants).includes('story-1'), 'the sender’s story id is gone entirely');
}

// The summary the export dialog has to be honest with.
{
  const s = describeCut(buildCut(STORY, SLICES));
  eq(s.passages, 2, 'passages counted');
  eq(s.words, 7, 'words counted');
  eq(s.directed, 1, 'and how much of it the Director has read');
  eq(s.marks, 1, 'hand marks counted');
  eq(s.edits, 1, 'Lens edits counted');
  eq(s.art, 0, 'and the pictures that will NOT travel, so the dialog can say so');
  ok(s.bytes > 100, 'the size is real, not an estimate');
  ok(s.carrying.includes('sceneByStory') && !s.carrying.includes('sandboxByStory'),
    'and it lists only what is actually carrying something');
}

// Filenames.
{
  eq(cutFilename('A Night at the Hearth'), 'a-night-at-the-hearth.cut.json', 'a readable name');
  eq(cutFilename('  ???  '), 'story.cut.json', 'and a fallback for a title made of punctuation');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
