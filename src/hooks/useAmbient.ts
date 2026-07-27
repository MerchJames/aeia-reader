import { useEffect, useReducer, useRef } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { AmbientController } from '../utils/ambient';
import { sceneAmbientSpec, tensionVolume } from '../utils/sceneMood';
import { useScenes } from './useScenes';
import { tensionAt } from '../utils/sceneSegment';
import { audioMixer } from '../utils/audioMixer';

/**
 * Loops an ambient bed while the reader is open. By default the bed is per
 * theme; when scene soundscapes are on, the bed follows the SCENE the reader is
 * in (its mood/location) so it holds across the span instead of flickering per
 * message, and the volume tracks tension along the scene's arc. A neutral or
 * bedless scene falls back to the theme bed. Works with no AI (heuristic scenes).
 */
export const useAmbient = () => {
  const enabled = useAppStore(s => s.ambientEnabled);
  const volume = useAppStore(s => s.ambientVolume);
  const themeSpec = useAppStore(s => s.ambientByTheme[s.theme] ?? '');
  const screen = useAppStore(s => s.screen);
  const soundscapes = useAppStore(s => s.sceneSoundscapes);
  const storyId = useAppStore(s => s.currentStory?.id);
  // When a generated-library bed is playing (Adaptive Soundscapes), the
  // procedural bed stands down so the two don't stack.
  const libActive = useAppStore(s => s.audioCuesEnabled && s.librarySoundscapeActive);
  const { active: scene, activeId } = useScenes();

  // A dramatic beat the Director marked in the message now streaming — fire a
  // one-shot sting as it opens (once per message).
  const streamingId = useAppStore(s => s.streamingMessage?.id);
  const hasBeat = useAuraV2Store(s => {
    const d = storyId && streamingId ? s.sceneByStory[storyId]?.[streamingId] : undefined;
    return !!d?.emphasis?.some(e => e.kind === 'beat');
  });

  // A scene with a bed drives the sound (mood/location) + volume (tension arc);
  // otherwise the per-theme bed at the plain volume.
  const sceneSpec = soundscapes && scene ? sceneAmbientSpec(scene.mood, scene.location) : '';
  // A live library bed owns the soundscape — silence the procedural one entirely.
  const spec = libActive ? '' : (sceneSpec || themeSpec);
  // Re-render when the mixer ducks (TTS speaking) so the bed drops out of the
  // way of the voice, then restores. Legacy loudness is preserved (only the
  // duck multiplier is applied — the new library beds carry the full hierarchy).
  const [, bumpDuck] = useReducer((x: number) => x + 1, 0);
  useEffect(() => audioMixer.subscribe(bumpDuck), []);
  const baseVol = sceneSpec ? tensionVolume(volume, tensionAt(scene!, activeId)) : volume;
  const effVolume = baseVol * audioMixer.duck('ambience');

  const ctlRef = useRef<AmbientController | null>(null);
  if (!ctlRef.current) ctlRef.current = new AmbientController();

  // Browsers block audio until the user interacts — resume on first gesture.
  useEffect(() => {
    const resume = () => ctlRef.current?.resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
  }, []);

  useEffect(() => {
    const ctl = ctlRef.current!;
    if (enabled && screen === 'reader' && spec) ctl.play(spec);
    else ctl.stop();
  }, [enabled, screen, spec]);

  useEffect(() => { ctlRef.current?.setVolume(effVolume); }, [effVolume]);

  useEffect(() => {
    if (enabled && soundscapes && screen === 'reader' && streamingId && hasBeat) {
      ctlRef.current?.sting();
    }
  }, [enabled, soundscapes, screen, streamingId, hasBeat]);

  useEffect(() => () => ctlRef.current?.dispose(), []);
};
