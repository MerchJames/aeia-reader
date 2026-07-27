import { Mood, SceneDescriptor } from '../types';
import { bucketFor } from '../lib/spriteStorage';
import type { Scene } from './sceneSegment';
import type { SceneFxKind } from './livingBackground';

/**
 * Screen special effects — the compact, asset-free answer to Fablekin's
 * `vfx:trigger` post-processing layer. A charged beat gets a screen-level
 * punch or wash: a white FLASH on impact, a SHAKE on a jolt, a GLITCH for the
 * uncanny, a VIGNETTE closing in on dread, a DESATURATE draining to grey on
 * despair, a soft BLOOM on wonder. All rendered as one CSS overlay (or a shake
 * class on the scene root) — no Pixi, no WebGL, no assets.
 *
 * Pure module: the Director may name a `vfx`, but when it doesn't we derive one
 * heuristically from mood + tension so the effect works with the AI off. The
 * heuristic is deliberately conservative — only strong beats earn an effect.
 */

export type VfxKind = 'flash' | 'shake' | 'vignette' | 'desaturate' | 'glitch' | 'bloom';

export const VFX_KINDS: readonly VfxKind[] = [
  'flash', 'shake', 'vignette', 'desaturate', 'glitch', 'bloom',
];

/** Punches that fire once per beat (keyed so they replay), vs. held washes. */
export const MOMENTARY_VFX: ReadonlySet<VfxKind> = new Set(['flash', 'shake', 'glitch']);
export const SUSTAINED_VFX: ReadonlySet<VfxKind> = new Set(['vignette', 'desaturate', 'bloom']);

/** The heuristic effect a mood earns once it crosses its tension gate. */
const MOOD_VFX: Partial<Record<Mood, { kind: VfxKind; at: number }>> = {
  action: { kind: 'shake', at: 0.82 },
  tense: { kind: 'vignette', at: 0.8 },
  ominous: { kind: 'vignette', at: 0.72 },
  eerie: { kind: 'glitch', at: 0.6 },
  melancholy: { kind: 'desaturate', at: 0.62 },
  awe: { kind: 'bloom', at: 0.58 },
  joyful: { kind: 'bloom', at: 0.78 },
};

/**
 * Choose the screen effect for the current beat. The Director's explicit `vfx`
 * always wins; otherwise a strong-enough mood earns its signature wash/punch.
 * Returns undefined for calm beats — most beats get nothing, by design.
 */
export const deriveVfx = (
  descriptor?: Pick<SceneDescriptor, 'vfx' | 'mood' | 'tension'>,
): VfxKind | undefined => {
  if (descriptor?.vfx) return descriptor.vfx;
  const mood = descriptor?.mood;
  if (!mood) return undefined;
  const rule = MOOD_VFX[mood];
  return rule && (descriptor?.tension ?? 0) >= rule.at ? rule.kind : undefined;
};

/**
 * Sticky weather — Fablekin's `stickyUntil` idea, compacted. Particle weather
 * the Director names on one passage should LINGER over the following beats
 * (fog doesn't evaporate mid-conversation), but only within the same scene: a
 * new location starts clean. Walks the current scene's passages up to and
 * including the one on screen and returns the most recently named `fx`.
 */
export const stickyWeather = (
  scene: Scene | undefined,
  currentId: string | undefined,
  descriptors: Record<string, SceneDescriptor> | undefined,
): SceneFxKind | undefined => {
  if (!scene || !descriptors) return undefined;
  const ids = scene.messageIds;
  // Look only as far as the beat we're actually showing (don't leak future fx).
  const stop = currentId ? ids.indexOf(currentId) : ids.length - 1;
  const upto = stop === -1 ? ids.length - 1 : stop;
  for (let i = upto; i >= 0; i--) {
    const fx = descriptors[ids[i]]?.fx;
    if (fx) return fx;
  }
  return undefined;
};

/**
 * A classic VN emote pop — a tiny symbol that bursts over a sprite at a strong
 * emotion (anger vein, sweat of fear, shock mark). Asset-free (an emoji glyph).
 * Only the loud emotions pop; the quieter ones rely on the body animation.
 */
export const emoteFor = (emotion?: string): string | null => {
  switch (bucketFor(emotion)) {
    case 'anger': return '💢';
    case 'fear': return '💦';
    case 'shock': return '❗';
    default: return null;
  }
};
