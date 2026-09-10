/**
 * Chat completion presets, and building one out of several.
 *
 * ── What this screen is for ────────────────────────────────────────────────
 *
 * A published preset is a body of work — Lucid Loom is 326 prompts, a few dozen
 * of them switched on. Most of the value in owning several is not running one
 * of them; it is that the system prompt in this one is better than the system
 * prompt in that one, and the style rules in a third are the ones you actually
 * want. So: import as many as you like, and assemble.
 *
 * ── Why the middle column shows prompts that are switched OFF ──────────────
 *
 * Because that is where the good ones are. An author leaves three hundred
 * prompts in a preset switched off — drafts, alternatives, things for a
 * different model — and the reader who imported it is entitled to reach any of
 * them. `readCcPreset` keeps the whole pile and marks what the order had on;
 * this shows both, and picking is unrelated to either.
 *
 * ── References, not copies ─────────────────────────────────────────────────
 *
 * A pick names a preset and a prompt. Re-import a preset whose author fixed a
 * typo and every completion built on it has the fix. Delete a preset and the
 * picks that pointed into it go stale — visibly, in the right-hand column,
 * rather than quietly resolving to nothing.
 */

import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronUp, FileJson, Plus, Save, Trash2, Upload, X,
} from 'lucide-react';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import {
  MARKER_SLOTS, addPick, completionId, describePreset, emptyCompletion, isFillableMarker,
  movePick, presetProblem, previewCompletion, readCcPreset, removePick, resolvePicks,
  sourcesSquash, type LensCompletion,
} from '../utils/ccPreset';
import { cn } from '../utils/cn';

