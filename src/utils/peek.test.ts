/**
 * Run: npx tsx src/utils/peek.test.ts
 *
 * What counts as "text you can tap to read".
 *
 * The rule has to be decided by LOOKING at what was clicked, not by a list of
 * blessed paragraphs — a list only ever covers the three someone wrapped by
 * hand, and wrapping them changes their spacing, which was the first attempt
 * and the reason for this one.
 */
import { proseAt, peekState, setPeekActive, showPeek, subscribePeek } from './peek';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** A stand-in element chain: `parentElement` walks up, `closest` finds controls. */
const node = (text: string, opts: { control?: boolean; parent?: any } = {}): any => ({
  innerText: text,
  parentElement: opts.parent ?? null,
  closest: (sel: string) => (opts.control && sel.includes('button') ? {} : null),
});

const LONG = 'The Director reads each passage mood, location and feeling so the reader can adapt.';

/* ── Prose ───────────────────────────────────────────────────────────────── */
{
  eq(proseAt(node(LONG)), LONG, 'a paragraph of real text is readable');
  eq(proseAt(null), null, 'and nothing is not');
  eq(proseAt(node('Volume')), null,
    'a word is a label, not prose — opening a reading panel for it answers a question '
    + 'nobody asked');
}

/* ── The click lands deep; the reader meant the sentence ─────────────────── */
{
  // Clicking a <b> in the middle of a sentence must read the sentence.
  const sentence = node(LONG);
  const bold = node('mood', { parent: sentence });
  eq(proseAt(bold), LONG, 'a click inside a phrase walks up to the sentence around it');
}

/* ── Controls are refused ────────────────────────────────────────────────── */
{
  eq(proseAt(node(LONG, { control: true })), null,
    'a control is refused however much text is on it — otherwise every click in peek '
    + 'mode does something, and the mode becomes a trap');
}

/* ── It gives up rather than climbing to the whole page ──────────────────── */
{
  let el = node('x');
  for (let i = 0; i < 12; i++) el = node('y', { parent: el });
  // Walking to the top would return the entire document's text.
  eq(proseAt(el), null, 'the walk is bounded — the answer is never "the whole screen"');
}

/* ── The mode ────────────────────────────────────────────────────────────── */
{
  const seen: boolean[] = [];
  const stop = subscribePeek(s => seen.push(s.active));
  setPeekActive(true);
  showPeek(LONG);
  eq(peekState().text, LONG, 'what is being read is published');
  setPeekActive(false);
  eq(peekState().text, '', 'and switching the mode off clears it — leaving the last '
    + 'paragraph loaded would reopen on something the reader has moved past');
  ok(seen.length >= 2, 'subscribers hear about it');
  stop();
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
