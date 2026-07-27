/**
 * Anchor-triggered SFX — pick the moments in a passage that WANT a sound effect,
 * capped by a permissiveness budget so it never carpet-bombs a page. Same spirit
 * as the impact-word emphasis pass: scan for charged cues (a crash, a scream, a
 * fall), score them, keep the strongest within budget, and hand back verbatim
 * anchors the reader can fire a one-shot at as the words stream past.
 *
 * Pure and AI-free. The reader resolves each anchor to a library SFX clip
 * (reuse-first) and plays it when the reveal reaches the anchor.
 */

import { SfxLevel } from '../types';
export type { SfxLevel };

export interface SfxAnchor {
  /** Verbatim phrase from the text where the sound fires. */
  anchor: string;
  /** Concrete sound to render/reuse (the library prompt). */
  intent: string;
  tags: string[];
  /** 1..5 importance — higher = louder / more pivotal. */
  weight: number;
}

/** Cue vocabulary: a trigger, the sound it implies, how pivotal it is, and an
 *  optional `not` guard — a metaphor pattern (checked in a window around the
 *  match) that SUPPRESSES it, so "shattered her confidence" or "fell in love"
 *  never fire a sound. This is the fix for spurious, irrelevant effects. */
const CUES: { re: RegExp; intent: string; tags: string[]; weight: number; not?: RegExp }[] = [
  { re: /\b(explo(?:de|des|ded|ding|sion)|detonat\w*)\b/i, intent: 'a heavy explosion blast', tags: ['explosion', 'blast'], weight: 5, not: /explo\w*\s+of\s+(?:colou?r|emotion|anger|joy|rage|flavou?r|feeling|energy|life|activity|laughter)/i },
  { re: /\b(gunshot|gunfire|a shot rang out|fires?\s+(?:a|the|his|her)\s+(?:gun|pistol|rifle|musket)|pulls?\s+the\s+trigger)\b/i, intent: 'a sharp gunshot crack', tags: ['gunshot'], weight: 5 },
  { re: /\b(scream(?:s|ed|ing)?|shriek(?:s|ed|ing)?)\b/i, intent: 'a piercing scream', tags: ['scream', 'human'], weight: 4, not: /scream(?:s|ed|ing)?\s+(?:silently|inside|internally|in\s+(?:her|his|their)\s+(?:head|mind))/i },
  { re: /\b(roar(?:s|ed|ing)?)\b/i, intent: 'a monstrous roar', tags: ['roar', 'monster'], weight: 4 },
  { re: /\b(shatter(?:s|ed|ing)?|smash(?:es|ed|ing)?\s+(?:the|a|through|into)|glass\s+break\w*)\b/i, intent: 'glass shattering', tags: ['shatter', 'glass'], weight: 4, not: /shatter\w*\s+(?:her|his|their|the)?\s*(?:dream|hope|silence|confidence|illusion|peace|heart|resolve|calm|world|composure|expectation)/i },
  { re: /\b(crash(?:es|ed|ing)?|collaps(?:e|es|ed|ing))\b/i, intent: 'a loud crashing collapse', tags: ['crash'], weight: 4, not: /(?:crash\s+course|(?:crash|collaps)\w*\s+(?:from\s+exhaustion|with\s+laughter|into\s+(?:a|his|her|the|their|bed|sleep)\s*(?:chair|bed|seat|sofa|couch|arms|lap|sleep)?))/i },
  { re: /\b(fall(?:s|ing)?\s+into|fell\s+into|plunge[sd]?|plummet\w*|tumbl(?:e|es|ed)\s+(?:off|down))\b/i, intent: 'a body falling and impacting below', tags: ['fall', 'impact'], weight: 4, not: /(?:in\s+love|into\s+(?:step|line|place|silence|thought|despair|disrepair|ruin|disarray|darkness|shadow|a\s+(?:rhythm|routine|trance|habit))|plummet\w*\s+(?:temperature|stock|price|mood|spirit|confidence))/i },
  { re: /\b(thunder(?:s|ed|ing)?|thunderclap|lightning\s+(?:struck|cracked|split))\b/i, intent: 'a rolling thunderclap', tags: ['thunder', 'storm'], weight: 3, not: /thunder(?:ous|ed)?\s+(?:applause|approval)/i },
  { re: /\b(clang\w*|clank\w*|blades?\s+(?:ring|meet|clash|rang)|steel\s+(?:rang|met|clash)|swords?\s+(?:clash|meet|ring))\b/i, intent: 'blades clashing, ringing steel', tags: ['metal', 'clash', 'sword'], weight: 3 },
  { re: /\b(slam(?:s|med|ming)?\s+(?:the|a|shut|closed|his|her)|door\s+(?:bang|slam)\w*)\b/i, intent: 'a heavy door slam', tags: ['door', 'slam'], weight: 3 },
  { re: /\b(splash(?:es|ed|ing)?|dove\s+into|dived\s+into|plunged\s+into\s+the\s+(?:water|river|sea|lake))\b/i, intent: 'a heavy splash into water', tags: ['splash', 'water'], weight: 3 },
  { re: /\b(bells?\s+(?:ring|rang|toll|tolled|chim\w*)|tolled)\b/i, intent: 'a deep tolling bell', tags: ['bell'], weight: 2 },
  { re: /\b(knock(?:s|ed|ing)?\s+(?:on|at|against)|rap(?:s|ped)\s+(?:on|at)|pounding\s+on)\b/i, intent: 'a knock on a wooden door', tags: ['knock', 'door'], weight: 2 },
  { re: /\b(clatter(?:s|ed|ing)?|thud(?:s|ded|ding)?)\b/i, intent: 'a dull heavy thud', tags: ['thud', 'impact'], weight: 2 },
  { re: /\b(footsteps?|hoofbeats?|approaching\s+steps)\b/i, intent: 'approaching footsteps', tags: ['footsteps'], weight: 1 },
  { re: /\b(door\s+creak\w*|hinges?\s+(?:creak|groan)\w*|floorboards?\s+creak\w*)\b/i, intent: 'a slow wooden creak', tags: ['creak', 'wood'], weight: 1 },
];

