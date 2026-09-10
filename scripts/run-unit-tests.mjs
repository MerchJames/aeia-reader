/**
 * Every unit test, in one command.
 *
 * These are plain scripts, not a framework: each one runs standalone under
 * `tsx`, counts its own assertions, prints "N passed, M failed" and exits
 * non-zero if anything failed. That is a deliberate choice — no test runner to
 * configure, no globals, and any file can be run on its own while working on it.
 *
 * The cost of it was that there was no way to run them ALL, so a change could
 * break a file nobody thought to open. This is that way. It runs them in
 * parallel, prints only what failed plus a total, and fails the command if any
 * file did.
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `*.test.ts` / `*.test.mjs` under a tree. */
const find = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === 'node_modules' || e === 'dist') continue;
    if (statSync(p).isDirectory()) find(p, out);
    else if (/\.test\.(ts|mjs)$/.test(e)) out.push(p);
  }
  return out;
};

const files = [
  ...find(path.join(root, 'src')),
  ...find(path.join(root, 'ST Extension')),
].sort();

const run = (file) => new Promise((resolve) => {
  const isTs = file.endsWith('.ts');
  execFile(
    process.execPath,
    isTs ? [path.join(root, 'node_modules/tsx/dist/cli.mjs'), file] : [file],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ file, code: err?.code ?? 0, stdout, stderr }),
  );
});

// Bounded parallelism: one tsx process per test file, but not 95 at once.
const LIMIT = 8;
const results = [];
let next = 0;
await Promise.all(Array.from({ length: LIMIT }, async () => {
  while (next < files.length) results.push(await run(files[next++]));
}));

let passed = 0, failed = 0, broken = 0;
for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
  const m = r.stdout.match(/(\d+) passed, (\d+) failed/);
  if (!m) {
    // A file that did not print a tally did not run — a syntax error, a missing
    // import, a throw before the first assertion. That is a failure, not a zero.
    broken++;
    console.error(`\n✗ ${path.relative(root, r.file)} — did not report a result`);
    console.error((r.stderr || r.stdout).trim().split('\n').slice(-12).join('\n'));
    continue;
  }
  passed += Number(m[1]);
  failed += Number(m[2]);
  if (r.code !== 0 || Number(m[2]) > 0) {
    console.error(`\n✗ ${path.relative(root, r.file)} — ${m[2]} failed`);
    console.error(r.stdout.split('\n').filter(l => l.startsWith('✗')).join('\n'));
  }
}

console.log(
  `\n${files.length} files · ${passed} assertions passed`
  + (failed ? ` · ${failed} FAILED` : '')
  + (broken ? ` · ${broken} did not run` : ''),
);
process.exit(failed || broken ? 1 : 0);
