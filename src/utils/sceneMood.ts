/**
 * Scene Director payoff mappings — pure lookups from a passage's descriptor to
 * an ambient bed (soundscapes, 5b) and to voice prosody (emotional TTS, 5c).
 * No assets: soundscapes reuse the synthesized builtin beds.
 */

import { AmbientSound, Mood, SceneDescriptor } from '../types';

type TimeOfDay = NonNullable<SceneDescriptor['timeOfDay']>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/* ---------------------------------------------------------------- */
/* 5b — soundscapes                                                  */
/* ---------------------------------------------------------------- */

/** Default bed per mood ('' = silence, e.g. bright/joyful scenes). */
const MOOD_AMBIENT: Record<Mood, AmbientSound | ''> = {
  tense: 'drone',
  ominous: 'drone',
  eerie: 'wind',
  melancholy: 'rain',
  tender: 'fire',
  joyful: '',
  action: 'wind',
  awe: 'waves',
  romantic: 'fire',
  neutral: '',
};

/** A concrete location wins over the mood default when it's recognizable. */
const LOCATION_AMBIENT: [RegExp, AmbientSound][] = [
  [/rain|storm|downpour|drizzle/i, 'rain'],
  [/sea|ocean|shore|beach|wave|tide|harbou?r/i, 'waves'],
  [/fire|hearth|camp|fireplace|flame|forge/i, 'fire'],
  [/wind|mountain|cliff|plain|desert|moor|field/i, 'wind'],
  [/cave|dungeon|void|abyss|deep|crypt|tomb|underground/i, 'drone'],
];

/** Ambient sound for a scene (location keywords override the mood default). */
export const moodToAmbient = (mood: Mood, location?: string): AmbientSound | '' => {
  if (location) {
    for (const [re, sound] of LOCATION_AMBIENT) if (re.test(location)) return sound;
  }
  return MOOD_AMBIENT[mood] ?? '';
};

/** AmbientController spec for a scene ('' = no bed). */
export const sceneAmbientSpec = (mood: Mood, location?: string): string => {
  const sound = moodToAmbient(mood, location);
  return sound ? `builtin:${sound}` : '';
};

/** Recognizable settings → a rich soundscape prompt + index tags. First match
 *  wins; drives the generated-library bed for a scene (Adaptive Soundscapes). */
const LOCATION_SOUNDSCAPE: [RegExp, string, string[]][] = [
  [/tavern|inn|alehouse|pub/i, 'a lively medieval tavern: low crowd murmur and chatter, clinking mugs, a warm crackling hearth', ['tavern', 'crowd', 'medieval']],
  [/market|bazaar|square|plaza/i, 'a bustling open-air market: overlapping voices, distant vendors, footsteps on stone', ['market', 'crowd']],
  [/forest|wood|grove|jungle/i, 'a deep forest at rest: rustling leaves, distant birdsong, a soft breeze through branches', ['forest', 'wind', 'birds']],
  [/sea|ocean|shore|beach|wave|tide|harbou?r|ship|deck/i, 'an ocean shore: rolling waves, wind over water, distant gulls', ['ocean', 'waves', 'wind']],
  [/rain|storm|downpour|drizzle/i, 'steady rainfall with rolling distant thunder and dripping water', ['rain', 'storm', 'thunder']],
  [/cave|dungeon|crypt|tomb|underground|mine/i, 'a cavernous underground space: a low ominous drone, dripping water, faint echoes', ['cave', 'dungeon', 'drone']],
  [/castle|keep|hall|throne|palace/i, 'a vast stone hall: a hollow reverberant tone, faint distant footsteps, a cold draught', ['castle', 'hall', 'reverb']],
  [/battle|war|siege|fight|clash/i, 'the distant din of battle: far-off clashes, shouts, and drums beneath the tension', ['battle', 'war', 'tense']],
  [/mountain|cliff|ridge|peak|gorge|crag/i, 'a high windswept mountain ridge: gusting wind, sparse and vast, a lonely openness', ['wind', 'mountain', 'eerie']],
  [/river|stream|creek|brook|falls/i, 'a flowing river: running water over stones, a gentle current, birds nearby', ['river', 'water']],
  [/camp|fire|hearth|fireplace|forge/i, 'a crackling campfire at night: popping embers, insects, a soft night wind', ['fire', 'camp', 'night']],
  [/city|town|street|alley/i, 'a medieval town: distant chatter, cart wheels on cobblestone, faint bells', ['city', 'crowd']],
];

