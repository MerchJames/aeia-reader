/**
 * The view bar is the reader's, not ours.
 *
 * Every view stays — each is genuinely a different way to read and they earn
 * their place. What crowded the app was every button competing for the top bar
 * on first open, which reads as a dozen decisions before a single word.
 *
 * So the bar is curated: `visibleViews` pins what sits up top, the rest live one
 * click deeper in an overflow that ALWAYS lists every one. Nothing is hidden
 * away, only hidden behind.
 *
 * `null` means "follow the workspace preset" — the preset SEEDS the bar. The
 * moment the reader pins, unpins or reorders anything it becomes an explicit
 * list and the preset stops touching it, permanently. Reader intent outranks our
 * defaults, the same way reader perform marks outrank the Director.
 *
 * Pure: no store, no React, no JSX.
 */

import { UiMode, ViewMode } from '../types';

/** Which workspace group a view belongs to — decides the preset's seed. */
export type ViewGroup = 'read' | 'cowrite' | 'scenes';

/** Canonical order. An explicit list may reorder freely; this is the fallback. */
export const VIEW_ORDER: readonly ViewMode[] = [
  'storybook', 'book', 'script', 'panels', 'atlas', 'stage', 'vn', 'rpg', 'sandbox', 'chat',
  'workspace',
  'branches', 'overview', 'highlights',
];

export const VIEW_GROUP: Record<ViewMode, ViewGroup> = {
  storybook: 'read', book: 'read', stage: 'read', vn: 'read', branches: 'read',
  overview: 'read', highlights: 'read', script: 'read', panels: 'read', atlas: 'read',
  rpg: 'scenes',
  sandbox: 'scenes',
  chat: 'cowrite',
  workspace: 'cowrite',
};

export const VIEW_LABEL: Record<ViewMode, string> = {
  storybook: 'Storybook', book: 'Book', stage: 'Stage', vn: 'Visual Novel',
  rpg: 'RPG', sandbox: 'Sandbox', chat: 'Chat', branches: 'Branches', overview: 'Overview',
  highlights: 'Highlights', script: 'Script', panels: 'Panels', atlas: 'Atlas',
  workspace: 'Workspace',
};

/**
 * Views that show the STORY, as opposed to a list ABOUT it.
 *
 * ── Why this is one constant ───────────────────────────────────────────────
 *
 * This list existed three times, written out by hand in `store.ts`: once when a
 * story opens, once when a timeline is chosen, and once in the persist
 * partialize. Adding a view meant remembering all three, and the first v3 view
 * proved it — opening a story with the Script view selected silently dropped
 * the reader into Chat, because two of the three copies had never heard of it.
 *
 * So: derived from `VIEW_ORDER` by subtraction, with a test that every view is
 * in exactly one group. A view added later is a reading view unless somebody
 * says otherwise, which is the safe default: worst case it opens somewhere real.
 */
export const LIST_VIEWS: readonly ViewMode[] = ['overview', 'highlights', 'branches'];

export const READING_VIEWS: readonly ViewMode[] =
  VIEW_ORDER.filter(v => !LIST_VIEWS.includes(v));

/** True when a story can be OPENED into this view. */
export const isReadingView = (v: unknown): v is ViewMode =>
  READING_VIEWS.includes(v as ViewMode);

/** One line on what each view is FOR — the overflow is where views are discovered. */
export const VIEW_HINT: Record<ViewMode, string> = {
  storybook: 'Continuous prose, like a novel.',
  book: 'Two-page spread with real page turns.',
  stage: 'RPG scene — portraits, dialogue window, game chrome.',
  vn: 'Cinematic visual novel — backdrops, sprites, camera.',
  rpg: 'The whole game interface — HUD, party, command row, press to continue.',
  sandbox: 'AI-designed presentation, per message.',
  chat: 'The original transcript, message by message.',
  branches: 'Alternate takes and attached timelines.',
  overview: 'The whole story at a glance.',
  highlights: 'Everything you’ve marked.',
  script: 'Screenplay format — scenes, cues, and how long it would run.',
  panels: 'A comic page: one beat per panel, laid out by what the beat is.',
  atlas: 'The whole story as a map you can zoom into.',
  workspace: 'For working on the text — arrange it, edit in place, keep your notes beside it.',
};

