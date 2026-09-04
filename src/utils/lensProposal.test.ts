/**
 * Run: npx tsx src/utils/lensProposal.test.ts
 *
 * The staging area between "the assistant wants to rewrite message 12" and
 * "message 12 now reads differently". Its whole reason to exist is that those
 * two are not the same event, and only a person gets to join them.
 *
 * So the tests are about the queue behaving like a review queue rather than a
 * log: one pending edit per message (a second request for the same message
 * REPLACES the first, because it was made precisely because the first was
 * wrong), settled ones kept as history, and nothing applied that a reader would
 * not be able to see the point of.
 *
 * The other half is the empty-edit trap. `resolveContent` refuses to display a
 * blank override, so applying one gives the reader an "edited" badge on a
 * message that reads exactly as before — a change they cannot see, cannot
 * explain, and would have to hunt through the Lens manager to undo.
 */
import {
  KEEP_SETTLED, makeProposal, pendingProposals, proposalDiff, proposalProblem,
  queueProposal, settleProposal, summarizeProposal, trimProposals,
  type LensProposal,
} from './lensProposal';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const prop = (over: Partial<Parameters<typeof makeProposal>[0]> = {}) => makeProposal({
  messageId: 'm12', index: 12, name: 'Mara',
  before: 'She smiled warmly and waited by the gate.',
  after: 'She smiled thinly and waited by the gate.',
  ...over,
});

/* ------------------------------------------------------------------ */
/* What kind of edit this is                                           */
/* ------------------------------------------------------------------ */

{
  eq(prop().kind, 'revision', 'rewriting an existing passage is a revision');
  eq(prop({ before: '' }).kind, 'branch', 'writing where there was nothing is new work');
  eq(prop({ before: '   ' }).kind, 'branch', 'whitespace is nothing');
  eq(prop({ before: '', kind: 'revision' }).kind, 'revision', 'an explicit kind is respected');
  eq(prop().state, 'pending', 'a fresh proposal is waiting on the reader');
  eq(prop().source, 'ai', 'and is assumed to come from the assistant');
  eq(prop({ source: 'user' }).source, 'user', 'unless the modal made it');
  ok(prop().id !== prop().id, 'every proposal gets its own id');
}

{
  // A branch has no before, so a diff of it would be one solid block of green —
  // true, and useless. It renders as new text instead.
  const branch = prop({ before: '', after: 'A wholly new turn.' });
  const parts = proposalDiff(branch);
  eq(parts.length, 1, 'a new passage previews as one run');
  eq(parts[0].type, 'add', 'marked entirely as new');

  const revision = proposalDiff(prop());
  ok(revision.some(p => p.type === 'same'), 'a revision previews with its untouched text intact');
  ok(revision.some(p => p.type === 'del'), 'and shows what goes');
}

/* ------------------------------------------------------------------ */
/* The header line                                                     */
/* ------------------------------------------------------------------ */

{
  const s = summarizeProposal(prop());
  eq(s.added, 1, 'one word in');
  eq(s.removed, 1, 'one word out');
  ok(!s.empty, 'and it is a real change');
  eq(s.line, '+1 word, −1 word.', 'summed in one line, singular where it should be');

  // Note the inputs: the added words are inserted mid-sentence rather than
  // appended. Appending "…, alone." to "…the gate." also rewrites `gate.` into
  // `gate,`, and the diff reports that honestly as a swap — punctuation rides
  // with its word, so a trailing insertion is genuinely not a pure addition.
  eq(summarizeProposal(prop({ before: 'the cat sat on the mat', after: 'the big black cat sat on the mat' })).line,
    '+2 words.', 'a pure addition does not mention removals');
  eq(summarizeProposal(prop({ before: 'the big black cat sat on the mat', after: 'the cat sat on the mat' })).line,
    '−2 words.', 'nor the reverse');
  eq(summarizeProposal(prop({ before: '', after: 'Two words' })).line,
    'New passage, 2 words.', 'new writing is described as new, not as an addition');
}

