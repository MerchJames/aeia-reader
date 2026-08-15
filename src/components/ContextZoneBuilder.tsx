import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, GitFork, Layers, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { flatWithIndex, groupRanges, parseRangeSpec } from '../utils/contextZone';
import { cn } from '../utils/cn';

/** One-line, markdown-stripped preview of a message for the row list. */
const preview = (text: string, len = 100): string => {
  const plain = text.replace(/[*_`#>[\]]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
};

// Beyond this, rendering every row unfiltered gets heavy — nudge toward search/range.
const RENDER_CAP = 600;

/**
 * Builder for a Context Zone: pick specific messages (by their reading number)
 * to include, and independently mark messages whose full branchlines (all
 * alternate versions) should come along. Selections save per story and can be
 * reused as a named AI-context scope.
 */
export const ContextZoneBuilder = ({
  storyId, onSaved,
}: {
  storyId: string;
  onSaved: (zoneId: string) => void;
}) => {
  const chains = useAppStore(s => s.chains);
  const timelines = useAppStore(s => s.currentStory?.timelines) ?? [];
  const editingZoneId = useAuraV2Store(s => s.editingZoneId);
  const zones = useAuraV2Store(s => s.zonesByStory[storyId]);
  const addZone = useAuraV2Store(s => s.addZone);
  const updateZone = useAuraV2Store(s => s.updateZone);
  const removeZone = useAuraV2Store(s => s.removeZone);
  const close = useAuraV2Store(s => s.setZoneBuilderOpen);

  const entries = useMemo(() => flatWithIndex(chains), [chains]);
  const existing = editingZoneId ? zones?.find(z => z.id === editingZoneId) : undefined;

  const [name, setName] = useState(existing?.name ?? `Zone ${(zones?.length ?? 0) + 1}`);
  const [included, setIncluded] = useState<Set<string>>(new Set(existing?.messageIds ?? []));
  const [branchlines, setBranchlines] = useState<Set<string>>(new Set(existing?.branchlineIds ?? []));
  // Attached branch timelines: whole tails, or individual tail messages.
  const [wholeTimelines, setWholeTimelines] = useState<Set<string>>(new Set(existing?.timelineIds ?? []));
  const [timelinePicks, setTimelinePicks] = useState<Set<string>>(new Set(existing?.timelineMessageIds ?? []));
  const [openTimelines, setOpenTimelines] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [rangeSpec, setRangeSpec] = useState('');
  const [rangeBranchlines, setRangeBranchlines] = useState(false);

  const toggle = (setFn: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setFn(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const applyRange = () => {
    const wanted = new Set(parseRangeSpec(rangeSpec, entries.length));
    if (wanted.size === 0) return;
    const picked = entries.filter(e => wanted.has(e.index));
    setIncluded(prev => {
      const next = new Set(prev);
      picked.forEach(e => next.add(e.msg.id));
      return next;
    });
    // The checkbox: also mark branchlines for any picked message that has alternates.
    if (rangeBranchlines) {
      setBranchlines(prev => {
        const next = new Set(prev);
        picked.forEach(e => { if ((e.msg.swipes?.length ?? 0) > 1) next.add(e.msg.id); });
        return next;
      });
    }
    setRangeSpec('');
  };

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return entries;
    return entries.filter(e =>
      e.msg.name.toLowerCase().includes(q) ||
      e.msg.content.toLowerCase().includes(q) ||
      String(e.index) === q);
  }, [entries, q]);
  const capped = filtered.length > RENDER_CAP && !q ? filtered.slice(0, RENDER_CAP) : filtered;

  const includedNums = entries.filter(e => included.has(e.msg.id)).map(e => e.index);
  const branchNums = entries
    .filter(e => branchlines.has(e.msg.id) && (e.msg.swipes?.length ?? 0) > 1)
    .map(e => e.index);
  const timelinePickCount = timelines
    .filter(t => !wholeTimelines.has(t.id))
    .reduce((n, t) => n + t.messages.filter(m => timelinePicks.has(m.id)).length, 0);
  const canSave = included.size > 0 || branchNums.length > 0
    || wholeTimelines.size > 0 || timelinePickCount > 0;

  const save = () => {
    if (!canSave) return;
    // Persist ids in reading order so the prompt reads coherently.
    const messageIds = entries.filter(e => included.has(e.msg.id)).map(e => e.msg.id);
    const branchlineIds = entries
      .filter(e => branchlines.has(e.msg.id) && (e.msg.swipes?.length ?? 0) > 1)
      .map(e => e.msg.id);
    const timelineIds = timelines.filter(t => wholeTimelines.has(t.id)).map(t => t.id);
    const timelineMessageIds = timelines
      .filter(t => !wholeTimelines.has(t.id))
      .flatMap(t => t.messages.filter(m => timelinePicks.has(m.id)).map(m => m.id));
    const trimmed = name.trim() || 'Untitled zone';
    let id = editingZoneId ?? '';
    if (existing) {
      updateZone(storyId, existing.id, {
        name: trimmed, messageIds, branchlineIds, timelineIds, timelineMessageIds,
      });
      id = existing.id;
    } else {
      id = addZone(storyId, {
        name: trimmed, messageIds, branchlineIds, timelineIds, timelineMessageIds,
      });
    }
    close(false);
    onSaved(id);
  };

  const del = () => {
    if (existing) removeZone(storyId, existing.id);
    close(false);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[3px]" onClick={() => close(false)} />
      <div className="relative w-full max-w-2xl h-[min(80dvh,680px)] flex flex-col rounded-2xl bg-surface border border-app-border shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border bg-app-text/5">
          <div className="flex items-center gap-2 font-bold text-sm">
            <Layers size={16} className="text-accent" />
            {existing ? 'Edit context zone' : 'New context zone'}
          </div>
          <button onClick={() => close(false)} className="p-1.5 rounded-full opacity-60 hover:opacity-100 hover:bg-app-text/10">
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 border-b border-app-border space-y-2.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Zone name…"
            className="w-full bg-app-text/5 border border-app-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent/50"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Quick add by number</span>
            <input
              type="text" value={rangeSpec}
              onChange={(e) => setRangeSpec(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyRange(); }}
              placeholder="e.g. 1-30, 45, 50-60"
              className="w-44 bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50"
            />
            <label
              className="flex items-center gap-1 cursor-pointer select-none"
              title="Also include all alternate versions (branchlines) of any message in this range that has them"
            >
              <input
                type="checkbox" checked={rangeBranchlines}
                onChange={(e) => setRangeBranchlines(e.target.checked)}
                className="accent-accent"
              />
              <GitBranch size={11} /> Branchlines
            </label>
            <button
              onClick={applyRange}
              className="px-2.5 py-1 rounded-md border border-app-border hover:bg-app-text/5"
            >
              Add
            </button>
            <input
              type="text" value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search messages…"
              className="flex-1 min-w-[8rem] bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
            <span><b className="text-app-text">{includedNums.length}</b> included{includedNums.length ? ` (${groupRanges(includedNums)})` : ''}</span>
            <span className="flex items-center gap-1"><GitBranch size={11} /><b className="text-app-text">{branchNums.length}</b> branchline{branchNums.length === 1 ? '' : 's'}{branchNums.length ? ` (${groupRanges(branchNums)})` : ''}</span>
            {timelines.length > 0 && (
              <span className="flex items-center gap-1">
                <GitFork size={11} />
                <b className="text-app-text">{wholeTimelines.size}</b> whole branch{wholeTimelines.size === 1 ? '' : 'es'}
                {timelinePickCount > 0 && <> · <b className="text-app-text">{timelinePickCount}</b> branch msg{timelinePickCount === 1 ? '' : 's'}</>}
              </span>
            )}
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {capped.length === 0 && (
            <p className="text-center text-sm text-muted py-8">No messages match “{search}”.</p>
          )}
          {capped.map(({ msg, index }) => {
            const isIn = included.has(msg.id);
            const hasSwipes = (msg.swipes?.length ?? 0) > 1;
            const isBranch = branchlines.has(msg.id) && hasSwipes;
            return (
              <div
                key={msg.id}
                className={cn(
                  'flex items-start gap-2 px-2.5 py-1.5 rounded-lg border mb-1 transition-colors',
                  isIn ? 'border-accent/60 bg-accent/[0.07]' : 'border-transparent hover:bg-app-text/5',
                )}
              >
                <button
                  onClick={() => toggle(setIncluded, msg.id)}
                  className={cn(
                    'mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] font-bold',
                    isIn ? 'bg-accent border-accent text-white' : 'border-app-border',
                  )}
                  title={isIn ? 'Included — click to remove' : 'Click to include this message'}
                >
                  {isIn ? '✓' : ''}
                </button>
                <button
                  onClick={() => toggle(setIncluded, msg.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-muted shrink-0">#{index}</span>
                    <span className="text-xs font-bold truncate">{msg.name}</span>
                  </div>
                  <div className="text-[11px] text-muted truncate">{preview(msg.content) || '(empty)'}</div>
                </button>
                {hasSwipes && (
                  <button
                    onClick={() => toggle(setBranchlines, msg.id)}
                    title={`Include all ${msg.swipes!.length} alternate versions (branchlines) of this message`}
                    className={cn(
                      'shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md border whitespace-nowrap',
                      isBranch ? 'border-accent bg-accent/10 text-accent font-bold' : 'border-app-border hover:bg-app-text/5',
                    )}
                  >
                    <GitBranch size={11} /> {msg.swipes!.length}
                  </button>
                )}
              </div>
            );
          })}
          {filtered.length > RENDER_CAP && !q && (
            <p className="text-center text-[11px] text-muted py-3">
              Showing first {RENDER_CAP} of {filtered.length}. Use search or the range adder to reach the rest.
            </p>
          )}

          {/* Attached branch timelines: whole tails or individual messages. */}
          {timelines.length > 0 && (
            <div className="mt-3 pt-3 border-t border-app-border">
              <p className="px-2 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
                <GitFork size={11} /> Branch timelines
              </p>
              {timelines.map(tl => {
                const whole = wholeTimelines.has(tl.id);
                const open = openTimelines.has(tl.id);
                const pickedHere = tl.messages.filter(m => timelinePicks.has(m.id)).length;
                return (
                  <div key={tl.id} className="mb-1">
                    <div
                      className={cn(
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-colors',
                        whole ? 'border-accent/60 bg-accent/[0.07]' : 'border-transparent hover:bg-app-text/5',
                      )}
                    >
                      <button
                        onClick={() => toggle(setWholeTimelines, tl.id)}
                        className={cn(
                          'w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] font-bold',
                          whole ? 'bg-accent border-accent text-white' : 'border-app-border',
                        )}
                        title={whole
                          ? 'Whole branch included — click to remove'
                          : 'Include this entire branch (its divergent tail)'}
                      >
                        {whole ? '✓' : ''}
                      </button>
                      <button
                        onClick={() => toggle(setOpenTimelines, tl.id)}
                        className="flex-1 min-w-0 text-left flex items-center gap-1.5"
                      >
                        {open ? <ChevronDown size={12} className="shrink-0 opacity-60" /> : <ChevronRight size={12} className="shrink-0 opacity-60" />}
                        <span className="text-xs font-bold truncate">{tl.name}</span>
                        <span className="text-[10px] text-muted shrink-0">
                          forks after #{tl.forkIndex} · {tl.messages.length} msg{tl.messages.length === 1 ? '' : 's'}
                          {!whole && pickedHere > 0 && ` · ${pickedHere} picked`}
                        </span>
                      </button>
                    </div>
                    {open && !whole && (
                      <div className="ml-6 mt-0.5">
                        {tl.messages.map((m, mi) => {
                          const isPicked = timelinePicks.has(m.id);
                          return (
                            <div
                              key={m.id}
                              className={cn(
                                'flex items-start gap-2 px-2.5 py-1 rounded-lg border mb-0.5 transition-colors',
                                isPicked ? 'border-accent/60 bg-accent/[0.07]' : 'border-transparent hover:bg-app-text/5',
                              )}
                            >
                              <button
                                onClick={() => toggle(setTimelinePicks, m.id)}
                                className={cn(
                                  'mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] font-bold',
                                  isPicked ? 'bg-accent border-accent text-white' : 'border-app-border',
                                )}
                              >
                                {isPicked ? '✓' : ''}
                              </button>
                              <button
                                onClick={() => toggle(setTimelinePicks, m.id)}
                                className="flex-1 min-w-0 text-left"
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] font-mono text-muted shrink-0">b{mi + 1}</span>
                                  <span className="text-xs font-bold truncate">{m.name}</span>
                                </div>
                                <div className="text-[11px] text-muted truncate">{preview(m.content) || '(empty)'}</div>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {open && whole && (
                      <p className="ml-6 mt-0.5 px-2.5 text-[11px] text-muted italic">
                        Whole branch included — uncheck it to pick individual messages.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-app-border bg-app-text/5">
          {existing ? (
            <button onClick={del} className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-400 px-2 py-1.5">
              <Trash2 size={14} /> Delete
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button onClick={() => close(false)} className="text-xs px-3 py-1.5 rounded-md border border-app-border hover:bg-app-text/5">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="text-xs px-4 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-40"
            >
              {existing ? 'Save zone' : 'Create zone'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
