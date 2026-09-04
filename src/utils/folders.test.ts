/**
 * Tests for library folders.
 *
 * The failure that matters here is a story disappearing. A folder system has
 * exactly one way to lose things: an assignment that points at a folder which
 * no longer exists. Such a story is not in that folder (it is gone) and not in
 * Unfiled (it has an assignment), so it shows in no view at all and reads as
 * deleted. Three tests below exist only to make that impossible — via
 * `removeFolder` returning both halves, `pruneAssignments`, and a stale
 * selection falling back to "everything" rather than "nothing".
 *
 * Run: npx tsx src/utils/folders.test.ts
 */

import {
  ALL_FOLDERS, MAX_FOLDERS, MAX_FOLDER_NAME, UNFILED,
  addFolder, assignFolder, filterByFolder, folderCounts, folderOf, folderProblem,
  pruneAssignments, removeFolder, renameFolder, sanitizeFolders, sortFolders,
  type Folder, type FolderAssignments,
} from './folders';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);
const nul = (got: unknown, what: string) => eq(got, null, what);

const folder = (id: string, name: string, createdAt = 0): Folder => ({ id, name, createdAt });
const stories = (...ids: string[]) => ids.map(id => ({ id }));

const FOLDERS = [folder('f1', 'Horror'), folder('f2', 'Comfort'), folder('f3', 'Abandoned')];
const ASSIGN: FolderAssignments = { s1: 'f1', s2: 'f1', s3: 'f2' };
const STORIES = stories('s1', 's2', 's3', 's4', 's5');

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

{
  nul(folderProblem('Sci-fi', FOLDERS), 'a fresh name is fine');
  ok(!!folderProblem('', FOLDERS), 'an empty name is refused');
  ok(!!folderProblem('   ', FOLDERS), 'and so is whitespace');
  ok(folderProblem('x'.repeat(MAX_FOLDER_NAME + 1), FOLDERS)!.includes(String(MAX_FOLDER_NAME)),
    'an over-long name says how long is allowed');
}

{
  ok(!!folderProblem('Horror', FOLDERS), 'a duplicate name is refused');
  ok(!!folderProblem('horror', FOLDERS),
    'case-insensitively — "Horror" and "horror" side by side is never what anyone meant');
  ok(!!folderProblem('  HORROR  ', FOLDERS), 'and whitespace does not smuggle one past');
  ok(folderProblem('Horror', FOLDERS)!.includes('Horror'), 'and the message names the clash');

  nul(folderProblem('Horror', FOLDERS, 'f1'),
    'renaming a folder to its own name is not a duplicate');
  ok(!!folderProblem('Comfort', FOLDERS, 'f1'),
    'but renaming it onto another folder’s name is');
}

{
  const many = Array.from({ length: MAX_FOLDERS }, (_, i) => folder(`f${i}`, `Folder ${i}`));
  ok(!!folderProblem('One more', many), 'the folder cap is enforced');
  ok(folderProblem('One more', many)!.includes('tags'),
    'and points at tags, which are the right tool at that scale');
  nul(folderProblem('Folder 0 renamed', many, 'f0'),
    'but the cap never blocks a RENAME — that adds nothing');
}

/* ------------------------------------------------------------------ */
/* Adding, renaming                                                    */
/* ------------------------------------------------------------------ */

{
  const next = addFolder(FOLDERS, 'Sci-fi', 100);
  eq(next.length, 4, 'a folder is added');
  eq(next[3].name, 'Sci-fi', 'with its name');
  eq(next[3].createdAt, 100, 'and its timestamp');
  ok(!!next[3].id, 'and an id');
  eq(FOLDERS.length, 3, 'and the input list is not mutated');

  eq(addFolder(FOLDERS, 'Horror').length, 3, 'a duplicate name adds nothing');
  eq(addFolder(FOLDERS, '  ').length, 3, 'and neither does a blank one');
  eq(addFolder(FOLDERS, '  Sci-fi  ')[3].name, 'Sci-fi', 'names are trimmed on the way in');
}