/** Mood-only fallback soundscapes when no location is recognizable. */
const MOOD_SOUNDSCAPE: Partial<Record<Mood, [string, string[]]>> = {
  tense: ['a tense low drone with an uneasy pulse, air thick with suspense', ['tense', 'drone', 'ominous']],
  ominous: ['a dark ominous drone, distant and foreboding, dread hanging in the air', ['ominous', 'drone', 'eerie']],
  eerie: ['an eerie ambience: thin high wind, faint unsettling tones, hollow emptiness', ['eerie', 'wind', 'creepy']],
  melancholy: ['a soft melancholy bed: gentle rain and a distant, sorrowful hush', ['melancholy', 'rain', 'somber']],
  tender: ['a warm tender ambience: a soft crackling fire and quiet calm', ['tender', 'fire', 'calm']],
  awe: ['a vast awe-struck bed: slow swelling tones, wide and majestic, open air', ['awe', 'epic', 'strings']],
  action: ['driving tense energy: a pulsing low bed with restless momentum', ['action', 'tense']],
  romantic: ['a warm intimate ambience: a soft crackling hearth, a gentle hush, closeness', ['romantic', 'warm', 'intimate', 'fire']],
};

export interface SoundscapeIntent { prompt: string; tags: string[]; category: 'ambience' | 'music' }

/**
 * A generated-library soundscape prompt for a scene — a recognizable location
 * first, else a mood fallback. Null for a plain/neutral scene with no setting
 * (no bed rather than a generic one). Used by the reader to REUSE or, when
 * offered, generate a bed that sets the scene. Pure, AI-free.
 */
export const sceneSoundscapeIntent = (mood: Mood, location?: string): SoundscapeIntent | null => {
  if (location) {
    for (const [re, prompt, tags] of LOCATION_SOUNDSCAPE) {
      if (re.test(location)) return { prompt, tags, category: 'ambience' };
    }
  }
  const m = MOOD_SOUNDSCAPE[mood];
  return m ? { prompt: m[0], tags: m[1], category: 'ambience' } : null;
};

/**
 * How LOUD a place is, as a 0.4–1 factor — the proximity/enclosure of the
 * soundscape. Moving from a roaring tavern into a closed room drops the din;
 * a cellar or crypt is quieter still; open/crowded places are full. Applied to
 * the ambience bed (and lightly to music) so the level tracks where you are.
 */
const LOCATION_LOUDNESS: [RegExp, number][] = [
  [/tavern|inn|market|bazaar|festival|feast|battle|war|siege|crowd|square|plaza|city|street/i, 1],
  [/forest|jungle|ocean|sea|shore|mountain|ridge|cliff|river|field|plain|road|storm|camp/i, 0.9],
  [/hall|throne|courtyard|corridor|hallway|stair/i, 0.75],
  [/room|chamber|bedroom|study|office|kitchen|parlou?r|cabin|tent|carriage|behind (?:the|a) (?:closed )?door/i, 0.6],
  [/cellar|crypt|tomb|cave|dungeon|vault|closet|cell|library|temple|shrine|sanctuary|chapel/i, 0.55],
];

/** Loudness/proximity factor for a location (1 = full, quieter when enclosed). */
export const locationLoudness = (location?: string): number => {
  if (!location) return 0.85;
  for (const [re, level] of LOCATION_LOUDNESS) if (re.test(location)) return level;
  return 0.85;
};

/* ---- music: an optional layer OVER ambience, only when it's warranted ---- */

/** Locations that call for music even at low tension (a bard, a festival…). */
const LOCATION_MUSIC: [RegExp, string, string[]][] = [
  [/tavern|inn|festival|feast|bard|minstrel|dance|celebration/i, 'a lively medieval folk tune, lute and fiddle over a warm hand-drum, convivial', ['folk', 'medieval', 'lute', 'tavern']],
  [/temple|shrine|cathedral|ritual|sacred/i, 'a solemn sacred choral pad, low drone and distant voices, reverent', ['choir', 'sacred', 'ambient']],
];

