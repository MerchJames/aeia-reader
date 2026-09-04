/**
 * Run: npx tsx src/utils/agentLoop.test.ts
 *
 * The turn that runs itself.
 *
 * A loop that talks to a model has exactly one catastrophic failure mode and it
 * is not a crash: it is a turn that never ends, spending the reader's tokens on
 * a model asking for the same pin forty times. Everything here is a fence
 * around that — the step cap, the repeat cache, and compaction, which is the
 * one that turns a long turn from expensive into impossible if it is missing,
 * because every tool result is re-sent on every subsequent step.
 *
 * The second failure mode is quieter and worse. A write lands, then the turn
 * runs out of steps, and the loop returns nothing — so the reader is told
 * nothing happened while a pin has silently gained a version. Every exit from
 * this loop is asserted to report the steps it took.
 *
 * `send` is a script, not a model, so all of it is deterministic.
 */
import {
  KEEP_TAIL, MAX_STEPS, SUMMARY_PREFIX,
  applyCompaction, buildCompactMessages, clip, estimateChars,
  runAgentTurn, shouldCompact, workingBudget,
} from './agentLoop';
import type { ToolContext } from './agentTools';
import type { ChatMsg } from './aiClient';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const fence = (body: string) => '```aura-tool\n' + body + '\n```';

let written = 0;
const ctx: ToolContext = {
  messageCount: 10,
  listPins: () => [{
    id: 'pin-a1', title: 'Account', format: 'markdown', content: 'the old text',
    versionCount: 1, activeVersion: 0, inContext: true,
  }],
  listZones: () => [{ id: 'z-1', name: 'Act I', summary: 'msg 1–5' }],
  buildZone: () => ({ name: 'Act I', body: 'ACT ONE', messageCount: 5, branchlineCount: 0, empty: false }),
  readStory: (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    index: from + i, name: 'Mara', content: `beat ${from + i}`,
  })),
  searchStory: () => [],
  listCodex: () => [],
  listSheets: () => [],
  createPin: () => 'pin-new',
  addPinVersion: () => { written++; return 2; },
  listLens: () => [],
  proposeLens: (target, _content, _note) => ({
    index: target, name: 'Mara', before: `beat ${target}`, noop: false,
  }),
};

/** A `send` that replays a script, and records what it was asked. */
const scripted = (replies: string[]) => {
  const sent: ChatMsg[][] = [];
  let i = 0;
  const send = async (messages: ChatMsg[]) => {
    sent.push(messages);
    return replies[Math.min(i++, replies.length - 1)];
  };
  return { send, sent, calls: () => i };
};

/* ------------------------------------------------------------------ */
/* Terminating                                                         */
/* ------------------------------------------------------------------ */

// The base case, and the whole basis of the protocol: no directive, so the
// reply IS the answer and the loop stops after one call.
{
  const s = scripted(['Mara leaves before dawn.']);
  const r = await runAgentTurn({ system: 'SYS', history: [{ role: 'user', content: 'who is Mara?' }], ctx, send: s.send });
  eq(r.text, 'Mara leaves before dawn.', 'a plain reply is the answer');
  eq(r.stop, 'answer', 'and the turn is over');
  eq(r.steps.length, 0, 'having run nothing');
  eq(s.calls(), 1, 'in exactly one request');
}

// Read, then answer. The tool result must actually reach the second request —
// a loop that runs a tool and forgets to send the output is a loop that looks
// like it works and answers from nothing.
{
  const s = scripted([
    `Let me check.\n${fence('{"tool": "pins.read", "pin": "pin-a1"}')}`,
    'It currently says "the old text".',
  ]);
  const r = await runAgentTurn({ system: 'SYS', history: [{ role: 'user', content: 'what does the pin say?' }], ctx, send: s.send });
  eq(r.steps.length, 1, 'one tool ran');
  eq(r.stop, 'answer', 'and then it answered');
  eq(r.text, 'It currently says "the old text".', 'with the final reply, not the prose from step one');
  const second = s.sent[1];
  ok(second.some(m => m.content.includes('TOOL RESULT (pins.read)')),
    'and the second request carries the result the model asked for');
  ok(second.some(m => m.content.includes('the old text')), 'including its content');
  eq(second[0].role, 'system', 'the system prompt leads every request');
  eq(second[0].content, 'SYS', 'unchanged — it is the story, and it is never edited');
}

/* ------------------------------------------------------------------ */
/* Not terminating                                                     */
/* ------------------------------------------------------------------ */

// The runaway. A model that only ever emits a directive must be stopped by the
// cap, and must still report what it did on the way.
{
  const s = scripted([fence('{"tool": "story.read", "from": 1, "to": 3}')]);
  const r = await runAgentTurn({
    system: 'SYS', history: [{ role: 'user', content: 'go' }], ctx, send: s.send, maxSteps: 4,
  });
  eq(r.stop, 'max-steps', 'the cap ends a turn that will not end itself');
  eq(s.calls(), 4, 'after exactly the number of steps allowed');
  ok(r.steps.length > 0, 'and the steps it took are reported, never swallowed');
}

// The commonest loop, broken before the cap has to: the same call twice.
// Asserted through a tool that COUNTS, so a second real execution would show.
{
  const s = scripted([
    fence('{"tool": "pins.newVersion", "pin": "pin-a1", "content": "new text"}'),
    fence('{"tool": "pins.newVersion", "pin": "pin-a1", "content": "new text"}'),
    'Done — I updated it.',
  ]);
  written = 0;
  const r = await runAgentTurn({ system: 'SYS', history: [{ role: 'user', content: 'update it' }], ctx, send: s.send });
  eq(written, 1, 'an identical repeat is answered from cache, not run again');
  eq(r.steps.length, 2, 'both attempts are still shown to the reader');
  eq(r.steps[1].result.repeated, true, 'the second is marked as a repeat');
  ok(String(r.steps[1].result.note).includes('already ran'),
    'and the model is told, so it stops asking');
}

