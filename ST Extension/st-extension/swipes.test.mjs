/**
 * Run: node st-extension/swipes.test.mjs   (from the repo root, or beside it)
 *
 * The second pass writes into somebody's chat. This is the part of it that
 * touches their message object, tested against the ACTUAL source rather than a
 * copy of it — the function is lifted out of `index.js` by brace-matching and
 * evaluated here, because `index.js` imports SillyTavern and cannot be loaded
 * in node. A copied-out version would drift the first time either was edited,
 * and the drift would be invisible.
 *
 * What is being protected: **the original is never lost.** A revision is added
 * as a new swipe beside what the model wrote, so the worst a bad second pass
 * can cost is one swipe. Every assertion here is a way that promise could be
 * broken quietly — a rebuilt `swipe_info` losing the timings of takes the
 * reader already has, a stale `swipe_id` writing over a hand edit, an
 * off-by-one leaving the message pointing at the wrong text.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'aeia-bridge', 'index.js'), 'utf8');

/** Lift one top-level function out of the source by matching its braces. */
const lift = (name) => {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in index.js any more`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
    }
  }
  throw new Error(`${name} is not closed`);
};

const ensureSwipeShape = lift('ensureSwipeShape');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('✗', msg); } };
const eq = (a, b, msg) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/**
 * What the extension does after shaping: park the current text in its own slot,
 * then add the revision beside it. Written out here because the ORDER of those
 * two steps is the whole guarantee.
 */
const addRevision = (message, text) => {
  ensureSwipeShape(message);
  if (message.swipes[message.swipe_id] !== message.mes) {
    message.swipes[message.swipe_id] = message.mes;
  }
  message.swipes.push(text);
  message.swipe_info.push({ extra: { aeia_second_pass: true } });
  message.swipe_id = message.swipes.length - 1;
  message.mes = text;
  return message;
};

/* ── A message that has never been swiped ────────────────────────────────── */
{
  const m = { mes: 'She set the lamp down.', send_date: 1 };
  ensureSwipeShape(m);
  eq(m.swipes, ['She set the lamp down.'], 'a message with no swipes gets one holding what it says');
  eq(m.swipe_id, 0, 'pointing at it');
  eq(m.swipe_info.length, 1, 'with one entry of info beside it');
}

/* ── A message that has ─────────────────────────────────────────────────── */
{
  const info = [{ extra: { a: 1 } }, { extra: { b: 2 } }, { extra: { c: 3 } }];
  const m = { mes: 'second', swipes: ['first', 'second', 'third'], swipe_id: 1, swipe_info: info };
  ensureSwipeShape(m);
  eq(m.swipes, ['first', 'second', 'third'], 'existing takes are left exactly alone');
  eq(m.swipe_id, 1, 'and so is which one is showing');
  // The reason this is not `ensureSwipes`-style rebuilding: those objects hold
  // the generation timings of takes the reader already has.
  eq(m.swipe_info, info, 'and their info is the same info, not a fresh set of blanks');
}

/* ── Shapes that would otherwise corrupt something ───────────────────────── */
{
  const m = { mes: 'b', swipes: ['a', 'b'], swipe_id: 7, swipe_info: [{}, {}] };
  ensureSwipeShape(m);
  eq(m.swipe_id, 0, 'a swipe_id past the end is brought back in range rather than trusted');

  const short = { mes: 'c', swipes: ['a', 'b', 'c'], swipe_id: 2, swipe_info: [{ extra: { a: 1 } }] };
  ensureSwipeShape(short);
  eq(short.swipe_info.length, 3, 'missing info is padded');
  eq(short.swipe_info[0], { extra: { a: 1 } }, 'and what was there is kept');

  const long = { mes: 'a', swipes: ['a'], swipe_id: 0, swipe_info: [{}, {}, {}] };
  ensureSwipeShape(long);
  eq(long.swipe_info.length, 1, 'and a surplus is trimmed, so the two arrays cannot drift');

  const none = { mes: 'a', swipes: [], swipe_id: 0 };
  ensureSwipeShape(none);
  eq(none.swipes, ['a'], 'an empty swipe list is not a message with no text');
}

/* ── The promise: the original survives ──────────────────────────────────── */
{
  const m = addRevision({ mes: 'The lamp guttered.', send_date: 1 }, 'The lamp guttered once.');
  eq(m.mes, 'The lamp guttered once.', 'the message shows the revision');
  eq(m.swipes, ['The lamp guttered.', 'The lamp guttered once.'], 'with the original still there');
  eq(m.swipe_id, 1, 'and the pointer on the new one');
  ok(m.swipe_info.length === m.swipes.length, 'info keeps pace with takes');
  ok(m.swipe_info[1].extra.aeia_second_pass, 'the new take is marked as ours');

  // The case that makes the ordering matter: a reply edited by hand after it
  // was generated, so `mes` and `swipes[swipe_id]` disagree. Pushing without
  // parking `mes` first would leave the hand edit nowhere.
  const edited = {
    mes: 'What the reader typed.',
    swipes: ['What the model wrote.'],
    swipe_id: 0,
    swipe_info: [{}],
  };
  addRevision(edited, 'The revision.');
  ok(edited.swipes.includes('What the reader typed.'),
    'a hand edit is parked in its own slot before anything is added beside it');
  eq(edited.swipes.length, 2, 'and it replaces the stale take rather than growing a third');
  eq(edited.mes, 'The revision.', 'with the revision showing');
}

/* ── Twice over ──────────────────────────────────────────────────────────── */
{
  // Not a case the extension allows (one draft at a time, and a revision is
  // refused unless the message still matches what was sent) — but if it ever
  // did, nothing may be lost.
  const m = addRevision(addRevision({ mes: 'one', send_date: 1 }, 'two'), 'three');
  eq(m.swipes, ['one', 'two', 'three'], 'every version is still reachable');
  eq(m.swipe_id, 2, 'and the newest is showing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
