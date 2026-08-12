/**
 * Scene weather — deciding WHICH particle effect a passage earns, and how hard
 * it comes down.
 *
 * The Director can name an `fx`, but it only ever reads a passage once and often
 * returns null, which is why weather used to feel arbitrary: a scene that plainly
 * says "snow was falling" got nothing unless the AI happened to tag it. This
 * module reads the prose directly — the words are right there — so weather is
 * consistent and accurate with the AI off, and the Director's call still wins
 * when it made one.
 *
 * Pure module: no store, no React, no assets. Matching is deliberately narrow
 * (a real weather word, not a metaphor) because a wrong effect is worse than
 * none — "her eyes burned" must not start an ember storm.
 */

import { SCENE_FX, SceneFxKind } from './livingBackground';

export interface Weather {
  fx: SceneFxKind;
  /** 0..1 — a faint haze vs. a whiteout. */
  level: number;
}

/**
 * What each effect is triggered by. Order matters: the first rule that matches
 * wins, so the specific and unmistakable cues come before the general ones.
 * Patterns are matched against the lowercased passage.
 */
const RULES: { fx: SceneFxKind; re: RegExp }[] = [
  // Unmistakable, specific weather first.
  { fx: 'snow', re: /\b(snow(fall|flake|ing|y|s)?|blizzard|flurr(y|ies)|sleet|whiteout)\b/ },
  { fx: 'rain', re: /\b(rain(fall|ing|drop|s|y)?|downpour|drizzl(e|ing)|deluge|torrent(ial)?|cloudburst)\b/ },
  { fx: 'fog', re: /\b(fog(gy|bank)?|mist(y|s)?|haze|hazy|pea.?soup)\b/ },
  { fx: 'ash', re: /\b(ash(fall|es)?|cinders?)\b/ },
  { fx: 'embers', re: /\b(embers?|sparks?\s+(?:rose|rising|flew|drift)|bonfire|pyre|forge)\b/ },
  { fx: 'smoke', re: /\b(smoke|smoky|smould(er|ering)|smolder(ing)?|soot)\b/ },
  { fx: 'steam', re: /\b(steam(ing|y)?|vapou?r|hot\s+spring|bathhouse|sauna|geyser)\b/ },
  { fx: 'sand', re: /\b(sandstorm|blowing\s+sand|dust\s+storm|grit\b|dunes?)\b/ },
  { fx: 'bubbles', re: /\b(underwater|bubbl(e|es|ing)|submerged|beneath\s+the\s+(?:waves|surface))\b/ },
  { fx: 'fireflies', re: /\b(firefl(y|ies)|lightning\s+bugs?|will[-\s]?o[-'\s]?the[-\s]?wisp|glowbugs?)\b/ },
  { fx: 'leaves', re: /\b(leaves\s+(?:fell|falling|drift|blew|swirl)|autumn\s+leaves|fallen\s+leaves|leaf\s+litter)\b/ },
  { fx: 'petals', re: /\b(petals?|blossoms?|sakura|cherry\s+blossom)\b/ },
  { fx: 'pollen', re: /\b(pollen|spores?|seed\s?pods?\s+drift)\b/ },
  { fx: 'dust', re: /\b(dust(y)?|cobwebs?|long[-\s]abandoned|disused|motes?\s+(?:of|in)\s+(?:dust|light))\b/ },
  { fx: 'sparkles', re: /\b(glitter(ing|ed)?|shimmer(ing|ed)?\s+motes|sparkl(e|es|ing)|glimmer(ing)?\s+lights?)\b/ },
  { fx: 'stars', re: /\b(stars?\s+(?:wheeled|shone|scattered|above|overhead)|starlight|night\s+sky|constellations?|milky\s+way)\b/ },
];

/** Words that say the weather is HEAVY. */
const HEAVY = /\b(heav(y|ily)|thick|dense|blinding|torrential|driving|choking|howling|relentless|pouring|whipping|churn(ing|ed)|roaring|swirl(ing|ed))\b/;
/** Words that say it is barely there. */
const LIGHT = /\b(faint(ly)?|thin|light(ly)?|wisp(y|s)?|drizzl(e|ing)|gentl(e|y)|soft(ly)?|few|scatter(ed|ing)|trace|hint\s+of)\b/;

/** How near a qualifier has to be to count as describing the weather. */
const QUALIFIER_WINDOW = 48;

/**
 * Read the weather out of a passage. Returns undefined when the prose doesn't
 * clearly show any — most passages have no weather, and inventing one is the
 * failure mode that made the old behaviour feel random.
 */
export const weatherFromText = (text: string): Weather | undefined => {
  if (!text) return undefined;
  const hay = text.toLowerCase();
  for (const rule of RULES) {
    const m = rule.re.exec(hay);
    if (!m) continue;
    // Look just around the hit for a "how hard" qualifier, so "heavy" three
    // paragraphs away doesn't turn a drizzle into a deluge.
    const from = Math.max(0, m.index - QUALIFIER_WINDOW);
    const near = hay.slice(from, m.index + m[0].length + QUALIFIER_WINDOW);
    let level = 0.65;
    if (HEAVY.test(near)) level = 1;
    else if (LIGHT.test(near)) level = 0.32;
    // A second mention means the passage is really about it.
    const again = new RegExp(rule.re.source, 'g');
    const hits = hay.match(again)?.length ?? 1;
    if (hits >= 2) level = Math.min(1, level + 0.15);
    return { fx: rule.fx, level };
  }
  return undefined;
};

/**
 * The weather to show for the beat on screen. The Director's explicit call wins
 * (it read the whole passage in context); otherwise the prose speaks for itself;
 * otherwise the weather already established earlier in the scene carries over —
 * fog doesn't evaporate because one paragraph forgot to mention it.
 */
export const resolveWeather = (
  descriptor: { fx?: SceneFxKind; fxLevel?: number } | undefined,
  text: string | undefined,
  sticky?: SceneFxKind,
): Weather | undefined => {
  if (descriptor?.fx) {
    const lvl = typeof descriptor.fxLevel === 'number' && Number.isFinite(descriptor.fxLevel)
      ? Math.max(0.1, Math.min(1, descriptor.fxLevel))
      // No level given: let the prose say how hard it's coming down, if it can.
      : (text && weatherFromText(text)?.fx === descriptor.fx
        ? weatherFromText(text)!.level
        : 0.7);
    return { fx: descriptor.fx, level: lvl };
  }
  const read = text ? weatherFromText(text) : undefined;
  if (read) return read;
  return sticky ? { fx: sticky, level: 0.55 } : undefined;
};

/** True when `fx` is one this build knows how to render. */
export const isSceneFx = (fx: unknown): fx is SceneFxKind =>
  typeof fx === 'string' && (SCENE_FX as readonly string[]).includes(fx);
