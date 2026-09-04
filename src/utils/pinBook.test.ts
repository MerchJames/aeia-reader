/**
 * Run: npx tsx src/utils/pinBook.test.ts
 *
 * A pin with pages, and the one invariant that lets it exist at all.
 *
 * Nearly everything in this app reads a pin as a single `content` string — the
 * dock card, `pinsToPromptBlock`, the Cut, the HTML export, the pin-update
 * prompt. None of them were changed when pins gained pages, and none of them
 * should have to be. That works only if `content` is ALWAYS the page on show,
 * without exception, after every operation. Get it wrong and the failure is
 * silent in the worst way: the reader turns a page, the card keeps rendering
 * the old one, and the model is sent a page nobody is looking at.
 *
 * So most of this file is one property applied to every mutation, plus the
 * back-compatibility rule that makes a library of existing pins safe: a pin
 * with no `pages` array is a book of one, and stays byte-identical on disk
 * until the reader actually asks for a second page.
 */
import type { Pin, PinVersion } from '../types';
import {
  MAX_PAGE_VERSIONS, MAX_PIN_PAGES, activePage, activePageIndex, addPage, applyManualEdit,
  bookText, editActivePage, isBook, mergeInto, movePage, pageLabel, pagesOf, patchPage,
  removePage, syncActive, turnTo, withPages, type PinPage,
} from './pinBook';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

let seq = 0;
const nextId = () => `id${++seq}`;

const plainPin = (over: Partial<Pin> = {}): Pin => ({
  id: 'pin1',
  title: 'Field journal',
  format: 'markdown',
  content: 'Day one.',
  inContext: false,
  docked: true,
  createdAt: 1000,
  ...over,
});

/** The invariant, checked after every mutation below. */
const mirrorsActivePage = (pin: Pin, where: string) => {
  const page = activePage(pin);
  eq(pin.content, page.content, `${where}: content mirrors the active page`);
  eq(pin.versions, page.versions, `${where}: versions mirror the active page`);
  eq(pin.activeVersion, page.activeVersion, `${where}: activeVersion mirrors the active page`);
};

/* ── A pin with no pages is a book of one ────────────────────────────────── */
{
  const pin = plainPin();
  eq(pagesOf(pin).length, 1, 'a plain pin reads as one page');
  eq(pagesOf(pin)[0].content, 'Day one.', 'whose content is the pin’s');
  eq(isBook(pin), false, 'but it is not a book');
  eq(activePageIndex(pin), 0, 'and page zero is showing');
  eq(activePage(pin).content, 'Day one.', 'which is the pin itself');

  // The point of this: nothing on disk changes for a reader who never uses
  // pages. A migration on load is a migration that can lose notes.
  eq(pin.pages, undefined, 'reading a pin never gives it a pages array');
  eq(withPages(pin) === pin, false, 'promotion makes a new object');
  eq(withPages(withPages(pin)).pages?.length, 1, 'and promoting twice is the same as once');
}

/* ── An existing version history survives promotion ──────────────────────── */
{
  const versions: PinVersion[] = [
    { content: 'first', source: 'original', createdAt: 1 },
    { content: 'second', source: 'ai', instruction: 'tighten it', createdAt: 2 },
  ];
  const pin = plainPin({ content: 'second', versions, activeVersion: 1 });
  const page = pagesOf(pin)[0];
  eq(page.versions?.length, 2, 'the legacy history becomes the first page’s history');
  eq(page.activeVersion, 1, 'with the same version showing');
  eq(page.versions?.[1].instruction, 'tighten it', 'and its provenance intact');
  mirrorsActivePage(withPages(pin), 'promotion');
}

/* ── Adding a page turns to it, and the mirror follows ───────────────────── */
{
  const one = plainPin();
  const two = addPage(one, { id: 'p2', title: 'Day eleven', content: 'The salt flats.', createdAt: 2000 });
  eq(two.pages?.length, 2, 'the book has two pages');
  eq(isBook(two), true, 'and is now a book');
  eq(activePageIndex(two), 1, 'showing the one just added');
  eq(two.content, 'The salt flats.', 'which is what the dock will render');
  mirrorsActivePage(two, 'addPage');

  // The original page is untouched — that is the whole difference from versions.
  eq(two.pages?.[0].content, 'Day one.', 'the first entry is still the first entry');
  eq(two.pages?.[0].versions, undefined, 'with a history of its own, still empty');
}

