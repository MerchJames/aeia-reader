/**
 * The RPG view's heads-up display — derived, never invented.
 *
 * An RPG HUD is a promise that the numbers on screen mean something. The
 * temptation in a reader is to fake it: give everyone 340/500 HP, invent a
 * level, roll a stat block, and it LOOKS like a game instantly. It is also a
 * lie about somebody's story, and this app's whole contract is that what you
 * see came from the text.
 *
 * So every panel here is fed by something the app genuinely knows:
 *
 * - **Party** — who is actually in this scene, from the Director's dialogue
 *   attribution and the passages around it.
 * - **Condition** — the scene's mood, said in the language a game would use.
 *   An interpretation of real data, not a number pulled from nowhere.
 * - **The gauge** — the Director's `tension`, which is already 0..1 and already
 *   drives the pacing. It is the one genuinely game-shaped number in the app.
 * - **Place and hour** — the Director's location and time-of-day reads.
 *
 * Where the Director has not read a passage, panels say so ("—") instead of
 * guessing. A HUD that invents when it does not know is a HUD nobody can trust
 * the rest of the time.
 *
 * Pure: no store, no React.
 */

import type { Message, Mood, SceneDescriptor } from '../types';

/**
 * What the HUD needs to know about the moment on screen.
 *
 * A structural type rather than `SceneDescriptor`, because the view assembles
 * it from two sources: the per-passage descriptor (who spoke, what was quoted)
 * and the scene SEGMENT that passage sits in (place, hour, mood — which carry
 * across a span, so the HUD does not blank out on the one paragraph the
 * Director happened not to name a location in).
 */
export interface HudScene {
  mood?: Mood;
  location?: string;
  timeOfDay?: SceneDescriptor['timeOfDay'];
  tension?: number;
  speaker?: { name: string; emotion: string };
  dialogue?: { text: string; speaker: string }[];
}

/** The mood the Director read, in the words a game would put on a status bar. */
export const CONDITION: Record<Mood, string> = {
  tense: 'On edge',
  tender: 'At ease',
  ominous: 'Dread',
  joyful: 'Elated',
  melancholy: 'Grieving',
  action: 'In danger',
  eerie: 'Unnerved',
  awe: 'Struck',
  romantic: 'Enthralled',
  neutral: 'Steady',
};

/**
 * A party member's condition.
 *
 * The speaker's own emotion wins where the Director attributed one, because a
 * scene can be tense while the person talking is delighted about it — and the
 * per-speaker read is the more specific fact.
 */
export const conditionFor = (mood?: Mood, emotion?: string): string => {
  const e = emotion?.trim();
  if (e) return e.charAt(0).toUpperCase() + e.slice(1).toLowerCase();
  return mood ? CONDITION[mood] ?? CONDITION.neutral : '—';
};

export interface PartyMember {
  name: string;
  /** They are the one talking right now. */
  speaking: boolean;
  /** This is the reader's own character. */
  you: boolean;
  condition: string;
  /**
   * How far back this person stands, 0 (front, speaking) upward.
   *
   * The scene reads as flat when everyone is the same size and brightness, and
   * as a stage the moment they are not. Depth is assigned by how recently
   * somebody spoke — which is the same thing a director does when they push in
   * on whoever has the line.
   */
  depth: number;
}

/** How many stand in the scene behind the window. Four is a party; more is a crowd. */
export const STAGE_SIZE = 3;

/** How many faces the party panel holds. Four is the genre's own answer. */
export const PARTY_SIZE = 4;
/** How far back "in this scene" reaches when nobody has spoken recently. */
export const PRESENCE_WINDOW = 6;

const clean = (s: string | undefined): string => (s ?? '').trim();

/**
 * Who is in this scene.
 *
 * Built from a WINDOW of recent passages rather than the current one alone: a
 * party that empties every time the narrator gets a paragraph is a party panel
 * that flickers, and flicker in a HUD reads as a bug even when the data is
 * right. Ordered by who spoke most recently, so the panel puts whoever is
 * carrying the scene at the top.
 */
export const partyFrom = (opts: {
  /** Recent passages, oldest first, ending with the one on screen. */
  recent: Pick<Message, 'name' | 'role'>[];
  /** What the Director knows about this moment, if it has read it. */
  scene?: HudScene;
  /** The reader's own name in this story. */
  userName?: string;
  /** The story's lead, so they hold their place even in a quiet stretch. */
  characterName?: string;
}): PartyMember[] => {
  const window = opts.recent.slice(-PRESENCE_WINDOW);
  const speakingNow = clean(window[window.length - 1]?.name);
  const emotionOf = clean(opts.scene?.speaker?.name) === speakingNow
    ? opts.scene?.speaker?.emotion
    : undefined;

  // Most recent first, deduped. Attributed dialogue counts as presence — a
  // character the narrator quotes is in the room even if they have no passage
  // of their own.
  const order: string[] = [];
  const push = (n: string) => {
    const name = clean(n);
    if (!name || order.some(o => o.toLowerCase() === name.toLowerCase())) return;
    order.push(name);
  };
  for (let i = window.length - 1; i >= 0; i--) push(window[i].name);
  for (const d of opts.scene?.dialogue ?? []) push(d.speaker);
  push(clean(opts.characterName));

  const you = clean(opts.userName);
  return order.slice(0, PARTY_SIZE).map((name, i) => {
    const isYou = !!you && name.toLowerCase() === you.toLowerCase();
    const speaking = name.toLowerCase() === speakingNow.toLowerCase();
    return {
      name,
      speaking,
      you: isYou,
      condition: conditionFor(opts.scene?.mood, speaking ? emotionOf : undefined),
      // `order` is already most-recent-first, so the index IS the depth: the
      // speaker is at the front and everyone else falls back behind them in the
      // order they last held the scene.
      depth: speaking ? 0 : Math.max(1, i),
    };
  });
};

/**
 * The tension gauge, as filled segments out of `segments`.
 *
 * Segmented rather than a smooth bar because that is what the genre does, and
 * because a segment count is honest about precision: the Director's tension is
 * a judgement to one decimal place, not a measurement, and eight blocks say so
 * where a pixel-perfect fill would imply otherwise.
 */
export const gauge = (tension: number | undefined, segments = 8): number => {
  if (typeof tension !== 'number' || Number.isNaN(tension)) return 0;
  return Math.max(0, Math.min(segments, Math.round(tension * segments)));
};

/** The hour, in the words a game would use. '' when the Director hasn't read it. */
export const hourOf = (scene?: HudScene): string => {
  const t = scene?.timeOfDay;
  if (!t || t === 'unknown') return '';
  return { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' }[t];
};

/** Where we are. Falls back to nothing rather than to a guess. */
export const placeOf = (scene?: HudScene, carried?: string): string =>
  clean(scene?.location) || clean(carried) || '';

/** "Chapter 3 · 12/40" — real position, in the shape a game would show it. */
export const progressLabel = (
  chapter: number, chapters: number, index: number, total: number,
): string => {
  const left = chapters > 1 ? `Chapter ${chapter}` : 'The story';
  return total > 0 ? `${left} · ${index}/${total}` : left;
};
