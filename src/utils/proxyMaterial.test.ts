/**
 * Run: npx tsx src/utils/proxyMaterial.test.ts
 *
 * Which of the reader's material goes into a prompt, and in what order.
 *
 * Order is the whole of it. The budget is spent from the top of this list and
 * everything past it is left out, so "what comes first" and "what gets used"
 * are the same question. The rule: **the reader's own order is the priority
 * order.** They picked these things one at a time; nothing here reorders them
 * on a guess about what matters.
 *
 * This replaced a version built on category checkboxes — "pins" on, "sheets"
 * off. That could not say "these four pins", which is the thing anyone actually
 * wants, and it hid the ordering decision entirely.
 */
import {
  DEFAULT_PICK, gatherBlocks, isPicked, listMaterial, normalizePick, pickCount, sheetText,
  togglePick, type MaterialInput, type MaterialPick,
} from './proxyMaterial';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const INPUT: MaterialInput = {
  pins: [
    { id: 'p1', title: 'Anatomy', content: 'Mara has no left arm.' },
    { id: 'p2', title: 'Weather', content: 'It has rained for a week.' },
    { id: 'p3', title: 'Old note', content: 'Something from chapter one.' },
  ],
  sets: [
    { id: 'set1', name: 'This scene', inContext: ['p2'] },
    { id: 'set2', name: 'Backstory', inContext: ['p3'] },
  ],
  activeSetId: 'set1',
  sheets: [{
    id: 's1',
    title: 'Cast',
    columns: ['Name', 'Role'],
    rows: [{ Name: 'Mara', Role: 'lamplighter' }, { Name: 'Ing', Role: 'thief' }],
  }],
  codex: [{ id: 'c1', name: 'The Lamplighters', kind: 'faction', summary: 'They keep the lights.' }],
  highlights: [{ id: 'h1', text: 'the lamp guttered', note: 'recurring image' }],
  zones: [{ id: 'z1', name: 'The argument', body: 'Two messages of it.' }],
};

const pick = (over: Partial<MaterialPick> = {}): MaterialPick =>
  ({ ...DEFAULT_PICK, activeSet: false, ...over });

const titles = (p: MaterialPick) => gatherBlocks(INPUT, p).map(b => b.title);

/* ── What the picker shows ───────────────────────────────────────────────── */
{
  const all = listMaterial(INPUT);
  eq(all.filter(i => i.kind === 'pin').length, 3, 'every pin is offered');
  eq(all.filter(i => i.kind === 'codex').length, 1, 'and the codex');
  eq(all.filter(i => i.kind === 'highlight').length, 1, 'and highlights');
  eq(all.find(i => i.kind === 'set')?.preview, '1 pin in context',
    'a set is described by what it holds, since it has no text of its own');
  ok(all.every(i => i.size >= 0), 'everything says what it would cost');

  const blank: MaterialInput = { ...INPUT, pins: [{ id: 'x', title: 'Blank', content: '  ' }] };
  eq(listMaterial(blank).filter(i => i.kind === 'pin').length, 0,
    'an empty pin is not offered — it would spend a title and say nothing');
}

/* ── Picking ─────────────────────────────────────────────────────────────── */
{
  const one = togglePick(pick(), { id: 'p1', kind: 'pin' });
  eq(one.pins, ['p1'], 'picking adds it');
  ok(isPicked(one, { id: 'p1', kind: 'pin' }), 'and it reads as picked');
  eq(togglePick(one, { id: 'p1', kind: 'pin' }).pins, [], 'picking again removes it');

  // Two things with the same id in different kinds must not collide.
  const both = togglePick(togglePick(pick(), { id: 'x', kind: 'pin' }), { id: 'x', kind: 'sheet' });
  eq(both.pins, ['x'], 'a pin and a sheet with one id are two different picks');
  eq(both.sheets, ['x'], 'both survive');

  const start = pick();
  togglePick(start, { id: 'p1', kind: 'pin' });
  eq(start.pins, [], 'and picking never mutates the pick it was given');

  eq(pickCount(pick({ pins: ['p1'], sheets: ['s1'], zones: ['z1'] })), 3, 'counted across kinds');
  eq(pickCount(pick({ activeSet: true })), 0,
    'the active-set rule is not an item, so it is not counted as one');
}

