/**
 * Run: npx tsx src/utils/crossingBoard.test.ts
 *
 * What the Branching board draws, and the one thing it may never drop.
 *
 * The board's whole job is linking two moments in two different chats. Every
 * decision here is downstream of that, and one of them is not a preference:
 *
 * **A linked passage is always drawn.** An edge with an undrawn end cannot be
 * drawn at all, and a link that quietly disappears is indistinguishable from a
 * link that was deleted — on a board whose only content IS the links. So the
 * node cap yields to it: when there are more linked passages than the cap, the
 * cap loses.
 *
 * Everything else is about not showing eight hundred paragraphs at once, which
 * is what the old two-column board did and why finding a beat was the hard part
 * of using it.
 */
import type { Message } from '../types';
import type { Crossing } from './crossing';
import {
  LANE_GAP, LANE_WIDTH, MAX_LANE_NODES, NODE_GAP, NODE_HEIGHT, WINDOW_RADIUS,
  gapIndices, keptIndices, laneX, layoutBoard, linkedIdsFor, matches, rowY, rowsFor,
} from './crossingBoard';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const msg = (i: number, over: Partial<Message> = {}): Message => ({
  id: `m${i}`,
  role: 'ai',
  name: 'Mara',
  content: `Passage number ${i}.`,
  ...over,
});
const story = (n: number, over: (i: number) => Partial<Message> = () => ({})) =>
  Array.from({ length: n }, (_, i) => msg(i, over(i)));

const link = (aId: string, bId: string, aStory = 'A', bStory = 'B'): Crossing => ({
  id: `${aId}-${bId}`,
  kind: 'parallel',
  createdAt: 0,
  a: { storyId: aStory, storyTitle: 'A', messageId: aId, index: 1, name: 'Mara', excerpt: '' },
  b: { storyId: bStory, storyTitle: 'B', messageId: bId, index: 1, name: 'Elara', excerpt: '' },
});

/* ── Finding a passage ───────────────────────────────────────────────────── */
{
  const m = msg(4, { content: 'She set the lamp down between them.', name: 'Elara' });
  ok(matches(m, 4, 'lamp'), 'the words of the passage');
  ok(matches(m, 4, 'LAMP'), 'case-insensitively');
  ok(matches(m, 4, 'elara'), 'and the speaker');
  ok(!matches(m, 4, 'lantern'), 'and nothing else');
  ok(!matches(m, 4, ''), 'an empty query matches nothing rather than everything');
  ok(!matches(m, 4, '   '), 'and neither does whitespace');

  // Numbers are how a reader refers to a beat once they have seen the board.
  ok(matches(m, 4, '5'), '#N finds message N, one-based');
  ok(matches(m, 4, '#5'), 'with or without the hash');
  ok(!matches(m, 4, '4'), 'and does not go looking for it as text');
}

/* ── Which passages are linked ───────────────────────────────────────────── */
{
  const ids = linkedIdsFor([link('m3', 'm7'), link('m9', 'm1', 'B', 'A')], 'A');
  eq(ids.size, 2, 'both ends that belong to this story');
  ok(ids.has('m3') && ids.has('m1'), 'whichever side of the link they were on');
  ok(!ids.has('m7'), 'and none that belong to the other');
}

/* ── The rule: a linked passage is always drawn ──────────────────────────── */
{
  const messages = story(400);
  // Far outside any window, no search, nowhere near the focus.
  const kept = keptIndices(messages, {
    linkedIds: new Set(['m0', 'm399']),
    focusIndex: 200,
  });
  ok(kept.has(0) && kept.has(399), 'a linked passage is kept however far away it is');
  ok(kept.has(200), 'and so is the reader’s own position');

  // The cap yields rather than dropping an edge's end.
  const manyLinks = new Set(story(400).slice(0, MAX_LANE_NODES + 30).map(m => m.id));
  const overCap = keptIndices(messages, { linkedIds: manyLinks, focusIndex: 200 });
  eq(overCap.size >= manyLinks.size, true, 'past the cap, every linked passage still survives');
  for (let i = 0; i < MAX_LANE_NODES + 30; i++) {
    if (!overCap.has(i)) { fail++; console.error('✗ linked passage', i, 'was dropped'); break; }
  }
  pass++;
}

/* ── The window around where the reader is ───────────────────────────────── */
{
  const messages = story(400);
  const kept = keptIndices(messages, { linkedIds: new Set(), focusIndex: 100 });
  ok(kept.has(100), 'the passage the reader is on');
  ok(kept.has(100 - WINDOW_RADIUS) && kept.has(100 + WINDOW_RADIUS), 'and the run around it');
  ok(!kept.has(100 - WINDOW_RADIUS - 1), 'and nothing past that');
  ok(!kept.has(0), 'so a long story does not open on chapter one');
}

