/**
 * Run: npx tsx src/utils/uiContext.test.ts
 *
 * Naming the part of the interface the reader is touching.
 *
 * `describeSpot` is the whole idea: the app already labels itself for the
 * guided tours, so an assistant can be told where somebody is without anyone
 * taking a screenshot. These assert the two halves it returns — the app's own
 * name for the REGION, and the human name of the CONTROL — because either alone
 * is not enough to answer "what does this do?".
 *
 * No DOM here, so the elements are the smallest stand-ins that satisfy the two
 * methods used: `closest` and the attribute getters.
 */
import { describeSpot } from './uiContext';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** A stand-in element: `closest` answers from a map of selector → element. */
const el = (opts: {
  attrs?: Record<string, string>;
  text?: string;
  closest?: Record<string, unknown>;
}): Element => ({
  getAttribute: (n: string) => opts.attrs?.[n] ?? null,
  innerText: opts.text ?? '',
  tagName: 'BUTTON',
  closest: (sel: string) => {
    for (const [k, v] of Object.entries(opts.closest ?? {})) if (sel.includes(k)) return v;
    return null;
  },
} as unknown as Element);

/* ── Both halves ─────────────────────────────────────────────────────────── */
{
  const region = el({ attrs: { 'data-tour': 'settings-sync' } });
  const button = el({ attrs: { 'aria-label': 'Two-way sync' } });
  const spot = describeSpot(el({
    closest: { 'data-tour': region, button },
  }));
  eq(spot?.anchor, 'settings-sync',
    "the app's own name for the region — maintained, because renaming it breaks a tour");
  eq(spot?.label, 'Two-way sync', 'and the human name of the thing under the pointer');
}

/* ── The control, not the glyph inside it ────────────────────────────────── */
{
  // Hovering a button's icon must report the button. An icon has no name.
  const button = el({ attrs: { title: 'Ask them again' } });
  const spot = describeSpot(el({ closest: { button } }));
  eq(spot?.label, 'Ask them again', 'an icon reports the control it sits in');
}

/* ── Falling back to what is written on it ───────────────────────────────── */
{
  const plain = el({ text: 'Import stories\nand more' });
  eq(describeSpot(el({ closest: { button: plain } }))?.label, 'Import stories',
    'with no accessible name, the first line of its text will do');
}

/* ── Nothing to say ──────────────────────────────────────────────────────── */
{
  eq(describeSpot(null), null, 'nothing under the pointer is nothing to report');
  eq(describeSpot(el({})), null,
    'and an unlabelled div in an unlabelled region is not worth a round trip');
}

/* ── Length ──────────────────────────────────────────────────────────────── */
{
  const wordy = el({ attrs: { 'aria-label': 'x'.repeat(500) } });
  const spot = describeSpot(el({ closest: { button: wordy } }));
  ok((spot?.label?.length ?? 0) <= 60,
    'a label is a name, not a paragraph — this travels in every guide prompt');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
