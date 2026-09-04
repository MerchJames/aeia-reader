/**
 * Tests for the SillyTavern bridge protocol.
 *
 * Everything this module reads comes from another origin, so nearly every test
 * here is an attack in miniature: a wildcard origin, a missing nonce, a nonce
 * that is nearly right, a payload the size of a hard drive. The module's only
 * job is to say no, in silence, without throwing — a thrown error from a
 * `message` handler is itself a way for an outside page to break the tab.
 *
 * The one that matters most is the wildcard: `readBridgeHandshake` returning a
 * handshake with `origin: '*'` would have us post the reader's entire chat log
 * to whatever page cared to listen. It is one character in a URL and it is the
 * whole security story, so it gets its own test with its own explanation.
 *
 * Run: npx tsx src/utils/stBridge.test.ts
 */

import {
  BRIDGE_PROTOCOL, BRIDGE_VERSION, MAX_CHAT_BYTES, MAX_EDITS,
  bothLoopback, describeApplied, envelope, pushProblem, readBridgeHandshake, readBridgeMessage,
  storageSplit, syncedStoryTitle } from './stBridge';
import type { PushEdit } from './stSync';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);
const nul = (got: unknown, what: string) => eq(got, null, what);

const NONCE = 'abcdefghijklmnop1234';
const ORIGIN = 'http://localhost:8000';

/* ------------------------------------------------------------------ */
/* The handshake                                                       */
/* ------------------------------------------------------------------ */

{
  const h = readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent(ORIGIN)}`);
  eq(h, { nonce: NONCE, origin: ORIGIN }, 'a well-formed handshake is read');

  eq(readBridgeHandshake(`${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent(ORIGIN)}`),
    { nonce: NONCE, origin: ORIGIN }, 'the leading # is optional');
}

{
  /**
   * The one that would give the whole thing away.
   *
   * `postMessage(data, '*')` delivers to whatever window is there. If a
   * wildcard could travel in through the fragment, any page could open Aeia
   * with it and receive the reader's entire chat log on the first handshake.
   */
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=*`),
    'a wildcard origin is refused — it would broadcast the chat to any listener');
}

{
  nul(readBridgeHandshake(''), 'an empty fragment is not a handshake');
  nul(readBridgeHandshake('#'), 'nor is a bare hash');
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}`), 'a handshake with no origin is refused');
  nul(readBridgeHandshake(`#origin=${encodeURIComponent(ORIGIN)}`), 'and one with no nonce is refused');
  nul(readBridgeHandshake('#somethingelse=x&origin=http://a.com'), 'an unrelated fragment is ignored');
}

{
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=short&origin=${encodeURIComponent(ORIGIN)}`),
    'a nonce too short to be a secret is refused');
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${'a'.repeat(200)}&origin=${encodeURIComponent(ORIGIN)}`),
    'and one absurdly long is too');
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=abcdefghijklmnop!!&origin=${encodeURIComponent(ORIGIN)}`),
    'a nonce with characters that could change the fragment’s meaning is refused');
}

{
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent('file:///tmp')}`),
    'a non-http origin is refused');
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent('javascript:alert(1)')}`),
    'and a javascript: one certainly is');
  nul(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent('http://localhost:8000/chat')}`),
    'a URL with a path is not an origin — accepting it would blur what we are addressing');
  eq(readBridgeHandshake(`#${BRIDGE_PROTOCOL}=${NONCE}&origin=${encodeURIComponent('https://tavern.example.com')}`),
    { nonce: NONCE, origin: 'https://tavern.example.com' }, 'a remote https origin is fine');
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const wrap = (body: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ protocol: BRIDGE_PROTOCOL, v: BRIDGE_VERSION, nonce: NONCE, ...body, ...over });

const CHAT = {
  chatId: '2026-01-01 @00h', character: 'Vera', user: 'You',
  file: '{"character_name":"Vera"}\n{"name":"Vera","mes":"Hello."}',
  messageCount: 1,
};

