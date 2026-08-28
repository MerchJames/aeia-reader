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
ok(VIEW_ORDER.length === 13, `all thirteen views are catalogued (${VIEW_ORDER.length})`);

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
