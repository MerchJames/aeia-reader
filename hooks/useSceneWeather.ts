import { useMemo } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveWeather } from '../utils/sceneWeather';
import { deriveVfx, stickyWeather } from '../utils/sceneVfx';
import type { Scene } from '../utils/sceneSegment';

/**
 * Particle weather for the beat on screen — the Director's call, the prose
 * itself, or whatever the scene already established.
 *
 * Extracted because three views had worked this out for themselves, in three
 * copies of the same six lines, and two views had not: Book and Sandbox showed
 * no weather at all. So a scene that snowed in Storybook, on the Stage and in
 * the VN stopped snowing the moment the reader opened the book — with nothing
 * in the settings panel to explain why, because nothing had changed except
 * which of five renderers happened to have the lines.
 *
 * The three rules that make it read right, all of which came from one of those
 * copies and are now shared:
 *  - the Director's read wins, but prose that plainly says it is snowing snows
 *    whether or not the AI ever looked at the passage;
 *  - weather is STICKY across a scene, so fog does not blink out between beats;
 *  - `stickyWeather` never looks past the beat being shown, so a storm three
 *    messages ahead does not arrive early.
 */
export const useSceneWeather = (
  scene: Scene | undefined,
  msg: { id: string; content: string } | undefined,
) => {
  const on = useAppStore(s => s.sceneTheming && s.themeEffects);
  const storyId = useAppStore(s => s.currentStory?.id);
  const sceneByStory = useAuraV2Store(s => s.sceneByStory);

  return useMemo(() => {
    if (!on || !msg) return undefined;
    const byMsg = storyId ? sceneByStory[storyId] : undefined;
    return resolveWeather(byMsg?.[msg.id], msg.content, stickyWeather(scene, msg.id, byMsg));
  }, [on, storyId, sceneByStory, scene, msg?.id, msg?.content]);
};

/**
 * The screen effect for the beat on screen — the Director's `vfx`, else a punch
 * derived from mood and tension so it works with the AI off.
 *
 * Same story as the weather beside it, one layer up: this lived in Stage and VN
 * and NOWHERE else, so a flash on an impact or a desaturate over a grief beat
 * happened in two of five views. Read a story in Storybook and the Director's
 * screen effects were simply not a feature — which is why "the effects from
 * Scene Read don't show in Story and Chat" kept coming back after emphasis and
 * performance were both proven to reach them. They did; this did not.
 */
export const useSceneVfx = (
  scene: Scene | undefined,
  msgId: string | undefined,
) => {
  const on = useAppStore(s => s.themeEffects);
  const storyId = useAppStore(s => s.currentStory?.id);
  const sceneByStory = useAuraV2Store(s => s.sceneByStory);

  return useMemo(() => {
    if (!on || !msgId) return undefined;
    const d = storyId ? sceneByStory[storyId]?.[msgId] : undefined;
    // With no read of THIS passage, the scene's own mood and tension still
    // carry a punch — the same fallback Stage has always used.
    const source = d ?? (scene
      ? { mood: scene.mood, tension: scene.tensionById[msgId] ?? scene.peakTension }
      : undefined);
    return deriveVfx(source);
  }, [on, storyId, sceneByStory, scene, msgId]);
};
