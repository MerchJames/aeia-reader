/**
 * Reading modes — one switch that means something.
 *
 * "Cinematic reading" was never a feature, it was a homework assignment: a
 * dozen independent toggles a reader had to assemble into a taste. Nobody
 * assembles a taste from parts; they try three switches, get an incoherent
 * result, and turn everything off.
 *
 * A ReadingMode is a named, opinionated bundle that WRITES those keys. It is a
 * view over the existing config, never a parallel state — one writer, no drift.
 * Every individual key still exists and is still reachable; it just stops being
 * the front door.
 *
 * The stored `readingMode` records the reader's last explicit CHOICE (intent).
 * Whether the config still matches it is derived (`modeMatches`), so touching an
 * advanced key surfaces as "Cinema · modified" rather than silently diverging or
 * silently snapping back.
 *
 * Pure: no store, no React.
 */

import { AppConfig } from '../types';

export type ReadingMode = 'plain' | 'lit' | 'cinema' | 'performance';

export const READING_MODES: readonly ReadingMode[] = ['plain', 'lit', 'cinema', 'performance'];

/**
 * The keys a mode owns. Deliberately narrow: this is "how much the app PERFORMS
 * the text", not general taste. Theme, font, colours, width, auto-format and the
 * AI endpoint are the reader's own and are never touched by a mode.
 *
 * Two near-misses left out on purpose. `themeEffects` and `animationStyle` are
 * theme IDENTITY, not performance — a Terminal theme without its scanlines is a
 * broken theme, not a plain read — so they sit with font and colour on the
 * reader's side of the line.
 */
export const MODE_KEYS = [
  'expressiveText', 'cinematicPacing', 'expressiveIntensity', 'sceneTheming',
  'sceneSoundscapes', 'sceneEmphasis', 'scenePerformance', 'emotionalTts',
  'livingBackground', 'streamEffect', 'dialogueAnimation', 'ttsEnabled',
] as const;

export type ModeKey = typeof MODE_KEYS[number];
export type ModeConfig = Pick<AppConfig, ModeKey>;

export interface ReadingModeDef {
  mode: ReadingMode;
  label: string;
  /** One line, reader-facing: what this mode actually does to the page. */
  hint: string;
  config: ModeConfig;
}

/**
 * The four modes, in increasing order of how much the app intervenes.
 *
 * Plain is the honest default for a first open: the story, set well, and
 * nothing else. Each step up adds one clearly-describable layer, so a reader who
 * dislikes the result knows which step to walk back.
 */
export const READING_MODE_DEFS: readonly ReadingModeDef[] = [
  {
    mode: 'plain',
    label: 'Plain',
    hint: 'Just the words, set well. No motion, no colour shifts, no sound.',
    config: {
      expressiveText: false,
      cinematicPacing: false,
      expressiveIntensity: 'subtle',
      sceneTheming: false,
      sceneSoundscapes: false,
      sceneEmphasis: false,
      scenePerformance: false,
      emotionalTts: false,
      livingBackground: false,
      streamEffect: 'none',
      dialogueAnimation: 'none',
      ttsEnabled: false,
    },
  },
  {
    mode: 'lit',
    label: 'Lit',
    hint: 'The page takes on the scene’s mood and light. Direction you feel, not notice.',
    config: {
      expressiveText: true,
      cinematicPacing: true,
      expressiveIntensity: 'subtle',
      sceneTheming: true,
      sceneSoundscapes: false,
      sceneEmphasis: false,
      scenePerformance: false,
      emotionalTts: false,
      livingBackground: false,
      streamEffect: 'none',
      dialogueAnimation: 'zoom',
      ttsEnabled: false,
    },
  },
  {
    mode: 'cinema',
    label: 'Cinema',
    hint: 'Adds weather, screen effects and an ambient bed that follow the scene.',
    config: {
      expressiveText: true,
      cinematicPacing: true,
      expressiveIntensity: 'expressive',
      sceneTheming: true,
      sceneSoundscapes: true,
      sceneEmphasis: false,
      scenePerformance: false,
      emotionalTts: true,
      livingBackground: true,
      streamEffect: 'fade',
      dialogueAnimation: 'zoom',
      ttsEnabled: false,
    },
  },
  {
    mode: 'performance',
    label: 'Performance',
    // Says outright that it will speak — a mode that starts talking unannounced
    // is a nasty surprise, and picking it is the reader's consent.
    hint: 'The full instrument: the reveal bends for emphasis, and the story reads aloud.',
    config: {
      expressiveText: true,
      cinematicPacing: true,
      expressiveIntensity: 'cinematic',
      sceneTheming: true,
      sceneSoundscapes: true,
      sceneEmphasis: true,
      scenePerformance: true,
      emotionalTts: true,
      livingBackground: true,
      streamEffect: 'fade',
      dialogueAnimation: 'zoom',
      ttsEnabled: true,
    },
  },
];

export const modeDef = (mode: ReadingMode): ReadingModeDef =>
  READING_MODE_DEFS.find(d => d.mode === mode) ?? READING_MODE_DEFS[0];

/** The config patch a mode applies. A fresh object every call — callers spread it. */
export const configForMode = (mode: ReadingMode): ModeConfig => ({ ...modeDef(mode).config });

/** Which of the mode's keys the current config disagrees on. */
export const modeDiff = (config: Partial<ModeConfig>, mode: ReadingMode): ModeKey[] => {
  const want = modeDef(mode).config;
  return MODE_KEYS.filter(k => config[k] !== undefined && config[k] !== want[k]);
};

/** Does the config still look exactly like the mode the reader chose? */
export const modeMatches = (config: Partial<ModeConfig>, mode: ReadingMode): boolean =>
  modeDiff(config, mode).length === 0;

/**
 * The mode an arbitrary config is closest to — fewest disagreeing keys, ties
 * going to the earlier (quieter) mode. Used once, at migration, so an existing
 * reader lands on a sensible label WITHOUT their config being rewritten.
 */
export const nearestMode = (config: Partial<ModeConfig>): ReadingMode => {
  let best: ReadingMode = READING_MODE_DEFS[0].mode;
  let bestScore = Infinity;
  for (const def of READING_MODE_DEFS) {
    const score = modeDiff(config, def.mode).length;
    if (score < bestScore) { bestScore = score; best = def.mode; }
  }
  return best;
};

/** Reader-facing label: "Cinema", or "Cinema · modified" once a key is touched. */
export const modeLabel = (config: Partial<ModeConfig>, mode: ReadingMode): string =>
  modeMatches(config, mode) ? modeDef(mode).label : `${modeDef(mode).label} · modified`;
