/**
 * How the Workspace arranges itself: columns you drag panels between.
 *
 * The Workspace is the cowriting view — the text, and everything you work on it
 * with. It used to be one movable text column plus a fixed 320px rail that
 * shuffled through pins, sets, sheets and branchlines one at a time, all of it
 * driven by five sliders.
 *
 * That was the wrong shape twice over. The sliders made you describe an
 * arrangement in numbers ("width 58, edge gap 2") instead of making it; and the
 * rail could only show ONE of the four things at once, so the arrangement the
 * view exists for — the text here, the assistant beside it, the notes beside
 * that — could not be expressed at all. The assistant was not even in the
 * Workspace; it floated over the top of it.
 *
 * So: COLUMNS. A column has a width and a stack of panels; a panel is dragged
 * from one column to another; a column edge is dragged to resize. The presets
 * become whole arrangements rather than five numbers each.
 *
 * ── Why lock is a first-class state ────────────────────────────────────────
 *
 * Because a panel header is both a title and a drag handle, and a column edge
 * is both a border and a resize grip. Once an arrangement is right, every one
 * of those is a thing to knock by accident on the way to a button. Locked, the
 * layout renders identically and refuses both gestures — which is why the lock
 * lives here rather than in the component: `movePanel` and `resizeColumn` are
 * the two functions that must know, and everything else can stay ignorant.
 *
 * ── What may not happen ────────────────────────────────────────────────────
 *
 * Same discipline as `panelDock` next door: the interesting part is what the
 * numbers may NOT be. A column can be dragged to nothing and a panel can be
 * dragged out of existence, and both are persisted, so both are still wrong
 * tomorrow with nothing on screen explaining why. Hence: a floor on column
 * width, a ceiling on column count, every panel at most once, and the text
 * panel can never be removed — it is the story, and a workspace without it is a
 * set of tools with nothing to use them on.
 *
 * Pure: no store, no React, no DOM.
 */

/** Everything that can occupy a column. */
export type PanelId = 'text' | 'assistant' | 'pins' | 'sets' | 'sheets' | 'branches';

export const PANELS: readonly { id: PanelId; label: string; hint: string }[] = [
  { id: 'text', label: 'Text', hint: 'The story, editable in place.' },
  { id: 'assistant', label: 'Assistant', hint: 'The reading assistant, in a column of its own.' },
  { id: 'pins', label: 'Pins', hint: 'Documents you keep beside the story.' },
  { id: 'sets', label: 'Sets', hint: 'Groups of pins, switched together.' },
  { id: 'sheets', label: 'Sheets', hint: 'Tables you fill in as you read.' },
  { id: 'branches', label: 'Branchlines', hint: 'Alternate takes on this passage.' },
];

export const isPanel = (v: unknown): v is PanelId =>
  PANELS.some(p => p.id === v);

export interface WorkspaceColumn {
  id: string;
  /** Share of the workspace's width. The columns' widths always sum to 1. */
  width: number;
  /** Panels stacked top to bottom. */
  panels: PanelId[];
}

export interface WorkspaceLayout {
  columns: WorkspaceColumn[];
  /** While true, panels cannot be moved and columns cannot be resized. */
  locked: boolean;
  /** Line spacing multiplier for the text panel, 1.2–2.4. */
  leading: number;
  /** Paragraph gap in em, 0–2.5. */
  paragraphGap: number;
  /** Text size in px, 13–26. */
  fontSize: number;
}

/**
 * A column narrower than this is a column you cannot read anything in, and —
 * worse — one whose own edge is hard to grab to widen again.
 */
export const MIN_COLUMN = 0.14;
export const MAX_COLUMNS = 4;

export const LIMITS = {
  leading: [1.2, 2.4],
  paragraphGap: [0, 2.5],
  fontSize: [13, 26],
} as const;

const clampTo = (value: number, [lo, hi]: readonly [number, number]): number =>
  (Number.isFinite(value) ? Math.min(Math.max(value, lo), hi) : lo);

let seq = 0;
const columnId = () => `col${Date.now().toString(36)}${(seq++).toString(36)}`;

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  columns: [
    { id: 'col-text', width: 0.58, panels: ['text'] },
    { id: 'col-rail', width: 0.42, panels: ['pins', 'branches'] },
  ],
  locked: false,
  leading: 1.7,
  paragraphGap: 1,
  fontSize: 17,
};

/* ------------------------------------------------------------------ */
/* Making a stored layout renderable                                   */
/* ------------------------------------------------------------------ */

