/**
 * Run: npx tsx src/utils/workspaceLayout.test.ts
 *
 * The Workspace's columns, and the states they may not reach.
 *
 * The reader drags panels between columns and drags column edges to resize.
 * Both gestures can reach a workspace nobody wants and both are PERSISTED, so a
 * bad one is still there tomorrow with nothing on screen explaining it: a
 * column of no width, a column holding nothing, the same panel mounted twice
 * fighting itself for focus, or the text gone entirely — a set of tools with
 * nothing to use them on.
 *
 * So the properties, in the order they would hurt:
 *
 *   1. **The text panel always exists.** It is the story.
 *   2. **Every panel is in exactly one place.**
 *   3. **Widths always sum to 1, and none is below the floor.** A column you
 *      cannot see is a column whose own edge you cannot grab to widen.
 *   4. **A broken stored layout costs a default, never a blank screen.**
 *   5. **Locked means locked** — the two mutating operations refuse, and
 *      nothing else needs to know.
 *
 * Plus the migration: every reader who has opened the Workspace has the OLD
 * shape in localStorage, and it says enough to reconstruct what they had.
 */
import {
  DEFAULT_LAYOUT, LAYOUT_PRESETS, LIMITS, MAX_COLUMNS, MIN_COLUMN, PANELS,
  addPanel, evenColumns, findPanel, gridTemplate, hasPanel, matchingPreset, movePanel,
  normalizeWidths, passageStyle, patchLayout, removePanel, resizeColumn, sanitizeLayout,
  textStyle, type LayoutPreset, type PanelId, type WorkspaceLayout,
} from './workspaceLayout';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};
const near = (a: number, b: number, msg: string) => ok(Math.abs(a - b) < 1e-9, msg);

/** Every layout that leaves this module must be renderable. */
const usable = (l: WorkspaceLayout, label: string) => {
  ok(l.columns.length > 0, `${label}: has at least one column`);
  ok(l.columns.length <= MAX_COLUMNS, `${label}: and no more than the ceiling`);
  near(l.columns.reduce((n, c) => n + c.width, 0), 1, `${label}: widths sum to the full width`);
  ok(l.columns.every(c => c.width >= MIN_COLUMN - 1e-9),
    `${label}: no column is too narrow to see or to grab`);
  ok(l.columns.every(c => c.panels.length > 0), `${label}: no column is empty`);
  const all = l.columns.flatMap(c => c.panels);
  eq(new Set(all).size, all.length, `${label}: no panel appears twice`);
  ok(all.includes('text'), `${label}: the story is on screen`);
  ok(l.leading >= LIMITS.leading[0] && l.leading <= LIMITS.leading[1], `${label}: readable line height`);
  ok(l.fontSize >= LIMITS.fontSize[0] && l.fontSize <= LIMITS.fontSize[1], `${label}: readable text size`);
};

const build = (columns: [number, PanelId[]][], locked = false): WorkspaceLayout =>
  sanitizeLayout({
    ...DEFAULT_LAYOUT,
    locked,
    columns: columns.map(([width, panels], i) => ({ id: `c${i}`, width, panels })),
  });

/* ── The defaults and the presets ────────────────────────────────────────── */
{
  usable(DEFAULT_LAYOUT, 'the default');
  (Object.keys(LAYOUT_PRESETS) as LayoutPreset[]).forEach(k => {
    usable(LAYOUT_PRESETS[k].layout, `preset ${k}`);
    eq(matchingPreset(LAYOUT_PRESETS[k].layout), k, `preset ${k} recognises itself`);
  });
  eq(matchingPreset(build([[0.5, ['text']], [0.5, ['sheets']]])), null,
    'and an arrangement of the reader’s own is not mistaken for one');

  // Locking does not change the arrangement, so a locked Draft is still Draft —
  // otherwise the preset chips would all go dark the moment you locked.
  const locked = { ...LAYOUT_PRESETS.draft.layout, locked: true };
  eq(matchingPreset(locked), 'draft', 'a locked preset is still that preset');

  // The one this whole rewrite was for.
  const cowrite = LAYOUT_PRESETS.cowrite.layout;
  eq(cowrite.columns.length, 3, 'Cowrite is three columns');
  eq(cowrite.columns[1].panels[0], 'assistant', 'with the assistant in the middle one');
  ok(hasPanel(cowrite, 'text') && hasPanel(cowrite, 'pins'),
    'and the text and the notes either side');
}