/* ── A page owns its versions ────────────────────────────────────────────── */
{
  const book = addPage(plainPin(), { id: 'p2', content: 'Second entry.', createdAt: 2000 });
  const edited = patchPage(book, 1, {
    content: 'Second entry, rewritten.',
    versions: [
      { content: 'Second entry.', source: 'original', createdAt: 2000 },
      { content: 'Second entry, rewritten.', source: 'ai', createdAt: 3000 },
    ],
    activeVersion: 1,
  });
  eq(edited.pages?.[1].versions?.length, 2, 'the edited page has two versions');
  eq(edited.pages?.[0].versions, undefined, 'and the other page has none');
  eq(edited.versions?.length, 2, 'the pin mirrors the SHOWING page’s history');
  mirrorsActivePage(edited, 'patchPage');

  // Turn back to page one: the mirror must follow, history and all.
  const back = turnTo(edited, 0);
  eq(back.content, 'Day one.', 'turning back shows page one');
  eq(back.versions, undefined, 'and page one’s empty history, not page two’s');
  mirrorsActivePage(back, 'turnTo');
}

/* ── Turning to a page that is not there does nothing ────────────────────── */
{
  const book = addPage(plainPin(), { id: 'p2', content: 'Two.', createdAt: 2 });
  eq(turnTo(book, 5) === book, true, 'past the end is refused');
  eq(turnTo(book, -1) === book, true, 'and so is before the start');
  // A stored index CAN outlive its page (delete a page, reload) — that must
  // read as page zero rather than crashing the dock.
  const stale = { ...book, activePage: 9 };
  eq(activePageIndex(stale), 0, 'an out-of-range stored index falls back to the first page');
  eq(activePage(stale).content, 'Day one.', 'and reads that page');
}

/* ── Removing pages ──────────────────────────────────────────────────────── */
{
  let book = plainPin();
  book = addPage(book, { id: 'p2', content: 'Two.', createdAt: 2 });
  book = addPage(book, { id: 'p3', content: 'Three.', createdAt: 3 });
  eq(activePageIndex(book), 2, 'we are on the last page');

  const gone = removePage(book, 0);
  eq(gone.pages?.length, 2, 'one page fewer');
  eq(gone.pages?.[0].content, 'Two.', 'and the rest close up');
  eq(activePageIndex(gone), 1, 'the view follows the page it was on');
  eq(gone.content, 'Three.', 'which is still Three');
  mirrorsActivePage(gone, 'removePage');

  const end = removePage(book, 2);
  eq(activePageIndex(end), 1, 'deleting the page you are on lands on the new last one');
  mirrorsActivePage(end, 'removePage at the end');

  // A pin with no pages has nothing to render and no way back. Deleting the
  // pin is a different, clearly-labelled action.
  const single = addPage(plainPin(), { id: 'p2', content: 'Two.', createdAt: 2 });
  const oneLeft = removePage(removePage(single, 1), 0);
  eq(pagesOf(oneLeft).length, 1, 'the last page cannot be removed');
}

/* ── Reordering ──────────────────────────────────────────────────────────── */
{
  let book = plainPin();
  book = addPage(book, { id: 'p2', content: 'Two.', createdAt: 2 });
  book = addPage(book, { id: 'p3', content: 'Three.', createdAt: 3 });

  const moved = movePage(book, 2, -1);
  eq(moved.pages?.map(p => p.content).join('|'), 'Day one.|Three.|Two.', 'the page moves one place');
  eq(activePageIndex(moved), 1, 'and the view moves with it');
  eq(moved.content, 'Three.', 'so the reader keeps watching the page they grabbed');
  mirrorsActivePage(moved, 'movePage');

  eq(movePage(book, 0, -1) === book, true, 'off the front is refused');
  eq(movePage(book, 2, 1) === book, true, 'and off the back');
}

/* ── Merging one pin into another ────────────────────────────────────────── */
{
  seq = 0;
  const target = addPage(plainPin(), { id: 'p2', content: 'Day two.', createdAt: 2 });
  const source = plainPin({
    id: 'pin2', title: 'Loose notes', content: 'A name I keep hearing.', createdAt: 5,
  });
  const merged = mergeInto(target, source, nextId);
  eq(merged.pages?.length, 3, 'the source arrives as a page');
  eq(merged.pages?.[2].content, 'A name I keep hearing.', 'with its text');
  eq(merged.pages?.[2].title, 'Loose notes', 'and its old name as the page heading');
  eq(activePageIndex(merged), 2, 'and the reader is shown what just arrived');
  mirrorsActivePage(merged, 'mergeInto');

  // Ids must be reissued: two pages sharing an id is a React key collision and
  // an ambiguous "which page did you mean" for every action below.
  const ids = pagesOf(merged).map(p => p.id);
  eq(new Set(ids).size, ids.length, 'every page keeps a distinct id');

  // Merging a multi-page pin brings all of it, in order.
  const bigSource = addPage(
    plainPin({ id: 'pin3', title: 'Charts', content: 'One.' }),
    { id: 'x', content: 'Two.', createdAt: 9 },
  );
  const big = mergeInto(target, bigSource, nextId);
  eq(big.pages?.length, 4, 'both of the source’s pages arrive');
  eq(big.pages?.slice(2).map(p => p.content).join('|'), 'One.|Two.', 'in their own order');
  eq(big.pages?.[3].title, undefined, 'and only the first inherits the source’s title');
}

