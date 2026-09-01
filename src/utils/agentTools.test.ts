/**
 * Run: npx tsx src/utils/agentTools.test.ts
 *
 * The assistant's hands.
 *
 * Two classes of failure live here, and neither one looks like a bug from the
 * outside.
 *
 * **A directive that fires when it should not.** The model is talking ABOUT a
 * tool — quoting one back to the reader, reasoning about which to use inside a
 * `<think>` block, listing the catalogue as an example. Every one of those
 * contains the exact text of a call. Executing them means a pin gains a version
 * nobody asked for, and the reader's only clue is a version counter that went
 * up on its own.
 *
 * **A directive that does not fire when it should.** The model named the pin by
 * its title instead of its id, or wrapped the JSON in prose, or the endpoint
 * ate the fence. The reader sees "I've updated that for you" over a pin that
 * did not change, which is the worst outcome this feature has: a confident
 * report of work that never happened.
 *
 * So the parser is asserted from both directions, and the one write that can
 * destroy something — a version with empty content, which would blank the pin —
 * is asserted to be refused.
 */
import {
  AGENT_TOOLS, MAX_CALLS_PER_STEP, MAX_READ_MESSAGES, TOOL_OUTPUT_CHARS,
  type ToolContext, parseToolCalls, renderToolCatalog, runToolCall,
  stripToolCalls, truncateMiddle,
} from './agentTools';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ------------------------------------------------------------------ */
/* A story to work on                                                  */
/* ------------------------------------------------------------------ */

const versions: { pinId: string; content: string; instruction: string }[] = [];
let created: { title: string; content: string; format: string } | null = null;

const pins = [
  { id: 'pin-a1', title: 'Mara — running account', format: 'markdown' as const,
    content: 'She left the inn before dawn.', versionCount: 2, activeVersion: 1, inContext: true },
  { id: 'pin-b2', title: 'Ledger', format: 'html' as const,
    content: '<table></table>', versionCount: 1, activeVersion: 0, inContext: false },
];

const messages = Array.from({ length: 120 }, (_, i) => ({
  index: i + 1,
  name: i % 2 ? 'Mara' : 'You',
  content: i === 41 ? 'The ratkins came over the wall at midnight.' : `beat ${i + 1}`,
}));

const ctx: ToolContext = {
  messageCount: messages.length,
  listPins: () => pins,
  listZones: () => [
    { id: 'z-1', name: 'Act I', summary: 'msg 1–30' },
    { id: 'z-2', name: 'Act II', summary: 'msg 31–70' },
  ],
  buildZone: id => (id === 'z-1'
    ? { name: 'Act I', body: 'ACT ONE BODY', messageCount: 30, branchlineCount: 1, empty: false }
    : id === 'z-2'
      ? { name: 'Act II', body: '', messageCount: 0, branchlineCount: 0, empty: true }
      : null),
  readStory: (from, to) => messages.slice(from - 1, to),
  searchStory: (q, limit) =>
    messages.filter(m => m.content.toLowerCase().includes(q.toLowerCase())).slice(0, limit),
  listCodex: () => [
    { name: 'Mara', kind: 'character', aliases: [], summary: 'the innkeeper', mentions: 40 },
    { name: 'The inn', kind: 'location', aliases: [], summary: 'where it starts', mentions: 12 },
  ],
  listSheets: () => [{ id: 's-1', title: 'Coin', columns: ['when', 'amount'], rowCount: 1, rows: [{ when: 'day 1', amount: '3' }] }],
  createPin: (title, content, format) => { created = { title, content, format }; return 'pin-new'; },
  addPinVersion: (pinId, content, instruction) => {
    const pin = pins.find(p => p.id === pinId);
    if (!pin) return null;
    versions.push({ pinId, content, instruction });
    return pin.versionCount + versions.filter(v => v.pinId === pinId).length;
  },
};

const call = (reply: string) => parseToolCalls(reply);
const run = (tool: string, args: Record<string, unknown>) => runToolCall({ tool, args }, ctx);

const fence = (body: string) => '```aura-tool\n' + body + '\n```';

/* ------------------------------------------------------------------ */
/* Parsing: what must NOT fire                                         */
/* ------------------------------------------------------------------ */

// The whole basis of the loop: a reply with no directive is the answer.
{
  eq(call('Mara leaves before dawn, and the ledger never balances.').length, 0,
    'ordinary prose calls nothing — this is how the loop knows it is finished');
  eq(call('').length, 0, 'and so does an empty reply');
}

