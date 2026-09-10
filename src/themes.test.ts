/**
 * Run: npx tsx src/themes.test.ts
 *
 * The theme catalogue.
 *
 * This exists because of a bug that shipped twice in one afternoon and both
 * times looked like nothing: a theme whose signature effect is written for a
 * class the reading view does not render. `riso` and `foil` were both authored
 * against `.reader-bubble-name`, which Storybook has no such element for — so
 * in the app's default view they arrived as a warm palette and a dark palette,
 * with none of the thing that makes them worth having.
 *
 * A screenshot caught it. A test cannot see a render, but it CAN check that a
 * theme claiming a root class has rules for it, and that the effects it hangs
 * there reach something every view actually draws.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCENTS, THEMES, readableInk } from './themes';
import { STREAM_EFFECTS } from './types';
import type { Theme } from './types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const css = readFileSync(join(import.meta.dirname, 'index.css'), 'utf8');
const ids = Object.keys(THEMES) as Theme[];

// The catalogue is internally consistent.
for (const id of ids) {
  const t = THEMES[id];
  ok(t.id === id, `${id}: keyed by its own id`);
  ok(!!t.label, `${id}: has a label for the picker`);
  for (const [k, v] of Object.entries(t.vars)) {
    ok(typeof v === 'string' && v.length > 0, `${id}: ${k} is set`);
  }
}

// A root class with no rules is a theme that silently renders as a palette.
for (const id of ids) {
  const root = THEMES[id].rootClass;
  if (!root) continue;
  for (const cls of root.split(/\s+/).filter(Boolean)) {
    ok(css.includes(`.${cls}`), `${id}: "${cls}" is claimed but has no CSS`);
  }
}

/**
 * The three material themes carry their look on selectors EVERY view renders.
 *
 * `.reader-bubble-name` is not one of them — Storybook, Book and Stage lay the
 * prose out themselves. A theme whose whole signature lives there is invisible
 * in the view most readers open.
 */
const EVERYWHERE = ['.markdown-body', '.reader-page', '::before', '::after'];
for (const id of ['riso', 'foil', 'vector', 'calligraphy'] as Theme[]) {
  const cls = `.${THEMES[id].rootClass!.split(/\s+/)[0]}`;
  const start = css.indexOf(cls);
  ok(start >= 0, `${id}: has a CSS block`);
  const block = css.slice(start, start + 4000);
  ok(EVERYWHERE.some(sel => block.includes(`${cls}${sel}`) || block.includes(`${cls} ${sel}`)),
    `${id}: its signature reaches something every view draws, not just the speaker plate`);
}

/**
 * And every one of them can be switched OFF.
 *
 * "Ambient theme effects" is a real setting, and a leftover that survives it is
 * the one the reader who turned it off will notice.
 */
for (const id of ['riso', 'foil', 'vector', 'calligraphy'] as Theme[]) {
  const cls = THEMES[id].rootClass!.split(/\s+/)[0];
  ok(css.includes(`.no-effects .${cls}`) || css.includes(`.${cls}.no-effects`),
    `${id}: honours the effects toggle`);
}

/**
 * Every effect in the catalogue has CSS standing behind it.
 *
 * Two ways to get this wrong, and the stylesheet is the only witness to either.
 *
 * A THEME can name a signature effect that does not exist. Calligraphy is the
 * case that matters: the script face is half the idea and `quill` is the other
 * half — a fancy font that fades in reads as a fancy font, the same font
 * written reads as a hand moving. A signature naming an effect with no rules
 * behind it silently falls back to whatever the reader had.
 *
 * And the SETTINGS PANEL offers every member of `STREAM_EFFECTS`, so a member
 * added to the type without a rule to match is a button that visibly does
 * nothing — the reader picks it, the words keep arriving exactly as before,
 * and there is no error anywhere to say why. Walking the catalogue rather than
 * the themes covers the signatures too, since a signature is a member of it.
 */
for (const fx of STREAM_EFFECTS) {
  if (fx === 'none') continue; // the one member that is the ABSENCE of an effect
  // Anchored at the END of the class name, not a bare `includes`: every effect
  // here is a PREFIX of a longer one somebody might write ("ink" of "inked",
  // "type" of "typewriter"), so a substring test passes on a rule for a class
  // that is not this one — which is precisely the failure it is here to catch.
  ok(new RegExp(`\\.word-reveal-${fx}(?![\\w-])`).test(css),
    `"${fx}" has a word reveal to run`);
}

