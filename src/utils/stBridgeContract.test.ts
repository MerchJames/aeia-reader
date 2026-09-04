/**
 * The contract between Aeia and the SillyTavern extension.
 *
 * These two are separate codebases in separate repositories running in separate
 * browser tabs, and between them sits exactly one shared assumption:
 *
 *     the extension writes ONE header line before the messages,
 *     so SillyTavern's `chat[i]` is the file's line `i + 1`.
 *
 * Aeia addresses every edit by file line. The extension subtracts one and
 * writes. If that number is ever wrong, the sync writes the reader's rewrite
 * over the message BESIDE the one they rewrote — a wrong write, in someone's
 * chat log, that looks like a successful sync.
 *
 * Nothing in either codebase's own tests can catch that, because each side is
 * self-consistent. So this file plays both parts: it builds the file the way
 * `st-extension/aeia-bridge/index.js` builds it, runs it through the real Aeia
 * engine, and then applies the resulting edits with the extension's own index
 * arithmetic — asserting that every edit lands on the message Aeia meant.
 *
 * ⚠ The two helpers at the top are MIRRORS of the extension's `buildChatFile`
 * and `planEdits`. They are copied deliberately, because the extension cannot
 * be imported here (it imports SillyTavern's `script.js` at module scope). If
 * you change either function in the extension, change it here — that is the
 * cost of the two halves living apart, and it is cheaper than the bug.
 *
 * Run: npx tsx src/utils/stBridgeContract.test.ts
 */

import { resolveContent } from './lens';
import { messageFromStObject } from './parser';
import { planPull } from './stApply';
import {
  alignSync, mergeToFile, parseStFile, pushEdits, type OurMessage, type PushEdit,
} from './stSync';
import type { Message, MessageOverride } from '../types';

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

/* ------------------------------------------------------------------ */
/* Mirrors of the extension                                            */
/* ------------------------------------------------------------------ */

/** SillyTavern's in-memory message, reduced to the fields that matter here. */
interface StChatMessage {
  name: string;
  is_user?: boolean;
  is_system?: boolean;
  mes: string;
  swipes?: string[];
  swipe_id?: number;
  extra?: Record<string, unknown>;
  send_date?: string;
}

/**
 * Mirror of the extension's `HEADER_LINES`. The number this file is about.
 *
 * VERIFIED against SillyTavern 1.18.0 source rather than assumed:
 *
 *   `public/script.js`, in `saveChat`:
 *       chat: [chatHeader, ...trimmedChat]
 *
 * Exactly one header object precedes the messages, so SillyTavern's `chat[i]`
 * is the file's line `i + 1`. The server writes that array with one
 * `JSON.stringify` per element (`src/endpoints/chats.js`, `trySaveChat`), so
 * the on-disk line numbering is the array's own.
 *
 * If a future SillyTavern writes two header lines, this constant is the single
 * place that has to change — and the tests below fail loudly rather than the
 * sync quietly writing every edit one message early.
 */
const HEADER_LINES = 1;

/** Mirror of the extension's `buildChatFile()`. */
const buildChatFile = (chat: StChatMessage[], name1: string, name2: string): string => {
  const header = { user_name: name1, character_name: name2, create_date: '', chat_metadata: {} };
  return [JSON.stringify(header), ...chat.map(m => JSON.stringify(m))].join('\n') + '\n';
};

interface Planned { at: number; index: number; before: string; text: string }

/** Mirror of the extension's `planEdits()` — the arithmetic under test. */
const planEdits = (chat: StChatMessage[], edits: readonly PushEdit[]) => {
  const planned: Planned[] = [];
  const skipped: { index: number; reason: string }[] = [];
  for (const edit of edits) {
    const at = edit.index - HEADER_LINES;
    const message = chat[at];
    if (!message) { skipped.push({ index: edit.index, reason: 'no such message' }); continue; }
    if (!edit.text.trim()) { skipped.push({ index: edit.index, reason: 'would blank' }); continue; }
    if (typeof edit.was === 'string' && message.mes !== edit.was) {
      skipped.push({ index: edit.index, reason: 'changed since' });
      continue;
    }
    if (message.mes === edit.text) { skipped.push({ index: edit.index, reason: 'already says this' }); continue; }
    planned.push({ at, index: edit.index, before: message.mes, text: edit.text });
  }
  return { planned, skipped };
};

