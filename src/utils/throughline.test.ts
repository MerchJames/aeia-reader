/**
 * Run: npx tsx src/utils/throughline.test.ts
 *
 * Throughlines — one person across several chats.
 *
 * Two properties carry this file, and they are the same two that carry
 * `utils/visitor`, because they are the same two failures.
 *
 * **The clamp holds.** An arc is told about arcs ordered BEFORE it and nothing
 * else. Get this wrong and opening chapter two hands the model the end of
 * chapter five — a spoiler with extra steps, delivered by the app itself. It is
 * asserted from both directions and at both ends, and a story that is not in
 * the throughline at all gets NOTHING rather than everything, because failing
 * closed is the only safe direction.
 *
 * **The negative space is written down.** A model handed a partial history
 * fills the gaps, cheerfully and invisibly. The two lines that stop it — these
 * are other stories, and what is not written did not happen — are asserted as
 * text, exactly as the visitor's "they have never met" is.
 *
 * A third, quieter one: `orderedArcs` must be a TOTAL order. Two arcs that can
 * swap places between renders mean "what happened before this" changes
 * depending on when you asked.
 */
import {
  ARC_BRIEF_CHARS, PROTAGONIST_FIELDS, arcIndex, arcsBefore, briefProgress, buildArcBriefMessages,
  emptyProtagonist, isUsable, moveArc, orderedArcs, parseArcBrief, renumber,
  sanitizeThroughline, sanitizeThroughlines, throughlineBlock, throughlineFor,
} from './throughline';
import type { Arc, Protagonist, Throughline } from './throughline';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const hero = (over: Partial<Protagonist> = {}): Protagonist => ({
  ...emptyProtagonist('Wren'),
  fields: { ...emptyProtagonist().fields, who: 'A courier who does not ask questions.' },
  ...over,
});

const arc = (storyId: string, order: number, over: Partial<Arc> = {}): Arc => ({
  storyId, title: `Story ${storyId}`, order, brief: `What happened in ${storyId}.`,
  active: true, ...over,
});

const line = (over: Partial<Throughline> = {}): Throughline => ({
  id: 't1', name: 'Wren', protagonist: hero(), createdAt: 0,
  arcs: [arc('a', 0), arc('b', 1), arc('c', 2)],
  ...over,
});

/* ── A total order ───────────────────────────────────────────────────────── */
{
  const t = line({ arcs: [arc('c', 2), arc('a', 0), arc('b', 1)] });
  eq(orderedArcs(t).map(a => a.storyId), ['a', 'b', 'c'], 'sorted by position');
  eq(arcIndex(t, 'b'), 1, 'and an arc knows where it sits');
  eq(arcIndex(t, 'nope'), -1, 'a story outside the throughline sits nowhere');

  // Ties must not swap between renders, or "before this" is not stable.
  const tied = line({
    arcs: [arc('z', 0, { title: 'Zebra' }), arc('a', 0, { title: 'Apple' })],
  });
  eq(orderedArcs(tied).map(a => a.title), ['Apple', 'Zebra'], 'ties break on title');
  eq(orderedArcs(tied).map(a => a.title), orderedArcs(tied).map(a => a.title),
    'and give the same answer twice');
}

/* ── The clamp ───────────────────────────────────────────────────────────── */
{
  const t = line();
  eq(arcsBefore(t, 'a').map(a => a.storyId), [], 'the first arc has no past');
  eq(arcsBefore(t, 'b').map(a => a.storyId), ['a'], 'the second sees the first');
  eq(arcsBefore(t, 'c').map(a => a.storyId), ['a', 'b'], 'the third sees both');

  // An arc never sees ITSELF — that would be a summary of the scene it is in.
  ok(!arcsBefore(t, 'c').some(a => a.storyId === 'c'), 'and never its own brief');
  // Nor anything after it. THE spoiler test.
  ok(!arcsBefore(t, 'a').length && !arcsBefore(t, 'b').some(a => a.storyId === 'c'),
    'and never an arc that comes later — that is a spoiler, delivered by the app');

  // Fail CLOSED. A story that is not part of this at all gets nothing.
  eq(arcsBefore(t, 'unknown'), [], 'a story outside the throughline learns nothing');
  eq(arcsBefore(line({ arcs: [] }), 'a'), [], 'an empty throughline has no past');

  // An arc switched off is in the chronology but does not travel.
  const muted = line({ arcs: [arc('a', 0, { active: false }), arc('b', 1)] });
  eq(arcsBefore(muted, 'b'), [], 'a muted arc does not travel');
  // Neither does one that has not been written up.
  const blank = line({ arcs: [arc('a', 0, { brief: '   ' }), arc('b', 1)] });
  eq(arcsBefore(blank, 'b'), [], 'nor an empty brief — there is nothing to say');
}

