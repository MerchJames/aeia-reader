/**
 * Living background — a subtle, asset-free Canvas 2D particle field that makes a
 * theme feel alive (drifting motes, rising embers, falling petals, twinkling
 * stars, soft rain). Deliberately low-density and low-opacity: it's ambience
 * behind the reading column, never a distraction. Canvas 2D (not WebGL) so it
 * runs on almost anything; the caller gates it on the effects + reduced-motion
 * settings.
 */

export type LivingMode =
  | 'motes' | 'embers' | 'petals' | 'stars' | 'rain'
  | 'fog' | 'smoke' | 'sparkles' | 'snow'
  | 'leaves' | 'bubbles' | 'fireflies';

export interface LivingSpec {
  mode: LivingMode;
  /** Particle colour (hex). */
  color: string;
  /** Roughly how many particles (scaled a little by viewport area). */
  count: number;
  /** Base speed multiplier. */
  speed: number;
  /**
   * Constant horizontal drift (px/frame at dt=1) — the wind. Positive blows
   * right. This is what separates a snowfall from a blizzard, or still air
   * from sand driving across a dune.
   */
  wind?: number;
  /** Overall opacity scale (0..1+). Lets one kind read as faint or choking. */
  density?: number;
}

/** Pick a fitting ambience for a theme. Falls back to gentle motes in the accent. */
export const specForTheme = (themeId: string, isDark: boolean, accent: string): LivingSpec => {
  switch (themeId) {
    case 'sakura': return { mode: 'petals', color: '#f7a8c4', count: 34, speed: 1 };
    case 'forest': return { mode: 'motes', color: '#8fe3a2', count: 42, speed: 0.6 };
    case 'ocean': return { mode: 'embers', color: '#67e8d2', count: 30, speed: 0.5 };
    case 'synthwave': return { mode: 'stars', color: '#f0abfc', count: 90, speed: 1 };
    case 'rpg': return { mode: 'stars', color: '#ffd23f', count: 80, speed: 1.2 };
    case 'pixelrpg': return { mode: 'stars', color: '#c8d4f8', count: 85, speed: 1 };
    case 'pixelchat': return { mode: 'motes', color: '#4de3c1', count: 36, speed: 0.7 };
    case 'snek': return { mode: 'rain', color: '#2e5c38', count: 40, speed: 1.2 };
    case 'amoled':
    case 'dark': return { mode: 'stars', color: '#cbd5e1', count: 70, speed: 1 };
    case 'terminal':
    case 'hacker': return { mode: 'rain', color: '#4ade80', count: 55, speed: 2 };
    case 'parchment':
    case 'book':
    case 'sepia': return { mode: 'motes', color: '#bd925a', count: 32, speed: 0.5 };
    case 'vista':
    case 'ocean-2': return { mode: 'motes', color: accent || '#93c5fd', count: 40, speed: 0.6 };
    default: return { mode: 'motes', color: accent || '#94a3b8', count: isDark ? 56 : 34, speed: 0.6 };
  }
};

