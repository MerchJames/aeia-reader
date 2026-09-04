/**
 * Folders for the library.
 *
 * ── Folders and tags are not the same thing, and both earn their place ─────
 *
 * The library already has tags, and tags are the better tool for most of what
 * people want: a chat can be `horror` and `long` and `finished` at once, and
 * filtering by any of them is cheap. What tags cannot do is answer "where does
 * this one live" — and that is the question someone with four hundred chats is
 * actually asking. A tag list of forty items is not an organising system; it is
 * another thing to read.
 *
 * So: a folder is exclusive. A story is in one, or in none. That single rule is
 * what makes the sidebar count mean something and what makes "Unfiled" a place
 * you can actually empty. Tags stay for the cross-cutting facts.
 *
 * ── Folders exist independently of what is in them ────────────────────────
 *
 * The cheap implementation derives the folder list from the assignments —
 * whatever names are in use are the folders. It is wrong, and in a way people
 * hit within a minute: you cannot make a folder before you have something to
 * put in it, and the moment you move the last story out, the folder vanishes
 * along with the thought behind it. So folders are their own list, and an empty
 * one is a perfectly good folder.
 *
 * ── Deleting a folder never deletes a story ───────────────────────────────
 *
 * `removeFolder` returns the assignments with that folder's stories unfiled.
 * There is no code path here that removes a story from anything but a folder.
 *
 * Pure: no store, no React, no IndexedDB.
 */

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

/** Story id → folder id. A story missing from this map is unfiled. */
export type FolderAssignments = Record<string, string>;

/** The pseudo-folder for everything unassigned. Never a real folder id. */
export const UNFILED = '__unfiled__';

/** The pseudo-folder meaning "do not filter at all". */
export const ALL_FOLDERS = '__all__';

export const MAX_FOLDER_NAME = 40;
/**
 * A ceiling, so the rail stays a rail.
 *
 * Past this many, folders have stopped being a way to find things and become a
 * second library to search. Tags are the right tool at that point, and the app
 * says so rather than letting someone build a mess it cannot render.
 */
export const MAX_FOLDERS = 60;

