import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Sparkles, X, Loader2, Music2, Waves, RotateCw, Pencil, Zap, Shuffle } from 'lucide-react';
import { useAppStore } from '../store';
import { useScenes } from '../hooks/useScenes';
import { sceneSoundscapeIntent, sceneMusicIntent, tensionVolume, locationLoudness, SoundscapeIntent } from '../utils/sceneMood';
import { tensionAt } from '../utils/sceneSegment';
import {
  searchAudioLibrary, generateAudio, audioAssetUrl, audioServiceUp,
  pickBestMatch, AudioAsset,
} from '../utils/audioLibrary';
import { AudioCategory } from '../types';
import { audioMixer } from '../utils/audioMixer';
import { CrossfadePlayer } from '../utils/crossfadePlayer';
import { cn } from '../utils/cn';

type Layer = 'ambience' | 'music';

/** Re-render whenever the mixer ducks/undocks (TTS speaking) so ceilings update. */
const useMixerTick = (): number => {
  const [t, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => audioMixer.subscribe(bump), []);
  return t;
};

/**
 * Adaptive Soundscapes for NORMAL reading. Conducts up to two generated-library
 * LAYERS for the scene the reader is in — an ambience bed (almost always) and,
 * when a scene earns it, a MUSIC bed layered on top — each REUSED from the
 * library when it fits, crossfading as scenes change, volumes set by the mixer
 * (voice-ducked, hierarchy: music over ambience). A one-tap offer generates a
 * missing layer (opt-in), and a small panel lets you mute or re-roll each layer.
 */
