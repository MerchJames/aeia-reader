import { MOMENTARY_VFX, VfxKind } from '../utils/sceneVfx';

/**
 * Screen special-effect overlay (flash / glitch / vignette / desaturate /
 * bloom). One absolutely-positioned layer over the scene; the effect is a CSS
 * class. Momentary punches key off `beatKey` so they remount and replay on each
 * new beat; sustained washes hold. `shake` is NOT rendered here — it moves the
 * scene itself, so the view applies it as a root class. The caller gates on
 * themeEffects; reduced-motion is honored in CSS.
 */
export const SceneVfx = ({ kind, beatKey }: { kind?: VfxKind; beatKey: string }) => {
  if (!kind || kind === 'shake') return null;
  // Replay momentary effects per beat; hold sustained ones steady.
  const replayKey = MOMENTARY_VFX.has(kind) ? `${kind}:${beatKey}` : `${kind}:hold`;
  return (
    <div
      key={replayKey}
      className={`scene-vfx scene-vfx-${kind}`}
      aria-hidden="true"
      data-vfx={kind}
    />
  );
};
