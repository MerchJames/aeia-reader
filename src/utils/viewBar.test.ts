/** Run: npx tsx src/utils/viewBar.test.ts */
import { ViewMode } from '../types';
import {
  LIST_VIEWS, READING_VIEWS, VIEW_GROUP, VIEW_HINT, VIEW_LABEL, VIEW_ORDER, defaultVisibleViews,
  isReadingView, moveView, overflowViews, resolveVisibleViews, sanitizeVisibleViews, toggleView,
} from './viewBar';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// --- the catalogue is complete ----------------------------------------------
// A view missing a label/hint/group renders as a blank row in the overflow —
// which is exactly the menu readers are supposed to DISCOVER views in.
// A count, deliberately. Adding a view means touching the label, the hint, the
// group, the icon table, the App dispatch and the onboarding step — and the
// count is what makes forgetting one of them fail here rather than ship as a
// blank row in the menu readers discover views in.
ok(VIEW_ORDER.length === 14, `all fourteen views are catalogued (${VIEW_ORDER.length})`);

/* ── Reading views vs list views ───────────────────────────────────────────
 *
 * This split decides what happens when a story OPENS. It used to be three
 * hand-written copies of the same array inside store.ts, and the first v3 view
 * proved what that costs: two of the three had never heard of it, so opening a
 * story with the Script view selected silently dropped the reader into Chat.
 *
 * The tripwire is that the two groups partition VIEW_ORDER exactly. A view
 * added to neither, or to both, fails here rather than in somebody's library.
 */
for (const v of VIEW_ORDER) {
  const reading = READING_VIEWS.includes(v);
  const list = LIST_VIEWS.includes(v);
  ok(reading !== list, `${v} is either a reading view or a list view, never both or neither`);
  ok(isReadingView(v) === reading, `isReadingView agrees about ${v}`);
}
ok(READING_VIEWS.length + LIST_VIEWS.length === VIEW_ORDER.length,
  'the two groups account for every view and nothing else');
ok(!isReadingView('nonsense') && !isReadingView(undefined),
  'a value that is not a view is not a reading view');
// Named explicitly: these three are ABOUT the story rather than the story, and
// opening a chat into one of them shows a reader a list where they wanted words.
for (const v of ['overview', 'highlights', 'branches'] as const) {
  ok(LIST_VIEWS.includes(v), `${v} is a list view`);
}

ok(new Set(VIEW_ORDER).size === VIEW_ORDER.length, 'no view is listed twice');
for (const v of VIEW_ORDER) {
  ok(!!VIEW_LABEL[v]?.trim(), `${v} has a label`);
  ok(!!VIEW_HINT[v]?.trim(), `${v} says what it is for`);
  ok(!!VIEW_GROUP[v], `${v} belongs to a group`);
}

// --- the preset seeds --------------------------------------------------------
for (const mode of ['read', 'cowrite', 'scenes', 'all'] as const) {
  const seed = defaultVisibleViews(mode);
  ok(seed.length > 0, `${mode} seeds a non-empty bar`);
  ok(seed.every(v => VIEW_ORDER.includes(v)), `${mode} seeds only real views`);
  ok(new Set(seed).size === seed.length, `${mode} seeds no duplicates`);
}
ok(defaultVisibleViews('read').length <= 4, 'a cold Read install shows at most four buttons');
// Fresh arrays: a caller mutating the bar must not rewrite the seed table.
const seedA = defaultVisibleViews('all');
seedA.push('overview');
ok(defaultVisibleViews('all').length !== seedA.length, 'seeds are copies, not the shared table');

// --- sanitize ----------------------------------------------------------------
ok(sanitizeVisibleViews(['book', 'chat'], 'all').join() === 'book,chat', 'a good list survives in order');
ok(!sanitizeVisibleViews(['book', 'nope' as ViewMode], 'all').includes('nope' as ViewMode),
  'a view from a later build is dropped, not rendered');