// A model reasoning about a call has written the call. It must not run.
{
  const thought = `<think>I should probably run ${fence('{"tool": "pins.newVersion", "pin": "pin-a1", "content": "x"}')} next.</think>Which pin did you mean?`;
  eq(call(thought).length, 0,
    'a directive inside a chain of thought is deliberation, not an instruction');
  eq(versions.length, 0, 'and nothing was written on the way past');
}

// Quoting the protocol back at the reader is the other way this misfires.
{
  eq(call('The block looks like {"tool": "pins.read", "pin": "…"} — shall I?').length, 0,
    'a sentence containing a directive is a sentence');
}

// The catalogue itself is full of tool names; a model echoing it must not
// trigger ten calls.
{
  ok(renderToolCatalog().includes('pins.newVersion'), 'the catalogue names the writes');
  eq(call(renderToolCatalog()).length, 1,
    'and the catalogue\'s own example is its only executable block');
}

/* ------------------------------------------------------------------ */
/* Parsing: what must fire                                             */
/* ------------------------------------------------------------------ */

{
  const reply = `Let me look at that pin first.\n\n${fence('{"tool": "pins.read", "pin": "pin-a1"}')}`;
  const calls = call(reply);
  eq(calls.length, 1, 'prose wrapped around a fence still parses');
  eq(calls[0].tool, 'pins.read', 'the tool name comes through');
  eq(calls[0].args.pin, 'pin-a1', 'and the arguments ride flat alongside it');
  eq(stripToolCalls(reply), 'Let me look at that pin first.',
    'the reader sees the sentence, never the JSON');
}

{
  const two = `${fence('{"tool": "zones.build", "zone": "z-1"}')}\nthen\n${fence('{"tool": "zones.build", "zone": "z-2"}')}`;
  const calls = call(two);
  eq(calls.length, 2, 'two blocks are two calls');
  eq(calls[0].args.zone, 'z-1', 'in the order they were written');
  eq(calls[1].args.zone, 'z-2', 'both of them');
}

{
  const many = Array.from({ length: 9 }, () => fence('{"tool": "pins.list"}')).join('\n');
  eq(call(many).length, MAX_CALLS_PER_STEP,
    'a model that emits the whole catalogue is capped rather than obeyed');
}

// Endpoints that strip fences, and models that answer in bare JSON.
{
  eq(call('{"tool": "pins.list"}').length, 1, 'a reply that is nothing but the object still runs');
  eq(call('Sure thing. {"tool": "pins.list"} ok?').length, 0,
    'but an object buried in a sentence does not — that way lies a sentence executing');
}

// A truncated directive is the commonest real failure: the budget ran out
// mid-JSON. It must cost the step, not the conversation.
{
  eq(call(fence('{"tool": "pins.newVersion", "pin": "pin-a1", "content": "half a sen')).length, 0,
    'an unbalanced directive is skipped rather than half-executed');
}

/* ------------------------------------------------------------------ */
/* Running: recoverable failure                                        */
/* ------------------------------------------------------------------ */

{
  const r = await run('pins.rewrite', { pin: 'pin-a1' });
  eq(r.ok, false, 'an invented tool name fails');
  ok(Array.isArray(r.tools) && (r.tools as string[]).includes('pins.newVersion'),
    'and answers with the names that would have worked');
}

{
  const r = await run('pins.read', { pin: 'the green one' });
  eq(r.ok, false, 'a pin that is not there fails');
  ok(JSON.stringify(r.pins).includes('pin-a1'),
    'and hands back the list, so the next step can fix itself');
}

{
  const r = await run('story.read', { from: 900, to: 950 });
  eq(r.ok, false, 'a range past the end of the story fails');
  ok(String(r.error).includes('1–120'), 'naming the range that exists');
}

/* ------------------------------------------------------------------ */
/* Running: the reads                                                  */
/* ------------------------------------------------------------------ */

{
  const r = await run('pins.read', { pin: 'Mara — running account' });
  eq(r.ok, true, 'a pin resolves by title as well as by id');
  eq(r.id, 'pin-a1', 'to the same pin');
  eq(r.version, 2, 'reporting which version is showing, 1-based for a reader-facing number');
}