/** How much text around a match to test the metaphor guard against. */
const GUARD_WINDOW = 40;

/** Budget per permissiveness: how many, and the minimum weight to qualify. */
const BUDGET: Record<Exclude<SfxLevel, 'off'>, { max: number; minWeight: number }> = {
  // Light: only the truly pivotal, 1–2 at most.
  light: { max: 2, minWeight: 4 },
  // Medium: a handful, still text-led.
  medium: { max: 5, minWeight: 2 },
  // Immersive: lean in, but a hard ceiling so it can never run away.
  immersive: { max: 20, minWeight: 1 },
};

/** A short verbatim anchor around a match — the whole matched phrase, trimmed. */
const anchorAt = (text: string, index: number, matched: string): string =>
  text.slice(index, index + matched.length).trim();

/**
 * Plan the SFX anchors for a passage under a permissiveness level. Strongest
 * cues win the budget; ties and the final list return in READING order so they
 * fire in sequence. `off` yields nothing.
 */
export const planSfxAnchors = (text: string, level: SfxLevel): SfxAnchor[] => {
  if (level === 'off' || !text) return [];
  const budget = BUDGET[level];

  interface Hit { index: number; anchor: string; intent: string; tags: string[]; weight: number }
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const cue of CUES) {
    const re = new RegExp(cue.re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (cue.weight < budget.minWeight) break;
      // Suppress metaphorical uses ("shattered her hopes", "fell in love").
      if (cue.not && cue.not.test(text.slice(Math.max(0, m.index - 4), m.index + GUARD_WINDOW))) continue;
      const anchor = anchorAt(text, m.index, m[0]);
      const dedupe = `${anchor.toLowerCase()}@${m.index}`;
      if (!anchor || seen.has(dedupe)) continue;
      seen.add(dedupe);
      hits.push({ index: m.index, anchor, intent: cue.intent, tags: cue.tags, weight: cue.weight });
    }
  }

  // Keep the strongest within budget (weight desc, earlier text breaks ties)…
  const kept = hits
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, budget.max);
  // …then present them in reading order so they fire in sequence.
  return kept
    .sort((a, b) => a.index - b.index)
    .map(({ anchor, intent, tags, weight }) => ({ anchor, intent, tags, weight }));
};

/* --------------------------------------------------------------------------- */
/* Volume modulation — the story-driven swell / hush, tied to a text anchor.    */
/* --------------------------------------------------------------------------- */

export interface VolumeCue {
  anchor: string;
  /** Target modulation for the environment (1 = neutral, <1 quieter, >1 louder). */
  target: number;
  dir: 'down' | 'up';
}