interface Particle {
  x: number; y: number; r: number; a: number; vx: number; vy: number; ph: number;
  /** Rotation + spin, for particles that tumble (leaves). */
  rot?: number; spin?: number;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const v = parseInt(n || '888888', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/**
 * Start the animation on a canvas; returns a stop() that cancels the loop and
 * detaches listeners. Safe to call repeatedly (each returns its own stopper).
 */
export const startLiving = (canvas: HTMLCanvasElement, spec: LivingSpec): (() => void) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const [cr, cg, cb] = hexToRgb(spec.color);
  const wind = spec.wind ?? 0;
  const dens = spec.density ?? 1;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0, raf = 0, last = performance.now();
  const ps: Particle[] = [];
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const spawn = (initial: boolean): Particle => {
    const base: Particle = { x: rnd(0, W), y: rnd(0, H), r: rnd(0.6, 2.2), a: rnd(0.15, 0.55), vx: 0, vy: 0, ph: rnd(0, Math.PI * 2) };
    if (spec.mode === 'embers') { base.vy = -rnd(0.15, 0.5) * spec.speed; base.vx = rnd(-0.1, 0.1); base.y = initial ? base.y : H + 8; }
    else if (spec.mode === 'fog' || spec.mode === 'smoke') {
      base.r = rnd(50, 130); base.a = rnd(0.03, 0.09);
      base.vx = rnd(0.05, 0.2) * spec.speed * (Math.random() < 0.5 ? -1 : 1);
      base.vy = spec.mode === 'smoke' ? -rnd(0.05, 0.16) * spec.speed : rnd(-0.02, 0.02);
      if (!initial) { base.x = base.vx > 0 ? -base.r : W + base.r; base.y = rnd(H * 0.2, H); }
    }
    else if (spec.mode === 'sparkles') { base.r = rnd(0.7, 1.9); base.a = rnd(0.35, 0.8); base.vy = -rnd(0.05, 0.2) * spec.speed; base.vx = rnd(-0.08, 0.08); }
    else if (spec.mode === 'snow') { base.vy = rnd(0.25, 0.75) * spec.speed; base.vx = rnd(-0.15, 0.15); base.r = rnd(1, 2.6); base.a = rnd(0.25, 0.7); base.y = initial ? base.y : -8; }
    else if (spec.mode === 'petals') { base.vy = rnd(0.25, 0.7) * spec.speed; base.vx = rnd(-0.25, 0.25); base.r = rnd(1.4, 3); base.y = initial ? base.y : -8; }
    else if (spec.mode === 'leaves') {
      // Heavier than a petal: falls faster, tumbles, and the wind carries it.
      base.vy = rnd(0.4, 1.1) * spec.speed; base.vx = rnd(-0.3, 0.3);
      base.r = rnd(2.4, 5); base.a = rnd(0.3, 0.7);
      base.rot = rnd(0, Math.PI * 2); base.spin = rnd(-0.06, 0.06);
      base.y = initial ? base.y : -10;
    }
    else if (spec.mode === 'bubbles') {
      base.vy = -rnd(0.3, 0.9) * spec.speed; base.vx = rnd(-0.06, 0.06);
      base.r = rnd(1.5, 6); base.a = rnd(0.18, 0.45);
      base.y = initial ? base.y : H + 10;
    }
    else if (spec.mode === 'fireflies') {
      base.vx = rnd(-0.22, 0.22) * spec.speed; base.vy = rnd(-0.16, 0.16) * spec.speed;
      base.r = rnd(1.2, 2.4); base.a = rnd(0.45, 0.95);
    }
    else if (spec.mode === 'rain') { base.vy = rnd(3, 6) * spec.speed; base.r = rnd(0.5, 1); base.a = rnd(0.1, 0.28); base.y = initial ? base.y : -12; }
    else if (spec.mode === 'stars') { base.vx = 0; base.vy = 0; base.r = rnd(0.5, 1.6); }
    else { base.vx = rnd(-0.15, 0.15) * spec.speed; base.vy = rnd(-0.12, 0.12) * spec.speed; } // motes
    return base;
  };

  const resize = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.round(spec.count * Math.min(1.6, Math.max(0.5, (W * H) / (1280 * 800))));
    ps.length = 0;
    for (let i = 0; i < target; i++) ps.push(spawn(true));
  };