/* ── A broken stored layout costs a default ──────────────────────────────── */
{
  const junk: unknown[] = [null, undefined, 0, '', 'draft', [], true];
  junk.forEach(v => {
    const l = sanitizeLayout(v);
    usable(l, `sanitize(${JSON.stringify(v)})`);
  });

  usable(sanitizeLayout({ columns: [] }), 'no columns at all');
  usable(sanitizeLayout({ columns: [{ panels: [] }] }), 'a column holding nothing');
  usable(sanitizeLayout({ columns: [{ width: NaN, panels: ['text'] }] }), 'a NaN width');
  usable(sanitizeLayout({ columns: [{ width: 0, panels: ['text'] }, { width: 0, panels: ['pins'] }] }),
    'two zero-width columns');
  usable(sanitizeLayout({ columns: [{ width: -5, panels: ['text'] }] }), 'a negative width');
  usable(sanitizeLayout({ columns: [{ width: 1, panels: ['nonsense', 'text'] }] }),
    'a panel from a newer build');
  usable(sanitizeLayout({ columns: [{ width: 1, panels: ['text'] }], fontSize: 900 }),
    'an absurd font size');
}

/* ── The text panel is not optional ──────────────────────────────────────── */
{
  const noText = sanitizeLayout({ columns: [{ width: 1, panels: ['pins', 'sheets'] }] });
  ok(hasPanel(noText, 'text'), 'a stored layout with no text gets it back');
  eq(noText.columns[0].panels[0], 'text', 'at the front of the first column');

  const removed = removePanel(build([[0.5, ['text']], [0.5, ['pins']]]), 'text');
  ok(hasPanel(removed, 'text'), 'and it cannot be removed');
}

/* ── Every panel in exactly one place ────────────────────────────────────── */
{
  const dupe = sanitizeLayout({
    columns: [
      { width: 0.5, panels: ['text', 'pins'] },
      { width: 0.5, panels: ['pins', 'sheets'] },
    ],
  });
  const all = dupe.columns.flatMap(c => c.panels);
  eq(all.filter(p => p === 'pins').length, 1, 'a duplicated panel is kept once');
  eq(findPanel(dupe, 'pins')?.column, 0, 'in the first place it appeared — where the reader put it');
  ok(all.includes('sheets'), 'and its neighbours are untouched');
}

/* ── Widths ──────────────────────────────────────────────────────────────── */
{
  const odd = normalizeWidths([
    { id: 'a', width: 3, panels: ['text'] },
    { id: 'b', width: 1, panels: ['pins'] },
  ]);
  near(odd[0].width + odd[1].width, 1, 'any set of widths is scaled to fill');
  near(odd[0].width, 0.75, 'in proportion');

  const even = evenColumns(build([[0.8, ['text']], [0.1, ['pins']], [0.1, ['sheets']]]));
  near(even.columns[0].width, 1 / 3, 'evening out gives equal shares');
  usable(even, 'evened');
}

/* ── Resizing an edge ────────────────────────────────────────────────────── */
{
  const l = build([[0.5, ['text']], [0.5, ['pins']]]);
  const wider = resizeColumn(l, 0, 0.1);
  near(wider.columns[0].width, 0.6, 'the column grows');
  near(wider.columns[1].width, 0.4, 'and its neighbour gives up exactly that much');
  near(wider.columns[0].width + wider.columns[1].width, 1, 'nothing is created or lost');

  // Refused, not clamped: a clamp means the edge keeps tracking the pointer
  // while nothing moves, which reads as a stuck drag rather than a limit.
  eq(resizeColumn(l, 0, 0.9), l, 'a drag past the floor is refused outright');
  eq(resizeColumn(l, 0, -0.9), l, 'in either direction');
  eq(resizeColumn(l, 1, 0.1), l, 'the last edge has nothing to trade with');
  eq(resizeColumn(l, 9, 0.1), l, 'and neither does one that is not there');
  eq(resizeColumn(l, 0, NaN), l, 'a NaN delta changes nothing');

  const third = build([[0.4, ['text']], [0.3, ['pins']], [0.3, ['sheets']]]);
  const mid = resizeColumn(third, 1, 0.05);
  near(mid.columns[0].width, 0.4, 'resizing an inner edge leaves the outer columns alone');
}