/** Mirror of the extension's `writeEdits()`, including the swipe rule. */
const writeEdits = (chat: StChatMessage[], planned: readonly Planned[]) => {
  for (const item of planned) {
    const message = chat[item.at];
    message.mes = item.text;
    if (Array.isArray(message.swipes) && message.swipes.length) {
      const found = message.swipes.indexOf(item.text);
      if (found !== -1) { message.swipe_id = found; continue; }
      const slot = Number.isInteger(message.swipe_id)
        && message.swipe_id! >= 0 && message.swipe_id! < message.swipes.length
        ? message.swipe_id! : 0;
      message.swipes[slot] = item.text;
    }
  }
};

/* ------------------------------------------------------------------ */
/* A chat with every awkward thing in it                               */
/* ------------------------------------------------------------------ */

/**
 * Not a tidy fixture on purpose.
 *
 * The alignment is by position, so anything that makes one side count
 * differently from the other is exactly what breaks it: a system/narrator line,
 * a message with alternates, a message that is nothing but an image, and a
 * message whose text repeats one earlier in the chat.
 */
const makeChat = (): StChatMessage[] => ([
  { name: 'Vera', is_user: false, mes: 'The gate was open.', send_date: 'a' },
  { name: 'You', is_user: true, mes: 'I go in.', send_date: 'b' },
  { name: 'Vera', is_user: false, mes: 'Dust. Then a sound.', swipes: ['Dust. Then a sound.', 'Dust, and a sound.'], swipe_id: 0, send_date: 'c' },
  { name: 'System', is_user: false, is_system: true, mes: '[The lamps go out.]', send_date: 'd' },
  { name: 'Vera', is_user: false, mes: '', extra: { image: 'data:image/png;base64,AAAA' }, send_date: 'e' },
  { name: 'You', is_user: true, mes: 'I go in.', send_date: 'f' },
  { name: 'Vera', is_user: false, mes: 'Nothing moved.', send_date: 'g' },
]);

/** Aeia's side: import the same file the way the reader's library did. */
const importStory = (file: string): Message[] => {
  const out: Message[] = [];
  for (const raw of file.split('\n').filter(l => l.trim())) {
    const parsed = JSON.parse(raw);
    const m = messageFromStObject(parsed, `m${out.length}`, { characterName: 'Vera', userName: 'You' });
    if (m) out.push(m);
  }
  return out;
};

const ourSide = (messages: readonly Message[], overrides: MessageOverride[]): OurMessage[] =>
  messages.map(m => ({
    id: m.id,
    original: m.content,
    current: resolveContent(m, overrides, true),
    name: m.name,
  }));

const override = (messageId: string, content: string): MessageOverride =>
  ({ messageId, kind: 'rewrite', content, source: 'user', createdAt: 1 });

/* ------------------------------------------------------------------ */
/* The image-only message: where the two sides used to disagree        */
/* ------------------------------------------------------------------ */

{
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);

  // Every one of ST's messages is a message here, including the empty one that
  // carries an image. If Aeia dropped it, every position after it would be off
  // by one — which is the bug the shared `messageFromStObject` rule prevents.
  eq(messages.length, chat.length,
    'Aeia counts exactly as many messages as SillyTavern has — including the image-only one');
  eq(messages.map(m => m.content), chat.map(m => m.mes), 'and in the same order, with the same text');
}