/** Mood → underscore when a scene earns a score. */
const MOOD_MUSIC: Partial<Record<Mood, [string, string[]]>> = {
  awe: ['a soaring orchestral theme, swelling strings and horns, majestic and wide', ['epic', 'orchestral', 'strings']],
  action: ['a driving action score, urgent percussive strings and low brass, relentless', ['action', 'percussion', 'epic']],
  tense: ['a taut suspense underscore, ostinato strings and a low pulse, coiled', ['tense', 'strings', 'suspense']],
  ominous: ['a dark brooding score, deep drone and sparse dissonant strings, dread', ['ominous', 'dark', 'drone']],
  melancholy: ['a mournful solo cello and piano theme, slow and aching', ['melancholy', 'piano', 'cello']],
  tender: ['a warm intimate theme, soft piano and gentle strings, hopeful', ['tender', 'piano', 'warm']],
  romantic: ['a tender romantic theme, soft solo piano and warm strings, intimate and yearning', ['romantic', 'piano', 'strings', 'love']],
};

/**
 * Should this scene carry MUSIC (a layer over ambience), and if so, what? Music
 * is reserved for weight: a fitting location (a bard), an emotionally charged
 * mood (awe/action/…), high tension, or an explicit Director cue. Null = no
 * score for this scene (ambience only). `wantsScore` lets the Scene Director
 * force one on. Pure, AI-free heuristic otherwise.
 */
export const sceneMusicIntent = (
  mood: Mood, location: string | undefined, tension: number, wantsScore = false,
): SoundscapeIntent | null => {
  if (location) {
    for (const [re, prompt, tags] of LOCATION_MUSIC) {
      if (re.test(location)) return { prompt, tags, category: 'music' };
    }
  }
  const earns = wantsScore || tension >= 0.6 || mood === 'awe' || mood === 'action' || mood === 'romantic';
  if (!earns) return null;
  const m = MOOD_MUSIC[mood];
  if (m) return { prompt: m[0], tags: m[1], category: 'music' };
  // An unmapped mood that still earns a score: lean tense when the tension is
  // high, otherwise a subtle, understated cinematic bed.
  return tension >= 0.6
    ? { prompt: 'a tense cinematic underscore, low strings and a slow build', tags: ['tense', 'cinematic'], category: 'music' }
    : { prompt: 'a soft cinematic underscore, subtle sustained strings, understated', tags: ['cinematic', 'ambient'], category: 'music' };
};

/** Scale the user's base volume by tension (0.7×…1.3×). */
export const tensionVolume = (base: number, tension: number): number =>
  clamp(base * (0.7 + clamp(tension, 0, 1) * 0.6), 0, 1);

/* ---------------------------------------------------------------- */
/* 5d — visual atmosphere (assetless overlays)                       */
/* ---------------------------------------------------------------- */

/**
 * Everything the reading surface needs to dress a scene, computed from its
 * mood / tension / time of day. Pure numbers + flags — the component just maps
 * them to CSS. All effects are subtle and sit BEHIND the text (readability is
 * never traded for atmosphere) and vanish under the `no-effects` toggle.
 */
export interface Atmosphere {
  mood: Mood;
  /** Mood colour wash strength (0 = none, e.g. neutral). */
  washOpacity: number;
  /** Edge darkening — the room "closes in" on tense/ominous scenes (alpha 0..~0.6). */
  vignette: number;
  /** Time-of-day sky tint colour ('' = none). */
  lightColor: string;
  lightOpacity: number;
  /** Desaturating veil for melancholy (0..~0.2). */
  veil: number;
  /** Faint noise texture for eerie scenes. */
  grain: boolean;
}

/**
 * Mood → a legible UI accent, for the scene spine ticks and the recap's mood
 * journey. Brighter than the reading-surface wash (these are foreground marks).
 */
export const MOOD_COLOR: Record<Mood, string> = {
  tense: '#5b74a8', tender: '#b06b80', ominous: '#6b4e9a', joyful: '#c79a4a',
  melancholy: '#5a6a99', action: '#b5583e', eerie: '#4e8f6d', awe: '#3e97ab',
  romantic: '#d16a8f', neutral: '#8a8a8a',
};