/* ── The book as one document ────────────────────────────────────────────── */
{
  eq(bookText(plainPin()), 'Day one.', 'a single note is just its text — no headings added');

  let book = plainPin();
  book = addPage(book, { id: 'p2', title: 'Day eleven', content: 'The salt flats.', createdAt: 2 });
  const text = bookText(book);
  ok(text.includes('## Page 1'), 'an unnamed page is headed by its number');
  ok(text.includes('## Day eleven'), 'and a named one by its name');
  ok(text.includes('Day one.') && text.includes('The salt flats.'), 'every page is present');
  ok(text.indexOf('Day one.') < text.indexOf('The salt flats.'), 'in reading order');
  ok(text.includes('---'), 'separated, so eleven entries do not read as one');
}

/* ── Labels ──────────────────────────────────────────────────────────────── */
{
  eq(pageLabel({ id: 'a', content: '', createdAt: 0 }, 3), 'Page 4', 'unnamed pages are numbered from one');
  eq(pageLabel({ id: 'a', title: '  ', content: '', createdAt: 0 }, 0), 'Page 1', 'whitespace is not a name');
  eq(pageLabel({ id: 'a', title: 'Ledger', content: '', createdAt: 0 }, 0), 'Ledger', 'a name wins');
}

/* ── The cap ─────────────────────────────────────────────────────────────── */
{
  let book = plainPin();
  for (let i = 0; i < MAX_PIN_PAGES + 5; i++) {
    book = addPage(book, { id: `p${i}`, content: `Entry ${i}`, createdAt: i });
  }
  eq(pagesOf(book).length, MAX_PIN_PAGES, 'the book stops growing at the cap');
  eq(activePage(book).content, `Entry ${MAX_PIN_PAGES + 4}`, 'and the newest page is the one showing');
  mirrorsActivePage(book, 'at the cap');
}

/* ── Editing a page by hand ──────────────────────────────────────────────── */
{
  const page = { id: 'p', content: 'As it arrived.', createdAt: 100 };

  // THE property. A pin the assistant wrote must survive somebody fixing a
  // typo in it — the first hand edit preserves what it replaces, for good.
  const first = applyManualEdit(page, 'Edited once.', 200);
  eq(first.versions?.length, 2, 'the first edit makes two versions');
  eq(first.versions?.[0].content, 'As it arrived.', 'the text it replaced is kept');
  eq(first.versions?.[0].source, 'original', 'as the original');
  eq(first.versions?.[0].createdAt, 100, 'stamped when the page was made, not when it was edited');
  eq(first.versions?.[1].source, 'manual', 'and the edit is a manual version');
  eq(first.activeVersion, 1, 'showing the edit');
  eq(first.content, 'Edited once.', 'which is what the page now reads');

  // …and only ever once. Typing is not drafting: a version per save would fill
  // a twelve-slot history with the last five minutes.
  const second = applyManualEdit(first, 'Edited twice.', 300);
  eq(second.versions?.length, 2, 'a second hand edit does NOT add a version');
  eq(second.versions?.[1].content, 'Edited twice.', 'it writes over the working copy');
  eq(second.versions?.[0].content, 'As it arrived.', 'and never over the original');
  eq(second.content, 'Edited twice.', 'the page reads the newest text');

  const third = applyManualEdit(second, 'Edited three times.', 400);
  eq(third.versions?.length, 2, 'nor does a third, or any after it');
  eq(third.versions?.[1].createdAt, 400, 'though the working copy is re-stamped');

  // Clicking in and out must not spend a slot.
  eq(applyManualEdit(third, 'Edited three times.', 500), third,
    'an edit that changes nothing changes nothing');
}

/* ── Writing a blank page is not an edit of anything ─────────────────────── */
{
  // "Add page" hands you an empty one. Banking its emptiness as the `original`
  // would give every written-from-scratch page a switcher offering to go back
  // to nothing.
  const blank = { id: 'p', content: '', createdAt: 1 };
  const written = applyManualEdit(blank, 'Day eleven. The salt flats.', 2);
  eq(written.versions, undefined, 'a first write on a blank page banks no history');
  eq(written.content, 'Day eleven. The salt flats.', 'it just becomes the page');

  // The second write, though, has something worth preserving.
  const rewritten = applyManualEdit(written, 'Day eleven. Salt, and no water.', 3);
  eq(rewritten.versions?.length, 2, 'the next edit keeps what was written');
  eq(rewritten.versions?.[0].content, 'Day eleven. The salt flats.', 'as the original');

  eq(applyManualEdit({ id: 'p', content: '   ', createdAt: 1 }, 'text', 2).versions, undefined,
    'and whitespace counts as blank');
}