// A write landed and then the model went quiet. The reader must not be left
// believing nothing happened.
{
  const s = scripted([
    fence('{"tool": "pins.newVersion", "pin": "pin-a1", "content": "x"}'),
    '',
  ]);
  written = 0;
  const r = await runAgentTurn({ system: 'SYS', history: [{ role: 'user', content: 'go' }], ctx, send: s.send });
  eq(written, 1, 'the write happened');
  eq(r.steps.length, 1, 'and the step survives an empty final reply');
  eq(r.stop, 'empty', 'which is reported as its own outcome, not as an answer');
}

// Abort mid-turn returns what it had rather than throwing into the panel.
{
  const controller = new AbortController();
  const s = scripted([fence('{"tool": "story.read", "from": 1, "to": 2}')]);
  const send = async (m: ChatMsg[]) => { controller.abort(); return s.send(m); };
  const r = await runAgentTurn({
    system: 'SYS', history: [{ role: 'user', content: 'go' }], ctx, send, signal: controller.signal,
  });
  eq(r.stop, 'aborted', 'stopping is an outcome, not an exception');
}

/* ------------------------------------------------------------------ */
/* Compaction                                                          */
/* ------------------------------------------------------------------ */

{
  const msgs: ChatMsg[] = [{ role: 'user', content: 'x'.repeat(100) }];
  eq(estimateChars(msgs), 100, 'the estimate is the text');

  // The system prompt is the story, and it is what actually fills the window.
  eq(workingBudget(0, 8000, 0), 32_000, 'an empty system prompt leaves the whole window');
  ok(workingBudget(30_000, 8000, 500) < 32_000, 'a big story leaves less room for the conversation');
  ok(workingBudget(40_000, 8000, 0) < 0,
    'and a story that alone overruns the window reports a negative budget');
  eq(shouldCompact([...Array(9)].map(() => msgs[0]), -1), false,
    'which never triggers compaction — folding the conversation cannot fix the story');
}

{
  const many: ChatMsg[] = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  eq(shouldCompact(many, 1_000_000), false, 'a conversation inside its budget is left alone');
  eq(shouldCompact(many, 5), true, 'one over it is folded');
  eq(shouldCompact(many.slice(0, 2), 5), false,
    'but never one too short to have a head worth folding');
}

{
  const working: ChatMsg[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = applyCompaction(working, 'we read the pin and it needs the tavern scene');
  eq(out.length, KEEP_TAIL + 1, 'a compaction is the note plus the tail');
  ok(out[0].content.startsWith(SUMMARY_PREFIX), 'the note says what it is');
  ok(out[0].content.includes('tavern'), 'and carries the summary');
  eq(out[out.length - 1].content, 'm9', 'the newest message survives verbatim');
  eq(out[1].content, 'm6', `the last ${KEEP_TAIL} do`);
  eq(applyCompaction(working, '   ').length, working.length,
    'and a summary that came back empty changes nothing rather than erasing the turn');
}

{
  const head: ChatMsg[] = [{ role: 'user', content: 'find the ledger' }];
  const built = buildCompactMessages('SYS', head);
  ok(built[0].content.startsWith('SYS'), 'compacting keeps the story in view');
  ok(/pin ids, message numbers/.test(built[0].content),
    'and names the values that must survive the fold');
  ok(built[1].content.includes('find the ledger'), 'the work so far is what gets summarised');
}

// End to end: a turn long enough to overrun its budget folds itself and keeps
// going. The script answers by ROLE rather than by position — a compaction is
// an extra request in the middle of the turn, and a positional script would
// silently hand the loop the wrong reply the moment one fired.
{
  const reads = [
    fence('{"tool": "story.read", "from": 1, "to": 5}'),
    fence('{"tool": "story.read", "from": 6, "to": 10}'),
    fence('{"tool": "story.read", "from": 2, "to": 4}'),
    fence('{"tool": "story.read", "from": 5, "to": 9}'),
  ];
  const sent: ChatMsg[][] = [];
  let n = 0;
  const send = async (messages: ChatMsg[]) => {
    sent.push(messages);
    if (messages[0].content.includes('Summarise the work so far')) {
      return 'Read messages 1–10; the ledger is in #7.';
    }
    return n < reads.length ? reads[n++] : 'Here is what happens.';
  };
  const r = await runAgentTurn({
    system: 'SYS', history: [{ role: 'user', content: 'read it all' }], ctx, send,
    budgetChars: 300, maxSteps: 6,
  });
  eq(r.compactions >= 1, true, 'the turn folded itself when the reads outgrew the budget');
  eq(r.stop, 'answer', 'and still reached an answer');
  eq(r.text, 'Here is what happens.', 'the real one');
  const last = sent[sent.length - 1];
  ok(last.some(m => m.content.includes(SUMMARY_PREFIX)),
    'written against the folded history, not the raw one');
  ok(last.some(m => m.content.includes('the ledger is in #7')),
    'so the specific values the fold was told to keep are still in front of it');
  ok(estimateChars(last) < estimateChars(sent[sent.length - 3]),
    'and the request actually got smaller, which is the entire point');
}

{
  eq(clip('one two three', 100), 'one two three', 'a short note is untouched');
  ok(clip('one two three four five', 12).endsWith('…'), 'a long one is marked as clipped');
  ok(!clip('one two three four five', 12).includes('thre '), 'and not cut mid-word');
}

eq(MAX_STEPS, 8, 'the default cap is stated, so a change to it is a decision');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