/** Scale a set of widths so they sum to 1, with none below the floor. */
export const normalizeWidths = (columns: WorkspaceColumn[]): WorkspaceColumn[] => {
  if (!columns.length) return columns;
  const floored = columns.map(c => ({
    ...c,
    width: Number.isFinite(c.width) ? Math.max(MIN_COLUMN, c.width) : MIN_COLUMN,
  }));
  const total = floored.reduce((n, c) => n + c.width, 0);
  return floored.map(c => ({ ...c, width: c.width / total }));
};

/**
 * The old layout, read as a new one.
 *
 * Every reader who has opened the Workspace has the previous shape in
 * localStorage — `{side, textWidth, rail, railOpen, …}`. Throwing it away and
 * showing the default would be a small betrayal on upgrade, and the old shape
 * says enough to reconstruct the arrangement it meant: which side the text was
 * on, how wide, and whether the rail was showing.
 */
const fromLegacy = (v: Record<string, unknown>): WorkspaceLayout | null => {
  if (!('textWidth' in v) && !('side' in v) && !('rail' in v)) return null;
  const textWidth = clampTo(Number(v.textWidth ?? 58), [30, 85] as const) / 100;
  const railOpen = v.railOpen !== false;
  const rail = typeof v.rail === 'string' && isPanel(v.rail) ? v.rail : 'pins';
  const text: WorkspaceColumn = { id: 'col-text', width: textWidth, panels: ['text'] };
  const side = v.side === 'right' ? 'right' : 'left';
  const columns = railOpen
    ? (side === 'right'
      // The rail was always on the far side from the text.
      ? [{ id: 'col-rail', width: 1 - textWidth, panels: [rail] }, text]
      : [text, { id: 'col-rail', width: 1 - textWidth, panels: [rail] }])
    : [{ ...text, width: 1 }];
  return {
    columns: normalizeWidths(columns),
    locked: false,
    leading: clampTo(Number(v.leading ?? 1.7), LIMITS.leading),
    paragraphGap: clampTo(Number(v.paragraphGap ?? 1), LIMITS.paragraphGap),
    fontSize: clampTo(Number(v.fontSize ?? 17), LIMITS.fontSize),
  };
};

/**
 * Make a stored layout renderable.
 *
 * Everything falls back rather than throwing: a layout is a preference, and a
 * half-written one should cost the reader a default, never a blank screen. The
 * two repairs that matter are a panel appearing twice (it would be mounted
 * twice, and the second would fight the first for focus) and the text panel
 * going missing (nothing to work on).
 */
export const sanitizeLayout = (value: unknown): WorkspaceLayout => {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LAYOUT };
  const v = value as Record<string, unknown>;

  const legacy = fromLegacy(v);
  if (legacy) return legacy;

  const seen = new Set<PanelId>();
  const raw = Array.isArray(v.columns) ? v.columns : [];
  let columns: WorkspaceColumn[] = raw
    .slice(0, MAX_COLUMNS)
    .map((c, i): WorkspaceColumn => {
      const col = (c ?? {}) as Record<string, unknown>;
      const panels = (Array.isArray(col.panels) ? col.panels : [])
        .filter(isPanel)
        // A panel may live in exactly one place. Duplicates are dropped rather
        // than merged: the first position is the one the reader last chose.
        .filter(p => !seen.has(p) && (seen.add(p), true));
      return {
        id: typeof col.id === 'string' && col.id ? col.id : `col${i}`,
        width: Number(col.width),
        panels,
      };
    })
    // A column with nothing in it is a gap the reader cannot see or fill.
    .filter(c => c.panels.length > 0);

  if (!columns.length) return { ...DEFAULT_LAYOUT };
  // The story is not optional.
  if (!seen.has('text')) columns[0] = { ...columns[0], panels: ['text', ...columns[0].panels] };

  columns = normalizeWidths(columns);
  return {
    columns,
    locked: v.locked === true,
    leading: clampTo(Number(v.leading ?? DEFAULT_LAYOUT.leading), LIMITS.leading),
    paragraphGap: clampTo(Number(v.paragraphGap ?? DEFAULT_LAYOUT.paragraphGap), LIMITS.paragraphGap),
    fontSize: clampTo(Number(v.fontSize ?? DEFAULT_LAYOUT.fontSize), LIMITS.fontSize),
  };
};