/* ── Moving a panel ──────────────────────────────────────────────────────── */
{
  const l = build([[0.6, ['text']], [0.4, ['pins', 'sheets']]]);

  const moved = movePanel(l, 'sheets', 0, 1);
  eq(findPanel(moved, 'sheets')?.column, 0, 'a panel lands in the column it was dropped on');
  eq(findPanel(moved, 'sheets')?.at, 1, 'at the position it was dropped at');
  usable(moved, 'after a move');

  // Emptying a column removes it, or the workspace keeps a gap the reader can
  // neither see nor fill.
  const emptied = movePanel(movePanel(l, 'pins', 0), 'sheets', 0);
  eq(emptied.columns.length, 1, 'a column emptied by a move goes away');
  near(emptied.columns[0].width, 1, 'and its width goes to what is left');

  // Dropping past the last column splits the workspace — the "add column"
  // gesture, without an add-column button.
  const split = movePanel(l, 'sheets', 2);
  eq(split.columns.length, 3, 'dropping past the end makes a new column');
  eq(findPanel(split, 'sheets')?.column, 2, 'holding the panel that was dropped');
  usable(split, 'after a split');
  ok(split.columns[2].width >= MIN_COLUMN, 'and it is wide enough to have been worth making');

  // Taking a whole column and putting it in a new one is a no-op — it would
  // churn ids and widths for no visible change.
  const solo = build([[0.6, ['text']], [0.4, ['pins']]]);
  eq(movePanel(solo, 'pins', 2), solo, 'moving a lone panel to a new column changes nothing');

  const full = build([[0.25, ['text']], [0.25, ['pins']], [0.25, ['sheets']], [0.25, ['sets', 'branches']]]);
  eq(movePanel(full, 'branches', 4), full, 'and the column ceiling holds');

  eq(movePanel(l, 'assistant', 0), l, 'a panel that is not on screen cannot be moved');
}

/* ── Adding and removing ─────────────────────────────────────────────────── */
{
  // A summoned panel must be VISIBLE. This used to append to the last column
  // whatever was already in it, so asking for a panel could get you a sliver
  // at the bottom of a column you were not looking at — indistinguishable, from
  // the reader's chair, from the button doing nothing at all.
  const one = build([[1, ['text']]]);
  const withAi = addPanel(one, 'assistant');
  eq(withAi.columns.length, 2, 'adding to a single-column workspace splits it');
  eq(findPanel(withAi, 'assistant')?.column, 1, 'the newcomer takes the new column');
  ok(findPanel(withAi, 'text')?.column === 0, 'and does not displace the text');
  usable(withAi, 'after adding');

  eq(addPanel(withAi, 'assistant'), withAi, 'adding something already on screen does nothing');

  const two = build([[0.6, ['text']], [0.4, ['pins']]]);
  const three = addPanel(two, 'sheets');
  eq(three.columns.length, 3, 'with room for a column, a newcomer gets one of its own');
  eq(three.columns[0].panels.join(), 'text', 'the text keeps its column');
  eq(three.columns[1].panels.join(), 'sheets', 'and the newcomer sits beside the widest');
  eq(three.columns[1].panels.length, 1, 'alone, so it is actually readable');
  usable(three, 'after adding a third column');

  // The widest column is the one that can afford to give up half its width.
  const lopsided = addPanel(build([[0.2, ['text']], [0.8, ['pins']]]), 'sheets');
  eq(findPanel(lopsided, 'sheets')?.column, 2, 'the split happens beside the widest column');
  ok((lopsided.columns[0].width ?? 0) > 0.15, 'and the narrow one is not made narrower');

  // Only at the ceiling does it stack — and then into the emptiest column, not
  // whichever happens to be last.
  const full = build([
    [0.25, ['text', 'pins']], [0.25, ['sheets']], [0.25, ['branches']], [0.25, ['sets']],
  ]);
  const stacked = addPanel(full, 'assistant');
  eq(stacked.columns.length, MAX_COLUMNS, 'at the ceiling no new column is made');
  ok(findPanel(stacked, 'assistant')!.column !== 0,
    'and it does not pile onto the column that already has two');
  eq(stacked.columns[findPanel(stacked, 'assistant')!.column].panels.length, 2,
    'it joins one of the single-panel columns');
  usable(stacked, 'after stacking at the ceiling');

  const gone = removePanel(three, 'sheets');
  ok(!hasPanel(gone, 'sheets'), 'and it can be taken away again');
  usable(gone, 'after removing');

  const lastOne = removePanel(build([[0.6, ['text']], [0.4, ['pins']]]), 'pins');
  eq(lastOne.columns.length, 1, 'removing the only panel of a column removes the column');
  near(lastOne.columns[0].width, 1, 'and the text takes the whole width');

  // Summoning everything must leave a workspace you can still use.
  let all = build([[1, ['text']]]);
  for (const p of PANELS) all = addPanel(all, p.id);
  ok(PANELS.every(p => hasPanel(all, p.id)), 'every panel can be on screen at once');
  usable(all, 'with everything on');
  ok(all.columns.every(c => c.panels.length <= 2),
    'and none of them is buried under a pile of others');
}