{
  eq(renameFolder(FOLDERS, 'f1', 'Dread')[0].name, 'Dread', 'a folder can be renamed');
  eq(renameFolder(FOLDERS, 'f1', 'Comfort')[0].name, 'Horror',
    'but not onto another folder’s name');
  eq(renameFolder(FOLDERS, 'nope', 'Whatever'), FOLDERS, 'renaming a folder that is not there is a no-op');
}

/* ------------------------------------------------------------------ */
/* Deleting never loses a story                                        */
/* ------------------------------------------------------------------ */

{
  /**
   * The failure this whole file is guarding.
   *
   * Removing the folder without clearing its assignments leaves s1 and s2
   * pointing at `f1`, which no longer exists. They then appear in no folder
   * (there is none) and not in Unfiled (they have an assignment) — they are
   * simply gone from every view.
   */
  const { folders, assignments } = removeFolder(FOLDERS, ASSIGN, 'f1');

  eq(folders.map(f => f.id), ['f2', 'f3'], 'the folder is removed');
  eq(assignments, { s3: 'f2' }, 'and its stories are unfiled, not left dangling');

  const all = filterByFolder(STORIES, assignments, ALL_FOLDERS);
  eq(all.length, 5, 'every story is still in the library');
  eq(filterByFolder(STORIES, assignments, UNFILED).map(s => s.id), ['s1', 's2', 's4', 's5'],
    'and the two that were in the deleted folder are now findable in Unfiled');
}

{
  const { folders, assignments } = removeFolder(FOLDERS, ASSIGN, 'nope');
  eq(folders.length, 3, 'removing a folder that is not there changes nothing');
  eq(assignments, ASSIGN, 'and touches no assignment');
}

{
  // The same repair, for data that arrived already broken — an older build, or
  // a restore that brought assignments back without their folders.
  const dangling: FolderAssignments = { s1: 'f1', s2: 'gone', s3: 'also-gone' };
  eq(pruneAssignments(dangling, FOLDERS), { s1: 'f1' },
    'assignments pointing at folders that do not exist are dropped');
  eq(pruneAssignments({}, FOLDERS), {}, 'an empty map prunes to empty');
  eq(pruneAssignments(ASSIGN, []), {}, 'with no folders at all, everything unfiles');
}

/* ------------------------------------------------------------------ */
/* Exclusivity — the whole difference from tags                        */
/* ------------------------------------------------------------------ */

{
  const moved = assignFolder(ASSIGN, 's1', 'f2');
  eq(moved.s1, 'f2', 'assigning moves a story');
  eq(Object.values(moved).filter((_, i) => Object.keys(moved)[i] === 's1').length, 1,
    'a story is in exactly one folder — assigning REPLACES, it does not add');

  eq(assignFolder(ASSIGN, 's1', null).s1, undefined, 'assigning null unfiles');
  eq(assignFolder(ASSIGN, 's1', UNFILED).s1, undefined, 'and so does the Unfiled pseudo-folder');
  eq(assignFolder(ASSIGN, 's9', 'f1').s9, 'f1', 'a story with no folder yet can be filed');
  eq(ASSIGN.s1, 'f1', 'and the input map is never mutated');
}

