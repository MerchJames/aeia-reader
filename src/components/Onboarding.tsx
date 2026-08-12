import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Play, Sparkles, Square, X } from 'lucide-react';
import { ONBOARDING_STEPS, OnboardingDemo, isAiStep } from '../utils/onboarding';
import { VIEW_HINT, VIEW_LABEL } from '../utils/viewBar';
import { useAppStore } from '../store';
import { ACCENTS, THEMES } from '../themes';
import { READING_MODES, modeDef } from '../utils/readingModes';
import { composeScene, heuristicPacket } from '../utils/stylePacket';
import { AccentColor, Theme, UiMode, ViewMode } from '../types';
import { chatCompletion, listModels } from '../utils/aiClient';
import { playSound } from '../utils/sandboxAudio';
import { AmbientController } from '../utils/ambient';
import { cn } from '../utils/cn';

/**
 * The first-run tour.
 *
 * Shown once, automatically, and reopenable from the library. It is skippable
 * on every step and closes on Escape or a backdrop click — a tour that traps
 * you is worse than none, and someone who already knows the app should be able
 * to get past it in one keystroke.
 *
 * Content lives in `utils/onboarding` so it can be tested; this is a renderer.
 */


/* ── Live demos ────────────────────────────────────────────────────────────
 * Each of these SHOWS the thing its step is about, using the app's own code
 * where there is any to use — the sandbox preview is built by the real
 * composer, the reading modes come from the real ladder. A tour that only
 * describes the features is a wall of text nobody finishes.
 */

const DEMO_LINE = 'The hearth crackled warm, and she would not meet his eyes.';

/** Words arriving at reading speed, on a loop. */
const TypingDemo = () => {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN(v => (v > DEMO_LINE.length + 12 ? 0 : v + 1)), 55);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rounded-xl border border-app-text/10 bg-app-bg/50 px-4 py-3 min-h-[4.5rem]">
      <div className="text-[10px] uppercase tracking-wider text-app-text/30 mb-1">Mara</div>
      <p className="text-sm text-app-text/80 leading-relaxed">
        {DEMO_LINE.slice(0, n)}
        <span className="inline-block w-[2px] h-[1em] align-[-0.15em] bg-accent animate-pulse ml-px" />
      </p>
    </div>
  );
};

/** Theme + accent, applied for real. The first thing anyone wants to change. */
const PICK_THEMES: Theme[] = ['dark', 'light', 'sepia', 'book', 'terminal', 'synthwave', 'grimoire', 'eink'];

