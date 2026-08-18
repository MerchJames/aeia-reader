import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Loader2, Check, X, AlertTriangle, Film, Zap, Volume2, RefreshCw, ChevronDown } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { samplerParamsFrom } from '../utils/aiClient';
import { generateScenePlan, generateSceneCue, BuildOrigin, CueGenInput, ScenePlanItem } from '../utils/sandboxDirector';
import {
  StylePacket, derivePacket, heuristicPacket, isPacketStale, packetLabel,
} from '../utils/stylePacket';
import { resolveAudioForBeat, searchAudioLibrary, AudioAsset } from '../utils/audioLibrary';
import { SceneCue } from '../types';
import { cn } from '../utils/cn';

/**
 * Scene Director — the two-pass staging workbench. First it PLANS a shot list
 * for the current beat (cheap, no CSS); the reader approves/edits the shots;
 * then it BUILDS each one on its own focused prompt, queued and knocked out one
 * by one with live status, and saves the finished cue track. Nothing is applied
 * until you approve it. Source text is never touched — cues only mark moments.
 */

type Status = 'idle' | 'building' | 'done' | 'error';
interface Shot extends ScenePlanItem {
  approved: boolean; status: Status; cue?: SceneCue; error?: string;
  /** How the finished shot was arrived at, and what the critic scored it. */
  origin?: BuildOrigin; score?: number;
}

/** What the reader is told about each outcome — plain language, no jargon. */
const ORIGIN_BADGE: Record<BuildOrigin, { label: string; title: string; cls: string }> = {
  ai: { label: 'designed', title: 'The model\u2019s scene passed the quality check as written.', cls: 'bg-emerald-400/10 text-emerald-500 border-emerald-400/25' },
  repaired: { label: 'repaired', title: 'The first attempt missed part of the brief; it was sent back with the exact misses and improved.', cls: 'bg-amber-400/10 text-amber-500 border-amber-400/25' },
  composed: { label: 'composed', title: 'The model couldn\u2019t hit the brief, so Aeia built this shot from your style packet instead.', cls: 'bg-sky-400/10 text-sky-500 border-sky-400/25' },
};

const KIND = {
  scene: { icon: Film, label: 'Scene', hint: 'Swaps the whole presentation' },
  fx: { icon: Zap, label: 'Effect', hint: 'A quick animation' },
  audio: { icon: Volume2, label: 'Sound', hint: 'A procedural sound' },
} as const;

interface Props {
  storyId: string;
  messageId: string;
  input: CueGenInput;
  onClose: () => void;
}

