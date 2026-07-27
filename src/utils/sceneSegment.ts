/**
 * Scene segmentation — turns the reader's flat message stream into SCENES:
 * contiguous spans of passages that share a place, a time, and an emotional
 * weather. A scene has an arc (per-message tension) and an aggregate mood, so
 * the reading surface can hold a mood across the span and ease between scenes
 * instead of snapping mood-to-mood on every message.
 *
 * Everything here is pure and cheap. It works with ZERO AI: each passage gets a
 * fast lexical/punctuation read (`heuristicRead`). When the Scene Director has
 * enriched a passage, its descriptor wins and only refines what the heuristic
 * already produced — AI sharpens, it isn't required.
 */

import { Mood, SceneDescriptor } from '../types';

/** The minimal message shape the segmenter reads. */
export interface SceneInput {
  id: string;
  role: 'user' | 'ai';
  content: string;
  /** Chapter / Kobold page break — always starts a new scene. */
  startsChain?: boolean;
}

type TimeOfDay = NonNullable<SceneDescriptor['timeOfDay']>;

/** A contiguous run of passages sharing place / time / emotional weather. */
export interface Scene {
  id: string;
  index: number;
  messageIds: string[];
  startId: string;
  endId: string;
  mood: Mood;
  location?: string;
  timeOfDay?: TimeOfDay;
  /** Highest tension reached in the span (0..1). */
  peakTension: number;
  /** Tension per message id along the arc (0..1). */
  tensionById: Record<string, number>;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/* ------------------------------------------------------------------ */
/* Heuristic read — a scene's mood/tension with no AI at all.          */
/* ------------------------------------------------------------------ */

/** Baseline tension each mood carries, before punctuation/intensity nudges. */
const MOOD_TENSION: Record<Mood, number> = {
  action: 0.85, ominous: 0.8, tense: 0.7, eerie: 0.6,
  awe: 0.5, romantic: 0.5, joyful: 0.42, melancholy: 0.45, tender: 0.32, neutral: 0.3,
};

/** Lexical votes: a word family points at a mood. First-listed wins ties via tension. */
const MOOD_LEX: [RegExp, Mood][] = [
  [/\b(blood|scream|knife|blade|kill(?:ed|s)?|die|dead|corpse|terror|horror|dread|threat)\b/i, 'ominous'],
  [/\b(ran|run|chase|fight|struck|strike|dodge|explod|slam|burst|charg(?:e|ed)|leap|sprint|grab)\b/i, 'action'],
  [/\b(shadow|whisper|cold|empty|hollow|wrong|creak|flicker|unseen|silent|watch(?:ing|ed)?)\b/i, 'eerie'],
  [/\b(passion(?:ate)?|desire|longing|yearn(?:ed|ing)?|breathless|caress|lips|lover|entwin\w*|seduc\w*|press(?:ed)?\s+against|arch(?:ed)?\s+into|trembl\w*\s+with\s+(?:desire|want|need))\b/i, 'romantic'],
  [/\b(smile|smiled|laugh|warm|gentle|kiss|embrace|soft|tender|comfort|held|home)\b/i, 'tender'],
  [/\b(joy|delight|bright|cheer|celebrat|radiant|beam(?:ed|ing)?|grin|thrill)\b/i, 'joyful'],
  [/\b(tear|tears|wept|weep|sorrow|grief|lonely|mourn|ache|loss|sigh(?:ed)?)\b/i, 'melancholy'],
  [/\b(vast|endless|stars?|horizon|infinite|majestic|towering|sublime|ancient|cathedral)\b/i, 'awe'],
];

/** Time-of-day words, used both to set the field and to mark a time shift. */
const TIME_WORDS: [RegExp, TimeOfDay][] = [
  [/\b(dawn|sunrise|daybreak|first light)\b/i, 'dawn'],
  [/\b(dusk|sunset|twilight|nightfall)\b/i, 'dusk'],
  [/\b(midnight|moonlit|starlit|the dark of night|late that night)\b/i, 'night'],
  [/\b(noon|midday|the next morning|broad daylight|afternoon)\b/i, 'day'],
];

/**
 * A fast, assetless read of one passage — mood, tension (0..1) and time of day —
 * from word families and punctuation. Deliberately coarse; the Director refines.
 */
export const heuristicRead = (
  content: string,
): { mood: Mood; tension: number; timeOfDay?: TimeOfDay } => {
  const text = content || '';
  const words = text.split(/\s+/).filter(Boolean);
  const len = Math.max(1, words.length);
  const shouts = words.filter(w => w.length >= 3 && /[A-Z]{3,}/.test(w)).length;
  const bangs = (text.match(/[!?]/g) || []).length;
  const intensity = clamp01((bangs * 1.1 + shouts * 2.2) / Math.max(10, len * 0.35));

  let mood: Mood = 'neutral';
  let best = 0;
  for (const [re, mo] of MOOD_LEX) {
    const hits = text.match(new RegExp(re.source, 'gi'));
    const n = hits ? hits.length : 0;
    if (n > best || (n === best && n > 0 && MOOD_TENSION[mo] > MOOD_TENSION[mood])) {
      best = n; mood = mo;
    }
  }
  // Loud but not lexically distinct → read as tense.
  if (mood === 'neutral' && intensity > 0.5) mood = 'tense';

  const tension = clamp01(MOOD_TENSION[mood] * 0.55 + intensity * 0.6);
  let timeOfDay: TimeOfDay | undefined;
  for (const [re, t] of TIME_WORDS) if (re.test(text)) { timeOfDay = t; break; }
  return { mood, tension, timeOfDay };
};

/* ------------------------------------------------------------------ */
/* Boundaries                                                          */
/* ------------------------------------------------------------------ */

/** A standalone typographic break line (***  ---  * * *  ~~~ …). */
const BREAK_RE = /^\s*([*\-~_=•·]\s*){3,}$/m;
/** A passage that opens with an explicit time/place jump. */
const SHIFT_RE = /^[\s>*_"']*(later|hours? later|days? later|weeks? later|the next (?:morning|day|night|evening)|that (?:night|evening|morning|afternoon)|meanwhile|elsewhere|the following (?:day|morning)|moments later|soon after|by (?:dawn|nightfall|morning|then)|at (?:dawn|dusk|midnight|night|last)|back (?:at|in|home))\b/i;

/** Passages per scene before we force a break, so a marker-less run still splits. */
const MAX_SCENE_LEN = 14;

interface Read {
  mood: Mood;
  tension: number;
  location?: string;
  timeOfDay?: TimeOfDay;
  fromAI: boolean;
}

const readFor = (m: SceneInput, descriptors?: Record<string, SceneDescriptor>): Read => {
  const d = descriptors?.[m.id];
  if (d) {
    return {
      mood: d.mood,
      tension: clamp01(d.tension),
      location: d.location,
      timeOfDay: d.timeOfDay && d.timeOfDay !== 'unknown' ? d.timeOfDay : undefined,
      fromAI: true,
    };
  }
  const h = heuristicRead(m.content);
  return { ...h, location: undefined, fromAI: false };
};

/** Most-recent defined value of a field across the scene so far. */
const recent = <K extends 'location' | 'timeOfDay'>(
  reads: Read[], idxs: number[], key: K,
): Read[K] => {
  for (let j = idxs.length - 1; j >= 0; j--) {
    const v = reads[idxs[j]][key];
    if (v) return v;
  }
  return undefined;
};

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\b(the|a|an|of)\b/g, '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

const aggregate = (
  messages: SceneInput[], reads: Read[], idxs: number[], index: number,
): Scene => {
  // Mood by weighted vote (AI reads count double; user turns don't set mood).
  const votes = new Map<Mood, number>();
  for (const i of idxs) {
    const r = reads[i];
    if (messages[i].role === 'user' || r.mood === 'neutral') continue;
    votes.set(r.mood, (votes.get(r.mood) ?? 0) + (r.fromAI ? 2 : 1));
  }
  let mood: Mood = 'neutral';
  let best = 0;
  for (const [mo, n] of votes) {
    if (n > best || (n === best && MOOD_TENSION[mo] > MOOD_TENSION[mood])) { best = n; mood = mo; }
  }

  const tensionById: Record<string, number> = {};
  let peakTension = 0;
  let location: string | undefined;
  let timeOfDay: TimeOfDay | undefined;
  for (const i of idxs) {
    const r = reads[i];
    tensionById[messages[i].id] = r.tension;
    if (r.tension > peakTension) peakTension = r.tension;
    if (!location && r.location) location = r.location;
    if (!timeOfDay && r.timeOfDay) timeOfDay = r.timeOfDay;
  }

  return {
    id: `scene-${messages[idxs[0]].id}`,
    index,
    messageIds: idxs.map(i => messages[i].id),
    startId: messages[idxs[0]].id,
    endId: messages[idxs[idxs.length - 1]].id,
    mood,
    location,
    timeOfDay,
    peakTension,
    tensionById,
  };
};

/**
 * Segment a story's messages into scenes. A boundary opens at a chapter/page
 * break, a typographic break line, an explicit time/place shift, an AI-detected
 * change of location or time of day, or after MAX_SCENE_LEN passages.
 */
export const segmentScenes = (
  messages: SceneInput[],
  descriptors?: Record<string, SceneDescriptor>,
): Scene[] => {
  if (messages.length === 0) return [];
  const reads = messages.map(m => readFor(m, descriptors));

  const groups: number[][] = [];
  let cur: number[] = [0];

  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    const r = reads[i];
    const prevLoc = recent(reads, cur, 'location');
    const prevTime = recent(reads, cur, 'timeOfDay');

    const boundary =
      !!m.startsChain ||
      BREAK_RE.test(m.content) ||
      SHIFT_RE.test(m.content) ||
      (!!prevLoc && !!r.location && norm(prevLoc) !== norm(r.location)) ||
      (!!prevTime && !!r.timeOfDay && prevTime !== r.timeOfDay) ||
      cur.length >= MAX_SCENE_LEN;

    if (boundary) { groups.push(cur); cur = [i]; }
    else cur.push(i);
  }
  groups.push(cur);

  return groups.map((idxs, gi) => aggregate(messages, reads, idxs, gi));
};

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

/** Map every message id to the scene that contains it, for O(1) active lookup. */
export const indexScenes = (scenes: Scene[]): Record<string, Scene> => {
  const map: Record<string, Scene> = {};
  for (const s of scenes) for (const id of s.messageIds) map[id] = s;
  return map;
};

/** Tension at a specific message within a scene (falls back to the peak). */
export const tensionAt = (scene: Scene, messageId?: string): number =>
  (messageId && scene.tensionById[messageId] != null)
    ? scene.tensionById[messageId]
    : scene.peakTension;
