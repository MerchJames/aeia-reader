import { useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, X, Loader2, Highlighter, ArrowLeftRight, Check, AlertTriangle, Copy, ListTree } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { samplerParamsFrom } from '../utils/aiClient';
import { extract, buildGrounding, fidelity, entitySet, Extraction, PosClass } from '../utils/narrativeExtractor';
import { generateRefinement, RefineMode } from '../utils/narrativeDirector';
import { narrativeBlocksFor } from '../utils/narrativeBlocks';
import {
  FUNCTION_LABEL, FUNCTION_HINT, FunctionedBlock, NarrativeFunction,
  floorFunctions, functionsPresent, labelFunctions, renderFunctionBlocks,
} from '../utils/narrativeFunction';
import { hashContent } from '../utils/sceneDirector';
import { castOf } from '../utils/askCharacter';
import { cn } from '../utils/cn';

/**
 * Narrative Refinery — extract the objective layer of the current passage, then
 * restyle it with the LLM under those constraints, verify the rewrite kept the
 * facts, and save it to the Lens override layer (source JSON untouched).
 */

const STYLE_PRESETS = ['Hemingway', 'Cormac McCarthy', 'Jane Austen', 'Victorian gothic', 'Terse noir', 'Lyrical / purple'];

const POS_CLASS: Record<PosClass, string> = {
  proper: 'text-accent font-semibold',
  verb: 'text-emerald-400',
  adjective: 'text-amber-400',
  adverb: 'text-sky-400',
  pronoun: 'text-fuchsia-400',
  noun: '',
  other: '',
};
const LEGEND: [PosClass, string][] = [['proper', 'names'], ['verb', 'verbs'], ['adjective', 'adjectives'], ['adverb', 'adverbs'], ['pronoun', 'pronouns']];