export const SceneDirectorModal = ({ storyId, messageId, input, onClose }: Props) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const aiReady = !!store.aiBaseUrl && !!store.aiModel;

  const [phase, setPhase] = useState<'planning' | 'review' | 'building' | 'done'>('planning');
  const [shots, setShots] = useState<Shot[]>([]);
  const [name, setName] = useState(() => {
    const existing = v2.sandboxSceneByStory[storyId]?.[messageId]?.name;
    if (existing) return existing;
    const words = input.content.trim().replace(/^[*"'\s]+/, '').split(/\s+/).slice(0, 4).join(' ').replace(/[.,;:!?*"']+$/, '');
    return words || `${input.name}’s scene`;
  });
  const [guidance, setGuidance] = useState(() => v2.sandboxGuidanceByStory[storyId] ?? '');
  // The resolved brief. Held in state (not read straight from the store) so the
  // reader can see it settle, and re-derived only when the guidance moves.
  const [packet, setPacket] = useState<StylePacket | null>(
    () => v2.sandboxPacketByStory[storyId]?.packet ?? null);
  const [packetBusy, setPacketBusy] = useState(false);
  const [showPacket, setShowPacket] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The generated-audio library offered to the planner as a reusable palette
  // (adaptive soundscapes) and looked up by id at build time.
  const libraryRef = useRef<AudioAsset[]>([]);

  const cfg = () => ({ base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel, params: samplerParamsFrom(store.aiAdvanced) });
  const genInput = (): CueGenInput => ({
    ...input,
    guidance: guidance.trim() || undefined,
    packet: packet ?? undefined,
    audioLibrary: libraryRef.current.length
      ? libraryRef.current.map(a => ({ id: a.id, category: a.category, tags: a.tags, description: a.description }))
      : undefined,
  });

  // What exact slice of the message each shot governs: a scene owns from its
  // anchor to the next scene's; a point cue marks the sentence it fires in.
  const coverage = useMemo(() => {
    const text = input.content;
    const hay = text.toLowerCase();
    const off = (a: string) => hay.indexOf(a.trim().toLowerCase());
    const scenes = shots.filter(s => s.kind === 'scene').map(s => ({ id: s.id, start: off(s.anchor) }))
      .filter(s => s.start >= 0).sort((a, b) => a.start - b.start);
    const map: Record<string, string> = {};
    for (const s of shots) {
      const o = off(s.anchor);
      if (o < 0) { map[s.id] = ''; continue; }
      if (s.kind === 'scene') {
        const i = scenes.findIndex(x => x.id === s.id);
        const start = i <= 0 ? 0 : scenes[i].start;
        const end = i >= 0 && i < scenes.length - 1 ? scenes[i + 1].start : text.length;
        map[s.id] = text.slice(start, end).trim();
      } else {
        const b = Math.max(0, Math.max(text.lastIndexOf('.', o - 1), text.lastIndexOf('\n', o - 1), text.lastIndexOf('?', o - 1), text.lastIndexOf('!', o - 1)) + 1);
        const ends = [text.indexOf('.', o), text.indexOf('\n', o), text.indexOf('?', o), text.indexOf('!', o)].filter(n => n >= 0);
        const e = ends.length ? Math.min(...ends) + 1 : text.length;
        map[s.id] = text.slice(b, e).trim();
      }
    }
    return map;
  }, [shots, input.content]);

  const runPlan = useCallback(async () => {
    if (!aiReady) { setError('Connect an AI endpoint in Settings to direct a scene.'); setPhase('review'); return; }
    setPhase('planning'); setError(null); setShots([]);
    abort.current = new AbortController();
    try {
      // Load the reusable audio palette first, so the plan can reference existing
      // beds by id (adaptive soundscapes). Best-effort — [] if the service is off.
      if (store.audioCuesEnabled) {
        try { libraryRef.current = await searchAudioLibrary(store.audioBaseUrl, {}, abort.current.signal); }
        catch { libraryRef.current = []; }
      }
      // Resolve the direction into a packet FIRST — the plan and every build
      // are then directed against one fixed brief instead of re-improvising the
      // look per beat. Cheap (one small call), cached until the guidance moves,
      // and it falls back to the built-in vocabulary rather than failing.
      let brief = packet;
      if (isPacketStale(v2.sandboxPacketByStory[storyId], guidance)) {
        setPacketBusy(true);
        brief = await derivePacket(
          guidance,
          [input.content.slice(0, 600)],
          { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
          abort.current.signal,
        );
        setPacket(brief);
        v2.setSandboxPacket(storyId, brief, guidance);
        setPacketBusy(false);
      }
      const plan = await generateScenePlan(
        { ...genInput(), packet: brief ?? undefined }, cfg(), abort.current.signal);
      if (!plan.length) { setError('The director didn’t return a usable plan. Try again.'); setPhase('review'); return; }
      setShots(plan.map(p => ({ ...p, approved: true, status: 'idle' })));
      setPhase('review');
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Planning failed.');
      setPhase('review');
    }
  }, [aiReady, input, guidance]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void runPlan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'building') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);
  useEffect(() => () => abort.current?.abort(), []);

  const patch = (id: string, p: Partial<Shot>) => setShots(s => s.map(x => x.id === id ? { ...x, ...p } : x));
  const approvedCount = shots.filter(s => s.approved).length;

  const runBuild = async () => {
    const queue = shots.filter(s => s.approved);
    if (!queue.length) return;
    setPhase('building'); setError(null);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const built: SceneCue[] = [];
    for (const shot of queue) {
      if (signal.aborted) break;
      patch(shot.id, { status: 'building', error: undefined });
      try {
        let cue: SceneCue | null = null;
        // An audio beat pulls a real clip from the generated-audio library. If
        // the plan REUSED an existing asset by id (adaptive soundscape), take it
        // straight from the loaded palette; otherwise resolve by intent (search
        // first, else generate). Falls back to a procedural sound if the service
        // is off/unreachable.
        if (shot.kind === 'audio' && store.audioCuesEnabled) {
          const reused = shot.assetId ? libraryRef.current.find(a => a.id === shot.assetId) ?? null : null;
          const asset = reused ?? await resolveAudioForBeat(store.audioBaseUrl, shot.intent, signal);
          if (asset) {
            cue = {
              id: `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              anchor: shot.anchor, kind: 'audio', assetId: asset.id,
              assetCategory: asset.category, loop: asset.loop,
              label: shot.intent.slice(0, 40),
            };
          }
        }
        let origin: BuildOrigin | undefined;
        let score: number | undefined;
        if (!cue) {
          const out = await generateSceneCue(
            genInput(), { ...shot, slice: coverage[shot.id] }, cfg(), signal);
          if (out) { cue = out.cue; origin = out.origin; score = out.score; }
        }
        if (cue) {
          built.push(cue);
          patch(shot.id, { status: 'done', cue, origin, score });
          v2.setSandboxCues(storyId, messageId, [...built]); // save as each lands
          v2.setSandboxScene(storyId, messageId, { name: name.trim() || `${input.name}’s scene`, enabled: true });
        } else {
          patch(shot.id, { status: 'error', error: 'nothing usable came back' });
        }
      } catch (e: any) {
        if (signal.aborted) break;
        patch(shot.id, { status: 'error', error: e?.message ?? 'failed' });
      }
    }
    setPhase('done');
  };

  const builtOk = shots.filter(s => s.status === 'done').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => { if (phase !== 'building') onClose(); }}>
      <div className="w-full max-w-lg rounded-2xl bg-app-surface border border-app-text/10 shadow-2xl flex flex-col max-h-[86dvh]"
        onClick={e => e.stopPropagation()} data-testid="scene-director">
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-text/10">
          <div className="flex items-center gap-2 font-semibold text-app-text">
            <Clapperboard size={18} className="text-accent" /> Scene Director
            <span className="text-xs font-normal text-app-text/40">· {input.name}’s beat</span>
          </div>
          <button onClick={onClose} disabled={phase === 'building'}
            className="text-app-text/50 hover:text-app-text disabled:opacity-30"><X size={18} /></button>
        </div>

        {phase === 'planning' ? (
          <div className="p-12 flex flex-col items-center gap-3 text-center">
            <Loader2 size={34} className="animate-spin text-accent" />
            <div className="text-app-text font-medium">Blocking out the shots…</div>
            <button onClick={() => abort.current?.abort()} className="text-sm text-app-text/60 hover:text-app-text underline">Cancel</button>
          </div>
        ) : (
          <>
            <div className="px-5 py-3 border-b border-app-text/10 text-xs text-app-text/50">
              {phase === 'review' && 'Here’s the plan — approve the beats you want, tweak the intent, then build.'}
              {phase === 'building' && 'Building each beat on its own — knocking them out one by one…'}
              {phase === 'done' && (builtOk ? `Staged ${builtOk} of ${shots.filter(s => s.approved).length} beats. Play the message to watch it.` : 'Nothing got built. Re-plan or try again.')}
            </div>

            <div className="p-4 space-y-2.5 overflow-y-auto">
              {error && <p className="text-sm text-red-400">{error}</p>}
              {phase === 'review' && (
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-app-text/40">Guidance — steer every shot (style, era, director, palette)</label>
                  <textarea value={guidance}
                    onChange={e => { setGuidance(e.target.value); v2.setSandboxGuidance(storyId, e.target.value); }}
                    rows={2} placeholder="e.g. 1970s giallo horror — deep reds & shadow, hard zooms, grainy; keep it lurid and operatic"
                    className="mt-1 w-full rounded-lg bg-app-bg border border-app-text/15 px-2.5 py-1.5 text-app-text text-sm resize-none focus:border-accent outline-none" />
                </div>
              )}
              {phase === 'review' && (packet || packetBusy) && (
                <div className="rounded-xl border border-app-text/10 bg-app-bg/40 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowPacket(v => !v)} disabled={!packet}
                      className="flex items-center gap-1.5 text-[11px] text-app-text/50 hover:text-app-text/80 disabled:opacity-50"
                      title="The look every shot of this story is built against">
                      <ChevronDown size={11} className={cn('shrink-0 transition-transform', showPacket && 'rotate-180')} />
                      <span className="uppercase tracking-wide">Look</span>
                    </button>
                    {packetBusy ? (
                      <span className="text-xs text-app-text/40 flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> resolving your direction…
                      </span>
                    ) : packet && (
                      <>
                        <span className="flex gap-1" aria-hidden>
                          {([packet.palette.bg, packet.palette.ink, packet.palette.accent, packet.palette.glow]).map((c, i) => (
                            <span key={i} className="w-3.5 h-3.5 rounded-full border border-app-text/20" style={{ background: c }} />
                          ))}
                        </span>
                        <span className="text-xs text-app-text/60 truncate flex-1" title={packet.look}>{packet.look}</span>
                        <span className="text-[10px] text-app-text/30 shrink-0">{packetLabel(packet)}</span>
                      </>
                    )}
                  </div>
                  {showPacket && packet && (
                    <div className="mt-2 space-y-1.5 text-[11px] text-app-text/50">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        {(['bg', 'ink', 'accent', 'glow'] as const).map(k => (
                          <label key={k} className="flex items-center gap-1.5">
                            <span className="uppercase tracking-wide w-11 shrink-0">{k}</span>
                            <input type="color" value={packet.palette[k]}
                              onChange={e => {
                                const next: StylePacket = {
                                  ...packet, source: 'reader',
                                  palette: { ...packet.palette, [k]: e.target.value },
                                };
                                setPacket(next);
                                v2.setSandboxPacket(storyId, next, guidance);
                              }}
                              className="w-7 h-6 rounded border border-app-text/15 bg-transparent p-0" />
                            <span className="font-mono text-[10px] text-app-text/40">{packet.palette[k]}</span>
                          </label>
                        ))}
                      </div>
                      <p><span className="text-app-text/35">light</span> {packet.light}</p>
                      <p><span className="text-app-text/35">camera</span> {packet.camera.join(' · ')}</p>
                      <p><span className="text-app-text/35">texture</span> {packet.texture.join(' · ')} · <span className="text-app-text/35">motion</span> {packet.motion}</p>
                      <p><span className="text-app-text/35">never</span> {packet.forbid.join(' · ')}</p>
                      <div className="flex gap-3 pt-0.5">
                        <button onClick={() => { const p = heuristicPacket(guidance); setPacket(p); v2.setSandboxPacket(storyId, p, guidance); }}
                          className="underline hover:text-app-text/80">Use the built-in look</button>
                        <button disabled={!aiReady || packetBusy}
                          onClick={async () => {
                            setPacketBusy(true);
                            const p = await derivePacket(guidance, [input.content.slice(0, 600)],
                              { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel });
                            setPacket(p); v2.setSandboxPacket(storyId, p, guidance); setPacketBusy(false);
                          }}
                          className="underline hover:text-app-text/80 disabled:opacity-40">Re-resolve with AI</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {phase === 'review' && shots.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-app-text/50">
                  <span className="uppercase tracking-wide">Scene name</span>
                  <input value={name} onChange={e => setName(e.target.value)}
                    className="flex-1 rounded-lg bg-app-bg border border-app-text/15 px-2.5 py-1.5 text-app-text text-sm focus:border-accent outline-none" />
                </label>
              )}
              {shots.map((s, i) => {
                const K = KIND[s.kind];
                return (
                  <div key={s.id} className={cn('rounded-xl border p-3',
                    s.status === 'done' ? 'border-emerald-400/40 bg-emerald-400/5'
                      : s.status === 'error' ? 'border-red-400/40 bg-red-400/5'
                      : s.approved ? 'border-app-text/15' : 'border-app-text/10 opacity-50')}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-app-text/30 w-4">{i + 1}</span>
                      <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-accent/10 text-accent border border-accent/25">
                        <K.icon size={12} /> {K.label}
                      </span>
                      {s.assetId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-400/10 text-emerald-500 border border-emerald-400/25"
                          title={`Reuses an existing library clip (${s.assetId})`}>
                          reuse
                        </span>
                      )}
                      <button onClick={() => setExpanded(x => x === s.id ? null : s.id)}
                        className="text-xs text-app-text/50 italic truncate flex-1 text-left flex items-center gap-1 hover:text-app-text/80"
                        title="Show the exact text this shot handles">
                        <ChevronDown size={11} className={cn('shrink-0 transition-transform', expanded === s.id && 'rotate-180')} />
                        “{s.anchor}”
                      </button>
                      {phase === 'review' && (
                        <input type="checkbox" checked={s.approved} onChange={e => patch(s.id, { approved: e.target.checked })}
                          title="Include this beat" className="accent-current text-accent" />
                      )}
                      {s.origin && (
                        <span title={ORIGIN_BADGE[s.origin].title}
                          className={cn('text-[10px] px-1.5 py-0.5 rounded-md border shrink-0', ORIGIN_BADGE[s.origin].cls)}>
                          {ORIGIN_BADGE[s.origin].label}{s.score != null ? ` ${s.score}` : ''}
                        </span>
                      )}
                      {s.status === 'building' && <Loader2 size={15} className="animate-spin text-accent" />}
                      {s.status === 'done' && <Check size={15} className="text-emerald-400" />}
                      {s.status === 'error' && <AlertTriangle size={15} className="text-red-400" />}
                    </div>

                    {expanded === s.id && (
                      <div className="mt-2 space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wide text-app-text/40">
                          {s.kind === 'scene' ? 'Text this shot displays' : 'Fires in this line'}
                        </div>
                        <div className="rounded-lg bg-app-bg/60 border border-app-text/10 px-2.5 py-2 text-sm text-app-text/80 leading-snug max-h-28 overflow-y-auto whitespace-pre-wrap">
                          {coverage[s.id] || <span className="text-red-400">Anchor not found in the message — fix it below.</span>}
                        </div>
                        {phase === 'review' && (
                          <label className="flex items-center gap-2 text-[11px] text-app-text/40">
                            <span className="uppercase tracking-wide shrink-0">Starts at</span>
                            <input value={s.anchor} onChange={e => patch(s.id, { anchor: e.target.value })}
                              className={cn('flex-1 rounded-md bg-app-bg border px-2 py-1 text-app-text text-xs font-mono focus:border-accent outline-none',
                                coverage[s.id] ? 'border-app-text/15' : 'border-red-400/50')} />
                          </label>
                        )}
                      </div>
                    )}

                    {phase === 'review' ? (
                      <textarea value={s.intent} onChange={e => patch(s.id, { intent: e.target.value })}
                        rows={2} disabled={!s.approved}
                        className="mt-2 w-full rounded-lg bg-app-bg border border-app-text/15 px-2.5 py-1.5 text-app-text text-sm resize-none focus:border-accent outline-none disabled:opacity-50" />
                    ) : (
                      <p className="mt-1.5 text-sm text-app-text/70 leading-snug">{s.intent}
                        {s.status === 'error' && s.error && <span className="text-red-400"> — {s.error}</span>}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-app-text/10">
              {phase === 'review' && (
                <>
                  <button onClick={runPlan} disabled={!aiReady}
                    className="mr-auto flex items-center gap-1.5 text-sm text-app-text/60 hover:text-app-text disabled:opacity-40">
                    <RefreshCw size={14} /> Re-plan
                  </button>
                  <button onClick={onClose} className="px-4 py-2 rounded-lg text-app-text/70 hover:text-app-text text-sm">Cancel</button>
                  <button onClick={runBuild} disabled={!aiReady || approvedCount === 0}
                    className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-40 flex items-center gap-1.5">
                    <Clapperboard size={15} /> Build {approvedCount} {approvedCount === 1 ? 'scene' : 'scenes'}
                  </button>
                </>
              )}
              {phase === 'building' && (
                <button onClick={() => abort.current?.abort()}
                  className="px-4 py-2 rounded-lg border border-red-500/40 text-red-400 text-sm">Stop</button>
              )}
              {phase === 'done' && (
                <>
                  <button onClick={runPlan} className="mr-auto flex items-center gap-1.5 text-sm text-app-text/60 hover:text-app-text">
                    <RefreshCw size={14} /> Re-plan
                  </button>
                  <button onClick={onClose} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90">Done</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
