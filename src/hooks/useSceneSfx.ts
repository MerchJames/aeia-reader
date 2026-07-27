import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { plainTextForSpeech, processText } from '../utils/textProcessor';
import { planSfxAnchors, planVolumeCues, planTransition, SfxAnchor, VolumeCue } from '../utils/sfxPlanner';
import {
  searchAudioLibrary, generateAudio, audioAssetUrl, audioServiceUp, pickBestMatch, AudioAsset,
} from '../utils/audioLibrary';
import { audioMixer } from '../utils/audioMixer';

/**
 * Per-permissiveness generation policy (reuse is always unlimited; this only
 * bounds how many NEW clips we render for a message and how weak an anchor may
 * be to earn one). Immersive fills subtle scenes — footsteps, a creak — that
 * Light/Medium leave to the library. All still require live-gen to be on.
 */
const GEN_BY_LEVEL: Record<'light' | 'medium' | 'immersive', { minWeight: number; budget: number }> = {
  light: { minWeight: 4, budget: 1 },
  medium: { minWeight: 3, budget: 3 },
  immersive: { minWeight: 1, budget: 6 },
};

interface ReadySfx { anchor: string; asset: AudioAsset; weight: number }

/**
 * Anchor-triggered scene-audio EVENTS for normal reading, all fired as the
 * reveal reaches a verbatim anchor:
 *   • SFX one-shots (gated by permissiveness) — a crash, a scream;
 *   • VOLUME modulation (gated by Scene audio) — the story swells or hushes;
 *   • BRIDGING (gated by Scene audio) — a mid-message move fires a threshold
 *     sound and hands the soundscape a new location so the bed can switch.
 * SFX/thresholds are momentary and never ducked; modulation shapes the beds.
 */
