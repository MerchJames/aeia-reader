/**
 * Run: node scripts/checkTourAnchors.mjs
 *
 * `tours.ts` names elements to spotlight. Those names are a promise about
 * markup in files it does not own, and the promise is broken by an ordinary
 * rename in an unrelated component — with no error anywhere, because a missing
 * anchor degrades to a centred card that explains the feature without pointing
 * at it. That is a good failure mode and a terrible thing to ship unnoticed.
 *
 * A unit test cannot check this: there is no DOM, and the attribute lives in
 * JSX. So it is grepped. Crude, and it catches the exact thing that happens.
 *
 * Exits non-zero when a tour names an anchor no component renders, and prints
 * anchors rendered by a component that no tour uses — those are not failures
 * (an anchor left behind is harmless) but they are usually a rename half done.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const files = walk(src).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

// The tours file, read as text rather than imported: this script runs under
// plain node, and importing it would drag in the whole type graph.
const toursText = readFileSync(join(src, 'utils', 'tours.ts'), 'utf8');
const wanted = new Set(
  [...toursText.matchAll(/target:\s*'([a-z0-9-]+)'/g)].map(m => m[1]),
);

const rendered = new Map();
for (const file of files) {
  if (file.endsWith(join('utils', 'tours.ts'))) continue;
  const text = readFileSync(file, 'utf8');
  // Three ways an anchor legitimately reaches the DOM: a literal attribute, a
  // conditional expression picking between literals, and the \`tour\` prop that
  // SettingsPanel's Section forwards. Anything else does not count — an anchor
  // built out of a variable cannot be checked, and should not be written.
  const marks = [
    ...text.matchAll(/data-tour="([a-z0-9-]+)"/g),
    ...[...text.matchAll(/data-tour={[^}]*}/g)]
      // Only after a `?` or a `:` — the branches of the ternary, not the
      // panel name it is testing. Reading both would report the CONDITION as an
      // anchor, which then shows up as rendered-but-unused for ever.
      .flatMap(m => [...m[0].matchAll(/[?:]\s*'([a-z0-9-]+)'/g)]),
    ...text.matchAll(/\btour="([a-z0-9-]+)"/g),
    // `tour: x27xx27` — a field on a data-driven row (the tool bar builds its
    // buttons from an array) rather than an attribute written by hand.
    ...text.matchAll(/\btour: '([a-z0-9-]+)'/g),
  ];
  for (const m of marks) {
    if (!rendered.has(m[1])) rendered.set(m[1], []);
    const at = file.slice(root.length + 1);
    if (!rendered.get(m[1]).includes(at)) rendered.get(m[1]).push(at);
  }
}

const missing = [...wanted].filter(a => !rendered.has(a)).sort();
const unused = [...rendered.keys()].filter(a => !wanted.has(a)).sort();

for (const anchor of [...wanted].sort()) {
  if (rendered.has(anchor)) console.log(`  ✓ ${anchor} — ${rendered.get(anchor).join(', ')}`);
}
for (const anchor of missing) console.log(`  ✗ ${anchor} — no component renders this`);
for (const anchor of unused) console.log(`  · ${anchor} — rendered but no tour uses it`);

console.log(
  missing.length
    ? `\n${missing.length} anchor(s) a tour points at do not exist`
    : `\nall ${wanted.size} tour anchors are rendered`,
);
process.exit(missing.length ? 1 : 0);
