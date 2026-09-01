import { AccentColor, AnimationStyle, FontFamily, StreamEffect, Theme } from './types';

/** Accent overrides. `''` keeps the theme's own accent. */
export const ACCENTS: { id: AccentColor; label: string; hex: string }[] = [
  { id: '', label: 'Theme', hex: '' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
  { id: 'magenta', label: 'Magenta', hex: '#d946ef' },
  { id: 'rose', label: 'Rose', hex: '#f43f5e' },
  { id: 'crimson', label: 'Crimson', hex: '#dc2626' },
  { id: 'amber', label: 'Amber', hex: '#f59e0b' },
  { id: 'gold', label: 'Gold', hex: '#d4a537' },
  { id: 'emerald', label: 'Emerald', hex: '#10b981' },
  { id: 'teal', label: 'Teal', hex: '#14b8a6' },
  { id: 'sky', label: 'Sky', hex: '#0ea5e9' },
];

export const accentHex = (accent: AccentColor): string =>
  ACCENTS.find(a => a.id === accent)?.hex ?? '';

export interface ThemeVars {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  bubbleAi: string;
  bubbleUser: string;
  bubbleUserText: string;
}

export interface ThemeDef {
  id: Theme;
  label: string;
  isDark: boolean;
  vars: ThemeVars;
  /** Force a font regardless of user setting (e.g. terminal). */
  font?: FontFamily;
  /** Tailwind max-width class for the reading column. */
  maxWidth?: string;
  /** Extra class applied to the app root (patterns, scanlines...). */
  rootClass?: string;
  /**
   * Signature reveal animation, applied while "Ambient theme effects" is
   * on (same precedent as the forced font). User's own pick otherwise.
   */
  animation?: AnimationStyle;
  /**
   * Signature PER-WORD arrival, same rule as `animation`.
   *
   * Separate because the two are different tracks: `animation` dresses the
   * block as it lands, this dresses each word as it is revealed. Calligraphy
   * needs the second one — a page that fades in is not being written.
   */
  streamEffect?: StreamEffect;
}

export const THEMES: Record<Theme, ThemeDef> = {
  light: {
    id: 'light', label: 'Light', isDark: false,
    vars: {
      bg: '#f8fafc', surface: '#ffffff', text: '#1e293b', muted: '#64748b',
      accent: '#3b82f6', border: 'rgba(15, 23, 42, 0.12)',
      bubbleAi: '#ffffff', bubbleUser: '#3b82f6', bubbleUserText: '#ffffff',
    },
  },
  dark: {
    id: 'dark', label: 'Dark', isDark: true,
    vars: {
      bg: '#0f172a', surface: '#1e293b', text: '#e2e8f0', muted: '#94a3b8',
      accent: '#60a5fa', border: 'rgba(226, 232, 240, 0.12)',
      bubbleAi: '#1e293b', bubbleUser: '#2563eb', bubbleUserText: '#ffffff',
    },
  },
  sepia: {
    id: 'sepia', label: 'Sepia', isDark: false,
    vars: {
      bg: '#f4ecd8', surface: '#efe4cb', text: '#5b4636', muted: '#8a715c',
      accent: '#a0622d', border: 'rgba(91, 70, 54, 0.18)',
      bubbleAi: '#eadfc6', bubbleUser: '#a0622d', bubbleUserText: '#f8f1e2',
    },
  },
  notebook: {
    id: 'notebook', label: 'Notebook', isDark: false,
    font: 'handwriting',
    rootClass: 'theme-notebook',
    vars: {
      bg: '#f9f5eb', surface: '#f3edda', text: '#2a2a2a', muted: '#6b6455',
      accent: '#b4552d', border: 'rgba(42, 42, 42, 0.15)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#2a2a2a',
    },
  },
  terminal: {
    id: 'terminal', label: 'Terminal (CRT)', isDark: true,
    font: 'mono',
    rootClass: 'theme-crt',
    animation: 'decrypt',
    vars: {
      bg: '#000700', surface: '#0a1a0a', text: '#22c55e', muted: '#15803d',
      accent: '#4ade80', border: 'rgba(34, 197, 94, 0.35)',
      bubbleAi: '#050f05', bubbleUser: '#0c2912', bubbleUserText: '#4ade80',
    },
  },
  book: {
    id: 'book', label: 'Classic Book', isDark: false,
    font: 'serif',
    maxWidth: 'max-w-[65ch]',
    rootClass: 'theme-book',
    vars: {
      bg: '#fbf7ef', surface: '#f5efe2', text: '#3f3a33', muted: '#7d7566',
      accent: '#8c5b2f', border: 'rgba(63, 58, 51, 0.15)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#3f3a33',
    },
  },
  phone: {
    id: 'phone', label: 'Phone Chat', isDark: false,
    maxWidth: 'max-w-md',
    vars: {
      bg: '#e9edf2', surface: '#ffffff', text: '#111827', muted: '#6b7280',
      accent: '#3b82f6', border: 'rgba(17, 24, 39, 0.1)',
      bubbleAi: '#ffffff', bubbleUser: '#3b82f6', bubbleUserText: '#ffffff',
    },
  },
  essay: {
    id: 'essay', label: 'College Essay', isDark: false,
    font: 'serif',
    maxWidth: 'max-w-[800px]',
    vars: {
      bg: '#fdfcf8', surface: '#f6f4ec', text: '#222222', muted: '#6f6b60',
      accent: '#1d4ed8', border: 'rgba(34, 34, 34, 0.12)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#222222',
    },
  },
  hacker: {
    id: 'hacker', label: 'Hacker', isDark: true,
    font: 'mono',
    maxWidth: 'max-w-[95%]',
    rootClass: 'theme-hacker',
    animation: 'decrypt',
    vars: {
      bg: '#010401', surface: '#03140a', text: '#00ff41', muted: '#0a8f36',
      accent: '#39ff6e', border: 'rgba(0, 255, 65, 0.3)',
      bubbleAi: '#020c05', bubbleUser: '#06240f', bubbleUserText: '#39ff6e',
    },
  },
  win98: {
    id: 'win98', label: 'Windows 98', isDark: false,
    rootClass: 'theme-win98',
    vars: {
      bg: '#008080', surface: '#c0c0c0', text: '#000000', muted: '#404040',
      accent: '#000080', border: '#808080',
      bubbleAi: '#c0c0c0', bubbleUser: '#000080', bubbleUserText: '#ffffff',
    },
  },
  vista: {
    id: 'vista', label: 'Aero Glass', isDark: true,
    rootClass: 'theme-vista',
    vars: {
      bg: '#0f2740', surface: 'rgba(255,255,255,0.10)', text: '#eaf4ff', muted: '#9fc3e6',
      accent: '#38b6ff', border: 'rgba(180, 220, 255, 0.35)',
      bubbleAi: 'rgba(255,255,255,0.12)', bubbleUser: 'rgba(56,182,255,0.35)', bubbleUserText: '#ffffff',
    },
  },
  parchment: {
    id: 'parchment', label: 'Fantasy Scroll', isDark: false,
    font: 'serif',
    maxWidth: 'max-w-[68ch]',
    rootClass: 'theme-parchment',
    animation: 'ink',
    vars: {
      bg: '#d9c39a', surface: '#ecdcb4', text: '#3a2a17', muted: '#7a6240',
      accent: '#7a3b1d', border: 'rgba(58, 42, 23, 0.28)',
      bubbleAi: 'rgba(255,250,235,0.55)', bubbleUser: 'rgba(122,59,29,0.18)', bubbleUserText: '#3a2a17',
    },
  },
  synthwave: {
    id: 'synthwave', label: 'Synthwave', isDark: true,
    rootClass: 'theme-synthwave',
    animation: 'glitch',
    vars: {
      bg: '#1a0b2e', surface: '#2a1147', text: '#fbe7ff', muted: '#c08be0',
      accent: '#ff2e97', border: 'rgba(255, 46, 151, 0.4)',
      bubbleAi: '#2a1147', bubbleUser: '#ff2e97', bubbleUserText: '#1a0b2e',
    },
  },
  amoled: {
    id: 'amoled', label: 'AMOLED Black', isDark: true,
    vars: {
      bg: '#000000', surface: '#0b0b0d', text: '#e6e6e8', muted: '#6b6b70',
      accent: '#22d3ee', border: 'rgba(255, 255, 255, 0.10)',
      bubbleAi: '#111114', bubbleUser: '#164e5a', bubbleUserText: '#e6feff',
    },
  },
  ocean: {
    id: 'ocean', label: 'Deep Ocean', isDark: true,
    vars: {
      bg: '#07243d', surface: '#0e3557', text: '#d8ecff', muted: '#7fabcf',
      accent: '#39c0ff', border: 'rgba(120, 190, 240, 0.2)',
      bubbleAi: '#0e3557', bubbleUser: '#1667a0', bubbleUserText: '#eaf6ff',
    },
  },
  forest: {
    id: 'forest', label: 'Forest', isDark: true,
    vars: {
      bg: '#132318', surface: '#1d3626', text: '#e0ecdd', muted: '#8fae8a',
      accent: '#86c06c', border: 'rgba(140, 190, 130, 0.2)',
      bubbleAi: '#1d3626', bubbleUser: '#3f6a44', bubbleUserText: '#f1f8ec',
    },
  },
  sakura: {
    id: 'sakura', label: 'Sakura', isDark: false,
    font: 'serif',
    rootClass: 'theme-sakura',
    animation: 'rise',
    vars: {
      bg: '#fff0f5', surface: '#ffe1ec', text: '#5a2c3d', muted: '#a3697f',
      accent: '#e0669a', border: 'rgba(90, 44, 61, 0.15)',
      bubbleAi: '#ffe1ec', bubbleUser: '#e0669a', bubbleUserText: '#fff5f9',
    },
  },
  comic: {
    id: 'comic', label: 'Comic Book', isDark: false,
    font: 'comic',
    rootClass: 'theme-comic',
    vars: {
      bg: '#fdf6e3', surface: '#ffffff', text: '#141414', muted: '#4a4a4a',
      accent: '#e5341f', border: '#141414',
      bubbleAi: '#ffffff', bubbleUser: '#ffd23f', bubbleUserText: '#141414',
    },
  },
  newspaper: {
    id: 'newspaper', label: 'Newspaper', isDark: false,
    font: 'serif',
    maxWidth: 'max-w-[800px]',
    rootClass: 'theme-newspaper',
    vars: {
      bg: '#eee9dd', surface: '#f7f3e9', text: '#181818', muted: '#5c574c',
      accent: '#1a1a1a', border: 'rgba(24, 24, 24, 0.25)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#181818',
    },
  },
  grimoire: {
    id: 'grimoire', label: 'Grimoire', isDark: true,
    font: 'serif',
    maxWidth: 'max-w-[68ch]',
    rootClass: 'theme-grimoire',
    animation: 'ink',
    vars: {
      bg: '#17110c', surface: '#241a11', text: '#e9d8b6', muted: '#a68a5f',
      accent: '#d4a537', border: 'rgba(212, 165, 55, 0.32)',
      bubbleAi: 'rgba(43, 31, 19, 0.7)', bubbleUser: 'rgba(122, 59, 29, 0.35)', bubbleUserText: '#f3e6c8',
    },
  },
  cyberpunk: {
    id: 'cyberpunk', label: 'Cyberpunk', isDark: true,
    font: 'mono',
    rootClass: 'theme-cyberpunk',
    animation: 'glitch',
    vars: {
      bg: '#050014', surface: '#0d0524', text: '#e6f7ff', muted: '#7a6bb0',
      accent: '#00e5ff', border: 'rgba(0, 229, 255, 0.4)',
      bubbleAi: '#0d0524', bubbleUser: 'rgba(255, 0, 128, 0.25)', bubbleUserText: '#ffe3f3',
    },
  },
  eink: {
    id: 'eink', label: 'E-Ink', isDark: false,
    font: 'serif',
    maxWidth: 'max-w-[64ch]',
    rootClass: 'theme-eink',
    vars: {
      bg: '#ececea', surface: '#f4f4f2', text: '#1b1b1b', muted: '#5c5c5c',
      accent: '#2b2b2b', border: 'rgba(0, 0, 0, 0.28)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#1b1b1b',
    },
  },
  gameboy: {
    id: 'gameboy', label: 'Game Boy', isDark: false,
    font: 'mono',
    maxWidth: 'max-w-2xl',
    rootClass: 'theme-gameboy',
    vars: {
      bg: '#9bbc0f', surface: '#8bac0f', text: '#0f380f', muted: '#306230',
      accent: '#0f380f', border: '#0f380f',
      bubbleAi: '#8bac0f', bubbleUser: '#306230', bubbleUserText: '#e0f8d0',
    },
  },
  starlight: {
    id: 'starlight', label: 'Starlight', isDark: true,
    rootClass: 'theme-starlight',
    animation: 'blur',
    vars: {
      bg: '#05060f', surface: '#0d1024', text: '#e8ecff', muted: '#8b93c4',
      accent: '#9d7bff', border: 'rgba(157, 123, 255, 0.28)',
      bubbleAi: '#0d1024', bubbleUser: '#2a2166', bubbleUserText: '#eef0ff',
    },
  },
  manga: {
    id: 'manga', label: 'Manga', isDark: false,
    maxWidth: 'max-w-2xl',
    rootClass: 'theme-manga',
    vars: {
      bg: '#ffffff', surface: '#ffffff', text: '#0a0a0a', muted: '#555555',
      accent: '#0a0a0a', border: '#0a0a0a',
      bubbleAi: '#ffffff', bubbleUser: '#0a0a0a', bubbleUserText: '#ffffff',
    },
  },
  noir: {
    id: 'noir', label: 'Film Noir', isDark: true,
    font: 'typewriter',
    maxWidth: 'max-w-[68ch]',
    rootClass: 'theme-noir',
    animation: 'typewriter',
    vars: {
      bg: '#101010', surface: '#1a1a1a', text: '#d9d9d9', muted: '#8a8a8a',
      accent: '#e8e8e8', border: 'rgba(217, 217, 217, 0.22)',
      bubbleAi: '#171717', bubbleUser: '#262626', bubbleUserText: '#f0f0f0',
    },
  },
  cozy: {
    id: 'cozy', label: 'Cozy Hearth', isDark: true,
    font: 'serif',
    maxWidth: 'max-w-[66ch]',
    rootClass: 'theme-cozy',
    animation: 'ink',
    vars: {
      bg: '#231710', surface: '#2f2016', text: '#f2e2c9', muted: '#b3946f',
      accent: '#e8963e', border: 'rgba(232, 150, 62, 0.28)',
      bubbleAi: 'rgba(58, 40, 26, 0.75)', bubbleUser: 'rgba(232, 150, 62, 0.22)', bubbleUserText: '#f7ecd9',
    },
  },
  aurora: {
    id: 'aurora', label: 'Aurora', isDark: true,
    rootClass: 'theme-aurora',
    animation: 'blur',
    vars: {
      bg: '#040b18', surface: '#0a1526', text: '#dcebf5', muted: '#7f9cb4',
      accent: '#4ee6b8', border: 'rgba(78, 230, 184, 0.25)',
      bubbleAi: '#0a1526', bubbleUser: 'rgba(78, 230, 184, 0.18)', bubbleUserText: '#e7fff6',
    },
  },
  rpg: {
    id: 'rpg', label: 'RPG Quest', isDark: true,
    font: 'rounded',
    maxWidth: 'max-w-3xl',
    rootClass: 'theme-rpg',
    animation: 'typewriter',
    vars: {
      bg: '#0d1030', surface: '#151a45', text: '#eef1ff', muted: '#8d93c8',
      accent: '#ffd23f', border: '#3d478f',
      bubbleAi: 'rgba(10, 13, 40, 0.92)', bubbleUser: 'rgba(61, 71, 143, 0.55)',
      bubbleUserText: '#eef1ff',
    },
  },
  pixelchat: {
    id: 'pixelchat', label: 'Pixel Chat', isDark: true,
    font: 'mono',
    maxWidth: 'max-w-md',
    rootClass: 'theme-pixelchat',
    animation: 'typewriter',
    vars: {
      bg: '#101830', surface: '#1a2547', text: '#d9f3ee', muted: '#7fa8b8',
      accent: '#4de3c1', border: '#3a5a8c',
      bubbleAi: '#152242', bubbleUser: '#1c4a44', bubbleUserText: '#d9f3ee',
    },
  },
  pixelrpg: {
    id: 'pixelrpg', label: 'Pixel RPG', isDark: true,
    font: 'mono',
    maxWidth: 'max-w-3xl',
    rootClass: 'theme-pixelrpg',
    animation: 'typewriter',
    vars: {
      bg: '#060a26', surface: '#101b6b', text: '#f4f6ff', muted: '#96a2d8',
      accent: '#ffe9a8', border: '#c8d4f8',
      bubbleAi: '#1a2a8c', bubbleUser: '#233293', bubbleUserText: '#f4f6ff',
    },
  },
  snek: {
    id: 'snek', label: 'Snek Comms', isDark: true,
    font: 'mono',
    maxWidth: 'max-w-2xl',
    rootClass: 'theme-snek theme-crt',
    animation: 'typewriter',
    vars: {
      bg: '#020604', surface: '#06110b', text: '#9fd8a8', muted: '#5a8a63',
      accent: '#c4f0c9', border: '#2e5c38',
      bubbleAi: '#04100a', bubbleUser: '#0a1f12', bubbleUserText: '#c4f0c9',
    },
  },
  /**
   * Risograph — spot inks on cheap paper, printed one colour at a time.
   *
   * The look is entirely in the FAULTS: a riso lays each ink in a separate
   * pass, so colours never quite line up, the coverage is grainy, and where two
   * inks overlap you get a third that neither drum could print. Clean it up and
   * it stops being a riso and becomes flat design. So the misregistration is
   * the feature — see `.theme-riso` for the ghosted second pass.
   */
  riso: {
    id: 'riso', label: 'Risograph', isDark: false,
    font: 'sans',
    maxWidth: 'max-w-[64ch]',
    rootClass: 'theme-riso',
    animation: 'rise',
    vars: {
      bg: '#f2ede1', surface: '#faf6ec', text: '#22201d', muted: '#7c7466',
      accent: '#ff4a3d', border: 'rgba(34, 32, 29, 0.22)',
      bubbleAi: 'rgba(255, 255, 255, 0.72)',
      bubbleUser: 'rgba(0, 116, 178, 0.16)', bubbleUserText: '#12354d',
    },
  },
  /**
   * Foil — iridescent stamp on a dark card.
   *
   * Modelled on the thing a holographic trading card actually does: the sheen
   * is not painted ON the letters, it MOVES across them, because what your eye
   * reads as "foil" is a highlight that changes with the angle you hold it at.
   * A static rainbow gradient reads as a sticker; a travelling one reads as
   * metal.
   */
  foil: {
    id: 'foil', label: 'Foil', isDark: true,
    font: 'sans',
    maxWidth: 'max-w-[66ch]',
    rootClass: 'theme-foil',
    animation: 'blur',
    vars: {
      bg: '#0b0a12', surface: '#141322', text: '#eceafd', muted: '#9a95c4',
      accent: '#8be9ff', border: 'rgba(190, 170, 255, 0.28)',
      bubbleAi: 'rgba(30, 27, 52, 0.78)',
      bubbleUser: 'rgba(120, 90, 220, 0.30)', bubbleUserText: '#f4f1ff',
    },
  },
  /**
   * Vector — a phosphor tube drawing strokes, not pixels.
   *
   * Deliberately NOT the app's other CRT: `theme-crt` is a raster screen, so it
   * is made of scanlines. A vector display has none — the beam draws the line
   * itself, so everything glows from its own edges, corners burn brighter where
   * the beam turned, and the whole image swims very slightly. Same era,
   * opposite machine.
   */
  vector: {
    id: 'vector', label: 'Vector', isDark: true,
    font: 'mono',
    maxWidth: 'max-w-[70ch]',
    rootClass: 'theme-vector',
    animation: 'decrypt',
    vars: {
      bg: '#01060a', surface: 'rgba(6, 22, 28, 0.55)', text: '#7dfcd6', muted: '#2f9b86',
      accent: '#f7f36a', border: 'rgba(125, 252, 214, 0.42)',
      bubbleAi: 'transparent', bubbleUser: 'transparent', bubbleUserText: '#f7f36a',
    },
  },
  /**
   * Calligraphy — a page being written, not displayed.
   *
   * The font is only half of it. A script face that fades in reads as a fancy
   * font; the same face laid down stroke by stroke reads as a hand moving. So
   * this theme brings its own per-word arrival (`quill`), the same way Hacker
   * brings `decrypt` — and like every signature, it yields the moment the
   * reader picks their own.
   */
  calligraphy: {
    id: 'calligraphy', label: 'Calligraphy', isDark: false,
    font: 'calligraphy',
    maxWidth: 'max-w-[58ch]',
    rootClass: 'theme-calligraphy',
    animation: 'ink',
    streamEffect: 'quill',
    vars: {
      bg: '#f6f1e4', surface: '#fdfaf1', text: '#1f2436', muted: '#6f6a5c',
      accent: '#2f3d7a', border: 'rgba(47, 61, 122, 0.26)',
      bubbleAi: 'rgba(253, 250, 241, 0.86)',
      bubbleUser: 'rgba(47, 61, 122, 0.10)', bubbleUserText: '#1b2340',
    },
  },
  custom: {
    id: 'custom', label: 'Custom', isDark: true, // isDark recomputed from bg luminance
    vars: {
      bg: '#111827', surface: '#1f2937', text: '#ffffff', muted: '#9ca3af',
      accent: '#60a5fa', border: 'rgba(255, 255, 255, 0.15)',
      bubbleAi: '#1f2937', bubbleUser: '#2563eb', bubbleUserText: '#ffffff',
    },
  },
};

const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};

export const isColorDark = (hex: string): boolean => {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};

const mix = (hex: string, withHex: string, amount: number): string => {
  const a = hexToRgb(hex);
  const b = hexToRgb(withHex);
  if (!a || !b) return hex;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * amount));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
};

/** Resolve the active theme, deriving custom-theme vars from the user's colors. */
export const resolveTheme = (theme: Theme, bgColor: string, textColor: string): ThemeDef => {
  const def = THEMES[theme] ?? THEMES.dark;
  if (theme !== 'custom') return def;
  const dark = isColorDark(bgColor);
  const towards = dark ? '#ffffff' : '#000000';
  return {
    ...def,
    isDark: dark,
    vars: {
      bg: bgColor,
      surface: mix(bgColor, towards, 0.07),
      text: textColor,
      muted: mix(textColor, bgColor, 0.35),
      accent: mix(textColor, bgColor, 0.15),
      border: dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
      bubbleAi: mix(bgColor, towards, 0.08),
      bubbleUser: mix(bgColor, towards, 0.18),
      bubbleUserText: textColor,
    },
  };
};