const VOL_DOWN = /\b(silence fell|fell silent|grew (?:quiet|still|silent|hushed)|went (?:quiet|still|silent|dead[\s-]?quiet)|hushed|died down|died away|faded (?:away|to silence|out)|quieted|(?:a|the) hush|stillness (?:fell|settled)|dropped to a whisper)\b/i;
const VOL_UP = /\b(grew louder|roared to life|swell(?:ed|ing)?\s+(?:to|into|up)|erupted|rose to a (?:roar|crescendo|fever)|reached a crescendo|deafening|thunderous|the din(?:\s+of)?|rising (?:noise|clamou?r|roar|tide)|burst into (?:noise|song|cheers)|the noise (?:swelled|surged|grew))\b/i;

/**
 * Volume-modulation cues in a passage: where the soundscape should HUSH or
 * SWELL, anchored to a verbatim phrase so it ramps as the reveal reaches it.
 * Reading order; a small cap keeps it from thrashing the mixer.
 */
export const planVolumeCues = (text: string): VolumeCue[] => {
  if (!text) return [];
  const out: { index: number; cue: VolumeCue }[] = [];
  const scan = (re: RegExp, target: number, dir: 'down' | 'up') => {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      const anchor = text.slice(m.index, m.index + m[0].length).trim();
      if (anchor) out.push({ index: m.index, cue: { anchor, target, dir } });
    }
  };
  scan(VOL_DOWN, 0.35, 'down');
  scan(VOL_UP, 1.15, 'up');
  return out.sort((a, b) => a.index - b.index).map(x => x.cue).slice(0, 6);
};

/* --------------------------------------------------------------------------- */
/* Bridging — a location change WITHIN one message (tavern → a closed room).    */
/* --------------------------------------------------------------------------- */

export interface TransitionCue {
  anchor: string;
  /** The place moved into, when the prose names one confidently (else null —
   *  still a transition worth a threshold sound). */
  location: string | null;
}

// Abstract "destinations" that aren't real places — never switch the bed to these.
const NOT_A_PLACE = /^(light|air|distance|silence|view|night|day|darkness|shadows?|focus|position|action|motion|thoughts?|question|sky|open|fog|mist|line|step|trouble|place)$/i;
const PLACE_TAIL = "([a-z][a-z' -]{2,24}?)(?=[.,;:!?\"”)]|\\s+(?:and|then|before|where|as|behind|,)|$)";
// Naming the destination — prepositional ("stepped into her room") or transitive
// ("entered the cellar"). These let the bed actually SWITCH.
const DEST_PATTERNS = [
  new RegExp(`\\b(?:step(?:s|ped)?|walk(?:s|ed)?|slip(?:s|ped)?|head(?:s|ed)?|retreat(?:s|ed)?|return(?:s|ed)?|climb(?:s|ed)?|descend(?:s|ed)?|duck(?:s|ed)?|move(?:s|d)?|cross(?:es|ed)?)\\s+(?:back\\s+|quickly\\s+|slowly\\s+)?(?:into|inside|through|toward|towards)\\s+(?:the|his|her|their|a|an)\\s+${PLACE_TAIL}`, 'i'),
  new RegExp(`\\b(?:enter(?:s|ed)?|reach(?:es|ed)?)\\s+(?:the|his|her|their|a|an)\\s+${PLACE_TAIL}`, 'i'),
];
// A transition worth a threshold SOUND but with no clear new place to name.
const DOOR = /\b(clos(?:e|es|ed|ing)\s+the\s+door|shut(?:s|ting)?\s+the\s+door|the\s+door\s+(?:clos|shut|swung|slamm)\w*|slamm\w+\s+the\s+door|step(?:s|ped)?\s+out(?:side)?|left\s+the\s+[a-z]|walk(?:s|ed)?\s+out|exit(?:s|ed)?\s+the)\b/i;

/**
 * A single mid-message transition worth bridging — the reader crosses into a new
 * space. Prefers a NAMED destination (so the bed can switch); falls back to a
 * door/threshold marker (a sound, no rename). At most one per message.
 */
export const planTransition = (text: string): TransitionCue | null => {
  if (!text) return null;
  let best: { index: number; anchor: string; location: string } | null = null;
  for (const re of DEST_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const place = m[1].trim();
    if (NOT_A_PLACE.test(place)) continue;
    if (!best || m.index < best.index) {
      best = { index: m.index, anchor: text.slice(m.index, m.index + m[0].length).trim(), location: place };
    }
  }
  if (best) return { anchor: best.anchor, location: best.location };
  const door = DOOR.exec(text);
  return door ? { anchor: text.slice(door.index, door.index + door[0].length).trim(), location: null } : null;
};
