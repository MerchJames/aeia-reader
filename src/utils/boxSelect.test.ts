/**
 * Run: npx tsx src/utils/boxSelect.test.ts
 *
 * The frame tool's decisions.
 *
 * Three properties carry this file.
 *
 * **A click is not a frame.** The tool sits over the whole reading area, so
 * every stray tap reaches it. If a 2px drag produced a capture, the reader
 * would get a popover full of actions every time they went to dismiss
 * something.
 *
 * **A frame captures what it covers, and nothing else.** Half a word counts;
 * the word past the edge does not. Both directions matter — capturing too
 * little drops the first and last word of every frame, capturing too much makes
 * a quote nobody can trust, and this text goes on to be pinned, read aloud and
 * quoted back to a model.
 *
 * **Two paragraphs do not become one sentence.** The words come back as text,
 * and a line WRAP is not a break the writer made while a paragraph break is.
 * Getting that backwards fabricates prose.
 */
import {
  CAPTURE_RATIO, MIN_DRAG, boxAnchor, capture, capturedBy, describeCapture,
  dominantMessage, isRealBox, joinCaptured, normalizeBox, overlapRatio,
} from './boxSelect';
import type { BoxRect, WordRect } from './boxSelect';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};
const near = (a: number, b: number, msg: string) => ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

const box = (left: number, top: number, width: number, height: number): BoxRect =>
  ({ left, top, width, height });

/** A word on a 20px line, laid out left to right. */
const word = (text: string, left: number, top: number, messageId = 'm1'): WordRect =>
  ({ text, rect: box(left, top, text.length * 8, 18), messageId });

/* ── A drag is a rectangle, in any direction ─────────────────────────────── */
{
  eq(normalizeBox(10, 20, 60, 90), box(10, 20, 50, 70), 'dragged down-right');
  eq(normalizeBox(60, 90, 10, 20), box(10, 20, 50, 70), 'dragged up-left is the same box');
  eq(normalizeBox(60, 20, 10, 90), box(10, 20, 50, 70), 'and down-left');
  eq(normalizeBox(40, 40, 40, 40), box(40, 40, 0, 0), 'a click is a zero box');
}

/* ── A click is not a frame ──────────────────────────────────────────────── */
{
  ok(!isRealBox(box(0, 0, 0, 0)), 'a click makes nothing');
  ok(!isRealBox(box(0, 0, MIN_DRAG - 1, MIN_DRAG + 40)), 'a thin vertical smear is a slip');
  // The one that actually happens: dragging along a line while meaning to select.
  ok(!isRealBox(box(0, 0, 400, 3)), 'a 400×3 smear across a line is a slip, not a frame');
  ok(isRealBox(box(0, 0, MIN_DRAG, MIN_DRAG)), 'the smallest real frame counts');
  ok(isRealBox(box(0, 0, 300, 80)), 'and an ordinary one');
}

/* ── What the frame caught ───────────────────────────────────────────────── */
{
  const b = box(100, 100, 100, 100);
  near(overlapRatio(box(120, 120, 40, 40), b), 1, 'a word fully inside is all of it');
  near(overlapRatio(box(0, 0, 10, 10), b), 0, 'a word nowhere near is none of it');
  near(overlapRatio(box(200, 100, 40, 40), b), 0, 'touching the edge exactly is not overlap');
  near(overlapRatio(box(180, 120, 40, 40), b), 0.5, 'half in is half');
  near(overlapRatio(box(120, 120, 0, 40), b), 0, 'a zero-width word cannot be captured');

  ok(capturedBy(box(180, 120, 40, 40), b), 'exactly half counts — the edge word is the aimed-at one');
  ok(!capturedBy(box(185, 120, 40, 40), b), 'less than half does not');
  eq(CAPTURE_RATIO, 0.5, 'and the threshold is half, stated once');
}

/* ── Which passage the frame belongs to ──────────────────────────────────── */
{
  // The frame clipped one line of the passage above and covered four of this one.
  const words = [
    word('tail', 0, 0, 'above'),
    word('one', 0, 20), word('two', 40, 20), word('three', 80, 20), word('four', 140, 20),
  ];
  eq(dominantMessage(words), 'm1',
    'the frame belongs to the passage it caught the most of, not the first it touched');
  eq(dominantMessage([]), undefined, 'an empty frame belongs to nothing');
  eq(dominantMessage([{ text: 'x', rect: box(0, 0, 8, 18) }]), undefined,
    'words outside any passage anchor nowhere');

  // A tie has to be stable, or the same frame anchors differently twice.
  const tie = [word('a', 0, 0, 'p1'), word('b', 0, 20, 'p2')];
  eq(dominantMessage(tie), 'p1', 'a tie goes to the earlier passage, every time');
  eq(dominantMessage([...tie].reverse()), 'p2', 'which is decided by order, not by name');
}

/* ── Putting the words back together ─────────────────────────────────────── */
{
  eq(joinCaptured([word('She', 0, 0), word('did', 30, 0), word('not', 60, 0)]),
    'She did not', 'words on a line join with spaces');

  // A wrap is where the column ended, not where the writer stopped.
  eq(joinCaptured([word('the', 200, 0), word('only', 0, 20), word('question', 40, 20)]),
    'the only question', 'a line wrap is a space');

  // A real gap is a paragraph, and running them together writes a sentence
  // nobody wrote.
  eq(joinCaptured([word('otherwise.', 0, 0), word('"You', 0, 60)]),
    'otherwise.\n\n"You', 'a paragraph gap stays a paragraph gap');

  eq(joinCaptured([word('end.', 0, 0, 'm1'), word('Start', 0, 20, 'm2')]),
    'end.\n\nStart', 'a new passage always breaks, however close it sits');

  eq(joinCaptured([]), '', 'an empty frame is empty text');
  eq(joinCaptured([word('alone', 0, 0)]), 'alone', 'one word is one word');
}

/* ── The capture, and how it is described ────────────────────────────────── */
{
  const c = capture([word('one', 0, 0), word('two', 40, 0), word('three', 0, 20, 'm2')]);
  eq(c.text, 'one two\n\nthree', 'the text');
  eq(c.messageId, 'm1', 'the passage');
  eq(c.words, 3, 'the count');
  eq(c.messages, 2, 'and how many passages it crossed');

  eq(describeCapture(capture([])), 'Nothing in the frame', 'an empty frame says so');
  eq(describeCapture(capture([word('x', 0, 0)])), '1 word', 'one word is singular');
  eq(describeCapture(capture([word('x', 0, 0), word('y', 20, 0)])), '2 words', 'two is plural');
  eq(describeCapture(c), '3 words across 2 passages',
    'a frame that crossed passages says so — the reader needs to know before pinning it');
}

/* ── Where the card hangs ────────────────────────────────────────────────── *
 * Off the BOTTOM edge. A frame is drawn top-down by nearly everyone, so the
 * hand finishes at the bottom — a card above the box appears behind where the
 * reader was just looking. */
{
  const a = boxAnchor(box(100, 200, 300, 80));
  eq(a.x, 250, 'centred horizontally on the frame');
  eq(a.y, 200, 'the top edge, for the popover’s flip measurement');
  eq(a.bottom, 280, 'and the bottom edge, which is where it actually hangs');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