/* ── The order is the reader's ───────────────────────────────────────────── */
{
  eq(titles(pick({ pins: ['p3', 'p1'] })), ['Old note', 'Anatomy'],
    'picked things go in the order they were picked, not the order they are stored');

  eq(titles(pick({ pins: ['p1'], sheets: ['s1'], codex: ['c1'], zones: ['z1'] })),
    ['Anatomy', 'Cast', 'The Lamplighters', 'The argument'],
    'named things first, and zones last because they are the largest by far');

  // A zone that does not fit should cost itself, not four pins.
  const last = titles(pick({ pins: ['p1', 'p2'], zones: ['z1'] }));
  eq(last[last.length - 1], 'The argument', 'so a zone is always the first thing the budget drops');
}

/* ── Sets ────────────────────────────────────────────────────────────────── */
{
  eq(titles(pick({ sets: ['set2'] })), ['Old note'], 'picking a set brings the pins it holds');

  // The distinction that earns `activeSet` its place: naming a set pins that
  // set forever; the rule follows the reader between scenes.
  eq(titles(pick({ activeSet: true })), ['Weather'], 'the active-set rule brings the ACTIVE set');
  eq(titles({ ...pick({ activeSet: true }) }), ['Weather'], 'whichever one that is');
  eq(gatherBlocks({ ...INPUT, activeSetId: 'set2' }, pick({ activeSet: true })).map(b => b.title),
    ['Old note'], 'and it follows when the reader switches sets');

  eq(titles(pick({ pins: ['p2'], activeSet: true })), ['Weather'],
    'a pin that arrives twice is included once');
  eq(titles(pick({ sets: ['set1'], activeSet: true })), ['Weather'], 'however it arrived');
}

/* ── Placement travels with the pick ─────────────────────────────────────── */
{
  ok(gatherBlocks(INPUT, pick({ pins: ['p1'], slot: 'end' })).every(b => b.slot === 'end'),
    'every block carries where the reader put it');
}

/* ── Nothing picked, nothing added ───────────────────────────────────────── */
{
  eq(gatherBlocks(INPUT, pick()).length, 0,
    'an empty pick is empty — never "well, everything then"');
  eq(titles(pick({ pins: ['gone'], zones: ['gone'] })), [],
    'and an id that no longer exists is not an error, just nothing');
}

/* ── A stored value of the wrong shape ───────────────────────────────────── */
{
  /*
   * The regression this section exists for.
   *
   * This setting persists, and its shape changed: it was category booleans
   * (`pins: true`) before it was a list of ids. A stored `true` reaching
   * `for (const id of pick.pins)` throws, React unmounts the tree, and the
   * packaged app shows a BLACK WINDOW with no console to open. That is what it
   * did. A migration handles this known case; these assertions are about every
   * other shape a stored value can take, because no setting should be able to
   * take the app down.
   */
  const old = { pins: true, sheets: false, zones: [], slot: 'system' } as never;
  eq(normalizePick(old).pins, [], 'the old boolean shape becomes an empty list');
  eq(gatherBlocks(INPUT, old).length >= 0, true, 'and gathering with it does not throw');

  eq(normalizePick(undefined).slot, 'system', 'nothing stored is the default');
  eq(normalizePick('nonsense' as never).pins, [], 'and so is rubbish');
  eq(normalizePick(null).activeSet, true, 'with the rule that keeps prompts useful left on');
  eq(normalizePick({ activeSet: false } as never).activeSet, false,
    'but an explicit "off" is honoured — absent and off are different answers');

  eq(normalizePick({ pins: ['a', 7, null, 'b'] } as never).pins, ['a', 'b'],
    'entries that are not ids are dropped rather than carried into a prompt');
  eq(normalizePick({ slot: 'nowhere' } as never).slot, 'system',
    'and a slot that does not exist falls back rather than placing a block nowhere');
  eq(normalizePick({ slot: 'end' } as never).slot, 'end', 'a real one is kept');

  eq(pickCount(old), 0, 'counting a bad shape is zero, not a crash');
  eq(isPicked(old, { id: 'p1', kind: 'pin' }), false, 'nor is asking whether it holds something');
  eq(togglePick(old, { id: 'p1', kind: 'pin' }).pins, ['p1'],
    'and picking against it recovers into a good one');
}

/* ── Sheets read as lines, not as a grid ─────────────────────────────────── */
{
  eq(sheetText(INPUT.sheets[0]), 'Name: Mara; Role: lamplighter\nName: Ing; Role: thief',
    'a table becomes labelled lines, which a model reads without reconstructing it');
  eq(sheetText({ id: 's', title: 't', columns: ['A'], rows: [] }), '',
    'and an empty sheet is empty rather than a header with nothing under it');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