ok(sanitizeVisibleViews(['book', 'book'], 'all').length === 1, 'duplicates collapse');
// An empty bar strands the reader with no way back to any view.
ok(sanitizeVisibleViews([], 'read').length > 0, 'an empty stored list falls back to the seed');
ok(sanitizeVisibleViews(['nope' as ViewMode], 'read').length > 0, 'an all-garbage list falls back too');
ok(sanitizeVisibleViews(null, 'read').join() === defaultVisibleViews('read').join(), 'null falls back to the seed');
ok(sanitizeVisibleViews('book' as never, 'read').length > 0, 'a non-array falls back rather than throwing');

// --- resolve -----------------------------------------------------------------
ok(resolveVisibleViews(null, 'read').join() === defaultVisibleViews('read').join(),
  'null follows the preset');
ok(resolveVisibleViews(['vn'], 'read').join() === 'vn', 'an explicit list outranks the preset');
// The bar must always show where you ARE, or the reader loses their place.
ok(resolveVisibleViews(['vn'], 'read', 'highlights').includes('highlights'),
  'the active view is shown even when unpinned');
ok(resolveVisibleViews(['vn'], 'read', 'vn').length === 1, 'and is not duplicated when already pinned');

// --- overflow ----------------------------------------------------------------
const shown: ViewMode[] = ['storybook', 'chat'];
const hidden = overflowViews(shown);
ok(hidden.length === VIEW_ORDER.length - shown.length, 'the overflow holds everything else');
ok(shown.concat(hidden).length === VIEW_ORDER.length, 'together they are the full nine — nothing is lost');
ok(hidden.every(v => !shown.includes(v)), 'nothing appears in both sections');
ok(overflowViews([...VIEW_ORDER]).length === 0, 'a fully-pinned bar has an empty overflow');

// --- pin / unpin -------------------------------------------------------------
const pinned = toggleView(['storybook', 'chat'], 'vn');
ok(pinned.includes('vn'), 'pinning adds the view');
ok(pinned.join() === 'storybook,vn,chat', 'and it lands in canonical order, not at the end');
ok(toggleView(pinned, 'vn').join() === 'storybook,chat', 'unpinning removes it again');
// Newly pinned views take the canonical slot, not the end of the list.
ok(toggleView(['chat'], 'storybook').join() === 'storybook,chat', 'a new pin sorts into place');
// A bar with nothing on it is a dead end with no way to switch views.
ok(toggleView(['chat'], 'chat').join() === 'chat', 'the last pinned view cannot be unpinned');

// --- reorder -----------------------------------------------------------------
const bar: ViewMode[] = ['storybook', 'book', 'chat'];
ok(moveView(bar, 'book', -1).join() === 'book,storybook,chat', 'a view moves left');
ok(moveView(bar, 'book', 1).join() === 'storybook,chat,book', 'a view moves right');
ok(moveView(bar, 'storybook', -1).join() === bar.join(), 'the first view cannot move left');
ok(moveView(bar, 'chat', 1).join() === bar.join(), 'the last view cannot move right');
ok(moveView(bar, 'vn', -1).join() === bar.join(), 'moving an unpinned view is a no-op');
ok(bar.join() === 'storybook,book,chat', 'reordering never mutates the input');


/* ══════════════════════════════════════════════════════════════════════════
 * What a preset GATES
 *
 * Two different jobs that look alike and must not be confused:
 *
 *   SEEDS say "start with these on the bar". Everything else is one click away
 *   in the overflow, because the overflow is where views are discovered.
 *
 *   HIDDEN say "not in this workspace at all" — gone from the bar AND the menu.
 *
 * The tests below are mostly about the second one not eating the first. A
 * workspace that hides things is a workspace a reader can get stuck in, so
 * every hiding rule here is paired with an assertion that there is a way out.
 * ══════════════════════════════════════════════════════════════════════════ */

import {
  HIDDEN_TOOLS, HIDDEN_VIEWS, TOOL_ORDER, allowedViews, toolAllowed,
  viewAfterModeChange, viewAllowed,
} from './viewBar';
import { UiMode } from '../types';

