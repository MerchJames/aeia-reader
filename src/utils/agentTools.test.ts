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
  AGENT_TOOLS, GUIDE_SETTINGS, MAX_CALLS_PER_STEP, MAX_READ_MESSAGES, TOOL_OUTPUT_CHARS,
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
  listLens: () => lensEdits,
  proposeLens: (target, content, note) => {
    const msg = messages[target - 1];
    if (!msg) return null;
    const noop = msg.content.replace(/\s+/g, ' ').trim() === content.replace(/\s+/g, ' ').trim();
    if (!noop) staged.push({ target, content, note });
    return { index: target, name: msg.name, before: msg.content, noop };
  },
};

/** Everything the staging tool touched — it must never touch anything else. */
const staged: { target: number; content: string; note: string }[] = [];
const lensEdits = [
  { index: 2, name: 'Mara', original: messages[1]?.content ?? '', content: 'A colder version.', note: 'colder' },
];

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

/* ------------------------------------------------------------------ */
/* Proposing a Lens edit — the tool that must NOT be able to write      */
/* ------------------------------------------------------------------ */

/**
 * The assistant can suggest a rewrite of the story. It cannot perform one.
 *
 * That is not a rule the panel enforces by remembering to show a dialog — it is
 * enforced here, by `lens.propose` having no route to the store at all. A Lens
 * override changes what a passage SAYS, everywhere, silently, and the reader
 * might not reread it for an hour; "the assistant rewrote message 40 while you
 * were discussing something else" is not a feature.
 */
{
  const before = staged.length;
  const r = await run('lens.propose', { message: 2, content: 'A much colder line.', note: 'colder' });
  ok(r.ok === true, 'a well-formed proposal is accepted');
  eq(r.staged, true, 'and says it was staged');
  eq(staged.length, before + 1, 'exactly one thing was queued');
  ok(/reader/i.test(String(r.note)), 'and the model is told a person decides');
  ok(/cannot apply it yourself/i.test(String(r.note)),
    'in words that leave no room for it to claim the change is done');
}

{
  // A model that skipped story.read and guessed a number.
  const r = await run('lens.propose', { message: 999, content: 'text' });
  ok(!r.ok, 'a message that does not exist is refused');
  ok(/no message 999/i.test(String(r.error)), 'by number');
  ok(String(r.error).includes(String(messages.length)), 'and told how many there are');

  const noTarget = await run('lens.propose', { content: 'text' });
  ok(!noTarget.ok, 'and so is a proposal with nothing to apply it to');
  ok(/story.search|story.read/i.test(String(noTarget.hint)), 'with a hint on how to find one');
}

{
  const r = await run('lens.propose', { message: 2, content: '  ' });
  ok(!r.ok, 'an empty rewrite is refused');
  ok(/whole passage/i.test(String(r.hint)), 'and the model is reminded it must send the entire passage');
}

{
  // The echo. A model with nothing to add hands the passage straight back, and
  // applying that would badge a message as edited with nothing to show for it.
  const before = staged.length;
  const r = await run('lens.propose', { message: 1, content: messages[0].content });
  ok(!r.ok, 'a rewrite identical to the passage is refused');
  eq(staged.length, before, 'and nothing at all is queued');
  ok(String(r.passage).length > 0, 'the passage comes back so the model can see what it sent');
}

{
  const r = await run('lens.list', {});
  ok(r.ok === true, 'the model can see the Lens edits already in place');
  eq((r.edits as unknown[]).length, 1, 'all of them');
}

eq(AGENT_TOOLS.filter(t => t.writes).length, 2,
  'exactly two tools write, and both of them go through a pin version');
eq(AGENT_TOOLS.filter(t => t.stages).length, 1,
  'and exactly one only proposes');
eq(AGENT_TOOLS.filter(t => t.writes && t.stages).length, 0,
  'with no tool claiming to be both — a staging tool that also writes is the bug this guards');
ok(!AGENT_TOOLS.some(t => t.name.startsWith('lens.') && t.writes),
  'nothing under lens.* may write: applying an override is a person\'s decision, not a tool call');

/**
 * The fourth category, and the line it must not cross.
 *
 * `navigates` exists so the guide can move the reader around the app without
 * the "exactly two tools write" tripwire above losing its meaning. That only
 * holds while navigation stays navigation: the moment a tool that changes the
 * view can also change a pin, the categories stop describing risk and the
 * reader's approval model quietly gets wider.
 */
eq(AGENT_TOOLS.filter(t => t.navigates && (t.writes || t.stages)).length, 0,
  'no tool both navigates and changes the story — the categories describe risk, '
  + 'and one tool in two of them makes them describe nothing');

eq(AGENT_TOOLS.filter(t => t.navigates).map(t => t.name).sort().join(','),
  'app.goto,app.setting',
  'exactly two tools move the reader around, and both are reversible in one action');

/**
 * The guide's tools are hidden unless the guide is on.
 *
 * A tool the model can see is a tool it will eventually reach for. An assistant
 * helping someone cowrite has no business switching their view, so the
 * catalogue simply does not mention it.
 */
{
  const plain = renderToolCatalog();
  const guided = renderToolCatalog(true);
  for (const name of ['guide.docs', 'guide.where', 'app.goto', 'app.setting']) {
    ok(!plain.includes(name), `the ordinary catalogue does not offer ${name}`);
    ok(guided.includes(name), `the guided catalogue does offer ${name}`);
  }
  ok(plain.includes('pins.read'), 'while the ordinary tools are there in both');
  ok(guided.includes('pins.read'), 'and the guide keeps them too');
  ok(guided.includes('guide.docs before explaining'),
    'and the guided catalogue tells it to look things up rather than invent them');
}

/**
 * What the guide may change, stated as a list rather than trusted to a review.
 *
 * Every one of these is cosmetic and instantly visible. The absences are the
 * point: nothing about the AI endpoint, syncing, or the reader's data. If this
 * assertion is failing because someone added a key, the question to ask is
 * whether a reader would notice the change immediately and be able to undo it.
 */
eq([...GUIDE_SETTINGS.map(s => s.key)].sort().join(','),
  'autoStream,contentWidth,dropCaps,fontFamily,fontSize,paragraphSpacing,'
  + 'playbackSpeed,readingMode,showHiddenMessages,showImages,smartTypography,'
  + 'theme,uiMode', 'the guide may change exactly these display settings, and nothing else');

for (const banned of ['aiBaseUrl', 'aiApiKey', 'aiModel', 'stSyncEnabled', 'aiAgentMode']) {
  ok(!GUIDE_SETTINGS.some(s => s.key === banned),
    `the guide cannot touch ${banned} — it is not cosmetic and not obviously reversible`);
}


console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