export const useSceneSfx = () => {
  const audioOn = useAppStore(s => s.audioCuesEnabled);
  const level = useAppStore(s => s.sfxPermissiveness);
  const liveGen = useAppStore(s => s.audioLiveGen);
  const base = useAppStore(s => s.audioBaseUrl);
  const screen = useAppStore(s => s.screen);
  const messageId = useAppStore(s => s.streamingMessage?.id);
  const streamedText = useAppStore(s => s.streamedText);

  const sfx = useRef<ReadySfx[]>([]);
  const firedSfx = useRef<Set<string>>(new Set());
  const vol = useRef<VolumeCue[]>([]);
  const firedVol = useRef<Set<string>>(new Set());
  const transition = useRef<{ anchor: string; location: string | null; asset: AudioAsset | null } | null>(null);
  const firedTransition = useRef(false);
  const token = useRef(0);

  const reader = screen === 'reader';
  const sfxActive = audioOn && level !== 'off' && reader;
  const envActive = audioOn && reader; // volume + bridging

  // Plan + pre-resolve everything for the message that just began streaming.
  useEffect(() => {
    const t = ++token.current;
    sfx.current = []; vol.current = []; transition.current = null;
    firedSfx.current = new Set(); firedVol.current = new Set(); firedTransition.current = false;
    const app = useAppStore.getState();
    app.clearRecentSfx();
    app.setMidSceneLocation(null);
    audioMixer.resetModulation();
    if (!envActive || !messageId) return;

    const msg = app.streamingMessage;
    if (!msg) return;
    const storyId = app.currentStory?.id;
    const v2 = useAuraV2Store.getState();
    const content = resolveContent(msg, storyId ? v2.overridesByStory[storyId] : undefined, !!storyId && !!v2.lensOnByStory[storyId]);
    const plain = plainTextForSpeech(processText(content, {
      hideMetadata: app.hideMetadata, characterName: app.currentStory?.characterName,
      userName: app.currentStory?.userName, role: msg.role,
    }).processedText);

    // Volume + bridging are synchronous plans; SFX needs library resolution.
    vol.current = planVolumeCues(plain);
    const tr = planTransition(plain);
    const sfxPlan: SfxAnchor[] = sfxActive ? planSfxAnchors(plain, level) : [];

    let cancelled = false;
    (async () => {
      if (!(await audioServiceUp(base))) return;
      // Resolve the transition's threshold sound (a door), reuse-first.
      if (tr) {
        let asset: AudioAsset | null = null;
        const hits = await searchAudioLibrary(base, { q: 'a door opening and closing, a threshold', category: 'sfx', tags: ['door', 'threshold'] });
        asset = pickBestMatch(hits, 'door threshold', ['door']);
        if (!asset && liveGen) { try { asset = await generateAudio(base, { prompt: 'a wooden door opening then closing, a threshold crossing', category: 'sfx', loop: false, tags: ['door', 'threshold'] }); } catch { asset = null; } }
        if (!cancelled && t === token.current) transition.current = { anchor: tr.anchor, location: tr.location, asset };
      }
      // Resolve SFX clips.
      let generated = 0;
      const gen = GEN_BY_LEVEL[level as 'light' | 'medium' | 'immersive'] ?? GEN_BY_LEVEL.medium;
      const resolved: ReadySfx[] = [];
      for (const a of sfxPlan) {
        if (cancelled || t !== token.current) return;
        const hits = await searchAudioLibrary(base, { q: a.intent, category: 'sfx', tags: a.tags });
        let asset = pickBestMatch(hits, a.intent, a.tags);
        if (!asset && liveGen && a.weight >= gen.minWeight && generated < gen.budget) {
          try { asset = await generateAudio(base, { prompt: a.intent, category: 'sfx', loop: false, tags: a.tags, description: a.intent }); generated++; }
          catch { asset = null; }
        }
        if (asset) resolved.push({ anchor: a.anchor, asset, weight: a.weight });
      }
      // Reader-authored SFX marks (highlight → sound): explicit intent, so they
      // fire regardless of permissiveness and generate on a miss.
      const marks = storyId ? (useAuraV2Store.getState().sfxMarksByStory[storyId]?.[msg.id] ?? []) : [];
      for (const mk of marks) {
        if (cancelled || t !== token.current) return;
        const hits = await searchAudioLibrary(base, { q: mk.prompt, category: 'sfx' });
        let asset = pickBestMatch(hits, mk.prompt, []);
        if (!asset) { try { asset = await generateAudio(base, { prompt: mk.prompt, category: 'sfx', loop: false, description: mk.prompt }); } catch { asset = null; } }
        if (asset && mk.text) resolved.push({ anchor: mk.text, asset, weight: 5 });
      }
      if (!cancelled && t === token.current) sfx.current = resolved;
    })();
    return () => { cancelled = true; };
  }, [envActive, sfxActive, messageId, level, base, liveGen]);

  // Fire events as the reveal passes each anchor.
  useEffect(() => {
    if (!envActive) return;
    const hay = streamedText.toLowerCase();
    const played = (id: string, vol2: number) => {
      try { const a = new Audio(audioAssetUrl(base, id)); a.volume = vol2; void a.play().catch(() => {}); } catch { /* ignore */ }
    };

    // SFX one-shots.
    for (const r of sfx.current) {
      if (firedSfx.current.has(r.anchor) || !hay.includes(r.anchor.toLowerCase())) continue;
      firedSfx.current.add(r.anchor);
      played(r.asset.id, audioMixer.volumeFor('sfx', 1, 0.6 + r.weight * 0.08));
      useAppStore.getState().pushRecentSfx({ id: r.asset.id, label: r.asset.prompt || r.anchor });
    }

    // Volume modulation — ramp the environment toward the cue's target.
    for (const c of vol.current) {
      if (firedVol.current.has(c.anchor) || !hay.includes(c.anchor.toLowerCase())) continue;
      firedVol.current.add(c.anchor);
      audioMixer.rampModulation(c.target, c.dir === 'down' ? 1100 : 800);
    }

    // Bridging — a mid-message move: threshold sound + hand off the new location.
    const tr = transition.current;
    if (tr && !firedTransition.current && hay.includes(tr.anchor.toLowerCase())) {
      firedTransition.current = true;
      if (tr.asset) played(tr.asset.id, audioMixer.volumeFor('sfx', 1, 0.9));
      if (tr.location) useAppStore.getState().setMidSceneLocation(tr.location);
    }
  }, [streamedText, envActive, base]);
};