{
  /**
   * The regression this is really guarding, in all four spellings.
   *
   * SillyTavern attaches pictures under four different keys depending on how
   * they got there — generated, uploaded, inlined by a vision model, swiped.
   * `stSync` used to carry its own copy of the "is this a message" filter that
   * knew about only two of them, so a chat containing a message that was
   * nothing but an `inline_image` counted as 7 messages in the importer and 6
   * in the aligner. Every position after it was off by one, and the sync would
   * cheerfully offer to write each of the reader's rewrites over the message
   * before the one they had rewritten.
   *
   * It is fixed by both sides asking `messageFromStObject`, so what this
   * asserts is that all four keys still agree — the moment one of them is
   * handled somewhere else, this fails.
   */
  const spellings: Record<string, unknown>[] = [
    { image: 'data:image/png;base64,AA' },
    { inline_image: 'data:image/png;base64,AA' },
    { images: ['data:image/png;base64,AA'] },
    { image_swipes: ['data:image/png;base64,AA'] },
  ];

  for (const extra of spellings) {
    const chat: StChatMessage[] = [
      { name: 'Vera', mes: 'Before.' },
      { name: 'Vera', mes: '', extra },
      { name: 'Vera', mes: 'After.' },
    ];
    const file = buildChatFile(chat, 'You', 'Vera');
    const messages = importStory(file);
    const key = Object.keys(extra)[0];

    eq(messages.length, 3, `a message carrying only an ${key} still counts as a message`);

    // And the alignment therefore stays in step: the rewrite of the LAST
    // message must be aimed at the last message.
    const rows = alignSync(ourSide(messages, [override(messages[2].id, 'After, changed.')]),
      parseStFile(file));
    const { planned } = planEdits(chat, pushEdits(rows).edits);
    eq(planned.map(p => p.at), [2],
      `and an edit after an ${key}-only message still lands on the right one`);
  }
}

/* ------------------------------------------------------------------ */
/* A round trip that actually writes                                   */
/* ------------------------------------------------------------------ */

{
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);

  // The reader rewrites two passages in the Lens: one plain, and one that has
  // alternates, which is the case with a second place to write.
  const overrides = [
    override(messages[0].id, 'The gate stood open.'),
    override(messages[2].id, 'Dust, and then a sound behind her.'),
  ];

  const rows = alignSync(ourSide(messages, overrides), parseStFile(file));
  const { edits, unresolved } = pushEdits(rows);

  eq(unresolved, 0, 'no conflicts: SillyTavern has not touched these');
  eq(edits.length, 2, 'two edits to push');

  // ── The claim this file exists to check ──────────────────────────────────
  const { planned, skipped } = planEdits(chat, edits);
  eq(skipped, [], 'the extension skips none of them');
  eq(planned.map(p => p.at), [0, 2],
    'each edit lands on the SillyTavern message Aeia meant — index − 1, exactly');
  eq(planned.map(p => p.before), ['The gate was open.', 'Dust. Then a sound.'],
    'and the text it is replacing is the text that was there');

  writeEdits(chat, planned);
  eq(chat[0].mes, 'The gate stood open.', 'the first rewrite landed');
  eq(chat[2].mes, 'Dust, and then a sound behind her.', 'and the second');
  eq(chat[1].mes, 'I go in.', 'the message between them is untouched');
  eq(chat[6].mes, 'Nothing moved.', 'and so is the one after');

  // The swipe rule: `mes` and the CURRENT alternate move together, and the
  // other alternate is left exactly as the model generated it.
  eq(chat[2].swipes, ['Dust, and then a sound behind her.', 'Dust, and a sound.'],
    'the live alternate is updated with mes, so swiping away and back keeps the edit');
  eq(chat[2].swipe_id, 0, 'and the selection does not move');
}

/* ------------------------------------------------------------------ */
/* The live path and the file path agree, edit for edit                */
/* ------------------------------------------------------------------ */