/** Render the passage with POS-coloured terms laid over the plain text. */
const Highlighted = ({ text, ex }: { text: string; ex: Extraction }) => {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ex.terms.forEach((t, i) => {
    if (t.start < cursor) return; // overlap guard
    if (t.start > cursor) nodes.push(text.slice(cursor, t.start));
    const cls = POS_CLASS[t.pos];
    nodes.push(cls ? <span key={i} className={cls}>{text.slice(t.start, t.start + t.length)}</span> : text.slice(t.start, t.start + t.length));
    cursor = t.start + t.length;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
};

const Chips = ({ label, items, tone = 'accent' }: { label: string; items: string[]; tone?: 'accent' | 'muted' }) => {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-app-text/40">{label}</span>
      {items.slice(0, 18).map((it, i) => (
        <span key={i} className={cn('text-xs px-1.5 py-0.5 rounded-md border',
          tone === 'accent' ? 'text-accent border-accent/30 bg-accent/10' : 'text-app-text/70 border-app-text/15')}>
          {it}
        </span>
      ))}
    </div>
  );
};

export const RefineModal = ({ onClose }: { onClose: () => void }) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const overrides = storyId ? v2.overridesByStory[storyId] : undefined;
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];
  const aiReady = !!store.aiBaseUrl && !!store.aiModel;

  const msg = store.chains[store.currentChainIndex]?.messages[store.currentMessageIndex];
  const source = useMemo(() => (msg ? resolveContent(msg, overrides, lensOn) : ''), [msg, overrides, lensOn]);
  const ex = useMemo(() => extract(source), [source]);

  // Passage structure — dialogue/thought/beat/shout, each attributed to a
  // speaker — handed to the model alongside the grounding, so a rewrite is
  // less likely to conflate who said or thought what.
  const cast = useMemo(
    () => castOf(store.chains.flatMap(c => c.messages), store.currentStory?.userName),
    [store.chains, store.currentStory?.userName],
  );
  const descriptor = storyId && msg ? v2.sceneByStory[storyId]?.[msg.id] : undefined;
  const blocks = useMemo(
    () => (msg ? narrativeBlocksFor(source, msg.name, { cast, dialogue: descriptor?.dialogue }) : []),
    [source, msg, cast, descriptor],
  );

  /**
   * Who the story has already met, before this passage.
   *
   * "First appearance" is a fact about the story so far, so the floor needs to
   * know which names are already spent — otherwise a passage read from the
   * middle of a chat claims to introduce a character the reader met an hour
   * ago. Only messages BEFORE this one count, which is the same read-so-far
   * gate the codex and Ask Character use.
   */
  const introducedBefore = useMemo(() => {
    const seen = new Set<string>();
    const flat = store.chains.flatMap(c => c.messages);
    const here = flat.findIndex(m => m.id === msg?.id);
    const earlier = flat.slice(0, here < 0 ? flat.length : here)
      .map(m => m.content.toLowerCase()).join(' ');
    for (const name of cast) {
      if (earlier.includes(name.trim().toLowerCase())) seen.add(name.trim().toLowerCase());
    }
    return seen;
  }, [store.chains, msg?.id, cast]);

  // The model's read, when there is one, else the heuristic floor. Cached per
  // message in the v2 store so re-opening the Refinery costs nothing.
  const [aiFns, setAiFns] = useState<NarrativeFunction[] | null>(null);
  const [reading, setReading] = useState(false);
  const passageHash = useMemo(() => hashContent(source), [source]);
  const cached = storyId && msg ? v2.functionsByStory[storyId]?.[msg.id] : undefined;
  const cachedFns = cached?.hash === passageHash ? cached.fns : undefined;

  const fnBlocks: FunctionedBlock[] = useMemo(() => {
    const floor = floorFunctions(blocks, { cast, introduced: new Set(introducedBefore) });
    const read = aiFns ?? cachedFns;
    return read && read.length === floor.length
      ? floor.map((b, i) => ({ ...b, fn: read[i] }))
      : floor;
  }, [blocks, cast, introducedBefore, aiFns, cachedFns]);

  const present = useMemo(() => functionsPresent(fnBlocks), [fnBlocks]);
  const [sections, setSections] = useState<Partial<Record<NarrativeFunction, string>>>({});
  const [order, setOrder] = useState<NarrativeFunction[]>([]);

  /* The structure handed to the model carries the FUNCTION labels rather than
   * the channel ones, so the per-section instructions and the target order
   * below name blocks the model can actually find in it. */
  const structure = useMemo(() => renderFunctionBlocks(fnBlocks), [fnBlocks]);

  const readStructure = async () => {
    if (!aiReady || reading || !blocks.length) return;
    setReading(true);
    try {
      const out = await labelFunctions(
        blocks,
        { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
        { cast, introduced: new Set(introducedBefore), reader: samplerParamsFrom(store.aiAdvanced) },
      );
      const fns = out.map(b => b.fn);
      setAiFns(fns);
      if (storyId && msg) v2.setFunctionRead(storyId, msg.id, passageHash, fns);
    } finally { setReading(false); }
  };

  const toggleOrder = (f: NarrativeFunction) =>
    setOrder(o => (o.includes(f) ? o.filter(x => x !== f) : [...o, f]));

  const [mode, setMode] = useState<RefineMode>('restyle');
  const [target, setTarget] = useState('');
  const [showHl, setShowHl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const fid = useMemo(() => (result ? fidelity(source, result) : null), [result, source]);

  const generate = async () => {
    if (!aiReady || busy || !source.trim()) return;
    setBusy(true); setError(null); setResult(null); setShowBefore(false);
    abort.current = new AbortController();
    try {
      const out = await generateRefinement(
        { text: source, mode, target, grounding: buildGrounding(ex), structure, sections, order },
        { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel, params: samplerParamsFrom(store.aiAdvanced) },
        abort.current.signal,
      );
      if (!out) setError('The model didn’t return usable prose. Try a clearer brief.');
      else setResult(out);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Refinement failed.');
    } finally { setBusy(false); }
  };

  const save = () => {
    if (!storyId || !msg || !result) return;
    v2.setOverride(storyId, {
      messageId: msg.id, kind: 'rewrite', content: result, source: 'ai',
      note: `Refinery · ${mode === 'restyle' && target.trim() ? target.trim() : mode}`
        + (order.length ? ` · reshaped` : '')
        + (Object.values(sections).some(v => v?.trim()) ? ` · per-section` : ''),
      createdAt: Date.now(),
    });
    if (!lensOn) v2.setLensOn(storyId, true); // so the rewrite is actually shown
    onClose();
  };

  const modes: { id: RefineMode; label: string }[] = [
    { id: 'restyle', label: 'Restyle' }, { id: 'grammar', label: 'Fix grammar' },
    { id: 'tighten', label: 'Tighten' }, { id: 'custom', label: 'Custom' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => { if (!busy) onClose(); }}>
      <div className="w-full max-w-2xl rounded-2xl bg-app-surface border border-app-text/10 shadow-2xl flex flex-col max-h-[88dvh]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-text/10">
          <div className="flex items-center gap-2 font-semibold text-app-text">
            <Wand2 size={18} className="text-accent" /> Narrative Refinery
            {msg && <span className="text-xs font-normal text-app-text/40">· {msg.name}’s passage</span>}
          </div>
          <button onClick={onClose} className="text-app-text/50 hover:text-app-text"><X size={18} /></button>
        </div>

        {!msg ? (
          <div className="p-10 text-center text-app-text/50">Open a story and land on a message to refine it.</div>
        ) : (
          <div className="p-5 space-y-4 overflow-y-auto">
            {/* Source + extraction */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs uppercase tracking-wide text-app-text/50">The passage</label>
                <button onClick={() => setShowHl(h => !h)}
                  className={cn('flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md border',
                    showHl ? 'text-accent border-accent/40' : 'text-app-text/50 border-app-text/15')}>
                  <Highlighter size={12} /> Highlight
                </button>
              </div>
              <div className="rounded-lg bg-app-bg border border-app-text/15 p-3 text-sm leading-relaxed max-h-44 overflow-y-auto whitespace-pre-wrap">
                {showHl ? <Highlighted text={source} ex={ex} /> : source}
              </div>
              {showHl && (
                <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-app-text/40">
                  {LEGEND.map(([p, name]) => <span key={p} className={POS_CLASS[p]}>{name}</span>)}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Chips label="Keeps" items={entitySet(ex)} />
              <Chips label="Actions" items={ex.verbs} tone="muted" />
              <div className="text-[11px] text-app-text/40">
                {ex.stats.sentences} sentences · {ex.stats.words} words · avg {ex.stats.avgSentenceLen}/sentence · {Math.round(ex.stats.dialogueRatio * 100)}% dialogue
              </div>
            </div>

            {/* Mode */}
            <div>
              <label className="text-xs uppercase tracking-wide text-app-text/50">What to do</label>
              <div className="mt-1 flex flex-wrap rounded-lg bg-app-bg border border-app-text/15 p-0.5">
                {modes.map(m => (
                  <button key={m.id} onClick={() => setMode(m.id)}
                    className={cn('flex-1 text-xs py-1.5 rounded-md min-w-[70px]',
                      mode === m.id ? 'bg-accent/20 text-accent' : 'text-app-text/60 hover:text-app-text')}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'restyle' && (
              <div>
                <input value={target} onChange={e => setTarget(e.target.value)}
                  placeholder="In the style of… (an author or a voice)"
                  className="w-full rounded-lg bg-app-bg border border-app-text/15 px-3 py-2 text-app-text text-sm focus:border-accent outline-none" />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {STYLE_PRESETS.map(s => (
                    <button key={s} onClick={() => setTarget(s)}
                      className="text-xs px-2 py-1 rounded-full bg-app-text/5 hover:bg-accent/15 hover:text-accent text-app-text/70 border border-app-text/10">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === 'custom' && (
              <input value={target} onChange={e => setTarget(e.target.value)}
                placeholder="Describe the change (e.g. present tense, more sensory detail)"
                className="w-full rounded-lg bg-app-bg border border-app-text/15 px-3 py-2 text-app-text text-sm focus:border-accent outline-none" />
            )}

            {/* Structure — the narrative-function read of this passage.
              *
              * The value of naming the sections is that a rewrite can then be
              * AIMED. One brief for a whole passage is the wrong granularity
              * for prose doing several things at once: "tighten this" means
              * something different to a stretch of world movement than to a
              * line of dialogue. Below, each section can carry its own
              * instruction, and the order they should end up in can be stated
              * outright instead of described. */}
            {present.length > 0 && (
              <div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-app-text/50">
                    <ListTree size={13} /> Structure
                  </label>
                  <button
                    onClick={readStructure}
                    disabled={!aiReady || reading}
                    title={aiReady
                      ? 'Read the passage and label each section'
                      : 'Connect an AI endpoint to read the structure'}
                    className="flex items-center gap-1 text-xs text-app-text/50 hover:text-accent disabled:opacity-40 disabled:hover:text-app-text/50"
                  >
                    {reading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    {aiFns || cachedFns ? 'Re-read' : 'Read with AI'}
                  </button>
                </div>
                <p className="mt-0.5 text-[11px] text-app-text/40">
                  {aiFns || cachedFns
                    ? 'Labelled by the model, cached for this passage.'
                    : 'Labelled by the built-in reader — no endpoint needed. Read with AI for a closer look.'}
                </p>

                <div className="mt-2 flex flex-col gap-1.5">
                  {present.map(f => {
                    const count = fnBlocks.filter(b => b.fn === f).length;
                    const pos = order.indexOf(f);
                    return (
                      <div key={f} className="flex items-center gap-2">
                        <button
                          onClick={() => toggleOrder(f)}
                          title={`${FUNCTION_HINT[f]}\nClick to place it in the target order.`}
                          className={cn(
                            'shrink-0 text-xs px-2 py-1 rounded-md border text-left min-w-[9.5rem]',
                            pos >= 0
                              ? 'border-accent/40 bg-accent/10 text-accent'
                              : 'border-app-text/15 text-app-text/70 hover:border-accent/30')}
                        >
                          <span className="tabular-nums opacity-60">
                            {pos >= 0 ? `${pos + 1}. ` : ''}
                          </span>
                          {FUNCTION_LABEL[f]}
                          <span className="opacity-40"> ×{count}</span>
                        </button>
                        <input
                          value={sections[f] ?? ''}
                          onChange={e => setSections(prev => ({ ...prev, [f]: e.target.value }))}
                          placeholder="leave alone"
                          aria-label={`What to do with ${FUNCTION_LABEL[f]}`}
                          className="flex-1 min-w-0 rounded-md bg-app-bg border border-app-text/15 px-2 py-1 text-xs text-app-text focus:border-accent outline-none"
                        />
                      </div>
                    );
                  })}
                </div>

                {order.length > 0 && (
                  <div className="mt-2 flex items-start gap-2 text-[11px] text-app-text/60">
                    <span className="uppercase tracking-wide text-app-text/40 shrink-0">Order</span>
                    <span className="flex-1">
                      {order.map(f => FUNCTION_LABEL[f]).join(' → ')}
                      {order.length < present.length && ' → (the rest, as written)'}
                    </span>
                    <button onClick={() => setOrder([])} className="shrink-0 hover:text-accent">Clear</button>
                  </div>
                )}
              </div>
            )}

            {/* Result */}
            {result != null && fid && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs uppercase tracking-wide text-app-text/50">{showBefore ? 'Original' : 'Rewrite'}</label>
                  <button onClick={() => setShowBefore(b => !b)} className="flex items-center gap-1 text-xs text-app-text/50 hover:text-accent">
                    <ArrowLeftRight size={12} /> {showBefore ? 'Show rewrite' : 'Compare original'}
                  </button>
                </div>
                <div className="rounded-lg bg-app-bg border border-app-text/15 p-3 text-sm leading-relaxed max-h-52 overflow-y-auto whitespace-pre-wrap">
                  {showBefore ? source : result}
                </div>
                <div className={cn('mt-2 flex items-start gap-1.5 text-xs rounded-md px-2 py-1.5',
                  fid.ok ? 'text-emerald-400 bg-emerald-400/10' : 'text-amber-400 bg-amber-400/10')}>
                  {fid.ok ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
                  <span>{fid.ok ? `Kept all ${fid.kept.length} named things and the event spine.` : fid.warning}</span>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
            {!aiReady && <p className="text-sm text-amber-400">Connect an AI endpoint in Settings to refine prose.</p>}
          </div>
        )}

        {msg && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-app-text/10">
            {result != null && (
              <button onClick={() => navigator.clipboard?.writeText(result)}
                className="mr-auto flex items-center gap-1.5 text-sm text-app-text/60 hover:text-app-text">
                <Copy size={14} /> Copy
              </button>
            )}
            {busy ? (
              <button onClick={() => abort.current?.abort()} className="px-4 py-2 rounded-lg border border-red-500/40 text-red-400 text-sm">Cancel</button>
            ) : (
              <button onClick={generate} disabled={!aiReady || !source.trim()}
                className="px-4 py-2 rounded-lg border border-app-text/15 text-app-text text-sm hover:border-accent/50 disabled:opacity-40 flex items-center gap-1.5">
                {result != null ? 'Regenerate' : (<><Wand2 size={15} /> Refine</>)}
              </button>
            )}
            {result != null && !busy && (
              <button onClick={save} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90">
                Save to Lens
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