const CustomizeDemo = () => {
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);
  const accent = useAppStore(s => s.accentColor);
  const setAccentColor = useAppStore(s => s.setAccentColor);
  const readingMode = useAppStore(s => s.readingMode);
  const setReadingMode = useAppStore(s => s.setReadingMode);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-app-text/35 mb-1.5">Theme</div>
        <div className="grid grid-cols-4 gap-1.5">
          {PICK_THEMES.map(id => {
            const def = THEMES[id];
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                data-testid={`tour-theme-${id}`}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-[11px] text-left transition-colors',
                  theme === id ? 'border-accent' : 'border-app-text/10 hover:border-app-text/30',
                )}
                style={{ background: def.vars.bg, color: def.vars.text }}
              >
                {def.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wider text-app-text/35">Accent</span>
        <div className="flex gap-1.5">
          {ACCENTS.map(a => (
            <button
              key={a.id}
              onClick={() => setAccentColor(a.id as AccentColor)}
              aria-label={a.label}
              className={cn('w-5 h-5 rounded-full border-2 transition-transform',
                accent === a.id ? 'border-app-text scale-110' : 'border-transparent')}
              style={{ background: a.hex }}
            />
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-app-text/35 mb-1.5">How much it performs</div>
        <div className="flex gap-1.5">
          {READING_MODES.map(m => (
            <button
              key={m}
              onClick={() => setReadingMode(m)}
              className={cn('flex-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors',
                readingMode === m
                  ? 'border-accent bg-accent/10 text-app-text'
                  : 'border-app-text/10 text-app-text/50 hover:text-app-text/80')}
            >
              {modeDef(m).label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

/** The Director bending the reveal — the real `perf-*` treatments. */
const KineticDemo = () => {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBeat(b => b + 1), 3200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rounded-xl border border-app-text/10 bg-app-bg/50 px-4 py-4 min-h-[5rem] flex items-center">
      <p key={beat} className="text-sm text-app-text/85 leading-relaxed">
        <span className="perf-slow">In.</span>{' '}
        <span className="perf-slow">the.</span>{' '}
        <span className="perf-slow">end.</span>{' '}
        <span className="perf-hold">She</span>{' '}
        <span className="perf-swell">knew</span>{' '}
        <span className="perf-tremble">exactly</span>{' '}
        <span className="perf-drop">what</span>{' '}
        <span className="perf-fade">it would cost her.</span>
      </p>
    </div>
  );
};

/** The dimmed page with the spotlight tracking the newest words. */
const AutofocusDemo = () => (
  <div className="relative rounded-xl border border-app-text/10 bg-app-bg/50 px-4 py-3 overflow-hidden">
    <p className="text-[13px] text-app-text/80 leading-relaxed">
      She turned slowly, her voice barely a whisper against the dark, and the light
      caught her eyes as she spoke of the things she had seen beyond the door.
    </p>
    {/* The same idea as the real thing: a scrim with a hole in it, moving. */}
    <div className="tour-spotlight" aria-hidden />
  </div>
);

/** A scene composed by the real composer — no model involved. */
const SandboxDemo = () => {
  const [look, setLook] = useState('noir');
  const css = useMemo(() => composeScene(heuristicPacket(look), { textLength: 90 }), [look]);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}${css}</style></head>
<body><div class="card"><span class="who">MARA</span>
<div class="body" id="aura-body"><p>She would not meet his eyes.</p></div></div></body></html>`, [css]);
  return (
    <div className="space-y-2">
      {/* Scaled, not squeezed. `composeScene` designs for a full viewport — the
        * type is sized in vw and the stage is 100vh — so rendering it into a
        * 160px box collapses the whole composition. Give the frame a real
        * viewport and shrink the result, the way any design preview does. */}
      <div className="rounded-xl overflow-hidden border border-app-text/10 h-44 relative">
        <iframe
          title="Sandbox preview"
          sandbox=""
          srcDoc={doc}
          className="absolute top-0 left-0 border-0 origin-top-left"
          style={{ width: '250%', height: '250%', transform: 'scale(0.4)' }}
        />
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {['noir', 'giallo', 'terminal', 'storybook', 'neon'].map(l => (
          <button
            key={l}
            onClick={() => setLook(l)}
            className={cn('rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors',
              look === l ? 'border-accent text-app-text' : 'border-app-text/15 text-app-text/50 hover:text-app-text/80')}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
};

/** A fork in the story. */
const BranchesDemo = () => (
  <div className="rounded-xl border border-app-text/10 bg-app-bg/50 p-4">
    <div className="flex items-center gap-2 text-[11px]">
      <span className="rounded-md bg-app-text/10 px-2 py-1 text-app-text/70">…she opened the door</span>
    </div>
    <div className="ml-4 mt-1 border-l border-app-text/15 pl-4 space-y-1.5 pt-1.5">
      <div className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-app-text/85">
        and stepped through. <span className="text-app-text/40">— reading this one</span>
      </div>
      <div className="rounded-md border border-app-text/10 px-2 py-1 text-[11px] text-app-text/45">
        and closed it again.
      </div>
      <div className="rounded-md border border-app-text/10 px-2 py-1 text-[11px] text-app-text/45">
        …but the hallway was already empty.
      </div>
    </div>
  </div>
);

/** Something pinned to the dock. */
const PinsDemo = () => (
  <div className="grid grid-cols-2 gap-2">
    <div className="rounded-xl border border-app-text/10 bg-app-bg/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-app-text/30 mb-1">Highlighted</div>
      <p className="text-[12px] text-app-text/75 leading-snug">
        she would not <mark className="bg-yellow-400/30 text-app-text rounded px-0.5">meet his eyes</mark>
      </p>
      <p className="text-[10px] text-app-text/40 mt-1.5 italic">“she already knows”</p>
    </div>
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      <div className="text-[10px] uppercase tracking-wider text-accent/70 mb-1">Pinned · sheet</div>
      <div className="space-y-1 text-[11px] text-app-text/70">
        <div className="flex justify-between"><span>Mara</span><span className="text-app-text/40">trusts him</span></div>
        <div className="flex justify-between"><span>Elara</span><span className="text-app-text/40">unknown</span></div>
        <div className="flex justify-between"><span>the letter</span><span className="text-app-text/40">unopened</span></div>
      </div>
    </div>
  </div>
);


/* ── A miniature of each view, for the hover preview ─────────────────────── */

const SLIVER = 'She would not meet his eyes. The hearth had burned down to embers.';
const SLIVER_A = 'She would not meet his eyes.';
const SLIVER_B = 'The hearth had burned down to embers.';

/**
 * A miniature of a view, with real words in it.
 *
 * Grey placeholder bars tell you a layout; they do not tell you what reading in
 * that view feels like — which is the only thing a preview is for.
 */
const ViewPreview = ({ view }: { view: ViewMode }) => {
  const t = 'text-[7px] leading-[1.5] text-app-text/70';
  switch (view) {
    case 'storybook':
      return <div className={cn('p-2.5', t)}>{SLIVER} She said the thing she had been carrying for a year, and the room did not change.</div>;
    case 'chat':
      return (
        <div className="p-2 space-y-1">
          <div className={cn('rounded-lg rounded-bl-sm bg-app-text/10 px-1.5 py-1 w-4/5', t)}>{SLIVER_A}</div>
          <div className={cn('rounded-lg rounded-br-sm bg-accent/25 px-1.5 py-1 w-3/5 ml-auto', t)}>I said nothing.</div>
        </div>
      );
    case 'book':
      return (
        <div className="p-2 grid grid-cols-2 gap-1 h-full">
          <div className={cn('rounded-l bg-app-text/5 p-1.5', t)}>{SLIVER_A}</div>
          <div className={cn('rounded-r bg-app-text/5 p-1.5 relative', t)}>
            {SLIVER_B}
            <span className="absolute bottom-1 right-1.5 text-[6px] text-app-text/30">41</span>
          </div>
        </div>
      );
    case 'stage':
      return (
        <div className="p-2 h-full flex flex-col justify-end gap-1">
          <div className="flex justify-between px-3">
            <div className="w-5 h-6 rounded-t-full bg-accent/40" />
            <div className="w-5 h-6 rounded-t-full bg-app-text/15" />
          </div>
          <div className={cn('rounded border border-accent/40 bg-app-text/10 px-1.5 py-1', t)}>
            <span className="text-accent/80">MARA</span> · {SLIVER_A}
          </div>
        </div>
      );
    case 'vn':
      return (
        <div className="relative h-full">
          <div className="absolute inset-0 bg-gradient-to-b from-accent/25 to-app-text/10" />
          <div className="absolute left-1/2 -translate-x-1/2 bottom-7 w-6 h-9 rounded-t-full bg-app-text/40" />
          <div className={cn('absolute inset-x-1.5 bottom-1.5 rounded bg-app-bg/85 backdrop-blur px-1.5 py-1', t)}>
            {SLIVER_A}
          </div>
        </div>
      );
    case 'sandbox':
      return (
        <div className="h-full grid place-items-center bg-gradient-to-br from-[#160709] to-[#08090b] px-3">
          <p className="text-[8px] text-center text-[#f4e6d6] tracking-wide" style={{ fontFamily: 'Georgia, serif' }}>
            <span className="block text-[6px] tracking-[0.25em] text-[#d61f2b] mb-0.5">MARA</span>
            {SLIVER_A}
          </p>
        </div>
      );
    case 'overview':
      return (
        <div className="p-2 space-y-1">
          {['The tavern, warm', 'A scream in the dark', 'At dawn, stars'].map((label, i) => (
            <div key={label} className={cn('flex items-center gap-1.5', t)}>
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                i === 1 ? 'bg-red-400/70' : 'bg-accent/60')} />
              {label}
            </div>
          ))}
        </div>
      );
    case 'highlights':
      return (
        <div className={cn('p-2 space-y-1.5', t)}>
          <p>she would not <mark className="bg-yellow-400/30 rounded px-0.5 text-app-text">meet his eyes</mark></p>
          <p className="text-app-text/40 italic">“she already knows”</p>
          <p><mark className="bg-sky-400/30 rounded px-0.5 text-app-text">burned down to embers</mark></p>
        </div>
      );
    case 'branches':
      return (
        <div className={cn('p-2', t)}>
          <div className="rounded bg-app-text/10 px-1.5 py-0.5 w-fit">…she opened the door</div>
          <div className="ml-2 mt-1 border-l border-app-text/20 pl-2 space-y-1">
            <div className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-app-text/80">and stepped through.</div>
            <div className="rounded border border-app-text/10 px-1.5 py-0.5 text-app-text/45">and closed it again.</div>
          </div>
        </div>
      );
    default:
      return <div className={cn('p-2.5', t)}>{SLIVER}</div>;
  }
};

/**
 * Voices and soundscapes — and where each of them actually comes from.
 *
 * The examples PLAY, and they play Aura's own synthesised audio: the one-shots
 * come from the procedural SFX synth and the beds from the ambient engine, so
 * the tour ships no audio files and demonstrates the real thing rather than a
 * recording of it.
 */
const AudioDemo = () => {
  const [cue, setCue] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const ambientRef = useRef<AmbientController | null>(null);

  /** Beds default to a background level; a preview should be audible. */
  const bed = (spec: string) => {
    const c = (ambientRef.current ??= new AmbientController());
    c.setVolume(0.75);
    c.play(spec);
  };

  const cues = [
    {
      kind: 'ambience', text: 'a hearth crackling in a low-ceilinged tavern', loop: true,
      play: () => bed('builtin:fire'),
    },
    {
      kind: 'sfx', text: 'a heavy door pulled shut in the next room', loop: false,
      play: () => playSound('boom'),
    },
    {
      kind: 'music', text: 'a low drone holding under the whole scene', loop: true,
      play: () => bed('builtin:drone'),
    },
  ];
  const active = cues[cue];

  // Never leave a bed running behind the reader when the tour closes.
  useEffect(() => () => { ambientRef.current?.play(''); }, []);
  useEffect(() => { ambientRef.current?.play(''); setPlaying(null); }, [cue]);

  const hear = () => {
    active.play();
    setPlaying(active.kind);
    if (!active.loop) setTimeout(() => setPlaying(null), 900);
  };
  const stop = () => { ambientRef.current?.play(''); setPlaying(null); };

  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-app-text/10 bg-app-bg/50 p-3 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-app-text/35">Read aloud</div>
        <div className="flex items-center gap-2">
          <span className="flex items-end gap-0.5 h-4" aria-hidden>
            {[3, 8, 5, 12, 6, 9, 4].map((h, i) => (
              <span key={i} className="w-0.5 rounded-full bg-accent/70 tour-eq"
                style={{ height: `${h}px`, animationDelay: `${i * 90}ms` }} />
            ))}
          </span>
          <p className="text-[11px] text-app-text/60">
            Browser voices work out of the box. The Director can shape the delivery —
            a frightened line reads faster and higher than a resigned one.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-app-text/10 bg-app-bg/50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-app-text/35">Sound for a beat</div>
          <div className="flex gap-1">
            {cues.map((c, i) => (
              <button
                key={c.kind}
                onClick={() => setCue(i)}
                data-testid={`tour-audio-${c.kind}`}
                className={cn('rounded-full border px-2 py-0.5 text-[10px] capitalize transition-colors',
                  i === cue ? 'border-accent text-app-text' : 'border-app-text/15 text-app-text/45')}
              >
                {c.kind}
              </button>
            ))}
          </div>
        </div>
        {/* Described in plain words — this is what the prompt actually takes. */}
        <div className="flex items-center gap-2">
          <button
            onClick={playing ? stop : hear}
            data-testid="tour-audio-play"
            aria-label={playing ? 'Stop' : `Hear the ${active.kind}`}
            className="shrink-0 w-7 h-7 rounded-full bg-accent/15 border border-accent/40 text-accent grid place-items-center hover:bg-accent/25"
          >
            {playing ? <Square size={11} /> : <Play size={12} className="ml-px" />}
          </button>
          <div className="flex-1 min-w-0 rounded-lg border border-app-text/15 bg-app-surface/60 px-2.5 py-1.5 text-[11px] text-app-text/75 italic">
            “{active.text}”
          </div>
        </div>
        <p className="text-[10px] text-app-text/40">
          {active.loop ? 'A bed — carried across the scene and reused.' : 'A one-shot, fired as the words reach it.'}
          {' '}These previews are synthesised by Aura itself, so nothing is bundled.
        </p>
      </div>

      {/* Honesty about what is and is not included. */}
      <p className="text-[10px] text-app-text/40 leading-relaxed">
        Higher-quality voices (Kokoro) and generated music/SFX run as
        <span className="text-app-text/60"> separate local services you start yourself</span> —
        Aura talks to them over a URL you set, and everything above still works without them.
      </p>
    </div>
  );
};

/** Slot in an endpoint and actually read a passage with it. */
const CONNECT_PASSAGE =
  'The hearth had burned down to embers. She spoke to the fire, not to him, and '
  + 'said the thing she had been carrying for a year.';

const ConnectDemo = () => {
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState(store.aiBaseUrl);
  const [model, setModel] = useState(store.aiModel);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const found = await listModels(base, store.aiApiKey);
      setModels(found.models.slice(0, 40));
      if (!model && found.models[0]) setModel(found.models[0]);
      store.setAiBaseUrl(found.base);
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not reach that endpoint.');
    } finally { setBusy(false); }
  };

  const tryIt = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      store.setAiModel(model);
      const reply = await chatCompletion(store.aiBaseUrl || base, store.aiApiKey, model, [
        { role: 'system', content: 'You read a passage and name its mood in ONE short phrase, then a sentence on why. No preamble.' },
        { role: 'user', content: CONNECT_PASSAGE },
      ], { temperature: 0, max_tokens: 120 });
      setResult(reply.trim() || '(the endpoint answered with nothing)');
    } catch (e) {
      setError((e as Error)?.message ?? 'That request failed.');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid="tour-connect"
        className="w-full rounded-xl border border-dashed border-app-text/20 px-4 py-3 text-sm
          text-app-text/60 hover:text-app-text hover:border-accent/50 transition-colors"
      >
        Have an endpoint? Try it on a passage →
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-app-text/15 bg-app-bg/50 p-3 space-y-2">
      <div className="flex gap-1.5">
        <input
          value={base}
          onChange={e => setBase(e.target.value)}
          placeholder="http://localhost:5001"
          data-testid="tour-base"
          className="flex-1 min-w-0 rounded-lg bg-app-surface border border-app-text/15 px-2 py-1.5 text-xs outline-none focus:border-accent"
        />
        <button
          onClick={() => void connect()}
          disabled={busy || !base.trim()}
          className="rounded-lg border border-app-text/15 px-2.5 text-xs text-app-text/70 hover:text-app-text disabled:opacity-40"
        >
          Connect
        </button>
      </div>
      {models.length > 0 && (
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          data-testid="tour-model"
          className="w-full rounded-lg bg-app-surface border border-app-text/15 px-2 py-1.5 text-xs outline-none"
        >
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
      <p className="text-[11px] text-app-text/45 italic leading-snug">“{CONNECT_PASSAGE}”</p>
      <button
        onClick={() => void tryIt()}
        disabled={busy || !model}
        data-testid="tour-try"
        className="w-full rounded-lg bg-accent text-white text-xs font-medium py-1.5 disabled:opacity-40"
      >
        {busy ? 'Reading…' : 'Read this passage'}
      </button>
      {result && (
        <p data-testid="tour-result" className="rounded-lg border border-app-text/10 bg-app-surface/60 px-2.5 py-2 text-[11px] text-app-text/75 whitespace-pre-wrap">
          {result}
        </p>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <p className="text-[10px] text-app-text/35">
        Saved to Settings if it works. Nothing is sent anywhere else.
      </p>
    </div>
  );
};

const DEMOS: Record<OnboardingDemo, () => JSX.Element> = {
  typing: TypingDemo,
  customize: CustomizeDemo,
  kinetic: KineticDemo,
  autofocus: AutofocusDemo,
  sandbox: SandboxDemo,
  branches: BranchesDemo,
  audio: AudioDemo,
  connect: ConnectDemo,
  pins: PinsDemo,
};

interface Props {
  onClose: () => void;
}

export const Onboarding = ({ onClose }: Props) => {
  const [step, setStep] = useState(0);
  const [hovered, setHovered] = useState<ViewMode | null>(null);
  // Hover INTENT, not raw hover. Entering shows at once, but leaving — or
  // sliding across to another tile — waits, so the preview does not strobe as
  // the pointer crosses the grid. Without this the first tiles you pass over
  // (Storybook and Chat, top-left) barely registered at all.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverView = (view: ViewMode | null) => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (view) { setHovered(view); return; }
    hoverTimer.current = setTimeout(() => setHovered(null), 450);
  };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const uiMode = useAppStore(s => s.uiMode);
  const setUiMode = useAppStore(s => s.setUiMode);
  const current = ONBOARDING_STEPS[step];
  const last = step === ONBOARDING_STEPS.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setStep(s => Math.min(ONBOARDING_STEPS.length - 1, s + 1));
      if (e.key === 'ArrowLeft') setStep(s => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="onboarding"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-app-surface border border-app-text/10 shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-app-text/35">
              <Sparkles size={12} className="text-accent" />
              Step {step + 1} of {ONBOARDING_STEPS.length}
              {isAiStep(current) && (
                <span className="rounded-full border border-app-text/20 px-1.5 py-0.5 normal-case tracking-normal">
                  optional
                </span>
              )}
            </div>
            <h2 className="text-xl font-serif font-bold text-app-text mt-1.5">{current.title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close the tour"
            data-testid="onboarding-close"
            className="p-1.5 -mr-1.5 rounded-lg text-app-text/40 hover:text-app-text shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 pb-5 space-y-4">
          <p className="text-sm text-app-text/70 leading-relaxed">{current.body}</p>

          {/* Showing beats describing — every step that can carries a concrete
            * example of the thing it is talking about. */}
          {current.demo && (() => { const Demo = DEMOS[current.demo!]; return <Demo />; })()}

          {current.example && (
            <ul className="rounded-xl border border-app-text/10 bg-app-bg/50 px-4 py-3 space-y-1.5">
              {current.example.map(line => (
                <li key={line} className="text-sm text-app-text/75 flex gap-2">
                  <span className="text-accent/70 shrink-0">·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}

          {current.views && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                {current.views.map(view => (
                  <button
                    key={view}
                    onMouseEnter={() => hoverView(view)}
                    onMouseLeave={() => hoverView(null)}
                    onFocus={() => hoverView(view)}
                    onBlur={() => hoverView(null)}
                    data-testid={`tour-view-${view}`}
                    className={cn(
                      'rounded-lg border bg-app-bg/50 px-2.5 py-1.5 text-left transition-colors',
                      hovered === view ? 'border-accent' : 'border-app-text/10',
                    )}
                  >
                    <div className="text-xs font-medium text-app-text/85">{VIEW_LABEL[view]}</div>
                    <div className="text-[10px] text-app-text/40 leading-snug line-clamp-2">
                      {VIEW_HINT[view]}
                    </div>
                  </button>
                ))}
              </div>

              {/* ONLY while hovering. Until the reader asks what one of these
                * looks like, the step should read as a plain list of names. */}
              {hovered && (
                <div
                  onMouseEnter={() => hoverView(hovered)}
                  onMouseLeave={() => hoverView(null)}
                  className="rounded-xl border border-accent/30 bg-app-bg/60 overflow-hidden"
                  data-testid="tour-view-preview"
                >
                  {/* Keyed so switching views cross-fades rather than snapping. */}
                  <div key={hovered} className="h-24 overflow-hidden tour-preview-in">
                    <ViewPreview view={hovered} />
                  </div>
                  <p className="border-t border-app-text/10 px-3 py-1 text-[10px] text-app-text/50">
                    {VIEW_LABEL[hovered]}
                  </p>
                </div>
              )}

              {/* The workspace preset seeds which of these show — and this is
                * the one moment the reader is thinking about that at all. */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-app-text/35 mb-1.5">
                  Start me with
                </div>
                <div className="flex gap-1.5">
                  {(['read', 'cowrite', 'scenes', 'all'] as UiMode[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setUiMode(m)}
                      data-testid={`tour-uimode-${m}`}
                      className={cn('flex-1 rounded-lg border px-2 py-1.5 text-[11px] capitalize transition-colors',
                        uiMode === m
                          ? 'border-accent bg-accent/10 text-app-text'
                          : 'border-app-text/10 text-app-text/50 hover:text-app-text/80')}
                    >
                      {m === 'all' ? 'Everything' : m}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-6 py-4 border-t border-app-text/10">
          <div className="flex gap-1.5 mr-auto" aria-hidden>
            {ONBOARDING_STEPS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === step ? 'w-5 bg-accent' : 'w-1.5 bg-app-text/20 hover:bg-app-text/40',
                )}
              />
            ))}
          </div>

          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-app-text/60 hover:text-app-text"
            >
              <ArrowLeft size={15} /> Back
            </button>
          )}
          {!last && (
            <button
              onClick={onClose}
              data-testid="onboarding-skip"
              className="px-3 py-2 rounded-lg text-sm text-app-text/50 hover:text-app-text"
            >
              Skip
            </button>
          )}
          <button
            onClick={() => (last ? onClose() : setStep(s => s + 1))}
            data-testid="onboarding-next"
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
          >
            {last ? <><Check size={15} /> Start reading</> : <>Next <ArrowRight size={15} /></>}
          </button>
        </div>
      </div>
    </div>
  );
};