/* ── Searching replaces the window ───────────────────────────────────────── */
{
  const messages = story(200, i => ({ content: i === 150 ? 'The salt flats.' : `Passage ${i}.` }));
  const kept = keptIndices(messages, {
    linkedIds: new Set(), query: 'salt flats', focusIndex: 10,
  });
  ok(kept.has(150), 'the hit is drawn');
  ok(!kept.has(10), 'and the window is not — a search is a question, and that is the answer');
  eq(kept.size, 1, 'only the hits');
}

/* ── A lane with nothing to go on shows the opening ──────────────────────── */
{
  // No search, no links, and not the story the reader has open. Drawing nothing
  // looks exactly like a story that failed to load.
  const kept = keptIndices(story(300), { linkedIds: new Set() });
  ok(kept.has(0), 'the first passage is drawn');
  ok(kept.size > 0 && kept.size <= MAX_LANE_NODES, 'and a readable run after it');
  ok(!kept.has(299), 'but not the whole story');

  // A short story is drawn whole — there is no "rest of it" to hide.
  const shortKept = keptIndices(story(5), { linkedIds: new Set() });
  eq(shortKept.size, 5, 'a five-message story is drawn entirely');
}

/* ── Opening a gap ───────────────────────────────────────────────────────── */
{
  const messages = story(200);
  const kept = keptIndices(messages, {
    linkedIds: new Set(), focusIndex: 10, expanded: new Set([180, 181, 182]),
  });
  ok(kept.has(180) && kept.has(182), 'an opened gap brings its passages in');
  ok(!kept.has(179), 'and only those');
}

/* ── Gaps stand in for what is not drawn ─────────────────────────────────── */
{
  const messages = story(20);
  const kept = new Set([0, 1, 10, 19]);
  const rows = rowsFor(messages, kept, new Set(['m10']));

  const kinds = rows.map(r => r.kind).join(',');
  eq(kinds, 'entry,entry,gap,entry,gap,entry', 'gaps sit between the runs that are drawn');

  const gaps = rows.flatMap(r => (r.kind === 'gap' ? [r.gap] : []));
  eq(JSON.stringify(gaps[0]), JSON.stringify({ from: 2, to: 9 }), 'the first gap covers 2–9');
  eq(JSON.stringify(gaps[1]), JSON.stringify({ from: 11, to: 18 }), 'the second covers 11–18');
  eq(gapIndices(gaps[0]).length, 8, 'and can name every passage inside it');

  // `at` is the row's slot in the lane, and it must count gaps too — a gap
  // occupies space, and numbering past it would stack nodes on top of it.
  eq(rows.map(r => r.at).join(','), '0,1,2,3,4,5', 'rows are numbered in drawing order');

  const linked = rows.flatMap(r => (r.kind === 'entry' && r.entry.linked ? [r.entry.index] : []));
  eq(linked.join(','), '10', 'the linked passage is marked as one');

  // Nothing hidden means no gaps at all — an empty marker on a short story
  // would be a piece of furniture standing in for nothing.
  const whole = rowsFor(story(3), new Set([0, 1, 2]), new Set());
  eq(whole.filter(r => r.kind === 'gap').length, 0, 'a fully drawn story has no gap markers');
}

/* ── Where things go ─────────────────────────────────────────────────────── */
{
  eq(laneX(0), 0, 'the first lane is at the origin');
  eq(laneX(2), 2 * (LANE_WIDTH + LANE_GAP), 'and the rest are evenly spaced');
  ok(laneX(1) - laneX(0) > LANE_WIDTH, 'with room between them for the links to travel');
  eq(rowY(1) - rowY(0), NODE_HEIGHT + NODE_GAP, 'rows are a node apart');
  ok(rowY(0) > 0, 'and the first one clears the lane header');
}

/* ── The whole board ─────────────────────────────────────────────────────── */
{
  const lanes = [
    { storyId: 'A', messages: story(60) },
    { storyId: 'B', messages: story(60) },
  ];
  const laid = layoutBoard(lanes, {
    crossings: [link('m5', 'm50')],
    focus: { storyId: 'A', index: 30 },
  });
  eq(laid.length, 2, 'one lane per story');
  eq(laid[0].x, 0, 'in board order');
  eq(laid[1].x, LANE_WIDTH + LANE_GAP, 'side by side');

  const drawnA = laid[0].rows.flatMap(r => (r.kind === 'entry' ? [r.entry.index] : []));
  ok(drawnA.includes(5), 'A draws its end of the link');
  ok(drawnA.includes(30), 'and the reader’s position');
  const drawnB = laid[1].rows.flatMap(r => (r.kind === 'entry' ? [r.entry.index] : []));
  ok(drawnB.includes(50), 'B draws its end of the same link, with no focus of its own');

  eq(laid[0].total, 60, 'each lane knows how long its story is');
  eq(laid[0].hidden, 60 - drawnA.length, 'and how much of it is not on screen');
  ok(laid[0].hidden > 0, 'which for a 60-message story with a window is some of it');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
