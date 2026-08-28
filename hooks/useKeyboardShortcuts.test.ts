/**
 * Run: npx tsx src/hooks/useKeyboardShortcuts.test.ts
 *
 * One key, one owner.
 *
 * This file reads the SOURCE of the shortcut hook rather than running it,
 * because what it is guarding is a property of the source: a `switch` takes the
 * first matching `case` and silently ignores every later one.
 *
 * That is not hypothetical. Moving the autofocus keys out of ReaderDisplay
 * added a `case 's'` near the top of the keydown switch for "zoom out" — and
 * `s` already opened Sheets further down. TypeScript says nothing, the build is
 * clean, both branches look right in review, and Sheets simply stops opening
 * for everybody. The same trap had already been paid for once: Space was owned
 * by two separate window listeners, and whichever ran last won.
 *
 * There is a second, quieter version of it. Space, W/A/S/D and B all fire
 * `preventDefault`, so a key claimed here is a key the browser no longer
 * handles — which is why a claim has to be deliberate enough to be listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'useKeyboardShortcuts.ts'), 'utf8');

/** The two switches, split at the keyup handler. */
const upAt = src.indexOf('const handleKeyUp');
ok(upAt > 0, 'the file still has a separate keyup handler');
const downSrc = src.slice(0, upAt);
const upSrc = src.slice(upAt);

/** `case 'x':` labels in one block — comments mentioning one do not count. */
const casesIn = (block: string): string[] =>
  [...block.matchAll(/^\s*case '([^']*)':/gm)].map(m => m[1]);

for (const [name, block] of [['keydown', downSrc], ['keyup', upSrc]] as const) {
  const keys = casesIn(block);
  ok(keys.length > 0, `${name} binds some keys`);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) { if (seen.has(k)) dupes.add(k); seen.add(k); }
  ok(dupes.size === 0,
    `${name}: every key has exactly one owner — a second case is DEAD CODE `
    + `(duplicated: ${[...dupes].join(', ') || 'none'})`);
}

/* The keys that are load-bearing enough to name. If one of these disappears,
 * something the README promises has quietly stopped working. */
const down = casesIn(downSrc);
for (const k of [' ', 'f', 'w', 'a', 'd', 's', 'b', 'q', 'e', 'c', 'm', 'escape',
  'arrowleft', 'arrowright']) {
  ok(down.includes(k), `keydown still binds ${JSON.stringify(k)}`);
}
const up = casesIn(upSrc);
for (const k of ['f', 'q', 'e']) ok(up.includes(k), `keyup still releases ${JSON.stringify(k)}`);

/* Autofocus zoom lives on W and S. S is shared with Sheets, so it must branch
 * on autofocus BEFORE doing anything else — which is the only reason the two
 * can coexist on one key at all. */
ok(/case 's':\s*\n\s*if \(s\.isAutofocusMode\)/.test(src),
  'the shared S key checks autofocus first, so neither owner shadows the other');

/* Views that paginate on their own terms must keep their arrow keys. */
ok(/OWN_PAGER/.test(src), 'the self-paginating views are named in one place');
for (const v of ['book', 'script', 'panels']) {
  ok(new RegExp(`OWN_PAGER = new Set\\(\\[[^\\]]*'${v}'`).test(src),
    `${v} turns its own pages`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
