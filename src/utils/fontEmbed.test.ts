/**
 * Run: npx tsx src/utils/fontEmbed.test.ts
 *
 * Fetching is not tested here (that needs a network and Google); what is tested
 * is the resolution, because getting it wrong is silent — the file exports, it
 * just looks like a different app than the one you were reading in.
 */
import { FONT_STACKS, resolveExportFont } from './fontEmbed';
import { THEMES } from '../themes';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const resolve = (themeId: keyof typeof THEMES, fontFamily: string, custom: string | null = null) =>
  resolveExportFont(themeId, THEMES[themeId].font, fontFamily as never, custom);

/* ---- every stack is real CSS ---- */

for (const [key, stack] of Object.entries(FONT_STACKS)) {
  ok(stack.length > 0 && stack.includes(','), `${key}: has a stack with a fallback`);
  // A stack with no generic family at the end falls back to the browser
  // default on a machine missing every named face, which is a lottery.
  ok(/(serif|sans-serif|monospace|cursive|fantasy)\s*$/.test(stack),
    `${key}: ends in a generic family`);
}

/* ---- an explicit choice always wins ---- */

ok(resolve('dark', 'handwriting').stack === FONT_STACKS.handwriting,
  'an explicit font is used as chosen');
ok(resolve('terminal', 'serif').stack === FONT_STACKS.serif,
  'and it beats the theme’s signature face');
ok(resolve('dark', 'handwriting').googleKey === 'handwriting',
  'an explicit built-in font is fetched from Google');

/* ---- 'theme' follows the theme ---- */

ok(resolve('terminal', 'theme').stack === FONT_STACKS[THEMES.terminal.font!],
  'following the theme uses its signature face');
ok(resolve('book', 'theme').stack === FONT_STACKS[THEMES.book.font!], 'book reads as a book');
// A theme with no declared font must still resolve to something sensible.
ok(resolve('light', 'theme').stack === FONT_STACKS.sans, 'a theme with no font falls back to sans');

/* ---- the pixel themes, which lie about their font ---- */

// They declare `font: 'mono'` but index.css overrides with Press Start 2P
// under `.stock-font`. Trusting the declaration exported a Game Boy chat in
// JetBrains Mono — the exact mismatch this module exists to prevent.
for (const id of ['pixelchat', 'pixelrpg', 'gameboy'] as const) {
  const r = resolve(id, 'theme');
  ok(r.stack.includes('Press Start 2P'), `${id}: exports in its real pixel face`);
  ok(r.localFace === 'Press Start 2P', `${id}: embeds the bundled file, not a Google one`);
  ok(r.googleKey === null, `${id}: does not also fetch a web font`);
  // …but only while the reader is following the theme.
  ok(!resolve(id, 'serif').stack.includes('Press Start'), `${id}: an explicit choice still wins`);
}

/* ---- uploaded fonts beat everything ---- */

const custom = resolve('pixelchat', 'theme', 'MyFace');
ok(custom.stack.startsWith('"MyFace"'), 'an uploaded font leads the stack');
ok(custom.customFamily === 'MyFace', 'and is embedded from IndexedDB');
ok(custom.googleKey === null && custom.localFace === null, 'nothing else is fetched for it');
ok(custom.stack.includes('sans-serif'), 'it still has a fallback if the bytes fail');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