{
  /**
   * Two ways to push, one merge.
   *
   * If these ever disagree, one of them writes something the reader did not
   * approve in the other — which is precisely why `pushEdits` was split out of
   * `mergeToFile` rather than duplicated into it.
   */
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);
  const overrides = [override(messages[3].id, '[The lamps gutter and go out.]')];
  const lines = parseStFile(file);
  const rows = alignSync(ourSide(messages, overrides), lines);

  // Path A: the merged file, applied the way the extension's file button does.
  const merged = mergeToFile(lines, rows);
  const mergedBody = merged.text.split('\n').filter(l => l.trim()).slice(HEADER_LINES);
  eq(mergedBody.length, chat.length, 'the merged file has one line per message, still');
  const viaFile = mergedBody.map(l => JSON.parse(l).mes);

  // Path B: the live bridge.
  const liveChat = makeChat();
  const { planned } = planEdits(liveChat, pushEdits(rows).edits);
  writeEdits(liveChat, planned);
  const viaBridge = liveChat.map(m => m.mes);

  eq(viaBridge, viaFile, 'the live bridge and the merged file produce the identical chat');
  eq(viaFile[3], '[The lamps gutter and go out.]', 'and both wrote the edit that was asked for');
}

/* ------------------------------------------------------------------ */
/* Staleness: the guard that makes a wrong index harmless              */
/* ------------------------------------------------------------------ */

{
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);
  const overrides = [override(messages[6].id, 'Nothing moved at all.')];
  const rows = alignSync(ourSide(messages, overrides), parseStFile(file));
  const { edits } = pushEdits(rows);

  // Between Aeia reading the chat and the reader pressing the button, the user
  // swiped in SillyTavern. The message at that position now says something else.
  const moved = makeChat();
  moved[6].mes = 'Nothing moved, yet.';

  const { planned, skipped } = planEdits(moved, edits);
  eq(planned, [], 'a message that changed here since is not overwritten');
  eq(skipped.map(s => s.reason), ['changed since'], 'it is refused, out loud, with a reason');
  eq(moved[6].mes, 'Nothing moved, yet.', 'and what the user wrote in SillyTavern still stands');
}

{
  /**
   * The failure mode the whole file is insurance against.
   *
   * Suppose the header assumption were wrong — a build of the extension that
   * wrote two header lines, say. Every edit would be aimed one message early.
   * `was` is what turns that from a wrong write into a visible refusal.
   */
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);
  const overrides = [override(messages[2].id, 'Dust, and a held breath.')];
  const rows = alignSync(ourSide(messages, overrides), parseStFile(file));
  const { edits } = pushEdits(rows);

  const offByOne = edits.map(e => ({ ...e, index: e.index + 1 }));
  const { planned, skipped } = planEdits(chat, offByOne);
  eq(planned, [], 'an edit aimed at the wrong message writes nothing');
  ok(skipped.length === 1, 'it is reported instead');
  eq(chat.map(m => m.mes), makeChat().map(m => m.mes), 'and the chat is untouched');
}

/* ------------------------------------------------------------------ */
/* The other direction: what ST gained comes back cleanly              */
/* ------------------------------------------------------------------ */

{
  const chat = makeChat();
  const file = buildChatFile(chat, 'You', 'Vera');
  const messages = importStory(file);

  // The reader keeps playing in SillyTavern: two more messages, and a re-swipe
  // of one they already had.
  const later = makeChat();
  later[2].mes = 'Dust, and a sound.';
  later[2].swipe_id = 1;
  later.push({ name: 'You', is_user: true, mes: 'I call out.' });
  later.push({ name: 'Vera', is_user: false, mes: 'No one answers.' });

  const rows = alignSync(ourSide(messages, []), parseStFile(buildChatFile(later, 'You', 'Vera')));
  let n = 0;
  const plan = planPull(rows, messages, () => `new-${n++}`, { characterName: 'Vera', userName: 'You' });

  eq(plan.added, 2, 'both new messages come in');
  eq(plan.updated, 1, 'and the re-swipe is taken');
  eq(plan.messages.length, later.length, 'the story now has what SillyTavern has');
  eq(plan.messages.map(m => m.content), later.map(m => m.mes), 'text for text');
  eq(plan.messages.slice(0, 7).map(m => m.id), messages.map(m => m.id),
    'and every message that already existed kept its id, so highlights survive');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