/** A preset file is JSON and small. Anything this size is not one. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const CompletionPanel = ({ onClose }: { onClose: () => void }) => {
  const presets = useAuraV2Store(s => s.ccPresets);
  const completions = useAuraV2Store(s => s.lensCompletions);
  const addCcPreset = useAuraV2Store(s => s.addCcPreset);
  const removeCcPreset = useAuraV2Store(s => s.removeCcPreset);
  const saveLensCompletion = useAuraV2Store(s => s.saveLensCompletion);
  const removeLensCompletion = useAuraV2Store(s => s.removeLensCompletion);

  const [selected, setSelected] = useState<string | null>(presets[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<LensCompletion>(() => emptyCompletion('New completion'));
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const preset = presets.find(p => p.id === selected) ?? null;
  const resolution = useMemo(() => resolvePicks(draft, presets), [draft, presets]);
  const preview = useMemo(
    // Every marker filled with a stand-in, so the preview shows the SHAPE of
    // the request. Filling them for real needs a story open and would make this
    // screen mean different things depending on where it was opened from.
    () => previewCompletion(draft, presets, Object.fromEntries(
      Object.entries(MARKER_SLOTS).map(([k, label]) => [k, `⟨${label}⟩`]),
    )),
    [draft, presets],
  );

  const importFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`${file.name} is ${Math.round(file.size / 1024)}KB — too large to be a preset.`);
      return;
    }
    let text: string;
    try { text = await file.text(); } catch { setError('That file could not be read.'); return; }
    const problem = presetProblem(text);
    if (problem) { setError(problem); return; }
    const name = file.name.replace(/\.json$/i, '');
    const imported = readCcPreset(text, name, `cc${Date.now().toString(36)}`);
    addCcPreset(imported);
    setSelected(imported.id);
  };

  const prompts = useMemo(() => {
    if (!preset) return [];
    const q = query.trim().toLowerCase();
    if (!q) return preset.prompts;
    return preset.prompts.filter(
      p => p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
    );
  }, [preset, query]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-5xl h-[min(86dvh,760px)] flex flex-col rounded-xl border border-app-border bg-app-bg shadow-2xl overflow-hidden"
        data-testid="completion-panel"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border/60 shrink-0">
          <FileJson size={14} className="text-accent" />
          <h2 className="text-sm font-semibold flex-1">Chat completion presets</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-app-text/10">
            <X size={14} />
          </button>
        </div>

        {error && <p className="px-4 py-2 text-[11px] text-red-500 shrink-0">{error}</p>}

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[200px_1fr_260px]">
          {/* ── Imported presets ─────────────────────────────────────────── */}
          <div className="border-r border-app-border/60 overflow-y-auto p-2 space-y-1">
            <label className="flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md border border-app-border hover:bg-app-text/5 cursor-pointer">
              <Upload size={11} /> Import a preset
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.target.value = '';
                }}
              />
            </label>

            {!presets.length && (
              <p className="text-[11px] text-muted px-1 pt-2 leading-relaxed">
                SillyTavern exports these from its preset menu. Text completion presets are a
                different format and will be refused.
              </p>
            )}

            {presets.map(p => (
              <div key={p.id} className="flex items-stretch">
                <button
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    'flex-1 min-w-0 text-left text-[11px] px-2 py-1.5 rounded-l-md border',
                    selected === p.id ? 'border-accent bg-accent/10' : 'border-app-border hover:bg-app-text/5',
                  )}
                >
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block text-[10px] text-muted">
                    {p.prompts.filter(x => x.enabled).length} on · {p.prompts.length} total
                  </span>
                </button>
                <button
                  onClick={() => { removeCcPreset(p.id); if (selected === p.id) setSelected(null); }}
                  aria-label={`Remove ${p.name}`}
                  className="px-1.5 rounded-r-md border border-l-0 border-app-border opacity-40 hover:opacity-100 hover:text-red-500"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>

          {/* ── The selected preset's prompts ────────────────────────────── */}
          <div className="border-r border-app-border/60 flex flex-col min-h-0">
            {preset ? (
              <>
                <div className="p-2 border-b border-app-border/60 shrink-0 space-y-1.5">
                  <p className="text-[11px] text-muted">{describePreset(preset)}</p>
                  {preset.ignored.length > 0 && (
                    <p className="text-[10px] text-amber-500">
                      {/* Named rather than dropped in silence: a reader whose
                          preset relied on regex scripts should know they did
                          not come along, not discover it from the output. */}
                      Not carried over: {preset.ignored.join('; ')}.
                    </p>
                  )}
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search these prompts…"
                    aria-label="Search prompts"
                    className="w-full text-[11px] rounded-md border border-app-border bg-transparent px-2 py-1"
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                  {prompts.map(p => {
                    const picked = draft.picks.some(
                      x => x.presetId === preset.id && x.identifier === p.identifier,
                    );
                    const unfillable = p.marker && !isFillableMarker(p.identifier);
                    return (
                      <div
                        key={p.identifier}
                        className={cn(
                          'flex items-start gap-2 rounded-md border px-2 py-1.5',
                          p.enabled ? 'border-app-border' : 'border-app-border/40 opacity-60',
                        )}
                      >
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium truncate">{p.name}</span>
                            {p.marker && (
                              <span className={cn(
                                'text-[9px] px-1 rounded shrink-0',
                                unfillable ? 'bg-amber-500/20 text-amber-500' : 'bg-accent/15 text-accent',
                              )}>
                                {unfillable ? 'no source' : 'placeholder'}
                              </span>
                            )}
                            {!p.enabled && <span className="text-[9px] text-muted shrink-0">off</span>}
                            {p.absolute && <span className="text-[9px] text-muted shrink-0">depth {p.depth}</span>}
                          </span>
                          <span className="block text-[10px] text-muted line-clamp-2 mt-0.5">
                            {p.marker
                              ? (isFillableMarker(p.identifier)
                                ? MARKER_SLOTS[p.identifier]
                                : `SillyTavern fills “${p.identifier}”; Aeia has nothing for it.`)
                              : p.content.slice(0, 160) || '(empty)'}
                          </span>
                        </span>
                        <button
                          onClick={() => setDraft(d => addPick(d, { presetId: preset.id, identifier: p.identifier }))}
                          disabled={picked || unfillable}
                          aria-label={`Add ${p.name}`}
                          className="shrink-0 p-1 rounded border border-app-border disabled:opacity-25 hover:bg-app-text/5"
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                    );
                  })}
                  {!prompts.length && (
                    <p className="text-[11px] text-muted px-1">Nothing matches that.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted p-3">Import a preset, or pick one on the left.</p>
            )}
          </div>

          {/* ── The completion being built ───────────────────────────────── */}
          <div className="flex flex-col min-h-0">
            <div className="p-2 border-b border-app-border/60 shrink-0 space-y-1.5">
              <input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                aria-label="Name"
                className="w-full text-[11px] font-medium rounded-md border border-app-border bg-transparent px-2 py-1"
              />
              <select
                value={draft.samplerFrom ?? ''}
                onChange={e => setDraft(d => ({ ...d, samplerFrom: e.target.value || null }))}
                aria-label="Sampler settings from"
                className="w-full text-[11px] rounded-md border border-app-border bg-transparent px-1.5 py-1"
              >
                <option value="">Aeia’s own sampler settings</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>Samplers from {p.name}</option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={draft.squashSystem}
                  onChange={e => setDraft(d => ({ ...d, squashSystem: e.target.checked }))}
                />
                Fold system messages together
              </label>
              {sourcesSquash(draft, presets) && !draft.squashSystem && (
                <p className="text-[10px] text-muted">
                  {/* Offered, never applied. Squashing is a property of the
                      endpoint, and inheriting it from whichever preset a single
                      prompt came out of would be a setting nobody chose. */}
                  A preset you picked from used this.
                </p>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
              {resolution.stale.map((s, i) => (
                <p key={i} className="text-[10px] text-amber-500">{s}</p>
              ))}
              {resolution.picks.map((r, i) => (
                <div key={`${r.pick.presetId}-${r.pick.identifier}`} className="flex items-center gap-1 rounded-md border border-app-border px-1.5 py-1">
                  <span className="flex-1 min-w-0">
                    <span className="block text-[11px] truncate">{r.prompt.name}</span>
                    <span className="block text-[9px] text-muted truncate">{r.presetName}</span>
                  </span>
                  <button onClick={() => setDraft(d => movePick(d, i, i - 1))} aria-label="Move up" className="p-0.5 opacity-40 hover:opacity-100">
                    <ChevronUp size={11} />
                  </button>
                  <button onClick={() => setDraft(d => movePick(d, i, i + 1))} aria-label="Move down" className="p-0.5 opacity-40 hover:opacity-100">
                    <ChevronDown size={11} />
                  </button>
                  <button onClick={() => setDraft(d => removePick(d, i))} aria-label="Remove" className="p-0.5 opacity-40 hover:opacity-100 hover:text-red-500">
                    <X size={11} />
                  </button>
                </div>
              ))}
              {!resolution.picks.length && (
                <p className="text-[11px] text-muted px-1">
                  Add prompts from the middle column. Order here is send order.
                </p>
              )}

              {showPreview && (
                <div className="mt-2 space-y-1.5">
                  {preview.dropped.map(d => (
                    <p key={d} className="text-[10px] text-amber-500">Dropped: {d}</p>
                  ))}
                  {preview.messages.map((m, i) => (
                    <div key={i} className="rounded-md bg-app-text/[0.04] px-2 py-1.5">
                      <span className="text-[9px] uppercase tracking-wider text-muted">{m.role}</span>
                      <p className="text-[10px] whitespace-pre-wrap line-clamp-6">{m.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 p-2 border-t border-app-border/60 shrink-0">
              <button
                onClick={() => setShowPreview(v => !v)}
                className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5"
              >
                {showPreview ? 'Hide' : 'Preview'}
              </button>
              <div className="flex-1" />
              <button
                onClick={() => { saveLensCompletion(draft); setDraft(d => ({ ...d, id: completionId() })); }}
                disabled={!resolution.picks.length}
                data-testid="save-completion"
                className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
              >
                <Save size={11} /> Save
              </button>
            </div>

            {completions.length > 0 && (
              <div className="border-t border-app-border/60 p-2 space-y-1 max-h-32 overflow-y-auto shrink-0">
                <p className="text-[10px] uppercase tracking-wider text-muted">Saved</p>
                {completions.map(c => (
                  <div key={c.id} className="flex items-center gap-1">
                    <button
                      onClick={() => setDraft(c)}
                      className="flex-1 min-w-0 text-left text-[11px] px-1.5 py-1 rounded-md border border-app-border hover:bg-app-text/5 truncate"
                    >
                      {c.name} · {c.picks.length}
                    </button>
                    <button
                      onClick={() => removeLensCompletion(c.id)}
                      aria-label={`Delete ${c.name}`}
                      className="p-1 opacity-40 hover:opacity-100 hover:text-red-500"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