const MODES: UiMode[] = ['read', 'cowrite', 'scenes', 'all'];

// --- All is the escape hatch ------------------------------------------------
// Every "you can't get there from here" message in the app points at All. If
// All itself hid anything, that advice would be a lie and there would be no
// way to reach the hidden thing at all.
ok(HIDDEN_VIEWS.all.length === 0, 'All hides no view — it is the escape hatch');
ok(HIDDEN_TOOLS.all.length === 0, 'and no tool');
ok(allowedViews('all').length === VIEW_ORDER.length, 'so All offers every view there is');

// --- Settings is never gated ------------------------------------------------
// A workspace you cannot leave, with no way to reach the switch that changes
// it, is a trap. Settings is how a reader gets out of one.
for (const mode of MODES) {
  ok(toolAllowed('settings', mode), `${mode} keeps Settings — the way out of any preset`);
}

// --- No preset is empty -----------------------------------------------------
for (const mode of MODES) {
  ok(allowedViews(mode).length > 0, `${mode} offers at least one view`);
  ok(allowedViews(mode).includes('storybook'),
    `${mode} keeps Storybook — every preset needs one plain way to read`);
  ok(allowedViews(mode).includes('chat'),
    `${mode} keeps Chat — the transcript is the story's ground truth`);
}

// --- The preset each rule was written for -----------------------------------
ok(!viewAllowed('book', 'cowrite'), 'Cowrite hides the book spread');
ok(!viewAllowed('vn', 'cowrite'), 'and the visual novel');
ok(!viewAllowed('stage', 'cowrite') && !viewAllowed('sandbox', 'cowrite'),
  'and the other two presentation views — this workspace is about the words');
ok(viewAllowed('overview', 'cowrite') && viewAllowed('branches', 'cowrite'),
  'while keeping the lists, which is how you navigate a draft');

ok(!viewAllowed('branches', 'scenes'), 'Scenes hides Branches');
ok(!viewAllowed('overview', 'scenes') && !viewAllowed('highlights', 'scenes'),
  'and the other two lists — Scenes shows the story, never a table about it');
for (const v of READING_VIEWS) {
  ok(viewAllowed(v, 'scenes'), `Scenes keeps every reading view, including ${v}`);
}
// Stated as an identity rather than a list, so adding a list view later cannot
// silently leak one into Scenes.
ok(HIDDEN_VIEWS.scenes.length === LIST_VIEWS.length
  && LIST_VIEWS.every(v => HIDDEN_VIEWS.scenes.includes(v)),
  'Scenes hides exactly the list views — no more, no fewer');

ok(HIDDEN_VIEWS.read.length === 0, 'Read hides no view — reading is what every view is for');

// --- Tools ------------------------------------------------------------------
ok(!toolAllowed('frame', 'read') && !toolAllowed('sheets', 'read') && !toolAllowed('multiverse', 'read'),
  'Read drops Frame, Sheets and Multiverse');
ok(toolAllowed('codex', 'read') && toolAllowed('autofocus', 'read'),
  'and keeps the two that serve reading: the Codex and Autofocus');
ok(TOOL_ORDER.filter(t => toolAllowed(t, 'read')).length === 3,
  'leaving Read with exactly three tools in the header');

ok(!toolAllowed('autofocus', 'cowrite'), 'Cowrite drops Autofocus — handsfree is not a writing posture');
ok(toolAllowed('ai', 'cowrite'), 'and keeps the assistant, which is the whole preset');

ok(!toolAllowed('autofocus', 'scenes') && !toolAllowed('multiverse', 'scenes')
  && !toolAllowed('sheets', 'scenes') && !toolAllowed('codex', 'scenes')
  && !toolAllowed('frame', 'scenes'),
  'Scenes drops every text-and-structure tool');

