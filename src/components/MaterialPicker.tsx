/**
 * Choosing which of your own material goes into a prompt.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The proxy panel used to offer two checkboxes — "pins" and "sheets" — and that
 * was a setting for a library rather than for a scene. A reader with thirty
 * pins does not want thirty pins in every prompt; they want the four that
 * matter tonight. And with a budget on top, WHICH four went in was decided by
 * an invisible ordering rule.
 *
 * So: a list of the actual things, with what each one holds and what it costs,
 * and the picked ones in the order they were picked — because that order is the
 * priority order the budget is spent in.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * Offer anything it could not actually deliver. Zones only appear when their
 * story is open (they are message ids, and rendering one needs the story's
 * chains); an empty pin is not listed at all. A picker showing options that
 * quietly do nothing is worse than a shorter picker.
 */

import { useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import {
  listMaterial, pickCount, togglePick,
  type MaterialInput, type MaterialItem, type MaterialKind, type MaterialPick,
} from '../utils/proxyMaterial';
import { cn } from '../utils/cn';

const KIND_LABEL: Record<MaterialKind, string> = {
  pin: 'Pins',
  set: 'Sets',
  sheet: 'Sheets',
  codex: 'Codex',
  highlight: 'Highlights',
  zone: 'Zones',
};

const ORDER: MaterialKind[] = ['pin', 'set', 'sheet', 'codex', 'highlight', 'zone'];

const size = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export const MaterialPicker = ({
  input, pick, onChange, onClose,
}: {
  input: MaterialInput;
  pick: MaterialPick;
  onChange: (next: MaterialPick) => void;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MaterialKind | 'all'>('all');

  const all = useMemo(() => listMaterial(input), [input]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(item =>
      (kind === 'all' || item.kind === kind)
      && (!q || item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q)));
  }, [all, kind, query]);

  const counts = useMemo(() => {
    const out = {} as Record<MaterialKind, number>;
    for (const k of ORDER) out[k] = all.filter(i => i.kind === k).length;
    return out;
  }, [all]);

  const picked = useMemo(
    () => new Set(all.filter(i => isOn(pick, i)).map(i => `${i.kind}:${i.id}`)),
    [all, pick],
  );

  // What the budget will actually be spent on, in the order it will be spent.
  const total = all
    .filter(i => picked.has(`${i.kind}:${i.id}`))
    .reduce((n, i) => n + i.size, 0);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl max-h-[82vh] flex flex-col rounded-xl border border-app-border
                      bg-app-surface shadow-2xl">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <h2 className="font-medium text-app-text text-sm">What goes into the prompt</h2>
          <span className="text-[11px] text-app-muted">
            {pickCount(pick)} picked · ~{size(total)} chars
          </span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-app-bg text-app-muted"
            aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="px-4 pt-3 space-y-2">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-app-bg
                          border border-app-border">
            <Search size={13} className="text-app-muted shrink-0" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search your material…"
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>

          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Tab on={kind === 'all'} onClick={() => setKind('all')} label={`All ${all.length}`} />
            {ORDER.filter(k => counts[k] > 0).map(k => (
              <Tab key={k} on={kind === k} onClick={() => setKind(k)}
                label={`${KIND_LABEL[k]} ${counts[k]}`} />
            ))}
          </div>

          {/*
            * The one thing here that is a rule rather than a choice.
            *
            * Picking a set names that set forever; this follows whichever set is
            * active as the reader moves between scenes, which is the entire
            * reason sets exist. Worth its own line, above the list, because it
            * behaves differently from everything below it.
            */}
          <label className={cn(
            'flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer',
            pick.activeSet ? 'border-accent bg-accent/10' : 'border-app-border',
          )}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={pick.activeSet}
              onChange={e => onChange({ ...pick, activeSet: e.target.checked })}
            />
            <span className="text-xs text-app-text">
              Whatever my active pin set holds
              <span className="block text-[10px] text-app-muted">
                Follows the set as you switch it, rather than naming one now.
              </span>
            </span>
          </label>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 pt-2">
          {!shown.length ? (
            <p className="text-xs text-app-muted py-6 text-center">
              {all.length
                ? 'Nothing matches that.'
                : 'This story has no pins, sheets or codex entries yet.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map(item => {
                const on = picked.has(`${item.kind}:${item.id}`);
                return (
                  <li key={`${item.kind}:${item.id}`}>
                    <button
                      onClick={() => onChange(togglePick(pick, item))}
                      className={cn(
                        'w-full text-left flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors',
                        on ? 'border-accent bg-accent/10' : 'border-app-border hover:bg-app-bg',
                      )}
                    >
                      <span className={cn(
                        'mt-0.5 w-4 h-4 rounded shrink-0 border flex items-center justify-center',
                        on ? 'bg-accent border-accent text-white' : 'border-app-border',
                      )}>
                        {on && <Check size={11} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm text-app-text truncate">{item.title}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg text-app-muted shrink-0">
                            {KIND_LABEL[item.kind].replace(/s$/, '')}
                          </span>
                        </span>
                        <span className="block text-[11px] text-app-muted truncate">
                          {item.preview}
                        </span>
                      </span>
                      <span className="text-[10px] text-app-muted shrink-0 mt-0.5">
                        {size(item.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-app-border flex items-center gap-2">
          <p className="text-[11px] text-app-muted flex-1">
            Picked material goes in the order you picked it — the budget is spent from the top.
          </p>
          <button onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
};

const Tab = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button
    onClick={onClick}
    className={cn('px-2 py-1 rounded-full border',
      on ? 'border-accent bg-accent/10 text-app-text' : 'border-app-border text-app-muted')}
  >
    {label}
  </button>
);

const isOn = (pick: MaterialPick, item: MaterialItem): boolean => ({
  pin: pick.pins,
  set: pick.sets,
  sheet: pick.sheets,
  codex: pick.codex,
  highlight: pick.highlights,
  zone: pick.zones,
}[item.kind].includes(item.id));