/* ── The block ───────────────────────────────────────────────────────────── */
{
  const t = line();
  const block = throughlineBlock(t, 'c', 'Mara');
  ok(block.includes('WREN'), 'the protagonist is named');
  ok(block.includes('A courier who does not ask questions.'), 'and described');
  ok(block.includes('Story a') && block.includes('Story b'), 'earlier arcs are listed');
  ok(!block.includes('Story c'), 'and this one is not — it has not happened yet');

  // The negative space, which is what stops a model filling the gaps.
  ok(/OTHER stories/i.test(block),
    'the arcs are named as OTHER stories — the commonest failure is folding them into this one');
  ok(/not written above has not happened/i.test(block),
    'and what is absent is stated to be absent');
  ok(block.includes('Mara'), 'the host story is named, so the two are not confused');

  // First arc: no past at all, and told so outright.
  const first = throughlineBlock(t, 'a');
  ok(/Nothing has happened/i.test(first) && /Do not invent a past/i.test(first),
    'an opening arc says there is no past rather than leaving a silence to fill');

  // Nothing to send is nothing sent.
  eq(throughlineBlock(undefined, 'a'), '', 'no throughline, no block');
  eq(throughlineBlock(t, undefined), '', 'no story, no block');
  eq(throughlineBlock(line({ protagonist: emptyProtagonist() }), 'c'), '',
    'a protagonist with nothing said about them sends nothing');
  eq(throughlineBlock(line({ protagonist: emptyProtagonist('Wren') }), 'c'), '',
    'a name alone is not a person');

  // Long briefs are clamped rather than allowed to crowd out the others.
  const fat = line({ arcs: [arc('a', 0, { brief: 'x'.repeat(5000) }), arc('b', 1)] });
  const fatBlock = throughlineBlock(fat, 'b');
  ok(fatBlock.length < 5000, 'one enormous brief cannot eat the block');
  ok(fatBlock.includes('…'), 'and is visibly cut rather than silently truncated');
  ok(ARC_BRIEF_CHARS > 200, 'the allowance is generous — there are only a few of these');

  // Aliases: a chat's {{user}} may have been set to something else entirely.
  const alias = line({ protagonist: hero({ aliases: ['W', 'the courier'] }) });
  ok(throughlineBlock(alias, 'b').includes('the courier'), 'aliases travel');
}

/* ── Which throughline a story belongs to ────────────────────────────────── */
{
  const t = line();
  const other = line({ id: 't2', arcs: [arc('x', 0)] });
  eq(throughlineFor([t, other], 'b')?.id, 't1', 'found by its arcs');
  eq(throughlineFor([t, other], 'x')?.id, 't2', 'and the right one');
  eq(throughlineFor([t, other], 'nope'), undefined, 'a story in none of them belongs to none');
  eq(throughlineFor(undefined, 'b'), undefined, 'no throughlines at all');
  eq(throughlineFor([t], undefined), undefined, 'no story at all');
}