{
  eq(folderOf(ASSIGN, 's1', FOLDERS)?.name, 'Horror', 'a story reports its folder');
  nul(folderOf(ASSIGN, 's4', FOLDERS), 'an unfiled story has none');
  nul(folderOf({ s1: 'gone' }, 's1', FOLDERS), 'and a dangling assignment reports none, not a crash');
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

{
  eq(filterByFolder(STORIES, ASSIGN, ALL_FOLDERS).length, 5, 'All shows everything');
  eq(filterByFolder(STORIES, ASSIGN, 'f1').map(s => s.id), ['s1', 's2'], 'a folder shows its own');
  eq(filterByFolder(STORIES, ASSIGN, 'f3'), [], 'an empty folder shows nothing, and that is fine');
  eq(filterByFolder(STORIES, ASSIGN, UNFILED).map(s => s.id), ['s4', 's5'],
    'Unfiled shows what is in no folder');
}

{
  /**
   * A selection that has gone stale must not look like an empty library.
   *
   * The reader deletes a folder in one tab while another has it selected. The
   * safe answer is "no filter" — showing them nothing looks exactly like having
   * lost everything, which is the most alarming thing this screen can do.
   */
  eq(filterByFolder(STORIES, ASSIGN, 'deleted-folder', FOLDERS).length, 5,
    'a selected folder that no longer exists falls back to showing everything');
  eq(filterByFolder(STORIES, ASSIGN, 'f1', FOLDERS).length, 2,
    'while a live selection still filters');
  eq(filterByFolder(STORIES, ASSIGN, 'anything').length, 0,
    'with no folder list to check against, an unknown id filters normally');
}

/* ------------------------------------------------------------------ */
/* Counts                                                              */
/* ------------------------------------------------------------------ */

{
  const { counts, unfiled, total } = folderCounts(FOLDERS, ASSIGN, STORIES);
  eq(counts.map(c => [c.folder.name, c.count]),
    [['Abandoned', 0], ['Comfort', 1], ['Horror', 2]],
    'every folder is counted, empty ones included, in alphabetical order');
  eq(unfiled, 2, 'and the unfiled are counted');
  eq(total, 5, 'and the total');
}

{
  /**
   * Counts describe what was passed in, not the whole library.
   *
   * A rail beside a search result should count the search result — "Horror 12"
   * above a list of three is a rail describing something the reader cannot see.
   */
  const searchResult = stories('s1');
  const { counts, unfiled } = folderCounts(FOLDERS, ASSIGN, searchResult);
  eq(counts.find(c => c.folder.name === 'Horror')?.count, 1,
    'counts follow the stories given, not the library');
  eq(unfiled, 0, 'including the unfiled count');
}

{
  const { counts, unfiled, total } = folderCounts([], {}, []);
  eq(counts, [], 'no folders, no counts');
  eq(unfiled, 0, 'nothing unfiled');
  eq(total, 0, 'nothing at all');
}

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

{
  const messy = [folder('c', 'zebra', 3), folder('a', 'Apple', 1), folder('b', 'apple', 2)];
  eq(sortFolders(messy).map(f => f.id), ['a', 'b', 'c'],
    'alphabetical, case-insensitive, with creation order breaking a tie');
  eq(sortFolders([]).length, 0, 'an empty list sorts fine');
  eq(messy[0].id, 'c', 'and the input is not mutated');

  eq(sortFolders([folder('1', 'Émile'), folder('2', 'Zoe'), folder('3', 'Alan')])
    .map(f => f.name), ['Alan', 'Émile', 'Zoe'],
    'accented names sort where a reader expects, not after z');
}

/* ------------------------------------------------------------------ */
/* Stored data                                                         */
/* ------------------------------------------------------------------ */

{
  eq(sanitizeFolders(null), [], 'null sanitizes to nothing');
  eq(sanitizeFolders('nope'), [], 'and so does a string');
  eq(sanitizeFolders([1, 'two', null, {}]), [], 'junk entries are dropped');
  eq(sanitizeFolders([{ id: 'a', name: 'Keep' }]),
    [{ id: 'a', name: 'Keep', createdAt: 0 }], 'a valid entry survives, with a default timestamp');
  eq(sanitizeFolders([{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }]).length, 1,
    'a duplicate id is dropped rather than shadowing the first');
  eq(sanitizeFolders([{ id: 'a', name: 'x'.repeat(200) }])[0].name.length, MAX_FOLDER_NAME,
    'an over-long stored name is truncated rather than refused');

  const tooMany = Array.from({ length: MAX_FOLDERS + 10 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
  eq(sanitizeFolders(tooMany).length, MAX_FOLDERS, 'and the cap holds on the way in');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