export const SceneSoundscape = () => {
  const enabled = useAppStore(s => s.ambientEnabled && s.audioCuesEnabled);
  const liveGen = useAppStore(s => s.audioLiveGen);
  const musicOn = useAppStore(s => s.sceneMusic);
  const base = useAppStore(s => s.audioBaseUrl);
  const ambVol = useAppStore(s => s.ambientVolume);
  const musVol = useAppStore(s => s.musicVolume);
  const screen = useAppStore(s => s.screen);
  const storyId = useAppStore(s => s.currentStory?.id);
  const setActive = useAppStore(s => s.setLibrarySoundscapeActive);
  const recentSfx = useAppStore(s => s.recentSfx);
  const midLoc = useAppStore(s => s.midSceneLocation);
  const { active: scene, activeId } = useScenes();
  const tick = useMixerTick();

  const on = enabled && screen === 'reader' && !!storyId && !!scene;
  const tension = scene ? tensionAt(scene, activeId) : 0;
  // A mid-message move (bridging) wins over the enriched scene location, so the
  // bed switches the moment the reader crosses a threshold.
  const effLocation = midLoc || scene?.location;
  const ambIntent = on ? sceneSoundscapeIntent(scene!.mood, effLocation) : null;
  const musIntent = on && musicOn ? sceneMusicIntent(scene!.mood, effLocation, tension) : null;
  // Identity of the current soundscape — re-resolve only when it changes.
  const sig = on ? `${storyId}|${ambIntent?.prompt ?? ''}|${musIntent?.prompt ?? ''}` : '';

  const [amb, setAmb] = useState<AudioAsset | null>(null);
  const [mus, setMus] = useState<AudioAsset | null>(null);
  const [offer, setOffer] = useState<{ layer: Layer; intent: SoundscapeIntent; label: string } | null>(null);
  const [busy, setBusy] = useState<Layer | null>(null);
  const [guided, setGuided] = useState<{ layer: Layer; text: string } | null>(null);

  const ambPlayer = useRef<CrossfadePlayer | null>(null);
  const musPlayer = useRef<CrossfadePlayer | null>(null);
  // Music blends slowly (a hard cut is jarring); ambience a touch quicker.
  if (!ambPlayer.current) ambPlayer.current = new CrossfadePlayer(3000);
  if (!musPlayer.current) musPlayer.current = new CrossfadePlayer(6000);
  const muted = useRef<Set<string>>(new Set());   // "sig|layer" the reader X'd out
  const dismissed = useRef<Set<string>>(new Set()); // "sig|layer" offers declined
  const token = useRef(0);

  const label = effLocation || scene?.mood || 'this scene';
  // Proximity: an enclosed room muffles the din; an open tavern is full. Ambience
  // takes it fully; music (non-diegetic score) only lightly.
  const loud = locationLoudness(effLocation);
  const ceil = (layer: Layer, asset: AudioAsset | null): number =>
    !asset ? 0 : layer === 'ambience'
      ? audioMixer.volumeFor('ambience', ambVol, tensionVolume(1, tension) * loud)
      : audioMixer.volumeFor('music', musVol, (0.6 + tension * 0.4) * (0.75 + 0.25 * loud));

  // Resume both layers on first user gesture (autoplay policy).
  useEffect(() => {
    const resume = () => { ambPlayer.current?.resume(); musPlayer.current?.resume(); };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => { window.removeEventListener('pointerdown', resume); window.removeEventListener('keydown', resume); };
  }, []);

  // Resolve both layers for the current scene: reuse-first, else offer (opt-in).
  useEffect(() => {
    const t = ++token.current;
    if (!on) { setAmb(null); setMus(null); setOffer(null); return; }
    let cancelled = false;
    (async () => {
      if (!(await audioServiceUp(base))) { if (!cancelled) { setAmb(null); setMus(null); setOffer(null); } return; }
      const resolve = async (intent: SoundscapeIntent | null, layer: Layer): Promise<AudioAsset | null> => {
        if (!intent || muted.current.has(`${sig}|${layer}`)) return null;
        const hits = await searchAudioLibrary(base, { q: intent.prompt, category: layer, tags: intent.tags });
        return pickBestMatch(hits, intent.prompt, intent.tags);
      };
      const [a, m] = await Promise.all([resolve(ambIntent, 'ambience'), resolve(musIntent, 'music')]);
      if (cancelled || t !== token.current) return;
      setAmb(a); setMus(m);
      // Offer the highest-value MISSING layer (ambience first) when live-gen is on.
      const missing: { layer: Layer; intent: SoundscapeIntent } | null =
        !a && ambIntent && !muted.current.has(`${sig}|ambience`) ? { layer: 'ambience', intent: ambIntent }
          : !m && musIntent && !muted.current.has(`${sig}|music`) ? { layer: 'music', intent: musIntent }
            : null;
      setOffer(liveGen && missing && !dismissed.current.has(`${sig}|${missing.layer}`)
        ? { ...missing, label } : null);
    })();
    return () => { cancelled = true; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play / crossfade each layer as its bed changes; the library ambience bed
  // makes the procedural ambient stand down (only when we actually have one).
  useEffect(() => { ambPlayer.current!.setCeiling(ceil('ambience', amb)); ambPlayer.current!.play(amb ? audioAssetUrl(base, amb.id) : null); setActive(!!amb); }, [amb]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { musPlayer.current!.setCeiling(ceil('music', mus)); musPlayer.current!.play(mus ? audioAssetUrl(base, mus.id) : null); }, [mus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live ceiling updates: volume sliders, scene tension, and the mixer duck.
  useEffect(() => {
    ambPlayer.current!.setCeiling(ceil('ambience', amb));
    musPlayer.current!.setCeiling(ceil('music', mus));
  }, [ambVol, musVol, tension, tick, amb, mus, loud]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    ambPlayer.current?.dispose(); musPlayer.current?.dispose(); setActive(false);
  }, [setActive]);

  const set = (layer: Layer, asset: AudioAsset | null) => (layer === 'ambience' ? setAmb : setMus)(asset);

  const generate = async (layer: Layer, prompt: string, tags: string[], variant?: number) => {
    setBusy(layer); setOffer(null); setGuided(null);
    try {
      const asset = await generateAudio(base, { prompt, category: layer as AudioCategory, loop: true, tags, description: prompt, variant });
      set(layer, asset);
      muted.current.delete(`${sig}|${layer}`);
    } catch { /* leave as-is; the reader can retry */ }
    finally { setBusy(null); }
  };

  const stopLayer = (layer: Layer) => { muted.current.add(`${sig}|${layer}`); set(layer, null); };
  // Re-rolls pass a nonce so the SAME prompt still renders a fresh, distinct clip
  // (otherwise the deterministic asset id just returns the cached one).
  const retryQuick = (layer: Layer) => {
    const cur = layer === 'ambience' ? amb : mus;
    const intent = layer === 'ambience' ? ambIntent : musIntent;
    // Fall back to the CURRENT clip's prompt so a re-roll works even when the
    // scene no longer computes an intent (e.g. music that's still playing).
    const prompt = intent?.prompt ?? cur?.prompt;
    const tags = intent?.tags ?? cur?.tags ?? [];
    if (prompt) void generate(layer, prompt, tags, Date.now());
  };
  // Swap to a DIFFERENT clip already in the library — an instant switch that
  // doesn't wait on (or depend on) generation. CYCLES through the whole category
  // pool (stable order, wrapping) so pressing it repeatedly walks every clip, not
  // the same "best match" each time. Falls back to a fresh render only when the
  // library holds no alternative for this layer.
  const swap = async (layer: Layer) => {
    const cur = layer === 'ambience' ? amb : mus;
    setBusy(layer);
    let pool: AudioAsset[] = [];
    try { pool = await searchAudioLibrary(base, { category: layer }); }
    catch { /* ignore */ }
    finally { setBusy(null); }
    const sorted = [...pool].sort((a, b) => a.id.localeCompare(b.id));
    if (sorted.length > 1 && cur) {
      const i = sorted.findIndex(a => a.id === cur.id);
      const next = sorted[(i + 1 + sorted.length) % sorted.length];
      if (next && next.id !== cur.id) { muted.current.delete(`${sig}|${layer}`); set(layer, next); return; }
    }
    if (sorted.length && !cur) { muted.current.delete(`${sig}|${layer}`); set(layer, sorted[0]); return; }
    const intent = layer === 'ambience' ? ambIntent : musIntent; // nothing to cycle to → render one
    const q = intent?.prompt ?? cur?.prompt;
    if (q) void generate(layer, q, intent?.tags ?? cur?.tags ?? [], Date.now());
  };
  const openGuided = (layer: Layer) => {
    const cur = layer === 'ambience' ? amb : mus;
    const intent = layer === 'ambience' ? ambIntent : musIntent;
    setGuided({ layer, text: cur?.prompt ?? intent?.prompt ?? '' });
  };

  const rows: { layer: Layer; asset: AudioAsset | null; icon: ReactNode }[] = [
    { layer: 'ambience', asset: amb, icon: <Waves size={13} /> },
    { layer: 'music', asset: mus, icon: <Music2 size={13} /> },
  ].filter(r => r.asset || busy === r.layer) as any;

  const replaySfx = (id: string) => {
    try { const a = new Audio(audioAssetUrl(base, id)); a.volume = audioMixer.volumeFor('sfx'); void a.play().catch(() => {}); } catch { /* ignore */ }
  };

  const showPanel = rows.length > 0 || !!guided || recentSfx.length > 0;
  if (!offer && !showPanel) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col items-end gap-2 max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
      {showPanel && (
        <div className="rounded-xl border border-app-border bg-app-surface/95 backdrop-blur px-3 py-2 shadow-xl w-[min(300px,90vw)]">
          <div className="text-[10px] uppercase tracking-wide text-app-text/40 px-1 pb-1">Scene audio · {label}</div>
          {rows.map(({ layer, asset, icon }) => (
            <div key={layer} className="flex items-center gap-2 py-0.5">
              <span className="text-accent shrink-0">{icon}</span>
              <span className="text-xs text-app-text/80 truncate flex-1" title={asset?.id}>
                {busy === layer ? 'Generating…' : (asset?.prompt ?? layer)}
                {asset && !busy && <span className="text-app-text/30"> ·{asset.id.split('__').pop()?.slice(0, 4)}</span>}
              </span>
              <button type="button" title="Swap to another clip in the library" onClick={() => void swap(layer)} disabled={busy === layer}
                className="text-app-text/40 hover:text-app-text/90 disabled:opacity-40"><Shuffle size={13} /></button>
              <button type="button" title="Re-roll — render a fresh clip" onClick={() => retryQuick(layer)} disabled={busy === layer}
                className="text-app-text/40 hover:text-app-text/90 disabled:opacity-40">
                {busy === layer ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
              </button>
              <button type="button" title="Guided re-roll (edit prompt)" onClick={() => openGuided(layer)} disabled={busy === layer}
                className="text-app-text/40 hover:text-app-text/90 disabled:opacity-40"><Pencil size={13} /></button>
              <button type="button" title="Mute this layer for the scene" onClick={() => stopLayer(layer)}
                className="text-app-text/40 hover:text-app-text/90"><X size={14} /></button>
            </div>
          ))}
          {recentSfx.length > 0 && (
            <div className="mt-1 pt-1.5 border-t border-app-border/50">
              <div className="text-[10px] uppercase tracking-wide text-app-text/35 px-0.5 pb-0.5">Recent SFX</div>
              {recentSfx.map((s) => (
                <div key={s.at} className="flex items-center gap-2 py-0.5">
                  <Zap size={12} className="text-accent/80 shrink-0" />
                  <span className="text-[11px] text-app-text/70 truncate flex-1" title={s.label}>{s.label}</span>
                  <button type="button" title="Replay" onClick={() => replaySfx(s.id)}
                    className="text-app-text/40 hover:text-app-text/90"><RotateCw size={12} /></button>
                </div>
              ))}
            </div>
          )}
          {guided && (
            <form className="flex items-center gap-1.5 pt-1.5" onSubmit={(e) => { e.preventDefault(); const g = guided; setGuided(null); void generate(g.layer, g.text.trim() || (g.layer === 'ambience' ? ambIntent : musIntent)?.prompt || '', (g.layer === 'ambience' ? ambIntent : musIntent)?.tags ?? [], Date.now()); }}>
              <input autoFocus value={guided.text} onChange={(e) => setGuided({ ...guided, text: e.target.value })}
                placeholder={`Describe the ${guided.layer}…`}
                className="flex-1 text-xs bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50" />
              <button type="submit" className="text-accent hover:opacity-80" title="Generate"><Sparkles size={14} /></button>
              <button type="button" onClick={() => setGuided(null)} className="text-app-text/40 hover:text-app-text/80"><X size={14} /></button>
            </form>
          )}
        </div>
      )}

      {offer && (
        <div className="flex items-center gap-2.5 rounded-full border border-app-border bg-app-surface/95 backdrop-blur px-3.5 py-1.5 shadow-xl">
          {offer.layer === 'music' ? <Music2 size={15} className="text-accent shrink-0" /> : <Waves size={15} className="text-accent shrink-0" />}
          <span className="text-sm text-app-text/90">
            Add {offer.layer} for <span className="font-semibold">{offer.label}</span>?
          </span>
          <button type="button" disabled={busy === offer.layer}
            onClick={() => void generate(offer.layer, offer.intent.prompt, offer.intent.tags)}
            className={cn('flex items-center gap-1.5 text-sm font-medium rounded-full bg-accent/15 text-accent border border-accent/30 px-3 py-1 hover:bg-accent/25 disabled:opacity-60')}>
            {busy === offer.layer ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {busy === offer.layer ? 'Generating…' : 'Generate'}
          </button>
          <button type="button" title="Not now"
            onClick={() => { dismissed.current.add(`${sig}|${offer.layer}`); setOffer(null); }}
            className="text-app-text/40 hover:text-app-text/80"><X size={16} /></button>
        </div>
      )}
    </div>
  );
};
