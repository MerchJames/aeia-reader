/**
 * The library's folder strip.
 *
 * A row of chips rather than a sidebar: the library is already a grid of wide
 * cards, and a left rail would take a column from them on exactly the screens
 * where cards are tightest. A row also degrades honestly — with no folders it
 * is one "New folder" button, which is the right amount of interface for
 * someone who has never wanted one.
 *
 * ── Counts are always shown, including zero ────────────────────────────────
 *
 * An empty folder that renders identically to a full one is how a reader loses
 * track of which folders they actually use. And because the counts come from
 * the stories currently in view, the strip stays truthful under a search: it
 * says how many of THESE are in each folder, not how many exist.
 *
 * Renaming and deleting live behind the chip's own edit affordance rather than
 * a separate management screen — there are never enough folders to need one,
 * and a screen is a place to have to go.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import {
  ALL_FOLDERS, UNFILED, folderCounts, folderProblem,
  type Folder, type FolderAssignments,
} from '../utils/folders';
import { cn } from '../utils/cn';

interface FolderRailProps {
  folders: Folder[];
  assignments: FolderAssignments;
  /** The stories currently in view — counts describe these, not the library. */
  stories: readonly { id: string }[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

export const FolderRail = ({
  folders, assignments, stories, selected, onSelect, onAdd, onRename, onRemove,
}: FolderRailProps) => {
  const { counts, unfiled, total } = folderCounts(folders, assignments, stories);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) addRef.current?.focus(); }, [adding]);

  const problem = adding ? folderProblem(draft, folders) : null;
  const editProblem = editingId ? folderProblem(editDraft, folders, editingId) : null;

  const commitAdd = () => {
    if (!folderProblem(draft, folders)) onAdd(draft);
    setDraft('');
    setAdding(false);
  };

  const commitEdit = () => {
    if (editingId && !folderProblem(editDraft, folders, editingId)) onRename(editingId, editDraft);
    setEditingId(null);
  };

  const Chip = ({ id, label, count }: { id: string; label: string; count: number }) => (
    <button
      onClick={() => onSelect(id)}
      data-testid={`folder-${id}`}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors',
        selected === id
          ? 'border-accent bg-accent/10 text-accent font-medium'
          : 'border-app-border text-muted hover:text-app-text hover:border-app-text/30',
      )}
    >
      <span className="truncate max-w-[10rem]">{label}</span>
      <span className="tabular-nums opacity-60">{count}</span>
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip id={ALL_FOLDERS} label="All" count={total} />
      {/* Unfiled only appears when something is actually unfiled. Before the
        * first folder exists everything is unfiled, and a chip saying so would
        * be a duplicate of All wearing a stranger name. */}
      {folders.length > 0 && unfiled > 0 && (
        <Chip id={UNFILED} label="Unfiled" count={unfiled} />
      )}

      {counts.map(({ folder, count }) => (
        editingId === folder.id ? (
          <span
            key={folder.id}
            className="flex items-center gap-1 px-2 py-1 rounded-full border border-accent/60 text-xs"
          >
            <input
              autoFocus
              value={editDraft}
              onChange={e => setEditDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') setEditingId(null);
              }}
              aria-label={`Rename ${folder.name}`}
              title={editProblem ?? undefined}
              className={cn(
                'bg-transparent outline-none w-24',
                editProblem && 'text-amber-400',
              )}
            />
            <button
              onClick={commitEdit}
              disabled={!!editProblem}
              aria-label="Save folder name"
              className="p-0.5 rounded text-accent disabled:opacity-40"
            >
              <Check size={12} />
            </button>
            {/* Removing a folder never removes a story — its chats become
              * Unfiled. The confirm says so, because "delete folder" reads like
              * it might take the contents with it. */}
            <button
              onClick={() => {
                const n = count === 1 ? 'its 1 chat' : `its ${count} chats`;
                if (count === 0 || confirm(
                  `Delete the folder “${folder.name}”?\n\n${n} will move to Unfiled. `
                  + 'Nothing is deleted.',
                )) {
                  onRemove(folder.id);
                  setEditingId(null);
                  if (selected === folder.id) onSelect(ALL_FOLDERS);
                }
              }}
              aria-label={`Delete folder ${folder.name}`}
              className="p-0.5 rounded text-red-400"
            >
              <Trash2 size={12} />
            </button>
          </span>
        ) : (
          <span key={folder.id} className="group relative flex items-center">
            <Chip id={folder.id} label={folder.name} count={count} />
            <button
              onClick={() => { setEditingId(folder.id); setEditDraft(folder.name); }}
              aria-label={`Edit folder ${folder.name}`}
              className="absolute -right-1 -top-1 p-0.5 rounded-full bg-surface border border-app-border
                         opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted hover:text-app-text"
            >
              <Pencil size={9} />
            </button>
          </span>
        )
      ))}

      {adding ? (
        <span className="flex items-center gap-1 px-2 py-1 rounded-full border border-accent/60 text-xs">
          <input
            ref={addRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitAdd();
              if (e.key === 'Escape') { setDraft(''); setAdding(false); }
            }}
            onBlur={commitAdd}
            placeholder="Folder name"
            aria-label="New folder name"
            className={cn('bg-transparent outline-none w-28', problem && draft && 'text-amber-400')}
          />
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={commitAdd}
            disabled={!!problem}
            aria-label="Create folder"
            className="p-0.5 rounded text-accent disabled:opacity-40"
          >
            <Check size={12} />
          </button>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => { setDraft(''); setAdding(false); }}
            aria-label="Cancel"
            className="p-0.5 rounded text-muted"
          >
            <X size={12} />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setAdding(true)}
          data-testid="new-folder"
          className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-muted
                     border border-dashed border-app-border hover:text-app-text hover:border-app-text/30"
        >
          <FolderPlus size={12} /> New folder
        </button>
      )}

      {adding && problem && draft.trim() && (
        <span className="text-[11px] text-amber-400">{problem}</span>
      )}
    </div>
  );
};