// Branching links one story to ANOTHER — structural work on the text, so it
// belongs with Cowrite and nowhere near a preset about reading or showing.
ok(toolAllowed('branching', 'cowrite'), 'Cowrite keeps Branching');
ok(!toolAllowed('branching', 'read') && !toolAllowed('branching', 'scenes'),
  'and the two presets that are not about structure drop it');
ok(toolAllowed('branching', 'all'), 'All keeps it, like everything else');

for (const mode of MODES) {
  for (const t of HIDDEN_TOOLS[mode]) {
    ok(TOOL_ORDER.includes(t), `${mode} hides "${t}", which is a real tool id`);
  }
  for (const v of HIDDEN_VIEWS[mode]) {
    ok(VIEW_ORDER.includes(v), `${mode} hides "${v}", which is a real view`);
  }
}

// --- Switching preset must not strand the reader ----------------------------
// The failure: reading in Book view, switch to Cowrite, and the bar no longer
// contains the view you are looking at. Nothing is broken and nothing works.
for (const mode of MODES) {
  for (const v of VIEW_ORDER) {
    const landed = viewAfterModeChange(v, mode);
    ok(viewAllowed(landed, mode), `switching to ${mode} from ${v} lands on a view ${mode} offers`);
  }
}
ok(viewAfterModeChange('storybook', 'cowrite') === 'storybook',
  'a reader whose view is still offered is not moved at all');
ok(viewAfterModeChange('overview', 'cowrite') === 'overview', 'nor for a list view Cowrite keeps');
// Cowrite's first seed is the Workspace, so that is where a reader who cannot
// stay put lands — the view the preset is actually for, rather than whichever
// happened to be first in the canonical order.
ok(viewAfterModeChange('book', 'cowrite') === 'workspace',
  'and one who must move lands on the preset\'s own starting point, not an arbitrary view');
ok(viewAfterModeChange('branches', 'scenes') === 'storybook', 'the same leaving a list behind in Scenes');

// --- The bar filters, it does not rewrite -----------------------------------
// A pin list is made once and kept forever; a preset is a statement about now.
// So the preset filters the pins for display and leaves them alone underneath,
// which is what makes switching back to All bring every one of them straight
// back.
{
  const pins: ViewMode[] = ['storybook', 'book', 'vn', 'chat'];
  const inCowrite = resolveVisibleViews(pins, 'cowrite', 'storybook');
  ok(!inCowrite.includes('book') && !inCowrite.includes('vn'),
    'a pinned view the preset hides is not shown');
  ok(inCowrite.includes('storybook') && inCowrite.includes('chat'), 'while the rest of the pins stay');
  ok(resolveVisibleViews(pins, 'all', 'storybook').length === pins.length,
    'and switching back to All restores every pin, untouched');

  // The one case where a hidden view is still shown: the reader is ON it.
  const onBook = resolveVisibleViews(pins, 'cowrite', 'book');
  ok(onBook.includes('book'),
    'the view the reader is actually on is always on the bar, preset or not');

  // A pin list consisting entirely of views this preset hides would otherwise
  // render an empty bar — a dead end with no way back to a view.
  const allHidden = resolveVisibleViews(['book', 'vn', 'sandbox'], 'cowrite', 'storybook');
  ok(allHidden.length > 0, 'a pin list the preset hides entirely falls back to the seed, never to nothing');
}

// --- The overflow is scoped too ---------------------------------------------
{
  const shown = resolveVisibleViews(null, 'cowrite');
  const more = overflowViews(shown, 'cowrite');
  ok(!more.includes('book'), 'the overflow does not offer a view the preset hides');
  ok(more.every(v => viewAllowed(v, 'cowrite')), 'none of them, in fact');
  ok(shown.concat(more).length === allowedViews('cowrite').length,
    'and between the bar and the overflow, every view the preset offers is reachable');

  for (const mode of MODES) {
    const bar = resolveVisibleViews(null, mode);
    const rest = overflowViews(bar, mode);
    ok(new Set([...bar, ...rest]).size === allowedViews(mode).length,
      `in ${mode}, nothing the preset offers is unreachable`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