{
  // The model handed back what it was given.
  const echoed = prop({ after: 'She smiled warmly and waited by the gate.' });
  ok(summarizeProposal(echoed).empty, 'an echoed passage is recognised as no change');
  ok(/no change/i.test(summarizeProposal(echoed).line), 'and says so plainly');

  const reflowed = prop({ before: 'One.\nTwo.', after: 'One.\n\nTwo.' });
  ok(summarizeProposal(reflowed).empty, 'so is one that only moved the whitespace');
}

/* ------------------------------------------------------------------ */
/* What must never be applied                                          */
/* ------------------------------------------------------------------ */

{
  ok(proposalProblem(prop()) === null, 'an ordinary revision is fine to apply');
  ok(proposalProblem(prop({ after: '' })) !== null, 'an empty rewrite is refused');
  ok(proposalProblem(prop({ after: '   \n ' })) !== null, 'so is a whitespace-only one');
  ok(/empty/i.test(proposalProblem(prop({ after: '' })) ?? ''), 'and the reason says why');

  // The one that would otherwise ship a badge with no visible cause.
  const echoed = prop({ after: 'She smiled warmly and waited by the gate.' });
  ok(proposalProblem(echoed) !== null, 'a rewrite identical to the passage is refused');
  ok(proposalProblem(prop({ before: '', after: 'New text.' })) === null,
    'but new writing with no before is perfectly applicable');
}

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

{
  let q: LensProposal[] = [];
  const first = prop({ instruction: 'colder' });
  q = queueProposal(q, first);
  eq(q.length, 1, 'a proposal joins the queue');

  // The reader did not like it and asked again. Two pending edits to the same
  // message is not a choice anyone wants to be offered.
  const second = prop({ instruction: 'colder still' });
  q = queueProposal(q, second);
  eq(q.length, 1, 'a second edit to the same message replaces the first');
  eq(q[0].instruction, 'colder still', 'and it is the newer one that survives');

  // A different message is a different edit.
  q = queueProposal(q, prop({ messageId: 'm3', index: 3 }));
  eq(q.length, 2, 'another message queues alongside');
}

{
  // Settled proposals are history, not a queue — a new edit to the same message
  // must not delete the record that an earlier one was applied.
  let q = queueProposal([], prop());
  q = settleProposal(q, q[0].id, 'applied');
  q = queueProposal(q, prop({ instruction: 'again' }));
  eq(q.length, 2, 'an applied edit survives a later edit to the same message');
  eq(q[0].state, 'applied', 'still marked applied');
  eq(q[1].state, 'pending', 'with the new one waiting');
  eq(pendingProposals(q).length, 1, 'and only one of them is waiting');
}

{
  const a = prop({ messageId: 'm9', index: 9 });
  const b = prop({ messageId: 'm2', index: 2 });
  const c = prop({ messageId: 'm5', index: 5 });
  const q = [a, b, c];
  eq(pendingProposals(q).map(p => p.index).join(','), '2,5,9',
    'the review runs in reading order, not the order the model happened to emit');

  const settled = settleProposal(q, b.id, 'discarded');
  eq(pendingProposals(settled).map(p => p.index).join(','), '5,9', 'a discarded one drops out of the queue');
  eq(settled.length, 3, 'without leaving the queue');
  eq(settled.find(p => p.id === a.id)?.state, 'pending', 'and settling one leaves the others alone');
}

{
  // History is capped; the real record of an applied edit is the Lens manager.
  let q: LensProposal[] = [];
  for (let i = 0; i < KEEP_SETTLED + 5; i++) {
    q = queueProposal(q, prop({ messageId: `m${i}`, index: i }));
    q = settleProposal(q, q[q.length - 1].id, 'applied');
  }
  q = queueProposal(q, prop({ messageId: 'live', index: 99 }));
  const trimmed = trimProposals(q);
  eq(trimmed.filter(p => p.state !== 'pending').length, KEEP_SETTLED, 'old settled ones are dropped');
  eq(pendingProposals(trimmed).length, 1, 'and a pending one is never trimmed away');
  ok(trimProposals([]).length === 0, 'trimming nothing is safe');

  const short = queueProposal([], prop());
  ok(trimProposals(short) === short, 'and a queue under the cap is returned untouched');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
