/**
 * Pockets, and the crew a task makes of them.
 *
 * A context zone is material and nothing else, so "all of my own messages" is a
 * thing the reader has to explain the purpose of every single time they use it.
 * A POCKET says it once: these zones, for this, in this voice.
 *
 * A task's STEPS are then an order over pockets — Mara writes three, I answer
 * twice, a third pocket narrates around both — which is the arrangement the
 * reader described and the one that could not be expressed before.
 *
 * Split out of `TaskPanel` because it is a second editor rather than more of
 * the first: a task without steps is still a plain walk over zones, and that
 * form has nothing to say about pockets.
 */

import { useState } from 'react';
import { ArrowDown, ArrowUp, Boxes, Plus, Trash2, X } from 'lucide-react';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import type { ContextZone } from '../types';
import {
  OUTPUT_LABEL, pocketSummary,
  type ContextPocket, type PocketOutput, type PocketStep,
} from '../utils/contextPocket';
import { cn } from '../utils/cn';

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/* ------------------------------------------------------------------ */
/* The pockets themselves                                              */
/* ------------------------------------------------------------------ */

export const PocketsEditor = ({
  storyId, pockets, zones,
}: {
  storyId: string;
  pockets: ContextPocket[];
  zones: ContextZone[];
}) => {
  const addPocket = useAuraV2Store(s => s.addPocket);
  const updatePocket = useAuraV2Store(s => s.updatePocket);
  const removePocket = useAuraV2Store(s => s.removePocket);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Boxes size={13} className="text-accent" />
        <span className="text-xs font-medium">Pockets</span>
        <span className="text-[10px] text-muted flex-1">
          A zone with a job attached — what it is for, and how it should sound.
        </span>
        <button
          onClick={() => {
            const id = addPocket(storyId, { name: `Pocket ${pockets.length + 1}`, zoneIds: [], purpose: '' });
            setOpenId(id);
          }}
          disabled={!zones.length}
          title={zones.length ? 'New pocket' : 'Make a context zone first'}
          data-testid="new-pocket"
          className="text-[11px] px-2 py-0.5 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40"
        >
          <Plus size={11} className="inline" /> New
        </button>
      </div>

      {!pockets.length && (
        <p className="text-[11px] text-muted leading-snug">
          None yet. A pocket is how you say “these passages, for writing as Mara” once
          instead of every time.
        </p>
      )}

      {pockets.map(p => {
        const open = openId === p.id;
        return (
          <div key={p.id} className="rounded-lg border border-app-border">
            <button
              onClick={() => setOpenId(open ? null : p.id)}
              aria-expanded={open}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-app-text/[0.03]"
            >
              <span className="text-xs font-medium truncate">{p.name}</span>
              <span className="text-[10px] text-muted truncate flex-1">{pocketSummary(p)}</span>
            </button>
            {open && (
              <div className="px-2 pb-2 space-y-1.5">
                <input
                  value={p.name}
                  onChange={e => updatePocket(storyId, p.id, { name: e.target.value })}
                  placeholder="Name"
                  aria-label="Pocket name"
                  className="w-full text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50"
                />
                <textarea
                  value={p.purpose}
                  onChange={e => updatePocket(storyId, p.id, { purpose: e.target.value })}
                  rows={2}
                  placeholder="What is this pocket for? (sent with every step it takes)"
                  className="w-full text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50 resize-y"
                />
                <textarea
                  value={p.voice ?? ''}
                  onChange={e => updatePocket(storyId, p.id, { voice: e.target.value })}
                  rows={2}
                  placeholder="How should it write, when it writes? (optional)"
                  className="w-full text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50 resize-y"
                />
                <div>
                  <p className="text-[10px] text-muted mb-1">Its material</p>
                  <div className="flex flex-wrap gap-1">
                    {zones.map(z => {
                      const on = p.zoneIds.includes(z.id);
                      return (
                        <button
                          key={z.id}
                          onClick={() => updatePocket(storyId, p.id, {
                            zoneIds: on
                              ? p.zoneIds.filter(id => id !== z.id)
                              : [...p.zoneIds, z.id],
                          })}
                          aria-pressed={on}
                          className={cn(
                            'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                            on
                              ? 'border-accent bg-accent/10 text-accent font-bold'
                              : 'border-app-border hover:bg-app-text/5',
                          )}
                        >
                          {z.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  onClick={() => { removePocket(storyId, p.id); setOpenId(null); }}
                  className="flex items-center gap-1 text-[10px] text-muted hover:text-red-500"
                >
                  <Trash2 size={10} /> Delete this pocket
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* The crew                                                            */
/* ------------------------------------------------------------------ */

export const StepsEditor = ({
  steps, pockets, onChange,
}: {
  steps: PocketStep[];
  pockets: ContextPocket[];
  onChange: (next: PocketStep[]) => void;
}) => {
  const patch = (id: string, updates: Partial<PocketStep>) =>
    onChange(steps.map(s => (s.id === id ? { ...s, ...updates } : s)));

  const move = (index: number, direction: -1 | 1) => {
    const to = index + direction;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">Steps</span>
        <span className="text-[10px] text-muted flex-1">
          Each pocket does its part, in order, seeing what the ones before it made.
        </span>
        <button
          onClick={() => onChange([...steps, {
            id: newId(),
            pocketId: pockets[0]?.id ?? '',
            instruction: '',
            output: 'drafts',
            count: 1,
          }])}
          disabled={!pockets.length}
          title={pockets.length ? 'Add a step' : 'Make a pocket first'}
          data-testid="new-step"
          className="text-[11px] px-2 py-0.5 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40"
        >
          <Plus size={11} className="inline" /> Step
        </button>
      </div>

      {!steps.length && (
        <p className="text-[11px] text-muted leading-snug">
          No steps — this task will read its zones straight through into one document,
          as it always has. Add a step to make it a crew of pockets instead.
        </p>
      )}

      {steps.map((step, i) => (
        <div key={step.id} className="rounded-lg border border-app-border p-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-muted shrink-0">{i + 1}</span>
            <select
              value={step.pocketId}
              onChange={e => patch(step.id, { pocketId: e.target.value })}
              aria-label={`Pocket for step ${i + 1}`}
              className="flex-1 min-w-0 text-xs bg-app-text/5 border border-app-border rounded-md px-1.5 py-1 outline-none focus:border-accent/50"
            >
              {/* A step whose pocket was deleted keeps naming it, so the plan
                * still shows what it was meant to be rather than silently
                * re-pointing at somebody else's pocket. */}
              {!pockets.some(p => p.id === step.pocketId) && (
                <option value={step.pocketId}>(deleted pocket)</option>
              )}
              {pockets.map(p => (
                <option key={p.id} value={p.id} className="text-black bg-white">{p.name}</option>
              ))}
            </select>
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move earlier"
              className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-25"
            >
              <ArrowUp size={11} />
            </button>
            <button
              onClick={() => move(i, 1)}
              disabled={i === steps.length - 1}
              aria-label="Move later"
              className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-25"
            >
              <ArrowDown size={11} />
            </button>
            <button
              onClick={() => onChange(steps.filter(s => s.id !== step.id))}
              aria-label="Remove this step"
              className="p-0.5 rounded hover:bg-app-text/10 hover:text-red-500"
            >
              <X size={11} />
            </button>
          </div>

          <textarea
            value={step.instruction}
            onChange={e => patch(step.id, { instruction: e.target.value })}
            rows={2}
            placeholder="What should this pocket do?"
            className="w-full text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50 resize-y"
          />

          <div className="flex items-center gap-1.5">
            {(Object.keys(OUTPUT_LABEL) as PocketOutput[]).map(o => (
              <button
                key={o}
                onClick={() => patch(step.id, { output: o })}
                title={OUTPUT_LABEL[o].hint}
                aria-pressed={step.output === o}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-md border transition-colors',
                  step.output === o
                    ? 'border-accent bg-accent/10 text-accent font-bold'
                    : 'border-app-border hover:bg-app-text/5',
                )}
              >
                {OUTPUT_LABEL[o].label}
              </button>
            ))}
            {step.output === 'drafts' && (
              <label className="ml-auto flex items-center gap-1 text-[10px] text-muted">
                how many
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={step.count ?? 1}
                  onChange={e => patch(step.id, {
                    count: Math.max(1, Math.min(12, Number(e.target.value) || 1)),
                  })}
                  className="w-12 bg-app-text/5 border border-app-border rounded px-1 py-0.5 outline-none focus:border-accent/50"
                />
              </label>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