  const frame = (t: number) => {
    const dt = Math.min(50, t - last) / 16.67;
    last = t;
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      if (spec.mode === 'stars') {
        p.ph += 0.02 * dt;
        const a = p.a * dens * (0.5 + 0.5 * Math.sin(p.ph));
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      p.ph += 0.03 * dt;
      const wobble = spec.mode === 'motes' || spec.mode === 'petals' || spec.mode === 'snow'
        || spec.mode === 'leaves' || spec.mode === 'bubbles' || spec.mode === 'fireflies';
      p.x += (p.vx + wind + (wobble ? Math.sin(p.ph) * 0.15 : 0)) * dt;
      p.y += p.vy * dt;
      if (p.spin != null) p.rot = (p.rot ?? 0) + p.spin * dt;
      // Recycle off-screen particles.
      if ((spec.mode === 'embers' || spec.mode === 'smoke' || spec.mode === 'sparkles' || spec.mode === 'bubbles') && p.y < -p.r - 8) Object.assign(p, spawn(false));
      else if ((spec.mode === 'petals' || spec.mode === 'rain' || spec.mode === 'snow' || spec.mode === 'leaves') && p.y > H + 12) Object.assign(p, spawn(false));
      else if ((spec.mode === 'fog' || spec.mode === 'smoke') && (p.x < -p.r * 1.5 || p.x > W + p.r * 1.5)) Object.assign(p, spawn(false));
      else if (spec.mode === 'motes' || spec.mode === 'fireflies') { if (p.x < -8) p.x = W + 8; if (p.x > W + 8) p.x = -8; if (p.y < -8) p.y = H + 8; if (p.y > H + 8) p.y = -8; }
      // Anything the wind can carry off the sides comes back on the far edge.
      if (wind !== 0 && (spec.mode === 'snow' || spec.mode === 'leaves' || spec.mode === 'rain' || spec.mode === 'petals')) {
        if (p.x < -12) p.x = W + 12;
        else if (p.x > W + 12) p.x = -12;
      }

      if (spec.mode === 'fog' || spec.mode === 'smoke') {
        const breathe = 0.75 + 0.25 * Math.sin(p.ph * 0.4);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${p.a * dens * breathe})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (spec.mode === 'sparkles') {
        const tw = Math.max(0, Math.sin(p.ph * 3));
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${p.a * dens * tw})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.7 + 0.5 * tw), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (spec.mode === 'fireflies') {
        // A slow, uneven pulse — a firefly breathes rather than twinkles, and
        // carries a soft halo so it reads as a light, not a dot.
        const glow = 0.25 + 0.75 * Math.max(0, Math.sin(p.ph * 0.9));
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${p.a * dens * glow})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,255,240,${p.a * dens * glow * 0.9})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.6, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (spec.mode === 'bubbles') {
        // Hollow ring + a highlight — reads as water, not as snow rising.
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${p.a * dens})`;
        ctx.lineWidth = Math.max(0.6, p.r * 0.18);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${p.a * dens * 0.5})`;
        ctx.beginPath(); ctx.arc(p.x - p.r * 0.32, p.y - p.r * 0.32, Math.max(0.4, p.r * 0.2), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (spec.mode === 'leaves') {
        // A tumbling blade: the ellipse thins as it turns edge-on, which is what
        // sells "falling leaf" over "falling dot".
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${p.a * dens})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r, Math.max(0.5, p.r * Math.abs(Math.cos(p.ph * 0.8)) * 0.55), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      const flick = spec.mode === 'embers' ? 0.6 + 0.4 * Math.sin(p.ph * 2) : 1;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${p.a * dens * flick})`;
      if (spec.mode === 'rain') {
        // The streak leans with the wind, so driving rain actually looks driven.
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = p.r;
        const len = 6 + p.vy;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (wind * len) / Math.max(1, p.vy), p.y + len);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    raf = requestAnimationFrame(frame);
  };

  resize();
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
};


/* ------------------------------------------------------------------ */
/* Director special FX — per-passage particle weather.                 */
/* ------------------------------------------------------------------ */

export const SCENE_FX = [
  'smoke', 'fog', 'stars', 'sparkles', 'rain', 'embers', 'snow', 'petals',
  'ash', 'dust', 'leaves', 'fireflies', 'bubbles', 'sand', 'steam', 'pollen',
] as const;
export type SceneFxKind = (typeof SCENE_FX)[number];

/** What each weather reads as, in one line — used by the Director prompt so the
 *  model picks by MEANING rather than guessing from a bare word list. */
export const FX_MEANING: Record<SceneFxKind, string> = {
  smoke: 'smoke rising — a fire, a forge, a burning building',
  fog: 'fog or mist hanging in the air',
  stars: 'a clear night sky',
  sparkles: 'magic, glitter, motes of light',
  rain: 'rain falling',
  embers: 'sparks or embers rising from a fire',
  snow: 'snow falling',
  petals: 'blossom or petals on the air',
  ash: 'ashfall — after a fire, a volcano, ruin',
  dust: 'dust in the air — an abandoned room, a dry road, disuse',
  leaves: 'leaves falling or blowing — autumn, a wooded place',
  fireflies: 'fireflies or drifting lights — a summer night, a marsh',
  bubbles: 'underwater, or bubbles rising through liquid',
  sand: 'blowing sand or grit — a desert, a dust storm',
  steam: 'steam — a bath, a spring, a kitchen, a vent',
  pollen: 'pollen or spores drifting — a meadow, a deep forest',
};

/**
 * Particle spec for a Director-called effect (denser than theme ambience).
 * `level` (0..1, default 0.7) is how HARD the weather is coming down — a light
 * drizzle and a downpour are the same kind at different levels, and the prose
 * almost always says which.
 */
export const specForFx = (fx: SceneFxKind, level = 0.7): LivingSpec => {
  const l = Math.max(0.1, Math.min(1, level));
  // Count and speed ride the level; density keeps a faint effect faint.
  // Weather the story actually calls for has to be SEEN — this is the scene's
  // own weather, not the theme's idle ambience, so it sits well above the
  // living-background densities.
  const s = (base: LivingSpec, windAt1 = 0): LivingSpec => ({
    ...base,
    count: Math.max(6, Math.round(base.count * (0.4 + l * 1.15))),
    speed: base.speed * (0.7 + l * 0.6),
    wind: windAt1 * l,
    density: 0.7 + l * 0.95,
  });
  switch (fx) {
    case 'smoke': return s({ mode: 'smoke', color: '#8d93a8', count: 20, speed: 1 }, 0.25);
    case 'fog': return s({ mode: 'fog', color: '#aeb6c4', count: 24, speed: 0.7 });
    case 'stars': return s({ mode: 'stars', color: '#dfe6ff', count: 140, speed: 1 });
    case 'sparkles': return s({ mode: 'sparkles', color: '#ffe9a8', count: 80, speed: 1 });
    case 'rain': return s({ mode: 'rain', color: '#9db8d8', count: 150, speed: 1.6 }, 1.1);
    case 'embers': return s({ mode: 'embers', color: '#ff9a4a', count: 70, speed: 1.1 }, 0.2);
    case 'snow': return s({ mode: 'snow', color: '#eef4ff', count: 120, speed: 0.9 }, 0.9);
    case 'petals': return s({ mode: 'petals', color: '#f7a8c4', count: 70, speed: 1 }, 0.35);
    case 'ash': return s({ mode: 'snow', color: '#9a958f', count: 100, speed: 0.5 }, 0.3);
    case 'dust': return s({ mode: 'motes', color: '#c3ac86', count: 70, speed: 0.35 }, 0.08);
    case 'leaves': return s({ mode: 'leaves', color: '#c87a3c', count: 52, speed: 1 }, 0.8);
    case 'fireflies': return s({ mode: 'fireflies', color: '#c8f06a', count: 34, speed: 0.5 });
    case 'bubbles': return s({ mode: 'bubbles', color: '#a9e4f2', count: 60, speed: 1 });
    case 'sand': return s({ mode: 'rain', color: '#d9bd8a', count: 150, speed: 0.9 }, 5.5);
    case 'steam': return s({ mode: 'smoke', color: '#e2e8ef', count: 22, speed: 1.3 }, 0.15);
    case 'pollen': return s({ mode: 'motes', color: '#f0dd8a', count: 60, speed: 0.4 }, 0.15);
  }
};