/* ── Locked means locked ─────────────────────────────────────────────────── */
{
  const l = build([[0.6, ['text']], [0.4, ['pins', 'sheets']]], true);
  eq(resizeColumn(l, 0, 0.1), l, 'a locked workspace does not resize');
  eq(movePanel(l, 'sheets', 0), l, 'and does not rearrange');

  // Locking must not MOVE anything: the reader locked it because it was where
  // they wanted it.
  const unlocked = build([[0.6, ['text']], [0.4, ['pins', 'sheets']]]);
  eq(JSON.stringify(patchLayout(unlocked, { locked: true }).columns),
    JSON.stringify(unlocked.columns),
    'turning the lock on leaves the arrangement exactly as it was');

  // Adding and removing stay available: they are menu choices, not gestures,
  // and the lock is about not knocking things with the pointer.
  ok(hasPanel(addPanel(l, 'assistant'), 'assistant'), 'a panel can still be summoned while locked');
}

/* ── The legacy layout every existing reader has ─────────────────────────── */
{
  const old = {
    side: 'left', textWidth: 58, edgeGap: 2, leading: 1.7,
    paragraphGap: 1, fontSize: 17, rail: 'sheets', railOpen: true,
  };
  const migrated = sanitizeLayout(old);
  usable(migrated, 'migrated');
  eq(migrated.columns.length, 2, 'the old text column and rail become two columns');
  eq(migrated.columns[0].panels[0], 'text', 'text on the left, as it was');
  eq(migrated.columns[1].panels[0], 'sheets', 'and the rail keeps the panel it was showing');
  near(migrated.columns[0].width, 0.58, 'at the width it had');
  eq(migrated.fontSize, 17, 'and the typography comes across');

  const right = sanitizeLayout({ ...old, side: 'right', rail: 'pins' });
  eq(right.columns[0].panels[0], 'pins', 'a right-hand text column puts the rail first');
  eq(right.columns[1].panels[0], 'text', 'and the text second');

  const closed = sanitizeLayout({ ...old, railOpen: false });
  eq(closed.columns.length, 1, 'a closed rail migrates to a single column');
  near(closed.columns[0].width, 1, 'holding everything');
}

/* ── Rendering ───────────────────────────────────────────────────────────── */
{
  const l = build([[0.6, ['text']], [0.4, ['pins']]]);
  const track = gridTemplate(l);
  eq(track.split(' ').length, 2, 'one grid track per column');
  ok(track.includes('%'), 'sized in percentages, so the grid scales with the window');

  eq(textStyle(l).fontSize, `${l.fontSize}px`, 'the text takes its size from the layout');
  eq(textStyle(l).lineHeight, l.leading, 'and its leading');
  eq(passageStyle(l).marginBottom, `${l.paragraphGap}em`, 'and passages take their spacing');
}

/* ── The panel catalogue ─────────────────────────────────────────────────── */
{
  const ids = PANELS.map(p => p.id);
  eq(new Set(ids).size, ids.length, 'every panel is listed once');
  ok(PANELS.every(p => p.label && p.hint), 'and each one says what it is');
  ok(ids.includes('assistant'),
    'including the assistant, which used to float over this view rather than live in it');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