/** Moods whose scenes darken at the edges; others stay open. */
const VIGNETTE_MOOD: Partial<Record<Mood, number>> = {
  ominous: 0.5, eerie: 0.4, tense: 0.34, action: 0.26, melancholy: 0.16,
};

/** Sky tint per time of day — warm at the day's ends, cool at night. */
const TIME_LIGHT: Record<TimeOfDay, { color: string; opacity: number }> = {
  dawn: { color: '#ffb27a', opacity: 0.15 },
  dusk: { color: '#ff8f57', opacity: 0.16 },
  night: { color: '#2b3566', opacity: 0.22 },
  day: { color: '', opacity: 0 },
  unknown: { color: '', opacity: 0 },
};

export const sceneAtmosphere = (
  mood: Mood, tension: number, timeOfDay?: TimeOfDay,
): Atmosphere => {
  const t = clamp(tension, 0, 1);
  const vigBase = VIGNETTE_MOOD[mood] ?? 0;
  const light = timeOfDay ? TIME_LIGHT[timeOfDay] : { color: '', opacity: 0 };
  return {
    mood,
    washOpacity: mood === 'neutral' ? 0 : clamp(0.14 + t * 0.26, 0, 0.45),
    vignette: vigBase ? clamp(vigBase * (0.55 + t * 0.7), 0, 0.62) : 0,
    lightColor: light.color,
    lightOpacity: light.opacity,
    veil: mood === 'melancholy' ? 0.16 : 0,
    grain: mood === 'eerie',
  };
};

/* ---------------------------------------------------------------- */
/* 5c — emotional TTS prosody                                        */
/* ---------------------------------------------------------------- */

export interface Prosody {
  /** Rate multiplier (×) applied on top of the base voice rate. */
  rate: number;
  /** Pitch multiplier (×) applied on top of the base voice pitch. */
  pitch: number;
}

/** Emotion → prosody nudges. Keys are lowercased single words. */
const EMOTION_PROSODY: Record<string, Prosody> = {
  afraid: { rate: 1.12, pitch: 1.12 }, fear: { rate: 1.12, pitch: 1.12 },
  scared: { rate: 1.12, pitch: 1.12 }, terrified: { rate: 1.18, pitch: 1.14 },
  angry: { rate: 1.1, pitch: 0.92 }, anger: { rate: 1.1, pitch: 0.92 }, furious: { rate: 1.16, pitch: 0.9 },
  sad: { rate: 0.9, pitch: 0.94 }, sorrow: { rate: 0.88, pitch: 0.93 }, grief: { rate: 0.85, pitch: 0.92 },
  happy: { rate: 1.06, pitch: 1.08 }, joy: { rate: 1.08, pitch: 1.1 }, joyful: { rate: 1.08, pitch: 1.1 },
  excited: { rate: 1.15, pitch: 1.12 },
  calm: { rate: 0.96, pitch: 1.0 }, tender: { rate: 0.94, pitch: 1.02 }, gentle: { rate: 0.94, pitch: 1.02 },
  tense: { rate: 1.05, pitch: 1.0 }, urgent: { rate: 1.15, pitch: 1.04 }, nervous: { rate: 1.1, pitch: 1.06 },
  awe: { rate: 0.92, pitch: 1.02 }, solemn: { rate: 0.9, pitch: 0.96 }, ominous: { rate: 0.92, pitch: 0.9 },
};

/**
 * Prosody for a spoken passage. A recognized emotion sets the base curve;
 * tension nudges rate/pitch up or down around neutral (0.5). Neutral input
 * returns {1, 1} so the voice is unchanged.
 */
export const emotionProsody = (emotion?: string, tension = 0.5): Prosody => {
  const base = emotion ? EMOTION_PROSODY[emotion.trim().toLowerCase()] : undefined;
  const t = (clamp(tension, 0, 1) - 0.5) * 0.12;
  return {
    rate: clamp((base?.rate ?? 1) + t, 0.6, 1.6),
    pitch: clamp((base?.pitch ?? 1) + t * 0.6, 0.6, 1.5),
  };
};
