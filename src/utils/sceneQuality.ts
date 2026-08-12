/**
 * The critic — a deterministic quality gate for an AI-authored scene.
 *
 * Sanitising answers "can this hurt the reader?". Nothing answered "is this any
 * good?", so a three-declaration flat dark box and a composed twenty-eight
 * declaration shot were accepted identically. That is the mechanism behind "it's
 * a gamble": the pipeline had no opinion about quality, so quality was whatever
 * the model happened to feel like that minute.
 *
 * This scores a stylesheet against the story's Style Packet on what can actually
 * be measured in CSS — substance, layered light, palette adherence, depth,
 * typography, motion matching the brief, and fitting on one screen. It is pure
 * and deterministic, so the same stylesheet always scores the same, and the
 * score is comparable across models and across runs.
 *
 * What it deliberately does NOT do is judge taste. `forbid` entries like "timid
 * colour" are prompt-side instructions; the critic only claims the checks it can
 * really make. The pipeline uses it as a floor, not as an arbiter:
 *   score >= ACCEPT            → ship it
 *   score >= REPAIRABLE        → one targeted repair round-trip, then re-score
 *   below, twice               → compose the scene from the packet instead
 */

import { StylePacket } from './stylePacket';

/** Ship an AI scene at or above this. */
export const ACCEPT_SCORE = 70;
/** Below this even after repair, the composed floor is the better scene. */
export const REPAIRABLE_SCORE = 55;

export interface Check {
  name: string;
  /** Points earned, out of `max`. */
  got: number;
  max: number;
  /** An imperative note for the repair prompt — absent when the check passed. */
  note?: string;
}

export interface SceneScore {
  /** 0-100. */
  score: number;
  checks: Check[];
  /** The notes from every check that lost points, strongest first. */
  failures: string[];
  /** Something is structurally wrong — repair cannot save it. */
  fatal: boolean;
}