{
  const got = readBridgeMessage(wrap({ type: 'chat', chat: CHAT }), NONCE);
  eq(got, { type: 'chat', chat: CHAT }, 'a chat message is read');
}

{
  nul(readBridgeMessage(wrap({ type: 'chat', chat: CHAT }), 'a-different-nonce-here'),
    'a message with the wrong nonce is dropped');
  nul(readBridgeMessage(wrap({ type: 'chat', chat: CHAT }, { nonce: undefined }), NONCE),
    'a message with no nonce at all is dropped');
  nul(readBridgeMessage(wrap({ type: 'chat', chat: CHAT }), ''),
    'and no nonce on OUR side never matches — an unhandshaken window accepts nothing');
}

{
  nul(readBridgeMessage(wrap({ type: 'chat', chat: CHAT }, { protocol: 'something-else' }), NONCE),
    'another protocol sharing the channel is ignored');
  nul(readBridgeMessage(wrap({ type: 'chat', chat: CHAT }, { v: BRIDGE_VERSION + 1 }), NONCE),
    'a newer protocol version is refused rather than half-understood');
  nul(readBridgeMessage(wrap({ type: 'nonsense' }), NONCE), 'an unknown type is ignored');
}

{
  // Nothing that arrives may throw: this runs inside a `message` handler.
  const junk = [null, undefined, 0, '', 'string', [], [1, 2], true, { a: 1 }, new Date()];
  let threw = false;
  for (const j of junk) {
    try { readBridgeMessage(j, NONCE); } catch { threw = true; }
  }
  ok(!threw, 'no shape of junk makes the reader throw');
  for (const j of junk) nul(readBridgeMessage(j, NONCE), `junk is refused: ${JSON.stringify(j)}`);
}

{
  nul(readBridgeMessage(wrap({ type: 'chat', chat: { ...CHAT, file: '' } }), NONCE),
    'a chat with no file is not a chat');
  nul(readBridgeMessage(wrap({ type: 'chat', chat: { ...CHAT, file: 'x'.repeat(MAX_CHAT_BYTES + 1) } }), NONCE),
    'and one over the size cap is refused before anything tries to parse it');
  nul(readBridgeMessage(wrap({ type: 'chat', chat: 'not-an-object' }), NONCE),
    'a chat that is not an object is refused');
}

{
  // Missing fields are filled rather than refused: they are labels, and losing
  // a character's name is not worth losing the chat over.
  const got = readBridgeMessage(wrap({ type: 'chat', chat: { file: CHAT.file } }), NONCE);
  eq(got, {
    type: 'chat',
    chat: { chatId: '', character: '', user: '', file: CHAT.file, messageCount: 0 },
  }, 'missing labels default rather than sink the message');
}

{
  const got = readBridgeMessage(
    wrap({ type: 'applied', applied: 3, skipped: [{ index: 4, reason: 'changed since' }] }), NONCE);
  eq(got, { type: 'applied', applied: 3, skipped: [{ index: 4, reason: 'changed since' }] },
    'a result comes back with its skips');

  eq(readBridgeMessage(wrap({ type: 'applied' }), NONCE),
    { type: 'applied', applied: 0, skipped: [] }, 'a bare result is still readable');
  eq(readBridgeMessage(wrap({ type: 'applied', applied: 1, skipped: [{}] }), NONCE),
    { type: 'applied', applied: 1, skipped: [{ index: -1, reason: 'no reason given' }] },
    'a skip with nothing in it still says something');
}

{
  eq(readBridgeMessage(wrap({ type: 'error', message: 'chat is closed' }), NONCE),
    { type: 'error', message: 'chat is closed' }, 'an error comes through');
  eq(readBridgeMessage(wrap({ type: 'error' }), NONCE),
    { type: 'error', message: 'SillyTavern reported an error' },
    'and a blank one still says something the reader can act on');
}


/* ------------------------------------------------------------------ */
/* Drafts — a reply handed over for a second pass                      */
/* ------------------------------------------------------------------ */