/**
 * A clip-path reveal must restore its end state when motion is off.
 *
 * Every other reveal animates opacity or transform, so killing the animation
 * leaves the word visible. `quill` reveals by UNCLIPPING — stop it dead and the
 * word stays clipped to nothing, which is not "reduced motion", it is a blank
 * page.
 */
{
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  ok(/word-reveal-quill[^}]*clip-path:\s*none/.test(reduced),
    'quill un-clips itself under reduced motion rather than leaving the words hidden');
  ok(/no-effects\s+\.word-reveal-quill[^}]*clip-path:\s*none/.test(css),
    'and with ambient effects switched off');
}

/* ── Ink on a solid accent ───────────────────────────────────────────────── */
{
  /*
   * Sixty surfaces paint `bg-accent text-white`. An audit measured 2.54:1 on the
   * default dark theme's blue, against a 4.5:1 bar — and the light accents are
   * further from it, not closer. `readableInk` picks the ink; these assert it
   * picks the one that can actually be read.
   */
  const luminance = (hex: string) => {
    const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map(i => f(parseInt(hex.slice(i, i + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  ok(readableInk('#ffffff') === '#111111', 'white takes dark ink');
  ok(readableInk('#000000') === '#ffffff', 'and black takes white');
  ok(readableInk('#60a5fa') === '#111111',
    "the default dark theme's blue — the button the audit failed on");
  ok(readableInk('#4ade80') === '#111111', 'a light green never took white text well');
  ok(readableInk('#dc2626') === '#ffffff', 'and a deep crimson still does');

  // The property that matters, over every accent the app actually ships.
  const swatches = [
    ...ACCENTS.filter(a => a.hex).map(a => a.hex),
    ...Object.values(THEMES).map(t => t.vars.accent),
  ];
  // The property that actually holds for every colour: it returns the BETTER of
  // the two. Checked exhaustively rather than on samples, because the catalogue
  // grows and a threshold picked by eye would not follow it.
  const other = (ink: string) => (ink === '#ffffff' ? '#111111' : '#ffffff');
  const wrong = swatches.filter(hex =>
    contrast(hex, readableInk(hex)) < contrast(hex, other(readableInk(hex))));
  ok(wrong.length === 0,
    `every shipped accent gets the higher-contrast ink (wrong: ${wrong.join(', ')})`);

  // …and that it is genuinely a choice, not "always dark".
  ok(new Set(swatches.map(readableInk)).size === 2,
    'both inks are used across the catalogue — a rule that always answers the same '
    + 'thing is not measuring anything');

  /*
   * How close that gets us to the 4.5:1 bar.
   *
   * All but two clear it. Those two cannot reach 4.5 against ANY ink — picking
   * the better one is already all this layer can do, and only a different
   * colour would close the gap:
   *
   *     #e5341f  the riso theme's red      4.35:1 on black
   *     #8b5cf6  the Violet accent         4.46:1 on white
   *
   * Both are a hair under, and changing a shipped palette is the owner's call,
   * not this file's. So they are named — and the set is asserted exactly, which
   * is the part that earns its keep: a THIRD one appearing is a regression, and
   * a bare "at most two" would let it in silently.
   */
  const ranked = swatches
    .map(hex => ({ hex, ratio: contrast(hex, readableInk(hex)) }))
    .sort((a, b) => a.ratio - b.ratio);
  const short = ranked.filter(r => r.ratio < 4.5).map(r => r.hex).sort();
  ok(JSON.stringify(short) === JSON.stringify(['#8b5cf6', '#e5341f']),
    `only the two known accents fall short of 4.5:1 (got: ${short.join(', ')})`);
  ok(ranked[0].ratio >= 4.3,
    `and they stay near it (worst: ${ranked[0].hex} at ${ranked[0].ratio.toFixed(2)})`);

  ok(readableInk('rgb(1,2,3)') === '#ffffff',
    'a colour it cannot parse falls back rather than throwing');
  ok(readableInk('#fff') === '#111111', 'and three-digit hex is understood');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
