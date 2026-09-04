/**
 * Run: npx tsx src/utils/exeBridge.test.ts
 *
 * What the desktop bridge accepts off the wire.
 *
 * The Rust listener is deliberately ignorant: it moves opaque strings between
 * SillyTavern and the app and has no opinion about their shape, which is what
 * lets it be tested on its own with no dependencies. That puts the whole burden
 * of "is this actually a chat" here.
 *
 * The rule it enforces is that **an unrecognised payload is refused, never
 * coerced**. A chat with no file is not an empty chat, it is not a chat; a
 * report with no count is not zero applied, it is no report. Filling in a
 * default would turn a protocol mismatch into a silent wrong answer, and the
 * wrong answer in this direction is "SillyTavern applied your edits" when
 * nothing of the kind happened.
 */
import { desktopAddress, readApplied, readChat } from './exeBridge';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── A chat arriving ─────────────────────────────────────────────────────── */
{
  const body = { chatId: 'Carys - Branch #1', character: 'Carys', user: 'You', file: '{"a":1}\n', messageCount: 12 };

  const bare = readChat(JSON.stringify(body));
  eq(bare?.chatId, 'Carys - Branch #1', 'a chat posted as the whole body is read');
  eq(bare?.file, '{"a":1}\n', 'with its file intact — this is what gets parsed and imported');
  eq(bare?.messageCount, 12, 'and its count');

  // The extension posts the same envelope it would postMessage in a browser,
  // so the chat may be nested. Both shapes, one protocol.
  const wrapped = readChat(JSON.stringify({ type: 'chat', chat: body }));
  eq(wrapped?.chatId, 'Carys - Branch #1', 'or nested under `chat`, as the browser envelope has it');
  eq(wrapped?.file, '{"a":1}\n', 'read the same way');
}

/* ── …and everything that is not one ─────────────────────────────────────── */
{
  eq(readChat('not json'), null, 'nonsense is refused');
  eq(readChat('null'), null, 'so is null');
  eq(readChat('"a string"'), null, 'and a bare string');
  eq(readChat('[]'), null, 'and an array');
  eq(readChat(JSON.stringify({ chatId: 'a' })), null,
    'a chat with no file is not an empty chat — it is not a chat');
  eq(readChat(JSON.stringify({ file: 'x' })), null,
    'and a file with no id cannot be matched to a story, so it is refused too');

  // Wrong types are refused rather than coerced: `"12"` messages is a sign the
  // other end is not what we think it is.
  const odd = readChat(JSON.stringify({ chatId: 'a', file: 'x', messageCount: '12', character: 7 }));
  eq(odd?.messageCount, 0, 'an unusable count falls back rather than lying');
  eq(odd?.character, '', 'as does an unusable name');
}

/* ── What SillyTavern says it did ────────────────────────────────────────── */
{
  const good = readApplied(JSON.stringify({ applied: 3, skipped: [{ index: 4, reason: 'changed there' }] }));
  eq(good?.applied, 3, 'a report carries its count');
  eq(good?.skipped.length, 1, 'and what it would not do');
  eq(good?.skipped[0].reason, 'changed there', 'with the reason, which is the useful half');

  eq(readApplied(JSON.stringify({ skipped: [] })), null,
    'a report with no count is NOT zero applied — it is no report at all');
  eq(readApplied('{}'), null, 'nor is an empty object');
  eq(readApplied('boom'), null, 'nor is rubbish');

  const messy = readApplied(JSON.stringify({ applied: 0, skipped: [null, 'x', { index: 1 }] }));
  eq(messy?.skipped.length, 1, 'entries that are not objects are dropped');
  eq(messy?.skipped[0].reason, 'no reason given', 'and one without a reason still says something');

  eq(readApplied(JSON.stringify({ applied: 2 }))?.skipped.length, 0,
    'a report with nothing skipped is perfectly ordinary');
}

/* ── The address the reader copies ───────────────────────────────────────── */
{
  // 127.0.0.1 and not localhost: this is the address the listener is BOUND to,
  // and on a machine where localhost resolves to ::1 first the two are not
  // interchangeable.
  eq(desktopAddress(8770), 'http://127.0.0.1:8770', 'the address names the loopback address itself');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