const DRAFT = { index: 7, text: 'Vera turned toward the door.', name: 'Vera', chatId: 'c1' };

{
  eq(readBridgeMessage(wrap({ type: 'draft', draft: DRAFT }), NONCE),
    { type: 'draft', draft: DRAFT }, 'a draft is read');
}

{
  nul(readBridgeMessage(wrap({ type: 'draft', draft: { ...DRAFT, text: '' } }), NONCE),
    'a draft with no text is not a reply');
  nul(readBridgeMessage(wrap({ type: 'draft', draft: { ...DRAFT, text: 'x'.repeat(MAX_CHAT_BYTES + 1) } }), NONCE),
    'and one past the size cap is refused before anything parses it');
  nul(readBridgeMessage(wrap({ type: 'draft', draft: 'nope' }), NONCE),
    'a draft that is not an object is refused');
}

{
  /**
   * The index is the only thing tying a revision back to a message.
   *
   * A draft with a missing, fractional or negative position cannot be applied
   * to anything, and guessing would mean writing a revision over whichever
   * message happened to be nearby.
   */
  for (const index of [undefined, null, -1, 1.5, NaN, '7', Infinity]) {
    nul(readBridgeMessage(wrap({ type: 'draft', draft: { ...DRAFT, index } }), NONCE),
      `a draft indexed ${JSON.stringify(index)} is refused rather than guessed at`);
  }
}

{
  // The labels are optional; losing a speaker's name is not worth losing the
  // reply over, and the index carries the identity.
  const got = readBridgeMessage(
    wrap({ type: 'draft', draft: { index: 0, text: 'Hi.' } }), NONCE);
  eq(got, { type: 'draft', draft: { index: 0, text: 'Hi.', name: '', chatId: '' } },
    'missing labels default rather than sink a draft');
}

/* ------------------------------------------------------------------ */
/* The envelope                                                        */
/* ------------------------------------------------------------------ */

{
  const e = envelope(NONCE, { type: 'hello' });
  eq(e, { protocol: BRIDGE_PROTOCOL, v: BRIDGE_VERSION, nonce: NONCE, type: 'hello' },
    'the envelope stamps protocol, version and nonce');

  // The round trip is the real test: what one side sends, the other reads.
  const edits: PushEdit[] = [{ index: 2, text: 'New.', was: 'Old.' }];
  const sent = envelope(NONCE, { type: 'apply', edits, label: 'Vera' });
  eq(sent.type, 'apply', 'an apply keeps its type through the envelope');
  eq(sent.edits, edits, 'and carries its edits unchanged');
}

/* ------------------------------------------------------------------ */
/* Refusing a bad push before it leaves                                */
/* ------------------------------------------------------------------ */

{
  nul(pushProblem([{ index: 0, text: 'Fine.', was: 'Old.' }]), 'an ordinary push is fine');

  ok(!!pushProblem([]), 'an empty push is refused — there is nothing to send');
  ok(pushProblem([])!.includes('Nothing to send'), 'and says so plainly');
}

{
  const blank: PushEdit[] = [{ index: 0, text: '   ', was: 'Something.' }];
  ok(!!pushProblem(blank),
    'an edit that would blank a message is refused — nothing here is for erasing');

  ok(!!pushProblem([{ index: -1, text: 'x', was: '' }]), 'a negative position is refused');
  ok(!!pushProblem([{ index: 1.5, text: 'x', was: '' }]), 'so is a fractional one');

  const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({ index: i, text: 'x', was: '' }));
  ok(!!pushProblem(many), 'an implausible number of edits is refused rather than sent');
}

{
  // An empty `was` is legitimate — ST allows an empty message, and an edit that
  // fills one in is exactly the kind of repair this feature is for.
  nul(pushProblem([{ index: 3, text: 'Filled in.', was: '' }]),
    'an empty previous value is allowed; only an empty NEW value is not');
}

/* ------------------------------------------------------------------ */
/* Reporting back                                                      */
/* ------------------------------------------------------------------ */

