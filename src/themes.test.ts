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
import { THEMES } from './themes';
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

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
