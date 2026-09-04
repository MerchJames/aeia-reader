/**
 * Aeia as SillyTavern's model endpoint — the screen that sets it up.
 *
 * It has one job the reader cannot do without: hand them the two strings that
 * go into SillyTavern's Custom endpoint, and be honest about what is running.
 * Everything else here is the honesty — an address that only works while this
 * is switched on, a listener that says whether it is actually listening, and a
 * log of what has come through, because "is it working" is otherwise
 * unanswerable from this side of the wire.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, Link2, ListPlus, Server, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { bridgeToken, isDesktop } from '../utils/exeBridge';
import type { Slot } from '../utils/promptPipeline';
import { proxyMaterialInput } from '../utils/proxyBlocks';
import { pickCount, type MaterialPick } from '../utils/proxyMaterial';
import {
  STEP_INFO, describeSteps, modelCost, moveStep, reconcileSteps, toggleStep,
} from '../utils/replyPipeline';
import { MaterialPicker } from './MaterialPicker';
import { useProxy, type ProxyEntry } from '../hooks/useProxy';
import { cn } from '../utils/cn';

/**
 * One collapsible part of the setup.
 *
 * The summary is not decoration: it is what the reader reads instead of opening
 * the fold, so it has to say what will actually happen on the next message
 * rather than name the section again.
 */
const Fold = ({ title, summary, open, onToggle, children }: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) => (
  <div className="rounded-lg border border-app-border overflow-hidden">
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-app-bg/60"
    >
      {open ? <ChevronDown size={14} className="text-app-muted shrink-0" />
        : <ChevronRight size={14} className="text-app-muted shrink-0" />}
      <span className="text-sm text-app-text shrink-0">{title}</span>
      <span className="text-[11px] text-app-muted truncate ml-auto">{summary}</span>
    </button>
    {open && <div className="px-3 pb-3 pt-1 space-y-3 border-t border-app-border">{children}</div>}
  </div>
);

/** A labelled row, so the folds read as a form rather than as a pile. */
const Row = ({ label, children }: { label: string; children: React.ReactElement }) => (
  <div className="grid grid-cols-[5.5rem_1fr] gap-2 items-start">
    <span className="text-[11px] text-app-muted pt-1.5">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);

const HOLDER = 'proxy';

const call = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
};

const Copy = ({ label, value, secret }: { label: string; value: string; secret?: boolean }) => {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-app-muted">{label}</span>
      <code className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-app-bg border border-app-border">
        {shown ? value : '•'.repeat(Math.min(24, value.length))}
      </code>
      {secret && (
        <button onClick={() => setShown(v => !v)} className="text-app-muted hover:text-app-text px-1">
          {shown ? 'hide' : 'show'}
        </button>
      )}
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); },
            () => { /* the OS said no; the text is on screen */ },
          );
        }}
        className="px-2 py-1 rounded border border-app-border hover:bg-app-bg"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
};