/** Count real declarations (`prop: value`), ignoring selectors and at-rules. */
const declarations = (css: string): number =>
  (css.match(/(^|[{;])\s*-{0,2}[a-z][a-z0-9-]*\s*:/gi) ?? []).length;

const gradients = (css: string): number =>
  (css.match(/(linear|radial|conic)-gradient\s*\(/gi) ?? []).length;

/** Does the stylesheet use this colour, as hex or as an rgb()/rgba() triplet? */
export const usesColor = (css: string, hex: string): boolean => {
  const h = hex.replace('#', '').toLowerCase();
  if (h.length !== 6) return false;
  if (css.toLowerCase().includes(`#${h}`)) return true;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return new RegExp(`rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*[,)]`).test(css);
};

/** Largest viewport-unit length in the sheet, for the overflow check. */
const maxViewportUnit = (css: string): number => {
  let max = 0;
  for (const m of css.matchAll(/(\d+(?:\.\d+)?)\s*(vw|vh|vmin|vmax)\b/gi)) max = Math.max(max, Number(m[1]));
  return max;
};

/** Largest fixed pixel WIDTH — the usual way an AI scene escapes the frame. */
const maxPixelWidth = (css: string): number => {
  let max = 0;
  for (const m of css.matchAll(/(?:^|[{;])\s*(?:min-|max-)?width\s*:\s*(\d+(?:\.\d+)?)px/gi)) max = Math.max(max, Number(m[1]));
  return max;
};

const smallestFontPx = (css: string): number => {
  let min = Infinity;
  for (const m of css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)) min = Math.min(min, Number(m[1]));
  return min;
};

/**
 * Score one scene stylesheet against the packet it was supposed to realise.
 *
 * `textLength` is the slice this shot displays — a hero line and a paragraph
 * have genuinely different type requirements, so the typography check asks a
 * different question for each rather than pretending one rule fits both.
 */
export const scoreScene = (css: string, packet: StylePacket, textLength = 240): SceneScore => {
  const checks: Check[] = [];
  const body = (css || '').trim();

  // Structurally unusable — no selector at all, or effectively empty.
  if (!body || declarations(body) < 3 || !/[{}]/.test(body)) {
    return {
      score: 0, fatal: true,
      checks: [{ name: 'usable', got: 0, max: 100, note: 'the stylesheet is empty or has no real rules' }],
      failures: ['the stylesheet is empty or has no real rules'],
    };
  }

  const push = (name: string, got: number, max: number, note?: string) =>
    checks.push({ name, got, max, ...(got < max && note ? { note } : {}) });

  // 1. Substance. A designed shot is ~14-30 declarations; 6 is a placeholder.
  const decls = declarations(body);
  push('substance', decls >= 14 ? 15 : decls >= 10 ? 10 : decls >= 6 ? 5 : 0, 15,
    `only ${decls} declarations — this is a placeholder, not a designed shot; aim for 14-30`);

  // 2. Layered light. One gradient is a wash; two or more is a lit scene.
  const grads = gradients(body);
  push('light', grads >= 2 ? 15 : grads === 1 ? 8 : 0, 15,
    grads === 0
      ? 'the backdrop is a flat fill — build it from at least two stacked gradients (a radial light source plus a linear base)'
      : 'only one gradient — add a second light so the backdrop has a source and a falloff');

  // 3. Palette adherence. The whole point of the packet is that it is obeyed.
  const pal = packet.palette;
  const used = [pal.bg, pal.ink, pal.accent, pal.glow].filter(c => usesColor(body, c)).length;
  push('palette', used >= 3 ? 15 : used === 2 ? 10 : used === 1 ? 4 : 0, 15,
    `the packet palette is barely used (${used}/4) — use bg ${pal.bg}, ink ${pal.ink}, accent ${pal.accent} and glow ${pal.glow} literally`);

  // 4. Depth. A vignette, an inset shadow, a mask or a blur — anything that
  //    stops the frame reading as a rectangle of colour. A bare ::before does
  //    NOT count on its own: an empty overlay layer is where a scene puts its
  //    ambient animation, not where it gets its depth.
  const depth = /box-shadow\s*:[^;}]*inset|mask-image|backdrop-filter|filter\s*:[^;}]*blur/i.test(body)
    || /::\s*(before|after)[^{}]*\{[^}]*(gradient|box-shadow|backdrop-filter|blur)/i.test(body);
  push('depth', depth ? 12 : 0, 12,
    'the frame is flat — add a vignette (inset box-shadow or a ::after radial) so it reads as a lit space');

  // 5. Typography, judged against what this shot has to display.
  const hasStack = /font-family\s*:/i.test(body) || /font\s*:\s*[^;}]*(serif|sans|mono)/i.test(body);
  const hero = textLength <= 120;
  const scaled = hero
    ? /clamp\s*\(|font-size\s*:\s*[^;}]*(rem|vw|em)/i.test(body)
    : /max-width\s*:\s*\d+\s*(ch|rem|em)|line-height\s*:/i.test(body);
  const shaped = /letter-spacing\s*:|font-weight\s*:\s*([1-2]00|[89]00)|text-transform\s*:/i.test(body);
  push('typography', (hasStack ? 5 : 0) + (scaled ? 4 : 0) + (shaped ? 4 : 0), 13,
    !hasStack ? `no font stack — set font-family to ${packet.type.stack}`
      : !scaled ? (hero
        ? 'a single line should be a hero — size it with clamp() so it fills the frame'
        : 'a multi-line slice needs a readable column — set max-width in ch and a line-height')
      : `nothing shaping the type — use the packet's weight extremes (${packet.type.weight[0]}/${packet.type.weight[1]}) and tracking ${packet.type.tracking}`);

  // 6. Motion, in BOTH directions — a `still` packet is betrayed by an ambient
  //    loop just as surely as a `restless` one is by a static frame.
  const hasKeyframes = /@keyframes/i.test(body);
  const hasAnimation = /animation\s*:|animation-name\s*:/i.test(body);
  const ambientLoop = /animation\s*:[^;}]*infinite/i.test(body);
  if (packet.motion === 'still') {
    push('motion', ambientLoop ? 4 : 10, 10,
      'the packet says still — drop the infinite ambient loop and compose in stillness (an entrance is fine)');
  } else {
    push('motion', hasKeyframes && hasAnimation ? 10 : hasKeyframes || hasAnimation ? 5 : 0, 10,
      `the packet says ${packet.motion} — add @keyframes plus an animation on a BACKDROP layer (never on the words)`);
  }

  // 7. Fit. The stage is a fixed, non-scrolling viewport; these are the ways an
  //    over-eager scene escapes it.
  let fit = 20;
  const fitNotes: string[] = [];
  if (/position\s*:\s*fixed/i.test(body)) { fit -= 8; fitNotes.push('remove position:fixed — it escapes the stage'); }
  const vu = maxViewportUnit(body);
  if (vu > 100) { fit -= 8; fitNotes.push(`a ${vu} viewport-unit length overflows the screen — nothing above 100`); }
  const pw = maxPixelWidth(body);
  if (pw > 900) { fit -= 6; fitNotes.push(`a ${pw}px fixed width is wider than the frame — use % or vw`); }
  const fs = smallestFontPx(body);
  if (fs < 13) { fit -= 8; fitNotes.push(`${fs}px text is below the readable floor — nothing under 14px`); }
  const hidesBody = /(#aura-body|\.body)[^{}]*\{[^}]*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(body);
  if (hidesBody) { fit = 0; fitNotes.push('the words are hidden — .body must never be display:none or visibility:hidden'); }
  push('fit', Math.max(0, fit), 20, fitNotes.join('; '));

  const score = Math.round(checks.reduce((n, c) => n + c.got, 0));
  const failures = checks
    .filter(c => c.note)
    .sort((a, b) => (b.max - b.got) - (a.max - a.got))
    .map(c => c.note!);

  return { score, checks, failures, fatal: hidesBody };
};

/**
 * The repair instruction — the critic's own findings, handed back verbatim.
 *
 * A generic "make it better" retry re-rolls the same dice. This tells the model
 * exactly which measurable thing it failed and what number to hit, which is the
 * difference between a second sample and a correction.
 */
export const repairNotes = (score: SceneScore): string => [
  `Your stylesheet scored ${score.score}/100 against the brief. Fix EXACTLY these,`
  + ' keep everything that already works, and return the same ```json object:',
  ...score.failures.map((f, i) => `${i + 1}. ${f}`),
].join('\n');
