import React, { useEffect, useRef } from 'react';
import { SceneFxKind, specForFx, startLiving } from '../utils/livingBackground';

/**
 * Director-called particle weather (smoke, fog, sparkles, snow, ash, leaves,
 * fireflies…) rendered on a canvas overlay behind the words — in the reader,
 * the Stage scene and the VN scene alike. Asset-free: the same Canvas 2D engine
 * as the living backgrounds, denser and scoped to the scene.
 *
 * `level` (0..1) is how hard it's coming down; changing it restarts the field,
 * so callers should pass a quantized value rather than a continuously drifting
 * one. The caller gates on themeEffects; reduced-motion is honoured here.
 */
export const SceneFx = (
  { fx, level = 0.7, fixed = false }: { fx?: SceneFxKind; level?: number; fixed?: boolean },
) => {
  const ref = useRef<HTMLCanvasElement>(null);
  // Restart only on a meaningful change in strength, not on every re-render.
  const step = Math.round(Math.max(0.1, Math.min(1, level)) * 4) / 4;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !fx) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return startLiving(canvas, specForFx(fx, step));
  }, [fx, step]);

  if (!fx) return null;
  return (
    <canvas
      ref={ref}
      className={fixed ? 'scene-fx scene-fx-fixed' : 'scene-fx'}
      aria-hidden="true"
      data-fx={fx}
      data-fx-level={step}
    />
  );
};