{
  const r = await run('story.read', { from: 1, to: 999 });
  eq(r.ok, true, 'an over-wide range is clamped rather than refused');
  eq((r.messages as string[]).length, MAX_READ_MESSAGES, 'to the per-call ceiling');
  eq(r.truncated, true, 'and says so, so the model knows to ask for the rest');
  ok((r.messages as string[])[0].startsWith('#1 '),
    'messages carry the #N the zones use, so the two can be cross-referenced');
}

{
  const r = await run('story.search', { query: 'ratkins' });
  eq(r.ok, true, 'search runs');
  eq(r.hits, 1, 'and finds the line');
  ok((r.matches as string[])[0].startsWith('#42 '), 'at its reading position');
  eq((await run('story.search', {})).ok, false, 'a search with no query is refused');
}

{
  const built = await run('zones.build', { zone: 'Act I' });
  eq(built.ok, true, 'a zone resolves by name');
  eq(built.body, 'ACT ONE BODY', 'and comes back as the block that would have been sent');
  const empty = await run('zones.build', { zone: 'z-2' });
  eq(empty.ok, true, 'an empty zone is not an error');
  eq(empty.empty, true, 'it is an empty zone, and says so rather than returning nothing');
  const missing = await run('zones.build', { zone: 'Act IX' });
  eq(missing.ok, false, 'a zone that does not exist fails');
  ok(JSON.stringify(missing.zones).includes('Act II'), 'with the ones that do');
}

{
  const r = await run('codex.list', { kind: 'location' });
  eq((r.entities as unknown[]).length, 1, 'the codex filters by kind');
  eq(((await run('codex.list', {})).entities as unknown[]).length, 2, 'and returns all of it unfiltered');
}

/* ------------------------------------------------------------------ */
/* Running: the writes                                                 */
/* ------------------------------------------------------------------ */

// The one that can destroy something. A version whose content is empty would
// leave the reader looking at a blank pin, and `resolveContent` has the same
// guard for the same reason on the Lens layer.
{
  const r = await run('pins.newVersion', { pin: 'pin-a1', content: '   ' });
  eq(r.ok, false, 'a version with no content is refused');
  eq(versions.length, 0, 'and never reaches the store');
}

{
  const r = await run('pins.newVersion', {
    pin: 'Ledger', content: 'day 1 — three coin', instruction: 'fold in the tavern',
  });
  eq(r.ok, true, 'a real write goes through');
  eq(r.pinId, 'pin-b2', 'resolved by title');
  eq(versions.length, 1, 'exactly one version was added');
  eq(versions[0].instruction, 'fold in the tavern', 'carrying the reason, which PinDock shows');
  ok(String(r.note).includes('step back'),
    'and the reply tells the model the reader can undo it — so it need not ask permission');
}

{
  const r = await run('pins.create', { title: 'Timeline', content: '## Day one' });
  eq(r.ok, true, 'a new pin can be started');
  eq(created?.format, 'markdown', 'defaulting to markdown rather than raw HTML');
  eq((await run('pins.create', { title: 'x' })).ok, false, 'but never an empty one');
}

/* ------------------------------------------------------------------ */
/* Output budget                                                       */
/* ------------------------------------------------------------------ */

{
  const long = 'A'.repeat(500) + 'MIDDLE' + 'Z'.repeat(500);
  const cut = truncateMiddle(long, 400);
  ok(cut.length < long.length, 'a long result is trimmed');
  ok(cut.startsWith('AAA'), 'the head survives');
  ok(cut.endsWith('ZZZ'), 'and so does the tail, which is where the answer usually is');
  ok(!cut.includes('MIDDLE'), 'it is the middle that goes');
  ok(/elided/.test(cut), 'and the gap is announced, so nothing is read as whole that is not');
  eq(truncateMiddle('short', 400), 'short', 'something inside the budget is untouched');
}

// The read tools must not be able to blow the window in one step, whatever
// they are pointed at — this is what makes a tool result safe to keep in the
// history for the rest of the conversation.
{
  const huge: ToolContext = { ...ctx, listPins: () => [{ ...pins[0], content: 'x'.repeat(200_000) }] };
  const r = await runToolCall({ tool: 'pins.read', args: { pin: 'pin-a1' } }, huge);
  ok(String(r.content).length < TOOL_OUTPUT_CHARS + 200, 'a huge pin comes back inside the budget');
}

eq(AGENT_TOOLS.filter(t => t.writes).length, 2,
  'exactly two tools write, and both of them go through a pin version');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