export const ProxyPanel = ({ onClose }: { onClose: () => void }) => {
  const enabled = useAppStore(s => s.proxyEnabled);
  const setEnabled = useAppStore(s => s.setProxyEnabled);
  const primary = useAppStore(s => s.proxyPrimary);
  const baseUrl = useAppStore(s => s.proxyBaseUrl);
  const apiKey = useAppStore(s => s.proxyApiKey);
  const model = useAppStore(s => s.proxyModel);
  const aiBaseUrl = useAppStore(s => s.aiBaseUrl);
  const material = useAppStore(s => s.proxyMaterial) as MaterialPick;
  const budget = useAppStore(s => s.proxyBudget);
  const drop = useAppStore(s => s.proxyDrop);
  const instructionLast = useAppStore(s => s.proxyInstructionLast);
  const storedReply = useAppStore(s => s.proxyReply);
  const storyId = useAppStore(s => s.proxyStoryId);
  const library = useAppStore(s => s.library);
  const openStory = useAppStore(s => s.currentStory);
  const set = useAppStore.setState;

  const [openFold, setOpenFold] = useState<'before' | 'after' | null>(null);
  const [picking, setPicking] = useState(false);

  // A stored list is from whatever version last ran; this fills in steps added
  // since (switched off) and drops any that no longer exist.
  const reply = useMemo(() => reconcileSteps(storedReply), [storedReply]);

  /*
   * Everything pickable, gathered once when the picker opens.
   *
   * Read through `proxyMaterialInput` — the SAME function the request pipeline
   * uses — so the list the reader chooses from cannot drift from the list the
   * prompt is built from. A picker offering things that never arrive is worse
   * than a shorter picker.
   */
  const pickerInput = useMemo(
    () => (picking ? proxyMaterialInput(useAppStore.getState()) : null),
    [picking, storyId, openStory?.id],
  );

  const chosen = pickCount(material);
  const materialLine = chosen || material.activeSet
    ? [
      chosen ? `${chosen} chosen` : '',
      material.activeSet ? 'the active pin set' : '',
    ].filter(Boolean).join(' + ')
    : 'nothing yet';

  const promptSummary = !proxyStoryName(storyId, openStory, library)
    ? 'no story to draw from'
    : [materialLine, instructionLast ? 'my turn last' : '', drop.trim() ? 'with filters' : '']
      .filter(Boolean).join(' · ');
  const replySummary = describeSteps(reply);

  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<ProxyEntry[]>([]);
  const token = useRef(isDesktop() ? bridgeToken() : '');

  // Newest first, and bounded: this is a health readout, not a history.
  useProxy(enabled, entry => setLog(prev => [entry, ...prev].slice(0, 12)));

  /*
   * The listener's lifetime is this switch, not this screen.
   *
   * `bridge_start` is named-holder based, so the sync panel opening and closing
   * cannot take the endpoint down under a story in progress — and closing this
   * screen does not either. Only turning it off does.
   */
  useEffect(() => {
    if (!isDesktop()) return;
    let gone = false;
    void (async () => {
      try {
        if (enabled) {
          const opened = await call<number>('bridge_start', { token: token.current, holder: HOLDER });
          if (!gone) { setPort(opened); setError(null); }
        } else {
          await call('bridge_stop', { holder: HOLDER });
          if (!gone) setPort(null);
        }
      } catch (e: any) {
        if (!gone) setError(String(e?.message ?? e));
      }
    })();
    return () => { gone = true; };
  }, [enabled]);

  // The socket can close itself under us — the app quitting, a port conflict —
  // and a screen that kept claiming an address would send the reader hunting
  // through SillyTavern for a fault that is here.
  useEffect(() => {
    if (!enabled || !isDesktop()) return;
    const id = window.setInterval(() => {
      void call<number | null>('bridge_status').then(open => setPort(open ?? null)).catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const address = port ? `http://127.0.0.1:${port}/v1` : null;

  return (
    <>
    {picking && pickerInput && (
      <MaterialPicker
        input={pickerInput}
        pick={material}
        onChange={next => set({ proxyMaterial: next })}
        onClose={() => setPicking(false)}
      />
    )}
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-app-border
                      bg-app-surface shadow-2xl">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <Server size={16} className="text-app-muted" />
          <h2 className="font-medium text-app-text">Aeia as your SillyTavern endpoint</h2>
          {port && (
            <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full
                             bg-emerald-500/15 text-emerald-400">
              <Link2 size={11} /> listening
            </span>
          )}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-app-bg text-app-muted"
            aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {!isDesktop() ? (
            <p className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                This only works in the desktop app. SillyTavern's <b>server</b> makes the call, not
                your browser — so there is no arrangement that lets a page answer it. A tab cannot
                listen on a port.
              </span>
            </p>
          ) : (
            <>
              <p className="text-sm text-app-muted leading-relaxed">
                Point SillyTavern's model at Aeia, and Aeia passes it on. It sees the prompt
                SillyTavern actually built, works on the reply, and can hand back both versions —
                the second one arrives as a swipe.
              </p>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-app-border">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  data-testid="toggle-proxy"
                />
                <span className="text-sm text-app-text">
                  Listen for SillyTavern
                  <span className="block text-[11px] text-app-muted">
                    A port on this machine, open while this is ticked and closed when it is not.
                  </span>
                </span>
              </label>

              {error && (
                <p className="p-3 rounded-lg bg-red-500/10 text-red-300 text-sm">{error}</p>
              )}

              {enabled && (
                <div className="p-3 rounded-lg bg-app-bg/60 border border-app-border space-y-2">
                  <p className="text-xs text-app-muted">
                    In SillyTavern: API → Chat Completion → <b>Custom (OpenAI-compatible)</b>.
                  </p>
                  <Copy label="Endpoint" value={address ?? 'starting…'} />
                  <Copy label="API key" value={token.current} secret />
                  <p className="text-[11px] text-app-muted leading-relaxed">
                    For two swipes, set <b>Number of responses</b> to 2 in SillyTavern. With it at 1
                    a second version is not a swipe there — it would be added to the end of the
                    reply — so Aeia sends only one.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-xs font-medium text-app-text uppercase tracking-wide">
                  Where Aeia sends it
                </h3>
                <input
                  value={baseUrl}
                  onChange={e => set({ proxyBaseUrl: e.target.value })}
                  placeholder={aiBaseUrl ? `${aiBaseUrl} (the assistant's)` : 'http://localhost:5001/v1'}
                  className="w-full px-3 py-2 rounded-lg bg-app-bg border border-app-border text-sm"
                />
                <div className="flex gap-2">
                  <input
                    value={apiKey}
                    onChange={e => set({ proxyApiKey: e.target.value })}
                    type="password"
                    placeholder="API key (optional)"
                    className="flex-1 px-3 py-2 rounded-lg bg-app-bg border border-app-border text-sm"
                  />
                  <input
                    value={model}
                    onChange={e => set({ proxyModel: e.target.value })}
                    placeholder="model — blank uses SillyTavern's"
                    className="flex-1 px-3 py-2 rounded-lg bg-app-bg border border-app-border text-sm"
                  />
                </div>
                <p className="text-[11px] text-app-muted">
                  Left blank, the assistant's own backend is used. This is the model that writes
                  your story — it need not be the one Aeia thinks with.
                </p>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-medium text-app-text uppercase tracking-wide">
                  Which version is the message
                </h3>
                {([
                  ['processed', 'The processed reply', 'Nothing appears until the pass has finished. The original is swipe 2.'],
                  ['original', 'The reply as written', 'Arrives as fast as it does today. The processed version is swipe 2.'],
                ] as const).map(([value, title, why]) => (
                  <label key={value} className={cn(
                    'flex gap-3 p-2.5 rounded-lg border cursor-pointer',
                    primary === value ? 'border-accent bg-accent/10' : 'border-app-border',
                  )}>
                    <input
                      type="radio"
                      className="mt-0.5"
                      checked={primary === value}
                      onChange={() => set({ proxyPrimary: value })}
                    />
                    <span className="text-sm text-app-text">
                      {title}
                      <span className="block text-[11px] text-app-muted">{why}</span>
                    </span>
                  </label>
                ))}
              </div>

              {/*
                * Folded, because open they were a wall.
                *
                * Each fold's summary line says what it will actually do on the
                * next message, so the reader can tell the state of the thing
                * without opening it — which is the only reason a fold is
                * better than a section.
                */}
              <Fold
                title="Before — the prompt"
                summary={promptSummary}
                open={openFold === 'before'}
                onToggle={() => setOpenFold(openFold === 'before' ? null : 'before')}
              >
                <p className="text-[11px] text-app-muted leading-relaxed">
                  SillyTavern's own prompt arrives here whole — card, world info, persona, history.
                  Nothing else in Aeia has ever seen it.
                </p>

                <Row label="Draw from">
                  <select
                    value={storyId}
                    onChange={e => set({ proxyStoryId: e.target.value })}
                    className="w-full px-2 py-1.5 rounded bg-app-bg border border-app-border text-xs"
                  >
                    <option value="">
                      {openStory ? `The open story — ${openStory.title}` : 'The open story (none open)'}
                    </option>
                    {library.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
                  </select>
                </Row>

                <Row label="Add">
                  <button
                    onClick={() => setPicking(true)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-app-bg
                               border border-app-border text-xs hover:border-accent/60 text-left"
                  >
                    <ListPlus size={13} className="text-app-muted shrink-0" />
                    <span className="flex-1 truncate">
                      {materialLine}
                    </span>
                    <span className="text-app-muted">choose…</span>
                  </button>
                </Row>

                <Row label="Placed">
                  <select
                    value={material.slot}
                    onChange={e => set({ proxyMaterial: { ...material, slot: e.target.value as Slot } })}
                    className="w-full px-2 py-1.5 rounded bg-app-bg border border-app-border text-xs"
                  >
                    <option value="system">with the system prompt — reference, read early</option>
                    <option value="before-last-user">just before my turn — close to the instruction</option>
                    <option value="end">last of all — the highest-attention position</option>
                  </select>
                </Row>

                <Row label="Budget">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={budget}
                      min={0}
                      step={500}
                      onChange={e => set({ proxyBudget: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-24 px-2 py-1.5 rounded bg-app-bg border border-app-border text-xs"
                    />
                    <span className="text-[11px] text-app-muted">
                      characters. Picked material goes in until this runs out; a block that does not
                      fit is left out whole and reported.
                    </span>
                  </div>
                </Row>

                <Row label="Restructure">
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={instructionLast}
                      onChange={e => set({ proxyInstructionLast: e.target.checked })}
                    />
                    <span>
                      Keep my turn last
                      <span className="block text-[10px] text-app-muted">
                        Moves it back to the end if material was placed after it. Long contexts are
                        read best at their edges.
                      </span>
                    </span>
                  </label>
                </Row>

                <Row label="Remove">
                  <>
                    <textarea
                      value={drop}
                      onChange={e => set({ proxyDrop: e.target.value })}
                      rows={2}
                      placeholder="Drop any context line containing…  (one phrase per line)"
                      className="w-full px-2 py-1.5 rounded bg-app-bg border border-app-border text-xs"
                    />
                    <p className="mt-1 text-[10px] text-app-muted">
                      Matched case-insensitively against every context message. Your own last turn
                      is never dropped, however well it matches.
                    </p>
                  </>
                </Row>
              </Fold>

              <Fold
                title="After — the reply"
                summary={replySummary}
                open={openFold === 'after'}
                onToggle={() => setOpenFold(openFold === 'after' ? null : 'after')}
              >
                <p className="text-[11px] text-app-muted leading-relaxed">
                  Each step runs in this order, top to bottom. Order matters: a check quotes a
                  sentence out of the text it was given, so formatting before or after it are
                  different things.
                </p>

                <ul className="space-y-1.5">
                  {reply.map((step, i) => {
                    const info = STEP_INFO[step.kind];
                    return (
                      <li key={step.kind} className={cn(
                        'flex items-start gap-2 p-2.5 rounded-lg border',
                        step.enabled ? 'border-accent/50 bg-accent/5' : 'border-app-border',
                      )}>
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={step.enabled}
                          onChange={() => set({ proxyReply: toggleStep(reply, step.kind) })}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-app-text">{i + 1}. {info.label}</span>
                            <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0',
                              info.model
                                ? 'bg-amber-500/15 text-amber-400'
                                : 'bg-app-bg text-app-muted')}>
                              {info.cost}
                            </span>
                          </div>
                          <p className="text-[10px] text-app-muted leading-snug mt-0.5">
                            {info.hint}
                          </p>
                        </div>
                        <div className="flex flex-col shrink-0">
                          <button
                            onClick={() => set({ proxyReply: moveStep(reply, step.kind, -1) })}
                            disabled={i === 0}
                            className="p-0.5 text-app-muted hover:text-app-text disabled:opacity-25"
                            aria-label={`Move ${info.label} earlier`}
                          >
                            <ChevronUp size={13} />
                          </button>
                          <button
                            onClick={() => set({ proxyReply: moveStep(reply, step.kind, 1) })}
                            disabled={i === reply.length - 1}
                            className="p-0.5 text-app-muted hover:text-app-text disabled:opacity-25"
                            aria-label={`Move ${info.label} later`}
                          >
                            <ChevronDown size={13} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {modelCost(reply) > 0 && (
                  <p className="text-[11px] text-amber-400/90 leading-relaxed">
                    Two of these call a model. With the message set to arrive after processing,
                    every reply waits for them.
                  </p>
                )}
              </Fold>

              <div className="space-y-1">
                <h3 className="text-xs font-medium text-app-text uppercase tracking-wide">
                  Recent requests
                </h3>
                {!log.length ? (
                  <p className="text-xs text-app-muted">
                    Nothing yet. Send a message in SillyTavern and it will show here.
                  </p>
                ) : (
                  <ul className="text-xs divide-y divide-app-border">
                    {log.map((entry, i) => (
                      <li key={i} className="py-1.5 flex items-center gap-2">
                        {entry.error
                          ? <AlertTriangle size={12} className="text-red-400 shrink-0" />
                          : <Check size={12} className="text-emerald-400 shrink-0" />}
                        <span className="text-app-muted">
                          {new Date(entry.at).toLocaleTimeString()}
                        </span>
                        <span className="truncate text-app-text">{entry.model || 'a reply'}</span>
                        <span className="ml-auto text-app-muted shrink-0 truncate max-w-[55%]"
                          title={[entry.prompt, entry.reply].filter(Boolean).join(' · ')}>
                          {entry.error ?? [
                            `${(entry.ms / 1000).toFixed(1)}s`,
                            entry.prompt && entry.prompt !== 'passed through unchanged'
                              ? entry.prompt : '',
                            entry.reply ?? (entry.changed ? 'tidied' : ''),
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    </>
  );
};

/** The story the pipelines will draw from, for the fold's summary line. */
const proxyStoryName = (
  storyId: string,
  open: { id: string; title: string } | null | undefined,
  library: { id: string; title: string }[],
): string => {
  if (!storyId) return open?.title ?? '';
  return library.find(m => m.id === storyId)?.title ?? '';
};