/* ── A hand edit never writes over an AI revision, or the original ───────── */
{
  const withAi = {
    id: 'p',
    content: 'The AI rewrite.',
    createdAt: 1,
    versions: [
      { content: 'As it arrived.', source: 'original' as const, createdAt: 1 },
      { content: 'The AI rewrite.', source: 'ai' as const, instruction: 'tighten it', createdAt: 2 },
    ],
    activeVersion: 1,
  };
  const edited = applyManualEdit(withAi, 'My tweak of the rewrite.', 3);
  eq(edited.versions?.length, 3, 'editing an AI version adds one rather than replacing it');
  eq(edited.versions?.[1].content, 'The AI rewrite.', 'the revision you asked for is untouched');
  eq(edited.versions?.[1].instruction, 'tighten it', 'with its provenance intact');
  eq(edited.versions?.[2].source, 'manual', 'and the tweak is yours');
  eq(edited.activeVersion, 2, 'and is what shows');

  // From there it folds again, so a session of tweaking costs one slot.
  const again = applyManualEdit(edited, 'My second tweak.', 4);
  eq(again.versions?.length, 3, 'and further tweaks fold into it');

  // Stepping back to the original and typing must not overwrite the original.
  const onOriginal = applyManualEdit({ ...again, activeVersion: 0, content: 'As it arrived.' },
    'Typed over the original?', 5);
  eq(onOriginal.versions?.[0].content, 'As it arrived.',
    'typing while the original is showing does not consume it');
  eq(onOriginal.versions?.length, 4, 'it adds a version instead');
}

/* ── The cap keeps the original ──────────────────────────────────────────── */
{
  // Only AI revisions can reach the cap by themselves — hand edits fold — so
  // this is the shape a heavily revised pin ends up in.
  let page: PinPage = {
    id: 'p',
    content: 'v0',
    createdAt: 0,
    versions: [{ content: 'v0', source: 'original', createdAt: 0 }],
    activeVersion: 0,
  };
  for (let i = 1; i <= MAX_PAGE_VERSIONS + 4; i++) {
    page = {
      ...page,
      versions: [...(page.versions ?? []), { content: `v${i}`, source: 'ai', createdAt: i }],
      activeVersion: (page.versions?.length ?? 0),
      content: `v${i}`,
    };
  }
  const edited = applyManualEdit(page, 'and then by hand', 999);
  ok((edited.versions?.length ?? 0) <= MAX_PAGE_VERSIONS, 'the history is capped');
  eq(edited.versions?.[0].content, 'v0', 'and the original is the one thing never dropped');
  eq(edited.versions?.[0].source, 'original', 'still marked as such');
  eq(edited.content, 'and then by hand', 'with the newest text showing');
}

/* ── Editing through the pin, on whichever page is open ──────────────────── */
{
  let book = plainPin();
  book = addPage(book, { id: 'p2', content: 'Second entry.', createdAt: 2 });
  eq(activePageIndex(book), 1, 'we are on the page just added');

  const edited = editActivePage(book, 'Second entry, fixed.', 500);
  eq(edited.pages?.[1].content, 'Second entry, fixed.', 'the open page is the one edited');
  eq(edited.pages?.[0].content, 'Day one.', 'and the other is untouched');
  eq(edited.pages?.[1].versions?.length, 2, 'with its own original kept');
  eq(edited.pages?.[0].versions, undefined, 'while the other page gains no history');
  mirrorsActivePage(edited, 'editActivePage');

  // A no-op must not churn the pin — the store leans on reference equality to
  // decide whether to write at all.
  eq(editActivePage(edited, 'Second entry, fixed.', 600), edited,
    'an edit that changes nothing returns the very same pin');

  // And on a plain, page-less pin it still works, promoting as it goes.
  const plain = editActivePage(plainPin(), 'Rewritten.', 700);
  eq(plain.content, 'Rewritten.', 'a single-note pin edits too');
  eq(plain.versions?.[0].content, 'Day one.', 'keeping what it said before');
  mirrorsActivePage(plain, 'editing a plain pin');
}

/* ── syncActive is idempotent ────────────────────────────────────────────── */
{
  const book = addPage(plainPin(), { id: 'p2', content: 'Two.', createdAt: 2 });
  const once = syncActive(book);
  const twice = syncActive(once);
  eq(JSON.stringify(once), JSON.stringify(twice), 'syncing an already-synced pin changes nothing');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