let seq = 0;
const newId = () => `f${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Is this a usable folder name? Returns a reason, or null when it is fine.
 *
 * Case-insensitive uniqueness: "Horror" and "horror" as two different folders
 * is never what anyone meant, and the resulting rail is unreadable.
 */
export const folderProblem = (
  name: string,
  folders: readonly Folder[],
  /** Ignore this folder when checking for duplicates — used when renaming. */
  exceptId?: string,
): string | null => {
  const clean = name.trim();
  if (!clean) return 'A folder needs a name.';
  if (clean.length > MAX_FOLDER_NAME) {
    return `Keep it under ${MAX_FOLDER_NAME} characters.`;
  }
  const taken = folders.some(
    f => f.id !== exceptId && f.name.trim().toLowerCase() === clean.toLowerCase(),
  );
  if (taken) return `There is already a folder called “${clean}”.`;
  if (!exceptId && folders.length >= MAX_FOLDERS) {
    return `That is ${MAX_FOLDERS} folders — past this, tags will find things faster.`;
  }
  return null;
};

/** Add a folder, or return the list unchanged when the name will not do. */
export const addFolder = (
  folders: readonly Folder[], name: string, now = Date.now(),
): Folder[] => {
  if (folderProblem(name, folders)) return [...folders];
  return [...folders, { id: newId(), name: name.trim(), createdAt: now }];
};

export const renameFolder = (
  folders: readonly Folder[], id: string, name: string,
): Folder[] => {
  if (folderProblem(name, folders, id)) return [...folders];
  return folders.map(f => (f.id === id ? { ...f, name: name.trim() } : f));
};

/**
 * Remove a folder and unfile everything that was in it.
 *
 * Returns both halves because they must change together: a folder removed from
 * the list while assignments still point at it leaves stories filed under
 * something that does not exist, which shows up as a library where some chats
 * appear in no folder AND not in Unfiled — that is, chats that have vanished.
 */
export const removeFolder = (
  folders: readonly Folder[],
  assignments: FolderAssignments,
  id: string,
): { folders: Folder[]; assignments: FolderAssignments } => {
  const next: FolderAssignments = {};
  for (const [storyId, folderId] of Object.entries(assignments)) {
    if (folderId !== id) next[storyId] = folderId;
  }
  return { folders: folders.filter(f => f.id !== id), assignments: next };
};

/**
 * File a story, or unfile it with `null`.
 *
 * Exclusive by construction: assigning replaces, it does not add. That is the
 * whole difference from tags and it is enforced here rather than trusted to
 * every caller.
 */
export const assignFolder = (
  assignments: FolderAssignments, storyId: string, folderId: string | null,
): FolderAssignments => {
  const next = { ...assignments };
  if (folderId === null || folderId === UNFILED) delete next[storyId];
  else next[storyId] = folderId;
  return next;
};

/**
 * Drop assignments pointing at folders that no longer exist.
 *
 * Belt and braces for data written by an older build, or a restore that brought
 * back assignments without their folders. Without it those stories are filed
 * nowhere visible — see the note on `removeFolder`.
 */
export const pruneAssignments = (
  assignments: FolderAssignments, folders: readonly Folder[],
): FolderAssignments => {
  const live = new Set(folders.map(f => f.id));
  const next: FolderAssignments = {};
  for (const [storyId, folderId] of Object.entries(assignments)) {
    if (live.has(folderId)) next[storyId] = folderId;
  }
  return next;
};

/** The folder a story is in, or null. */
export const folderOf = (
  assignments: FolderAssignments, storyId: string, folders: readonly Folder[],
): Folder | null => {
  const id = assignments[storyId];
  return (id && folders.find(f => f.id === id)) || null;
};

/**
 * Keep only the stories in the chosen folder.
 *
 * `ALL_FOLDERS` returns everything, `UNFILED` returns what is in no folder, and
 * an id that does not exist returns everything rather than nothing — a stale
 * selection should look like "no filter", not like an empty library.
 */
export const filterByFolder = <T extends { id: string }>(
  stories: readonly T[],
  assignments: FolderAssignments,
  selected: string,
  folders: readonly Folder[] = [],
): T[] => {
  if (selected === ALL_FOLDERS) return [...stories];
  if (selected === UNFILED) return stories.filter(s => !assignments[s.id]);
  if (folders.length && !folders.some(f => f.id === selected)) return [...stories];
  return stories.filter(s => assignments[s.id] === selected);
};

export interface FolderCount {
  folder: Folder;
  count: number;
}

/**
 * Folders with how many stories are in each, plus the unfiled total.
 *
 * Counts come from the stories PASSED IN, so a rail rendered beside a filtered
 * library counts what the reader can actually see. Counting the whole library
 * instead would show "Horror 12" above a list of three.
 */
export const folderCounts = (
  folders: readonly Folder[],
  assignments: FolderAssignments,
  stories: readonly { id: string }[],
): { counts: FolderCount[]; unfiled: number; total: number } => {
  const tally = new Map<string, number>();
  let unfiled = 0;
  for (const story of stories) {
    const id = assignments[story.id];
    if (!id) { unfiled++; continue; }
    tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  return {
    counts: sortFolders(folders).map(folder => ({ folder, count: tally.get(folder.id) ?? 0 })),
    unfiled,
    total: stories.length,
  };
};

/**
 * Alphabetical, and stable.
 *
 * Not creation order: a rail you scan for a name has to be in the order names
 * come in, or every lookup is a linear search. `localeCompare` so accented
 * names sort where a reader expects rather than after `z`.
 */
export const sortFolders = (folders: readonly Folder[]): Folder[] =>
  [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.createdAt - b.createdAt);

/** Make a stored list safe to render. */
export const sanitizeFolders = (raw: unknown): Folder[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const id = typeof f.id === 'string' ? f.id : '';
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, MAX_FOLDER_NAME),
      createdAt: typeof f.createdAt === 'number' ? f.createdAt : 0,
    });
  }
  return out.slice(0, MAX_FOLDERS);
};