/** Change one field, keeping the whole thing legal. */
export const patchLayout = (
  layout: WorkspaceLayout, patch: Partial<WorkspaceLayout>,
): WorkspaceLayout => sanitizeLayout({ ...layout, ...patch });

/* ------------------------------------------------------------------ */
/* Arranging                                                           */
/* ------------------------------------------------------------------ */

/** Which column holds a panel, and where in its stack. */
export const findPanel = (
  layout: WorkspaceLayout, panel: PanelId,
): { column: number; at: number } | null => {
  for (let c = 0; c < layout.columns.length; c++) {
    const at = layout.columns[c].panels.indexOf(panel);
    if (at !== -1) return { column: c, at };
  }
  return null;
};

/** Is this panel on screen at all? */
export const hasPanel = (layout: WorkspaceLayout, panel: PanelId): boolean =>
  findPanel(layout, panel) !== null;

/**
 * Move a panel to a position in a column.
 *
 * `toColumn === layout.columns.length` means "a new column at the end", which
 * is how a reader splits their workspace without a separate "add column"
 * button — they drag something past the last edge and a column appears.
 */
export const movePanel = (
  layout: WorkspaceLayout, panel: PanelId, toColumn: number, toIndex = Infinity,
): WorkspaceLayout => {
  if (layout.locked) return layout;
  const from = findPanel(layout, panel);
  if (!from) return layout;

  const makingNew = toColumn >= layout.columns.length;
  if (makingNew && layout.columns.length >= MAX_COLUMNS) return layout;
  // Dragging the only panel of a column into a NEW column is a no-op that would
  // otherwise churn ids and widths for no visible change.
  if (makingNew && layout.columns[from.column].panels.length === 1) return layout;

  const columns = layout.columns.map(c => ({ ...c, panels: [...c.panels] }));
  columns[from.column].panels.splice(from.at, 1);

  if (makingNew) {
    // The new column takes half of what the panel came from, so the drop lands
    // somewhere readable rather than as a sliver at the edge.
    const share = columns[from.column].width / 2;
    columns[from.column].width = share;
    columns.push({ id: columnId(), width: share, panels: [panel] });
  } else {
    const target = columns[toColumn];
    // Moving within a column: the index was measured before the removal above.
    const at = Math.max(0, Math.min(target.panels.length, Math.floor(toIndex)));
    target.panels.splice(at, 0, panel);
  }

  return {
    ...layout,
    columns: normalizeWidths(columns.filter(c => c.panels.length > 0)),
  };
};

/** Take a panel off the workspace entirely. The text panel is not removable. */
export const removePanel = (layout: WorkspaceLayout, panel: PanelId): WorkspaceLayout => {
  if (panel === 'text') return layout;
  const at = findPanel(layout, panel);
  if (!at) return layout;
  const columns = layout.columns
    .map(c => ({ ...c, panels: c.panels.filter(p => p !== panel) }))
    .filter(c => c.panels.length > 0);
  return { ...layout, columns: normalizeWidths(columns) };
};

/**
 * Summon a panel, somewhere the reader will actually see it.
 *
 * This used to add to the LAST column whenever there was more than one, which
 * was wrong in the way that matters: asking for a panel and getting a 40px
 * sliver at the bottom of a column you were not looking at is
 * indistinguishable from the button doing nothing. Four panels stacked in one
 * column is four headers and no content.
 *
 * So a new panel gets its OWN column while there is room for one, taking half
 * the width of the widest column rather than the last — the widest is the one
 * that can most afford it, and it is usually the text. Only at the column
 * ceiling does it stack, and then into the emptiest column rather than
 * whichever happens to be last.
 */
export const addPanel = (layout: WorkspaceLayout, panel: PanelId): WorkspaceLayout => {
  if (hasPanel(layout, panel)) return layout;
  const columns = layout.columns.map(c => ({ ...c, panels: [...c.panels] }));

  if (columns.length < MAX_COLUMNS) {
    let widest = 0;
    columns.forEach((c, i) => { if (c.width > columns[widest].width) widest = i; });
    const share = columns[widest].width / 2;
    columns[widest].width = share;
    // Beside the column it came out of, rather than at the far end — a new
    // panel that appears next to what it relates to needs no hunting for.
    columns.splice(widest + 1, 0, { id: columnId(), width: share, panels: [panel] });
    return { ...layout, columns: normalizeWidths(columns) };
  }

  let emptiest = 0;
  columns.forEach((c, i) => {
    if (c.panels.length < columns[emptiest].panels.length) emptiest = i;
  });
  columns[emptiest].panels.push(panel);
  return { ...layout, columns: normalizeWidths(columns) };
};