/* ------------------------------------------------------------------ */
/* What a preset actually gates                                        */
/* ------------------------------------------------------------------ */

/**
 * Views a preset takes OFF THE TABLE — not merely unpinned, gone.
 *
 * This is a stronger claim than `SEEDS` below, and the two do different jobs.
 * Seeding says "start with these on the bar"; every other view is still one
 * click away in the overflow, which is right, because the overflow is where
 * views are discovered. Hiding says "not in this workspace at all".
 *
 * The distinction is the difference between a curated bar and a MODE. Cowrite
 * is for working on the text: a two-page book spread with real page turns is a
 * lovely way to read and a terrible way to revise, and offering it in the menu
 * is offering a wrong turn. Scenes is the reverse — every way of *showing* the
 * story, and none of the lists ABOUT it.
 *
 * `all` hides nothing, ever. It is the escape hatch, and a reader who cannot
 * find something is told to go there.
 */
export const HIDDEN_VIEWS: Record<UiMode, readonly ViewMode[]> = {
  read: [],
  // Presentation views, in a workspace about the words.
  cowrite: ['book', 'stage', 'vn', 'sandbox'],
  // The three that are a list about the story rather than the story.
  scenes: ['branches', 'overview', 'highlights'],
  all: [],
};

/** Every view this preset offers, in canonical order. */
export const allowedViews = (uiMode: UiMode): ViewMode[] => {
  const hidden = HIDDEN_VIEWS[uiMode] ?? [];
  return VIEW_ORDER.filter(v => !hidden.includes(v));
};

/** True when this preset offers this view at all. */
export const viewAllowed = (view: ViewMode, uiMode: UiMode): boolean =>
  !(HIDDEN_VIEWS[uiMode] ?? []).includes(view);

/**
 * The view to be on after switching preset.
 *
 * A reader in Book view who switches to Cowrite cannot stay there — Book is not
 * in that workspace. Rather than stranding them on a view the bar no longer
 * shows, move to the nearest thing the preset does offer, preferring the seed
 * so they land somewhere the preset considers a good starting point.
 *
 * Returns the CURRENT view untouched when it is still allowed, so switching
 * preset never moves a reader who did not need moving.
 */
export const viewAfterModeChange = (current: ViewMode, uiMode: UiMode): ViewMode => {
  if (viewAllowed(current, uiMode)) return current;
  const seeds = SEEDS[uiMode] ?? SEEDS.all;
  return seeds.find(v => viewAllowed(v, uiMode)) ?? allowedViews(uiMode)[0] ?? 'storybook';
};

/** The header tools a preset can gate. Mirrors the `tools` list in TopNavigation. */
export type ToolId =
  | 'multiverse' | 'branching' | 'codex' | 'sheets' | 'ai' | 'frame' | 'autofocus' | 'settings';

export const TOOL_ORDER: readonly ToolId[] =
  ['multiverse', 'branching', 'codex', 'sheets', 'ai', 'frame', 'autofocus', 'settings'];

/**
 * Tools a preset hides.
 *
 * The header was the single worst thing about opening this app for the first
 * time: seven icons, none of them labelled, every one of them a feature you
 * have to try before you understand. So each preset keeps only what its own
 * work needs.
 *
 * Read keeps three — the Codex (who is this, again?), Autofocus, and Settings.
 * Scenes keeps almost nothing, because its work is in the VIEWS; the tools are
 * all about text and structure and are noise beside a visual novel.
 *
 * `settings` is deliberately absent from every list. A workspace you cannot
 * leave, with no way to reach the switch that changes it, is a trap.
 */
export const HIDDEN_TOOLS: Record<UiMode, readonly ToolId[]> = {
  read: ['multiverse', 'branching', 'sheets', 'ai', 'frame'],
  cowrite: ['autofocus'],
  scenes: ['autofocus', 'multiverse', 'branching', 'sheets', 'codex', 'frame', 'ai'],
  all: [],
};