{
  eq(describeApplied(1, []), '1 message updated in SillyTavern.', 'the singular reads properly');
  eq(describeApplied(4, []), '4 messages updated in SillyTavern.', 'and so does the plural');
  ok(describeApplied(4, [{ index: 1, reason: 'changed' }]).includes('1 skipped'),
    'skips are surfaced, not swallowed — a silent skip reads as a silent failure');
  ok(describeApplied(0, [{ index: 1, reason: 'x' }, { index: 2, reason: 'y' }]).includes('they had'),
    'and the wording agrees with itself in the plural');
}

/* ── Two chats with one character are two different stories ─────────────── */
{
  /*
   * The importer names a SillyTavern story after its CHARACTER, so every chat
   * with Carys imports as "Carys". With one chat that is right; with five it is
   * five identical rows in the library and no way to tell which is which — and
   * a whole-library sync makes five the normal case.
   *
   * The bug this came from: the panel auto-opened a story by matching the
   * character name, picked a DIFFERENT Carys chat, and offered to write one
   * conversation over another.
   */
  eq(syncedStoryTitle('Carys', '2025-10-13 @00h 45m 12s 743ms - Branch #1'), 'Carys · Branch #1',
    'the tail the writer chose is the name');
  eq(syncedStoryTitle('Carys', '2025-10-13 @00h 45m 12s 743ms'), 'Carys · 2025-10-13',
    'with no tail, the date at least answers "which one"');
  eq(syncedStoryTitle('Elara', 'Elara'), 'Elara',
    'a chat named after its character needs no suffix');
  eq(syncedStoryTitle('Elara', 'elara'), 'Elara', 'whatever its case');
  eq(syncedStoryTitle('', 'loose chat'), 'loose chat', 'no character, just the chat');
  eq(syncedStoryTitle('Carys', ''), 'Carys', 'no chat id, just the character');
  eq(syncedStoryTitle('', ''), 'SillyTavern chat', 'and neither leaves something to show');

  // Distinctness is the whole point.
  const names = [
    '2025-10-13 @00h - Branch #1',
    '2025-10-13 @00h - Branch #2',
    '2025-10-14 @09h',
  ].map(id => syncedStoryTitle('Carys', id));
  eq(new Set(names).size, 3, 'three chats with one character get three names');
}

/* ── The partitioned-storage trap ─────────────────────────────────────────── */
{
  /*
   * The failure this detects is silent by construction: the frame's library
   * reads as a working, empty one, imports into it succeed and report success,
   * and only the reader — looking at a tab that never changes — can tell that
   * anything is wrong. So the test is about not crying wolf as much as about
   * catching it.
   */
  eq(storageSplit('http://localhost:3000/#x', 'http://localhost:8000'), null,
    'a different PORT is the same site — never report one');
  eq(storageSplit('https://aeia.example.com/', 'https://aeia.example.com'), null,
    'and the same host is the same host');

  const split = storageSplit('http://localhost:3000/#aeia=1', 'http://127.0.0.1:8000');
  ok(!!split, 'localhost framed by 127.0.0.1 IS two sites, however much it looks like one machine');
  eq(split?.here, 'http://localhost:3000', 'it names where the frame is');
  eq(split?.there, 'http://127.0.0.1:8000', 'and where SillyTavern is');
  eq(split?.suggested, 'http://127.0.0.1:3000',
    'and the address that makes them agree — SillyTavern\'s host, Aeia\'s port');
  ok(!split?.suggested.includes('aeia=1'), 'with no handshake nonce carried into a link');

  eq(storageSplit('http://localhost:3000/', null), null,
    'no handshake, no claim — this is only ever asked inside a frame');
  eq(storageSplit('not a url', 'http://127.0.0.1:8000'), null, 'and nonsense is not a finding');

  ok(bothLoopback('http://localhost:3000', 'http://127.0.0.1:8000'),
    'two names for this machine are recognised as such');
  ok(!bothLoopback('http://localhost:3000', 'https://example.com'),
    'a real remote host is not');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
