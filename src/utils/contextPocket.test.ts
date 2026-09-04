/**
 * Run: npx tsx src/utils/contextPocket.test.ts
 *
 * Pockets: a zone with a job, and a short crew of them run in order.
 *
 * Two things carry this file, and the first is the one every prompt-building
 * module in this app has had to learn separately:
 *
 * **The instruction is the last line.** Attention is U-shaped, and the request
 * a model actually answers is the one at the end of the last message. Reference
 * material goes in the system block where it reads as fact; prior work goes
 * above the instruction; the instruction goes last, after everything. Every
 * feature here that got that wrong returned something plausible and off-brief.
 *
 * **A step sees what the steps before it made.** The reader's own example is
 * "Mara writes three, then I answer twice, then a third pocket narrates around
 * both" — which is a dependency, not an ordering preference. A run where step
 * three cannot see steps one and two cannot do the thing it was asked to do.
 *
 * The rest is about failing legibly: a crew of three that quietly ran as two
 * produces a document with a hole in it and no way to tell.
 */
import {
  HANDOFF_CHARS, OUTPUT_LABEL, buildPocketMessages, handoffOf, planProblems, pocketSummary,
  runPockets, splitDrafts,
  type ContextPocket, type PocketSection, type PocketStep,
} from './contextPocket';
import type { ChatMsg } from './aiClient';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const pocket = (over: Partial<ContextPocket> = {}): ContextPocket => ({
  id: 'p1',
  name: 'My voice',
  zoneIds: ['z1'],
  purpose: 'Write as the reader writes — same register, same length.',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const step = (over: Partial<PocketStep> = {}): PocketStep => ({
  id: 's1',
  pocketId: 'p1',
  instruction: 'Answer Mara, briefly.',
  output: 'drafts',
  ...over,
});

const section = (over: Partial<PocketSection> = {}): PocketSection => ({
  zoneId: 'z1',
  name: 'All my messages',
  body: '=== #4 (You) ===\nI said nothing and watched the door.',
  ...over,
});

/* ── The prompt puts things where they land ──────────────────────────────── */
{
  const msgs = buildPocketMessages({
    pocket: pocket({ voice: 'Clipped. Never more than two sentences.' }),
    sections: [section()],
    step: step({ instruction: 'Answer Mara, briefly.' }),
    index: 2,
    total: 3,
    prior: '## Mara\n"You worry too much, sister."',
    title: 'The Salt Road',
  });

  eq(msgs.length, 2, 'one system block and one user turn');
  eq(msgs[0].role, 'system', 'the grounding is the system block');
  eq(msgs[1].role, 'user', 'and the asking is the user turn');

  // THE property. Not "contains the instruction" — IS the last line.
  const lastLine = msgs[1].content.trim().split('\n').pop();
  eq(lastLine, 'Answer Mara, briefly.', 'the instruction is the final line of the final message');

  ok(msgs[0].content.includes('I said nothing and watched the door.'),
    'the material is in the system block');
  ok(msgs[0].content.includes('All my messages'), 'under the zone’s own name');
  ok(msgs[0].content.includes('Write as the reader writes'), 'and so is the pocket’s purpose');
  ok(msgs[0].content.includes('Clipped.'), 'and its voice, when it has one');
  ok(msgs[0].content.includes('step 2 of 3'), 'the pocket is told where in the crew it is');

  ok(msgs[1].content.includes('You worry too much'), 'prior work is in the user turn');
  ok(msgs[1].content.indexOf('You worry too much') < msgs[1].content.indexOf('Answer Mara'),
    'above the instruction, never below it');
}

/* ── A pocket with no voice is not given one ─────────────────────────────── */
{
  const msgs = buildPocketMessages({
    pocket: pocket({ voice: undefined }),
    sections: [section()],
    step: step(),
    index: 1,
    total: 1,
  });
  ok(!msgs[0].content.includes('The voice you write in'),
    'a summarising pocket is not handed a performance to give');

  const blank = buildPocketMessages({
    pocket: pocket({ voice: '   ' }),
    sections: [section()],
    step: step(),
    index: 1,
    total: 1,
  });
  ok(!blank[0].content.includes('The voice you write in'), 'and neither is a whitespace one');
}

/* ── Empty material is admitted, not papered over ────────────────────────── */
{
  const msgs = buildPocketMessages({
    pocket: pocket(),
    sections: [section({ body: '   ' })],
    step: step(),
    index: 1,
    total: 1,
  });
  ok(msgs[0].content.includes('no material'),
    'a pocket with nothing in it is told so — a model handed a blank section invents one');
  ok(!msgs[0].content.includes('### All my messages'),
    'and the empty zone is not presented as though it had content');
}

/* ── Asking for several messages ─────────────────────────────────────────── */
{
  const many = buildPocketMessages({
    pocket: pocket(),
    sections: [section()],
    step: step({ output: 'drafts', count: 5 }),
    index: 1,
    total: 1,
  });
  ok(many[1].content.includes('5 separate messages'), 'the count is asked for');
  ok(many[1].content.includes('---'), 'with a separator it can be split on');
  // Still last, even with the separator instruction above it.
  eq(many[1].content.trim().split('\n').pop(), 'Answer Mara, briefly.',
    'and the instruction is still the last line');

  const one = buildPocketMessages({
    pocket: pocket(), sections: [section()], step: step({ count: 1 }), index: 1, total: 1,
  });
  ok(!one[1].content.includes('separate messages'), 'one message needs no separator protocol');

  const pinStep = buildPocketMessages({
    pocket: pocket(), sections: [section()], step: step({ output: 'pin', count: 5 }), index: 1, total: 1,
  });
  ok(!pinStep[1].content.includes('separate messages'),
    'and neither does a step whose output is a document');
}

/* ── Splitting a reply back into messages ────────────────────────────────── */
{
  eq(splitDrafts('one\n---\ntwo\n---\nthree').length, 3, 'the separator we asked for is honoured');
  eq(splitDrafts('one\n  ---  \ntwo').length, 2, 'even loosely written');
  eq(splitDrafts('one\n-----\ntwo').length, 2, 'and with extra dashes');

  // A model that ignored the protocol gives one long draft. That is a far
  // better failure than five fragments cut on a guess at where a message ends.
  eq(splitDrafts('a paragraph.\n\nanother paragraph.').length, 1,
    'without the separator, nothing is split');
  eq(splitDrafts('   ').length, 0, 'and an empty reply yields nothing');

  // A horizontal rule INSIDE a message would split it — accepted, because the
  // alternative is a heuristic that guesses, and prose in this app uses `---`
  // as a scene break precisely because it is unambiguous.
  ok(splitDrafts('one\n---\ntwo').every(d => d && !d.includes('---')), 'the separator is consumed');
}

/* ── The handoff ─────────────────────────────────────────────────────────── */
{
  eq(handoffOf(''), '', 'nothing to hand on');
  eq(handoffOf('short'), 'short', 'short work is handed on whole');

  const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const cut = handoffOf(long, 200);
  ok(cut.length <= 200, 'a long run is trimmed');
  ok(long.endsWith(cut), 'from the END — the most recent work is what the next step needs');
  ok(!/^Paragraph \d+\.$/.test(cut.split('\n')[0]) || cut.startsWith('Paragraph'),
    'and cut on a paragraph rather than mid-sentence');
}

/* ── The run: order, and seeing what came before ─────────────────────────── */
{
  const pockets = [
    pocket({ id: 'mara', name: 'Mara', zoneIds: ['z2'] }),
    pocket({ id: 'me', name: 'My voice' }),
    pocket({ id: 'scene', name: 'The scene' }),
  ];
  const steps: PocketStep[] = [
    { id: 's1', pocketId: 'mara', instruction: 'Speak as Mara.', output: 'drafts', count: 3 },
    { id: 's2', pocketId: 'me', instruction: 'Answer her.', output: 'drafts', count: 2 },
    { id: 's3', pocketId: 'scene', instruction: 'Narrate around both.', output: 'pin' },
  ];

  const seen: { order: string[]; sawPrior: boolean[] } = { order: [], sawPrior: [] };
  const send = async (msgs: ChatMsg[]): Promise<string> => {
    const sys = msgs[0].content;
    const who = pockets.find(p => sys.includes(`## Your part: ${p.name}`))!;
    seen.order.push(who.name);
    seen.sawPrior.push(msgs[1].content.includes('earlier steps produced'));
    return who.name === 'Mara' ? 'one\n---\ntwo\n---\nthree' : `${who.name} wrote this.`;
  };

  const progress: string[] = [];
  const result = await runPockets({
    steps,
    pockets,
    sectionsFor: () => [section()],
    send,
    onStep: (_d, _t, name) => { if (name) progress.push(name); },
  });

  eq(seen.order.join(' → '), 'Mara → My voice → The scene', 'the steps run in the order written');
  eq(seen.sawPrior.join(','), 'false,true,true', 'every step but the first sees the work so far');
  eq(progress.join(','), 'Mara,My voice,The scene', 'and the reader is told which is running');

  eq(result.results.length, 3, 'three steps produced something');
  eq(result.results[0].drafts.length, 3, 'the drafts step split into three messages');
  eq(result.results[2].drafts.length, 0, 'and a pin step is not split into messages');
  eq(result.aborted, false, 'the run finished');
  eq(result.skipped.length, 0, 'with nothing skipped');
  ok(result.document.includes('The scene wrote this.'), 'the document holds what was kept');
}

/* ── A working note is handed on and not kept ────────────────────────────── */
{
  const pockets = [pocket({ id: 'a', name: 'Notes' }), pocket({ id: 'b', name: 'Prose' })];
  const steps: PocketStep[] = [
    { id: 's1', pocketId: 'a', instruction: 'List the beats.', output: 'note' },
    { id: 's2', pocketId: 'b', instruction: 'Write it.', output: 'pin' },
  ];
  let secondSawFirst = false;
  const result = await runPockets({
    steps,
    pockets,
    sectionsFor: () => [section()],
    send: async (msgs) => {
      if (msgs[0].content.includes('## Your part: Prose')) {
        secondSawFirst = msgs[1].content.includes('SCAFFOLDING');
      }
      return msgs[0].content.includes('Notes') ? 'SCAFFOLDING' : 'The finished passage.';
    },
  });
  ok(secondSawFirst, 'a note is handed to the step after it');
  ok(!result.document.includes('SCAFFOLDING'),
    'and stays out of the document — which is what makes a stitching pocket expressible');
  ok(result.document.includes('The finished passage.'), 'while the kept step lands in it');
}

/* ── Failing legibly ─────────────────────────────────────────────────────── */
{
  const pockets = [pocket({ id: 'a', name: 'Full' }), pocket({ id: 'b', name: 'Empty' })];
  const steps: PocketStep[] = [
    { id: 's1', pocketId: 'a', instruction: 'Do it.', output: 'pin' },
    { id: 's2', pocketId: 'b', instruction: 'Do it.', output: 'pin' },
    { id: 's3', pocketId: 'gone', instruction: 'Do it.', output: 'pin' },
  ];
  const result = await runPockets({
    steps,
    pockets,
    sectionsFor: id => (id === 'a' ? [section()] : [section({ body: '  ' })]),
    send: async () => 'done',
  });
  eq(result.results.length, 1, 'only the step that could run, ran');
  eq(result.skipped.length, 2, 'and the two that could not are reported');
  ok(result.skipped.some(s => s.includes('Empty')), 'the one with no material, by name');
  ok(result.skipped.some(s => s.includes('Step 3')), 'and the one whose pocket is gone, by position');

  // A model that returns nothing is a skipped step, not an empty section in the
  // middle of the document.
  const silent = await runPockets({
    steps: [step({ output: 'pin' })],
    pockets: [pocket()],
    sectionsFor: () => [section()],
    send: async () => '   ',
  });
  eq(silent.results.length, 0, 'an empty reply produces no result');
  eq(silent.skipped.length, 1, 'and is reported as a skip');
}

/* ── Stopping ────────────────────────────────────────────────────────────── */
{
  const controller = new AbortController();
  let calls = 0;
  const result = await runPockets({
    steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    pockets: [pocket()],
    sectionsFor: () => [section()],
    signal: controller.signal,
    send: async () => { calls++; controller.abort(); return 'partial'; },
  });
  eq(calls, 1, 'stopping ends the run');
  eq(result.aborted, true, 'and says so');
  eq(result.results.length, 1, 'keeping what was already produced');
  ok(result.document.includes('partial'), 'rather than throwing the run away');
}

/* ── Problems the reader can fix before spending a request ───────────────── */
{
  const pockets = [pocket({ id: 'a', name: 'Full' })];
  const sections = (id: string) => (id === 'a' ? [section()] : []);

  eq(planProblems([], pockets, sections).length, 1, 'an empty plan is a problem');
  eq(planProblems([step({ pocketId: 'a' })], pockets, sections).length, 0, 'a good step is not');

  const noInstruction = planProblems(
    [step({ pocketId: 'a', instruction: '  ' })], pockets, sections);
  ok(noInstruction[0].includes('no instruction'), 'a step with nothing asked of it is named');
  ok(noInstruction[0].includes('Full'), 'by its pocket');

  const gone = planProblems([step({ pocketId: 'nope' })], pockets, sections);
  ok(gone[0].includes('no longer exists'), 'a deleted pocket is named');

  const empty = planProblems(
    [step({ pocketId: 'a' })], pockets, () => [section({ body: '' })]);
  ok(empty[0].includes('no material'), 'and so is a pocket whose zones select nothing');
}

/* ── Summaries and labels ────────────────────────────────────────────────── */
{
  eq(pocketSummary(pocket({ zoneIds: [] })).startsWith('no zones yet'), true,
    'a pocket with no zones says so first');
  ok(pocketSummary(pocket({ zoneIds: ['a', 'b'] })).startsWith('2 zones'), 'and one with two says two');
  ok(pocketSummary(pocket()).includes('Write as the reader writes'), 'the purpose follows');
  ok(pocketSummary(pocket({ purpose: '' })) === '1 zone', 'and is left off when there is none');

  eq(Object.keys(OUTPUT_LABEL).length, 3, 'three kinds of output');
  ok(OUTPUT_LABEL.drafts.hint.includes('Never written into the story'),
    'and the drafts one says the thing that matters: nothing here writes to a story');
  ok(HANDOFF_CHARS > 0, 'the handoff has a budget');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