/**
 * Drag the edge between column `index` and the one after it.
 *
 * The two columns trade width and nothing else moves, which is what a reader
 * dragging a border expects. `delta` is a fraction of the whole workspace, so
 * the caller converts pixels once and this stays resolution-free.
 *
 * Refused rather than clamped when either side would go under the floor: a
 * clamp here means the edge keeps following the pointer while nothing changes,
 * which reads as a stuck drag.
 */
export const resizeColumn = (
  layout: WorkspaceLayout, index: number, delta: number,
): WorkspaceLayout => {
  if (layout.locked) return layout;
  const a = layout.columns[index];
  const b = layout.columns[index + 1];
  if (!a || !b || !Number.isFinite(delta)) return layout;
  const aw = a.width + delta;
  const bw = b.width - delta;
  if (aw < MIN_COLUMN || bw < MIN_COLUMN) return layout;
  const columns = layout.columns.map((c, i) =>
    (i === index ? { ...c, width: aw } : i === index + 1 ? { ...c, width: bw } : c));
  return { ...layout, columns };
};

/** Even shares all round — the way out of an arrangement gone lopsided. */
export const evenColumns = (layout: WorkspaceLayout): WorkspaceLayout => ({
  ...layout,
  columns: layout.columns.map(c => ({ ...c, width: 1 / layout.columns.length })),
});

/* ------------------------------------------------------------------ */
/* Whole arrangements                                                  */
/* ------------------------------------------------------------------ */

export type LayoutPreset = 'draft' | 'manuscript' | 'cowrite' | 'compare';

const preset = (
  columns: [number, PanelId[]][], rest: Partial<WorkspaceLayout> = {},
): WorkspaceLayout => sanitizeLayout({
  ...DEFAULT_LAYOUT,
  ...rest,
  columns: columns.map(([width, panels], i) => ({ id: `col-${i}`, width, panels })),
});

export const LAYOUT_PRESETS: Record<LayoutPreset, {
  label: string; hint: string; layout: WorkspaceLayout;
}> = {
  draft: {
    label: 'Draft',
    hint: 'Text on the left, everything you keep on the right.',
    layout: preset([[0.58, ['text']], [0.42, ['pins', 'branches']]]),
  },
  manuscript: {
    label: 'Manuscript',
    hint: 'Just the words, set wide and loose.',
    layout: preset([[1, ['text']]], { leading: 2, fontSize: 19 }),
  },
  cowrite: {
    label: 'Cowrite',
    hint: 'The assistant in the middle, with the text and your notes either side.',
    layout: preset([[0.36, ['text']], [0.34, ['assistant']], [0.3, ['sets', 'pins']]]),
  },
  compare: {
    label: 'Compare',
    hint: 'A narrow column of text against the alternate takes on it.',
    layout: preset([[0.42, ['text']], [0.58, ['branches', 'sheets']]], { leading: 1.6 }),
  },
};

/** True when a layout is exactly one of the presets, for showing which is on. */
export const matchingPreset = (layout: WorkspaceLayout): LayoutPreset | null => {
  const shape = (l: WorkspaceLayout) => JSON.stringify({
    // Ids and the lock are not part of the arrangement: a locked Draft is still
    // a Draft, and a column that was rebuilt has a new id and the same layout.
    columns: l.columns.map(c => ({ w: Math.round(c.width * 100), p: c.panels })),
    leading: l.leading,
    paragraphGap: l.paragraphGap,
    fontSize: l.fontSize,
  });
  const mine = shape(layout);
  return (Object.keys(LAYOUT_PRESETS) as LayoutPreset[])
    .find(k => shape(LAYOUT_PRESETS[k].layout) === mine) ?? null;
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** The grid template the columns render into. */
export const gridTemplate = (layout: WorkspaceLayout): string =>
  layout.columns.map(c => `${(c.width * 100).toFixed(3)}%`).join(' ');

/** The text panel's typography, as a style. */
export const textStyle = (layout: WorkspaceLayout): {
  fontSize: string; lineHeight: number;
} => ({ fontSize: `${layout.fontSize}px`, lineHeight: layout.leading });

/** The spacing between passages, as a style. */
export const passageStyle = (layout: WorkspaceLayout): { marginBottom: string } =>
  ({ marginBottom: `${layout.paragraphGap}em` });
