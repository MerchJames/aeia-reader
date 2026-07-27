import { useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, X, Loader2, Layers, LayoutTemplate } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { samplerParamsFrom } from '../utils/aiClient';
import { generateStudioConfig } from '../utils/sandboxDirector';
import { SandboxKind, SandboxScope, ShellControl, StyleConfig } from '../types';
import { cn } from '../utils/cn';

/**
 * Sandbox Studio intake — the place to instill direction. A grounded form (what
 * vibe? how wide? a card theme or a full-screen view?) then a loading screen
 * while the model composes. Saves a named Style Config, or updates one in place
 * when editing. Nothing closes it mid-generation except an explicit Cancel.
 */

const VIBES = ['1987 VHS horror', 'Old storybook', 'Terminal / hacker', 'Comic panels', 'Redacted dossier', 'Neon cyberpunk'];
const STATUS = ['Reading the scene…', 'Composing the set…', 'Hanging the lights…', 'Framing the shots…', 'Dressing the stage…'];
/** In-world trinkets a View can embed — wired to the allowlisted intent bus. */
const TRINKETS: { id: ShellControl; label: string }[] = [
  { id: 'playpause', label: 'Play / pause' },
  { id: 'next', label: 'Next' },
  { id: 'prev', label: 'Previous' },
  { id: 'restart', label: 'Restart' },
  { id: 'text', label: 'Text switch' },
  { id: 'fx', label: 'Flourish' },
];

