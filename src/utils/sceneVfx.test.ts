import { deriveVfx, stickyWeather, emoteFor, MOMENTARY_VFX, SUSTAINED_VFX } from './sceneVfx';
import type { Scene } from './sceneSegment';
import type { SceneDescriptor } from '../types';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

// --- deriveVfx ------------------------------------------------------------
eq('director vfx wins', deriveVfx({ mood: 'tender', tension: 0.1, vfx: 'flash' }), 'flash');
eq('action peak → shake', deriveVfx({ mood: 'action', tension: 0.85 }), 'shake');
eq('action below gate → none', deriveVfx({ mood: 'action', tension: 0.5 }), undefined);
eq('ominous → vignette', deriveVfx({ mood: 'ominous', tension: 0.8 }), 'vignette');
eq('melancholy → desaturate', deriveVfx({ mood: 'melancholy', tension: 0.7 }), 'desaturate');
eq('awe → bloom', deriveVfx({ mood: 'awe', tension: 0.6 }), 'bloom');
eq('eerie → glitch', deriveVfx({ mood: 'eerie', tension: 0.65 }), 'glitch');
eq('calm neutral → none', deriveVfx({ mood: 'neutral', tension: 0.9 }), undefined);
eq('no descriptor → none', deriveVfx(undefined), undefined);

// momentary / sustained partition is complete and disjoint
eq('flash momentary', MOMENTARY_VFX.has('flash'), true);
eq('vignette sustained', SUSTAINED_VFX.has('vignette'), true);
eq('shake not sustained', SUSTAINED_VFX.has('shake'), false);

// --- stickyWeather --------------------------------------------------------
const scene = { messageIds: ['a', 'b', 'c', 'd'] } as Scene;
const d = (fx?: SceneDescriptor['fx']): SceneDescriptor =>
  ({ messageId: '', hash: '', mood: 'neutral', tension: 0, fx, createdAt: 0 });

// fog set at 'b' lingers on 'c' (no fx of its own).
eq('weather lingers within scene',
  stickyWeather(scene, 'c', { b: d('fog'), c: d() }), 'fog');
// the current beat's own fx wins over an earlier one.
eq('current fx wins',
  stickyWeather(scene, 'c', { a: d('rain'), c: d('snow') }), 'snow');
// nothing set anywhere → undefined.
eq('no weather → none', stickyWeather(scene, 'd', { a: d(), b: d() }), undefined);
// future fx (past the current beat) must not leak backward.
eq('future fx does not leak',
  stickyWeather(scene, 'b', { d: d('embers') }), undefined);
eq('no scene → none', stickyWeather(undefined, 'a', { a: d('fog') }), undefined);

// --- emoteFor -------------------------------------------------------------
eq('anger pops vein', emoteFor('furious'), '💢');
eq('fear pops sweat', emoteFor('terrified'), '💦');
eq('neutral no pop', emoteFor('calm'), null);

console.log(`\nsceneVfx: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