/* ── Compiling a brief ───────────────────────────────────────────────────── */
{
  const msgs = buildArcBriefMessages({
    protagonist: hero(), title: 'The Salt Road', character: 'Mara', history: 'THE STORY',
  });
  eq(msgs.length, 2, 'a system brief and the history');
  eq(msgs[1].content, 'THE STORY', 'the history goes in as the user turn');
  const sys = msgs[0].content;
  ok(sys.includes('Wren'), 'the protagonist is named in the instruction');
  ok(sys.includes('Mara'), 'and so is the arc’s own character');
  ok(sys.includes('The Salt Road'), 'and the arc');
  ok(/happened TO Wren/i.test(sys),
    'asked for what happened to the PROTAGONIST — a plain summary is about somebody else, '
    + 'and the reader’s own person barely appears in it');
  ok(/do not state them|Only what the text shows/i.test(sys),
    'and told not to invent, which is the whole risk with a note this short');

  eq(parseArcBrief('  a note.  '), 'a note.', 'trimmed');
  eq(parseArcBrief('```\na note.\n```'), 'a note.', 'unfenced');
  eq(parseArcBrief("Here's the summary: a note."), 'a note.',
    'models announce themselves however firmly they are told not to');
  eq(parseArcBrief('Continuity note: a note.'), 'a note.', 'in several ways');
  eq(parseArcBrief(''), '', 'nothing is nothing');
}

/* ── Reordering ──────────────────────────────────────────────────────────── */
{
  const t = line();
  eq(renumber(orderedArcs(t)).map(a => a.order), [0, 1, 2], 'renumbering leaves no gaps');
  eq(orderedArcs({ ...t, arcs: moveArc(t, 'c', -1) }).map(a => a.storyId), ['a', 'c', 'b'],
    'an arc moves earlier');
  eq(orderedArcs({ ...t, arcs: moveArc(t, 'a', 1) }).map(a => a.storyId), ['b', 'a', 'c'],
    'and later');
  eq(moveArc(t, 'a', -1), t.arcs, 'the first cannot move earlier');
  eq(moveArc(t, 'c', 1), t.arcs, 'nor the last later');
  eq(moveArc(t, 'nope', 1), t.arcs, 'nor a story that is not here');

  eq(briefProgress(t), { done: 3, total: 3 }, 'progress counts written briefs');
  eq(briefProgress(line({ arcs: [arc('a', 0, { brief: '' }), arc('b', 1)] })),
    { done: 1, total: 2 }, 'and only written ones');
}

/* ── Stored data is rebuilt, never trusted ───────────────────────────────── *
 * This reaches a PROMPT. A malformed record must not be able to put junk in
 * front of a model, and a duplicated story id makes the clamp itself
 * non-deterministic. */
{
  eq(sanitizeThroughline(undefined), null, 'nothing stored');
  eq(sanitizeThroughline({}), null, 'a record with no id is not a throughline');
  eq(sanitizeThroughlines(undefined), [], 'no list');
  eq(sanitizeThroughlines('junk'), [], 'junk instead of a list');
  eq(sanitizeThroughlines([{}, { id: 'ok' }]).map(t => t.id), ['ok'],
    'the bad ones are dropped and the good ones kept');

  const t = sanitizeThroughline({ id: 't', arcs: [
    { storyId: 'a', order: 1 },
    { storyId: 'a', order: 0, title: 'Duplicate' },
    { storyId: 'b' },
    { nonsense: true },
  ] })!;
  eq(t.arcs.map(a => a.storyId), ['a', 'b'],
    'a story listed twice is collapsed — two arcs with one id make the clamp non-deterministic');
  eq(t.arcs[0].title, 'Untitled', 'the first entry wins, and a missing title gets a placeholder');
  eq(t.arcs[1].order, 2, 'a missing order falls back to its position in the list');
  ok(t.arcs.every(a => a.active),
    'an arc from a build that predates the active flag still travels — defaulting it off '
    + 'would silently empty somebody’s continuity');

  const p = sanitizeThroughline({ id: 't', protagonist: { name: 7, aliases: 'no', fields: 'no' } })!;
  eq(p.protagonist.name, '', 'a corrupt name becomes empty rather than "7"');
  eq(p.protagonist.aliases, [], 'and corrupt aliases become none');
  ok(PROTAGONIST_FIELDS.every(f => p.protagonist.fields[f] === ''),
    'every field exists and is a string, whatever was stored');
  ok(!isUsable(p.protagonist), 'and a protagonist rebuilt from junk sends nothing');

  eq(sanitizeThroughline({ id: 't', name: '' })!.name, 'Throughline',
    'an unnamed throughline still has something to show in a list');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
