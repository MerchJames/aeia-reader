/**
 * Static checks on the extension that do not need SillyTavern running:
 * every symbol it imports must exist in the ST source, and every id its
 * JavaScript reaches for must exist in the markup it ships.
 */
import { readFileSync } from 'node:fs';

const EXT = 'st-extension-20260903T160656Z-1-001/st-extension/aeia-bridge/index.js';
const ST = 'gut/SillyTavern-release/SillyTavern-release/public';
const src = readFileSync(EXT, 'utf8');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('  ✗', msg); } };

// ---- imports resolve to real exports -------------------------------------
const files = {
  '../../../extensions.js': `${ST}/scripts/extensions.js`,
  '../../../../script.js': `${ST}/script.js`,
  '../../../popup.js': `${ST}/scripts/popup.js`,
  '../../../slash-commands/SlashCommand.js': `${ST}/scripts/slash-commands/SlashCommand.js`,
  '../../../slash-commands/SlashCommandParser.js': `${ST}/scripts/slash-commands/SlashCommandParser.js`,
  '../../../slash-commands/SlashCommandArgument.js': `${ST}/scripts/slash-commands/SlashCommandArgument.js`,
};
console.log('imports:');
for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)) {
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const path = files[m[2]];
  if (!path) { console.log('  ? unknown module', m[2]); bad++; continue; }
  const target = readFileSync(path, 'utf8');
  for (const n of names) {
    const exported = new RegExp(`export\\s+(async\\s+)?(function|const|let|var|class)\\s+${n}\\b`).test(target)
      || new RegExp(`^\\s*${n},\\s*$`, 'm').test(target)   // listed in an export block
      || new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`, 's').test(target);
    ok(exported, `${n} is not exported by ${m[2]}`);
    if (exported) console.log(`  ✓ ${n}`);
  }
}

// ---- every id the code touches exists in the markup it ships -------------
console.log('\nDOM ids:');
const markup = [...src.matchAll(/id="([a-z0-9_]+)"/gi)].map(m => m[1]);
const used = new Set([...src.matchAll(/[$#]\(?['"]#([a-z0-9_]+)['"]\)?/gi)].map(m => m[1]));
for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);
// Ids SillyTavern renders, not us — verified to exist in its index.html.
const ST_OWNED = new Set(['extensions_settings2']);
for (const id of used) {
  if (ST_OWNED.has(id)) {
    const inSt = readFileSync(`${ST}/index.html`, 'utf8').includes(`id="${id}"`);
    ok(inSt, `#${id} is SillyTavern's, but its index.html has no such id`);
    if (inSt) console.log(`  ✓ #${id} (SillyTavern's own)`);
    continue;
  }
  const present = markup.includes(id);
  ok(present, `#${id} is referenced but never rendered`);
  if (present) console.log(`  ✓ #${id}`);
}

console.log(bad ? `\n${bad} problem(s)` : '\nall clear');
process.exit(bad ? 1 : 0);