const rid = () => `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface Props {
  storyId: string;
  initialScope: SandboxScope;
  /** The beat the reader is on — targets for message/chapter scope. */
  currentChainId?: string;
  currentMessageId?: string;
  samples: string[];
  cast: string[];
  /** When present, edit this config in place instead of creating a new one. */
  editConfig?: StyleConfig;
  onClose: () => void;
}

export const SandboxStudioModal = ({ storyId, initialScope, currentChainId, currentMessageId, samples, cast, editConfig, onClose }: Props) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const aiReady = !!store.aiBaseUrl && !!store.aiModel;
  const editing = !!editConfig;

  const [intent, setIntent] = useState(editConfig?.intent ?? '');
  const [tweak, setTweak] = useState('');
  const [name, setName] = useState(editConfig?.name ?? '');
  const [scope, setScope] = useState<SandboxScope>(editConfig?.scope ?? initialScope);
  const [kind, setKind] = useState<SandboxKind>(editConfig?.kind ?? 'theme');
  const [controls, setControls] = useState<ShellControl[]>(editConfig?.controls ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(STATUS[0]);
  const abort = useRef<AbortController | null>(null);

  // Views work at any scope — a message-scope view is a per-beat frame (a title
  // card here, a dark room on the next beat). Nothing to coerce.

  useEffect(() => {
    if (!busy) return;
    let i = 0;
    const t = setInterval(() => { i = (i + 1) % STATUS.length; setStatus(STATUS[i]); }, 1400);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    if (!aiReady || busy) return;
    if (editing && !tweak.trim()) { setError('Describe what to change.'); return; }
    setBusy(true); setError(null);
    abort.current = new AbortController();
    try {
      const wantControls = kind === 'shell' && controls.length ? controls : undefined;
      const parsed = await generateStudioConfig(
        { intent, scope, kind, samples, cast, controls: wantControls, priorCss: editing ? editConfig!.css : undefined, tweak: editing ? tweak : undefined },
        { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel, params: samplerParamsFrom(store.aiAdvanced) },
        abort.current.signal,
      );
      if (!parsed) { setError('The model didn’t return a usable design. Try a clearer direction.'); setBusy(false); return; }
      if (editing) {
        v2.updateSandboxConfig(storyId, editConfig!.id, {
          intent: intent.trim() || editConfig!.intent, name: name.trim() || editConfig!.name,
          css: parsed.css, skeleton: parsed.skeleton, title: parsed.title, controls: wantControls,
        });
      } else {
        const config: StyleConfig = {
          id: rid(),
          name: name.trim() || intent.trim().split(/\s+/).slice(0, 4).join(' ') || `${kind} ${scope}`,
          scope, kind, intent: intent.trim(),
          css: parsed.css, skeleton: parsed.skeleton, title: parsed.title, controls: wantControls,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        const target = scope === 'message' ? currentMessageId : scope === 'chain' ? currentChainId : undefined;
        v2.addSandboxConfig(storyId, config);
        v2.setSandboxActive(storyId, scope, config.id, target);
      }
      v2.setSandboxEnabled(storyId, true);
      onClose();
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Generation failed.');
      setBusy(false);
    }
  };

  const scopeLabel = useMemo(() => ({ message: 'this message', chain: 'this chapter', chat: 'the whole chat' }), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => { if (!busy) onClose(); }}>
      <div className="w-full max-w-lg rounded-2xl bg-app-surface border border-app-text/10 shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}>
        {busy ? (
          <div className="p-12 flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <Loader2 size={40} className="animate-spin text-accent" />
              <Wand2 size={16} className="absolute inset-0 m-auto text-accent" />
            </div>
            <div className="text-app-text font-medium">{status}</div>
            <div className="text-app-text/50 text-sm">Designing {scopeLabel[scope]} — hang tight.</div>
            <button onClick={() => abort.current?.abort()} className="mt-2 text-sm text-app-text/60 hover:text-app-text underline">
              Cancel generation
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-app-text/10">
              <div className="flex items-center gap-2 font-semibold text-app-text">
                <Wand2 size={18} className="text-accent" /> {editing ? 'Edit style' : 'Sandbox Studio'}
              </div>
              <button onClick={onClose} className="text-app-text/50 hover:text-app-text"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="text-xs uppercase tracking-wide text-app-text/50">What should it feel like?</label>
                <textarea autoFocus={!editing} value={intent} onChange={e => setIntent(e.target.value)}
                  placeholder="e.g. a grainy 1987 VHS horror tape — red neon title, film grain, deep shadows"
                  rows={3}
                  className="mt-1 w-full rounded-lg bg-app-bg border border-app-text/15 px-3 py-2 text-app-text text-sm resize-none focus:border-accent outline-none" />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {VIBES.map(v => (
                    <button key={v} onClick={() => setIntent(i => (i ? `${i}, ${v.toLowerCase()}` : v))}
                      className="text-xs px-2 py-1 rounded-full bg-app-text/5 hover:bg-accent/15 hover:text-accent text-app-text/70 border border-app-text/10">
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {editing && (
                <div>
                  <label className="text-xs uppercase tracking-wide text-app-text/50">What to change?</label>
                  <input autoFocus value={tweak} onChange={e => setTweak(e.target.value)}
                    placeholder="e.g. make the title bigger and add flickering"
                    className="mt-1 w-full rounded-lg bg-app-bg border border-app-text/15 px-3 py-2 text-app-text text-sm focus:border-accent outline-none" />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-wide text-app-text/50">How wide?</label>
                  <div className="mt-1 flex rounded-lg bg-app-bg border border-app-text/15 p-0.5">
                    {(['message', 'chain', 'chat'] as SandboxScope[]).map(s => (
                      <button key={s} disabled={editing || (s === 'message' && !currentMessageId) || (s === 'chain' && !currentChainId)}
                        onClick={() => setScope(s)}
                        title={s === 'message' ? 'Just this beat (a per-message view/theme)' : s === 'chain' ? 'This chapter' : 'The whole chat'}
                        className={cn('flex-1 text-xs py-1.5 rounded-md disabled:opacity-30',
                          scope === s ? 'bg-accent/20 text-accent' : 'text-app-text/60 hover:text-app-text')}>
                        {s === 'chat' ? 'Whole' : s === 'chain' ? 'Chapter' : 'Beat'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wide text-app-text/50">What kind?</label>
                  <div className="mt-1 flex rounded-lg bg-app-bg border border-app-text/15 p-0.5">
                    <button onClick={() => setKind('theme')} disabled={editing}
                      className={cn('flex-1 text-xs py-1.5 rounded-md flex items-center justify-center gap-1 disabled:opacity-40',
                        kind === 'theme' ? 'bg-accent/20 text-accent' : 'text-app-text/60 hover:text-app-text')}>
                      <Layers size={13} /> Theme
                    </button>
                    <button onClick={() => setKind('shell')} disabled={editing}
                      title="A full-screen view, one message at a time"
                      className={cn('flex-1 text-xs py-1.5 rounded-md flex items-center justify-center gap-1 disabled:opacity-40',
                        kind === 'shell' ? 'bg-accent/20 text-accent' : 'text-app-text/60 hover:text-app-text')}>
                      <LayoutTemplate size={13} /> View
                    </button>
                  </div>
                </div>
              </div>

              {kind === 'shell' && (
                <>
                  <p className="text-xs text-app-text/50 leading-relaxed">
                    A <span className="text-accent">View</span> takes over the screen and shows one message at a time —
                    the words stream in and you advance with the normal playback controls. The text stays exact.
                  </p>
                  <div>
                    <label className="text-xs uppercase tracking-wide text-app-text/50">Interactive trinkets</label>
                    <p className="text-[11px] text-app-text/40 mb-1.5">In-world widgets the view can embed — a hamster wheel that plays, a light switch that hides text.</p>
                    <div className="flex flex-wrap gap-1.5">
                      {TRINKETS.map(t => {
                        const on = controls.includes(t.id);
                        return (
                          <button key={t.id} type="button"
                            onClick={() => setControls(cs => on ? cs.filter(c => c !== t.id) : [...cs, t.id])}
                            className={cn('text-xs px-2 py-1 rounded-full border',
                              on ? 'bg-accent/15 text-accent border-accent/40' : 'bg-app-text/5 text-app-text/70 border-app-text/10 hover:border-accent/30')}>
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name this style (optional)"
                className="w-full rounded-lg bg-app-bg border border-app-text/15 px-3 py-2 text-app-text text-sm focus:border-accent outline-none" />

              {error && <p className="text-sm text-red-400">{error}</p>}
              {!aiReady && <p className="text-sm text-amber-400">Connect an AI endpoint in Settings to generate a design.</p>}
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-app-text/10">
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-app-text/70 hover:text-app-text text-sm">Cancel</button>
              <button onClick={generate} disabled={!aiReady}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-40 flex items-center gap-1.5">
                <Wand2 size={15} /> {editing ? 'Update' : 'Generate'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
