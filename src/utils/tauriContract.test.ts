/**
 * Run: npx tsx src/utils/tauriContract.test.ts
 *
 * Do the TypeScript callers and the Rust commands agree about arguments?
 *
 * ── The bug this exists for ────────────────────────────────────────────────
 *
 * `bridge_start` used to take a token. The proxy needed the listener to outlive
 * the sync panel, so it grew a second argument — the name of whoever is asking
 * for the socket — and the proxy's caller was updated. The sync panel's caller
 * was not:
 *
 *     invoke('bridge_start', { token })            // sync — missing `holder`
 *     invoke('bridge_start', { token, holder })    // proxy
 *
 * Tauri rejects the first before it reaches the listener, so on the desktop app
 * the two-way sync could not open a socket at all. Nothing caught it. `invoke`
 * takes `Record<string, unknown>`, so TypeScript is satisfied by anything; the
 * Rust side compiles perfectly because it is not the side that is wrong; and
 * every unit test on both halves passes, because each half is self-consistent.
 * It is only wrong ACROSS the boundary, and nothing was reading both sides.
 *
 * So this does. It parses `src-tauri/src/lib.rs` for what each command
 * requires, parses the TypeScript for what each call site passes, and compares.
 * Text, not types, because the boundary is not typed — that is the whole
 * problem.
 *
 * What it cannot see: an argument built dynamically, or a command invoked
 * through a variable. Those are skipped rather than guessed at, and there are
 * none today.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const root = path.join(import.meta.dirname, '..', '..');

/* ── What Rust requires ──────────────────────────────────────────────────── */

/**
 * Arguments a command takes from the caller.
 *
 * `AppHandle`, `State<'_, T>`, `Window` and friends are injected by Tauri and
 * are not sent by the caller — including them would make every call look wrong.
 */
/**
 * Arguments a command takes from the caller.
 *
 * `AppHandle`, `State<'_, T>`, `Window` and friends are injected by Tauri and
 * are not sent by the caller — including them would make every call look wrong.
 */
const INJECTED = /^(AppHandle|Window|WebviewWindow|State\s*<|tauri::)/;

/**
 * Split on commas that are not inside brackets.
 *
 * `State<'_, Bridge>` is ONE parameter containing a comma, and a plain
 * `split(',')` turns it into two — which is how the first draft of this test
 * decided every call site in the app was missing an argument called `Bridge>`.
 */
const topLevelSplit = (text: string, open = '<([{', close = '>)]}'): string[] => {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (open.includes(ch)) depth++;
    else if (close.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(p => p.trim()).filter(Boolean);
};

const commandArgs = (rust: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  const re = /#\[tauri::command\][\s\S]*?fn\s+(\w+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rust)) !== null) {
    const [, name, params] = m;
    const args = topLevelSplit(params)
      .map(p => {
        const at = p.indexOf(':');
        return { name: p.slice(0, at).trim(), type: p.slice(at + 1).trim() };
      })
      .filter(a => a.name && !INJECTED.test(a.type))
      // `Option<T>` is genuinely optional; everything else is required.
      .filter(a => !a.type.startsWith('Option<'))
      .map(a => a.name);
    out.set(name, args);
  }
  return out;
};

/* ── What TypeScript passes ──────────────────────────────────────────────── */

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};

interface CallSite { file: string; command: string; keys: string[] }

/** The balanced `{ … }` starting at `from`, or null. */
const objectAt = (src: string, from: number): string | null => {
  const start = src.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
};

/**
 * Every `call('cmd', { … })` / `invoke('cmd', { … })` in the app.
 *
 * The object is taken by matching braces, not by `[^}]*` — the argument to
 * `bridge_queue_edits` is `{ payload: JSON.stringify({ … }) }`, and a
 * non-greedy scan reads the keys of the INNER object and reports three
 * arguments that do not exist.
 */
const callSites = (files: string[]): CallSite[] => {
  const out: CallSite[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const re = /\b(?:call|invoke)\s*(?:<[^>]*>)?\s*\(\s*'([a-z_]+)'\s*(,)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const [, command, comma] = m;
      const body = comma ? objectAt(src, m.index + m[0].length) : '';
      const keys = topLevelSplit(body ?? '')
        .map(p => (p.startsWith('...') ? '…spread' : p.split(':')[0].trim()))
        .filter(k => k && !k.startsWith('['));
      out.push({ file: path.relative(root, file), command, keys });
    }
  }
  return out;
};

/* ── The comparison ──────────────────────────────────────────────────────── */

const rust = readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
const required = commandArgs(rust);
const sites = callSites(walk(path.join(root, 'src')));

ok(required.size >= 8, `found the Rust commands (${required.size})`);
eq(required.get('bridge_start'), ['token', 'holder'],
  'bridge_start takes a token AND a holder — the argument this test exists for');
ok(sites.length >= 8, `found the call sites (${sites.length})`);

for (const site of sites) {
  const want = required.get(site.command);
  if (!want) {
    // A command the app calls that Rust does not define is the same class of
    // fault, caught from the other direction.
    ok(false, `${site.file} calls '${site.command}', which no Rust command defines`);
    continue;
  }
  if (site.keys.includes('…spread')) {
    // e.g. the proxy's frame writer, which spreads `{ id, ...args }`. Its keys
    // cannot be read here; `writer()` supplies the id and the caller the rest.
    pass++;
    continue;
  }
  const missing = want.filter(k => !site.keys.includes(k));
  const extra = site.keys.filter(k => !want.includes(k));
  ok(missing.length === 0,
    `${site.file} → ${site.command} is missing ${missing.join(', ')}`
    + ' — Tauri rejects the call before the command runs');
  ok(extra.length === 0,
    `${site.file} → ${site.command} passes ${extra.join(', ')}, which it does not take`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