/** True when this preset offers this tool. */
export const toolAllowed = (tool: ToolId, uiMode: UiMode): boolean =>
  !(HIDDEN_TOOLS[uiMode] ?? []).includes(tool);

/**
 * How many views a preset seeds. `read` opens on two — enough to show the bar is
 * a choice, few enough that it isn't a decision.
 */
const SEEDS: Record<UiMode, ViewMode[]> = {
  read: ['storybook', 'chat'],
  cowrite: ['workspace', 'storybook', 'chat', 'overview'],
  scenes: ['storybook', 'chat', 'vn', 'sandbox'],
  all: ['storybook', 'book', 'chat', 'vn'],
};

/** The bar a preset starts you with, before the reader touches anything. */
export const defaultVisibleViews = (uiMode: UiMode): ViewMode[] => [...(SEEDS[uiMode] ?? SEEDS.all)];

const isView = (v: unknown): v is ViewMode => VIEW_ORDER.includes(v as ViewMode);

/**
 * Make a stored list safe to render: drop anything unknown (a view removed by a
 * later build), dedupe, and never return an empty bar — an empty bar strands the
 * reader with no way back to a view.
 */
export const sanitizeVisibleViews = (list: unknown, uiMode: UiMode): ViewMode[] => {
  if (!Array.isArray(list)) return defaultVisibleViews(uiMode);
  const seen = new Set<ViewMode>();
  for (const v of list) if (isView(v)) seen.add(v);
  return seen.size ? [...seen] : defaultVisibleViews(uiMode);
};

/**
 * The bar to actually render. An explicit list wins; `null` follows the preset.
 * The active view is always shown even when unpinned — the bar must never fail
 * to indicate where the reader currently is.
 */
export const resolveVisibleViews = (
  visibleViews: ViewMode[] | null,
  uiMode: UiMode,
  active?: ViewMode,
): ViewMode[] => {
  const base = visibleViews ? sanitizeVisibleViews(visibleViews, uiMode) : defaultVisibleViews(uiMode);
  /**
   * The preset filters the reader's own pins.
   *
   * Reader intent normally outranks our defaults — but a pin list is made once
   * and kept forever, and the reader who switches to Cowrite has just said
   * something about *now*. Filtering rather than rewriting is what makes it
   * survivable: the pins are untouched underneath, so switching back to All
   * brings every one of them straight back.
   */
  const offered = base.filter(v => viewAllowed(v, uiMode));
  const shown = offered.length ? offered : defaultVisibleViews(uiMode);
  // The active view is always on the bar, even when the preset would hide it —
  // a bar that does not show where the reader currently IS is worse than a bar
  // with one extra button on it.
  return active && !shown.includes(active) ? [...shown, active] : shown;
};

/**
 * Views not on the bar — the overflow's "more" section.
 *
 * Scoped to the preset, so the overflow lists what this workspace offers rather
 * than everything that exists. That is a real narrowing of the menu views are
 * DISCOVERED in, which is why `all` hides nothing and the mode strip says so.
 */
export const overflowViews = (shown: ViewMode[], uiMode: UiMode = 'all'): ViewMode[] =>
  allowedViews(uiMode).filter(v => !shown.includes(v));

/** Pin/unpin, keeping canonical order for newly pinned views. */
export const toggleView = (shown: ViewMode[], view: ViewMode): ViewMode[] => {
  if (shown.includes(view)) {
    const next = shown.filter(v => v !== view);
    // Never unpin the last one — a bar with nothing on it is a dead end.
    return next.length ? next : shown;
  }
  const next = [...shown, view];
  return VIEW_ORDER.filter(v => next.includes(v));
};

/** Move a pinned view one slot left (-1) or right (+1). No-op at the ends. */
export const moveView = (shown: ViewMode[], view: ViewMode, direction: -1 | 1): ViewMode[] => {
  const idx = shown.indexOf(view);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= shown.length) return shown;
  const next = [...shown];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
};
