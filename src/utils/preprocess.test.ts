/**
 * Tests for the reply pre-processor.
 *
 * This feature's whole risk is that it makes good replies worse. It runs on
 * every message, unattended, and a model asked "find the contradiction" is very
 * willing to find one that is not there. So nearly every test below is about
 * the pass declining to act:
 *
 * 1. **NONE is the default reading.** Ambiguity, silence, preamble, a
 *    paraphrase instead of a quote — all resolve to "leave it alone". A parser
 *    that leaned the other way would rewrite every message in the chat.
 * 2. **A quote that is not verbatim is refused.** It is the only thing that
 *    makes a surgical splice possible; an approximate match would corrupt the
 *    reply in a way nobody notices until they reread it.
 * 3. **A repair that changes too much is refused.** Models asked to fix one
 *    sentence routinely return the whole passage, or an explanation.
 *
 * Run: npx tsx src/utils/preprocess.test.ts
 */

import {
  MAX_CHECKS, MAX_REPAIR_RATIO,
  applyRepair, buildCheckPrompt, buildRepairPrompt, changedAnything, emptyRun,
  readVerdict, relevance, relevantFacts, stagesFor, summarizeRun,
  type CheckFact, type PreprocessRun,
} from './preprocess';

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

const fact = (over: Partial<CheckFact> = {}): CheckFact => ({
  id: 'f1', source: 'pin', title: 'Vera — anatomy',
  text: 'Vera has six eyes arranged in two rows. She has no wings.',
  ...over,
});

const REPLY = 'Vera turned toward the door, all six eyes narrowing at once. '
  + 'She folded her arms and waited for the lock to give.';

/** The second sentence of REPLY, verbatim — what a check would quote. */
const target = 'She folded her arms and waited for the lock to give.';

/* ------------------------------------------------------------------ */
/* Choosing what to spend a call on                                    */
/* ------------------------------------------------------------------ */

{
  const anatomy = fact();
  const tavern = fact({
    id: 'f2', title: 'The Gilded Hart',
    text: 'A tavern on the harbour road. The innkeeper is called Bosk.',
  });

  ok(relevance(REPLY, anatomy) > relevance(REPLY, tavern),
    'a reply about Vera’s eyes is more relevant to the anatomy pin than to the tavern');
  eq(relevantFacts(REPLY, [anatomy, tavern]).map(f => f.id), ['f1'],
    'and only the relevant one is checked — the point is not to spend a call on the tavern');
}

{
  eq(relevance('', fact()), 0, 'an empty reply is relevant to nothing');
  eq(relevance(REPLY, fact({ text: '', title: '' })), 0, 'and an empty fact matches nothing');
  eq(relevantFacts(REPLY, []), [], 'no facts, no checks');
  eq(relevantFacts('Nothing in common at all here.', [fact()]), [],
    'a reply sharing no vocabulary spends no calls');
}

{
  const many = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}` }));
  ok(relevantFacts(REPLY, many).length <= MAX_CHECKS,
    'the number of checks is capped — this number IS the latency');
  eq(relevantFacts(REPLY, many, 2).length, 2, 'and the cap can be lowered');
  eq(relevantFacts(REPLY, many, 0), [], 'a zero limit checks nothing');
}

{
  // Stopwords must not create relevance, or every fact matches every reply.
  const filler = fact({ id: 'f3', title: 'Nothing', text: 'It was there and then it was not.' });
  eq(relevance('This was here and that is there.', filler), 0,
    'shared stopwords alone do not make a fact relevant');
}

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

{
  const prompt = buildCheckPrompt(REPLY, fact());
  ok(prompt.includes(REPLY), 'the check prompt carries the reply');
  ok(prompt.includes('six eyes'), 'and the fact');
  ok(prompt.includes('NONE'), 'and offers NONE as an answer');
  ok(/most replies do not/i.test(prompt),
    'and tells the model that most replies are fine — one that believes it is '
    + 'hunting for problems will find them');
  ok(/word for word/i.test(prompt), 'and demands a verbatim quote, which is what makes a splice possible');
  ok(/unsure, answer NONE/i.test(prompt), 'and sends uncertainty toward doing nothing');

  const long = buildCheckPrompt(REPLY, fact({ text: 'x'.repeat(5000) }));
  ok(long.length < 4000, 'an enormous fact is clipped rather than sent whole');
}

{
  // The prompts are hard-wrapped for readability, so a phrase can straddle a
  // newline. The model reads the joined string; so does this.
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const prompt = flat(buildRepairPrompt(REPLY, target, fact()));
  ok(/as little as you can/i.test(prompt), 'the repair prompt asks for the smallest change');
  ok(/keep the same voice/i.test(prompt), 'and to keep the voice');
  ok(/do not write anything except the rewritten sentence/i.test(prompt),
    'and forbids the explanation models love to add');
  ok(/roughly the same length/i.test(prompt), 'and to keep the length');
}

/* ------------------------------------------------------------------ */
/* Reading a verdict — biased toward doing nothing                     */
/* ------------------------------------------------------------------ */


{
  for (const raw of [
    'NONE', 'None', 'none.', '  NONE  ', 'No contradiction.',
    'The reply does not contradict the fact.', 'No conflict here.',
  ]) {
    eq(readVerdict(raw, REPLY).contradicts, false, `"${raw}" reads as no contradiction`);
  }
}

{
  // Silence, junk, and refusal all mean leave it alone.
  for (const raw of ['', '   ', 'I am not sure.', 'Hmm.', 'As an AI language model…', '???']) {
    eq(readVerdict(raw, REPLY).contradicts, false,
      `unparseable output "${raw.slice(0, 20)}" changes nothing`);
  }
}

{
  const v = readVerdict(`CONTRADICTS: "${target}"`, REPLY);
  ok(v.contradicts, 'a clean, verbatim, quoted finding is acted on');
  eq(v.sentence, target, 'and the sentence comes back exactly');
}

{
  // The quote marks a model might reach for.
  for (const [open, close] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»']]) {
    ok(readVerdict(`CONTRADICTS: ${open}${target}${close}`, REPLY).contradicts,
      `a quote in ${open}${close} is understood`);
  }
  ok(readVerdict(`CONTRADICTS: ${target}`, REPLY).contradicts,
    'and an unquoted one still works');
  ok(readVerdict(`Contradicts:\n${target}`, REPLY).contradicts, 'case and newline do not matter');
}

{
  /**
   * The one that would corrupt the reply.
   *
   * A model that paraphrases the offending sentence has given us something we
   * cannot locate. Splicing on an approximate match would rewrite the wrong
   * span, and nobody would catch it until they reread the message.
   */
  const v = readVerdict('CONTRADICTS: "She folded her arms and waited for the door to open."', REPLY);
  eq(v.contradicts, false, 'a paraphrased quote is refused rather than approximately matched');
  ok(!!v.rejected, 'and the refusal says why');
  ok(v.rejected!.includes('word for word'), 'in terms that name the actual problem');
}

{
  const v = readVerdict('CONTRADICTS: "six"', REPLY);
  eq(v.contradicts, false, 'a span too short to locate uniquely is refused');
  ok(v.rejected!.includes('too short'), 'and says so');
}

{
  // A model that says NONE and then rambles about a hypothetical contradiction.
  eq(readVerdict(`NONE. Though if she had wings, CONTRADICTS: "${target}"`, REPLY).contradicts,
    false, 'a NONE before a hypothetical claim wins — the model already answered');
}

{
  // A model that explains after the quote.
  const v = readVerdict(`CONTRADICTS: "${target}"\nBecause the fact says she has no wings.`, REPLY);
  ok(v.contradicts, 'trailing explanation does not break the parse');
  eq(v.sentence, target, 'and does not end up inside the quoted sentence');
}

{
  // Nothing may throw: this reads arbitrary model output on every message.
  const junk = ['', '{', 'CONTRADICTS:', 'CONTRADICTS: ""', ' ', 'a'.repeat(9000)];
  let threw = false;
  for (const j of junk) { try { readVerdict(j, REPLY); } catch { threw = true; } }
  ok(!threw, 'no model output makes the verdict parser throw');
}

/* ------------------------------------------------------------------ */
/* Splicing a repair back in — or refusing to                          */
/* ------------------------------------------------------------------ */

{
  const fixed = 'She folded two of her arms and waited for the lock to give.';
  const r = applyRepair(REPLY, target, fixed);
  ok(r.ok, 'a small, in-place rewrite is applied');
  ok(r.text.includes(fixed), 'the new sentence is in the reply');
  ok(!r.text.includes(target), 'and the old one is not');
  ok(r.text.startsWith('Vera turned toward the door'),
    'and the rest of the reply is untouched, word for word');
}

{
  ok(!applyRepair(REPLY, target, '').ok, 'an empty rewrite is refused');
  ok(!applyRepair(REPLY, target, '   ').ok, 'and so is whitespace');
  ok(!applyRepair(REPLY, target, target).ok, 'an identical rewrite is refused rather than "applied"');
  ok(!applyRepair(REPLY, 'a sentence that is not in the reply at all', 'x').ok,
    'a sentence that is not there cannot be replaced');
}

{
  /**
   * What models actually do when asked to fix one sentence: return the whole
   * passage, or explain themselves at length.
   */
  const wholePassage = `${REPLY} And so the scene continued for some time, `
    + 'with much that could be said about the nature of locks and of waiting.';
  const r = applyRepair(REPLY, target, wholePassage);
  ok(!r.ok, 'a rewrite far longer than the sentence is refused');
  eq(r.text, REPLY, 'and the reply is left exactly as the model wrote it');
  ok(r.refused!.includes('longer'), 'with a reason that names the problem');
}

{
  const essay = 'Certainly! Here is the rewritten sentence, which I have adjusted '
    + 'to account for the established fact about the character\'s anatomy, '
    + 'while preserving the original tone and cadence as requested by the user.';
  ok(!applyRepair(REPLY, target, essay).ok, 'an explanation instead of a sentence is refused');
}

{
  /**
   * The ratio guard, on a reply short enough that one sentence IS most of it.
   *
   * This is the case the length check alone misses: a replacement of similar
   * length that shares almost no words with the original is a new sentence,
   * not a corrected one.
   */
  const short = 'She had wings.';
  const r = applyRepair(short, short, 'The harbour road ran east.');
  ok(!r.ok, 'a same-length replacement that changes everything is refused');
  ok(r.refused!.includes('%'), 'and reports how much it would have moved');
  eq(r.text, short, 'leaving the reply alone');
}

{
  // Quote marks a model wraps its answer in are stripped, not spliced in.
  const r = applyRepair(REPLY, target, `"She unfolded her arms and waited for the lock to give."`);
  ok(r.ok, 'a rewrite wrapped in quotes is still applied');
  ok(!r.text.includes('"She unfolded'), 'with the wrapping quotes removed');
}

{
  ok(MAX_REPAIR_RATIO > 0 && MAX_REPAIR_RATIO < 1, 'the repair ratio is a fraction');
  /**
   * Only the matched span moves.
   *
   * A sentence appearing twice replaces the FIRST, which is what
   * `String.replace` does and what a reader watching one sentence get fixed
   * would expect. The surrounding text is long on purpose: with a two-sentence
   * reply, repairing one of them legitimately moves half the words and the
   * ratio guard refuses — correctly, but it would test the guard rather than
   * the splice.
   */
  const filler = 'The corridor smelled of tallow and old rain, and somewhere below '
    + 'them a door was being opened very slowly by someone who did not want to be '
    + 'heard doing it. The lamps had not been lit since the second bell.';
  const twice = `${filler} ${target} ${filler} ${target}`;
  const r = applyRepair(twice, target, 'She waited, and counted.');
  ok(r.ok, `a repeated sentence still repairs (${r.refused ?? 'ok'})`);
  eq(r.text, `${filler} She waited, and counted. ${filler} ${target}`,
    'replacing the first occurrence only');
}

/* ------------------------------------------------------------------ */
/* Reporting a run                                                     */
/* ------------------------------------------------------------------ */

{
  const run = emptyRun(REPLY);
  eq(run.text, REPLY, 'an empty run changes nothing');
  ok(!changedAnything(run), 'and says so');
  eq(summarizeRun(run), 'Nothing to check.', 'with no calls, it says there was nothing to check');
}

{
  const quiet: PreprocessRun = { ...emptyRun(REPLY), calls: 4, ms: 3000 };
  ok(summarizeRun(quiet).includes('nothing to change'),
    'a run that checked and found nothing says exactly that — reporting activity '
    + 'every turn is how people learn to ignore this');
  ok(!changedAnything(quiet), 'and nothing changed');
}

{
  const busy: PreprocessRun = {
    original: REPLY, text: `${REPLY} (fixed)`, reformatted: true, calls: 5, ms: 4200,
    findings: [
      { factId: 'f1', factTitle: 'Vera — anatomy', sentence: target, repaired: true },
      { factId: 'f2', factTitle: 'Ledger', sentence: 'x', repaired: false, skipped: 'not verbatim' },
    ],
  };
  const said = summarizeRun(busy);
  ok(said.includes('reformatted'), 'the deterministic pass is reported');
  ok(said.includes('fixed 1 contradiction'), 'so are repairs');
  ok(said.includes('flagged 1'), 'and findings it could not repair are surfaced, not hidden');
  ok(said.includes('4.2s'), 'with the time it cost, which is the thing being traded');
  ok(changedAnything(busy), 'and the run reports that it changed something');
}

/* ------------------------------------------------------------------ */
/* Stages, for the status line                                         */
/* ------------------------------------------------------------------ */

{
  const stages = stagesFor([fact(), fact({ id: 'f2', title: 'Ledger' })]);
  eq(stages[0].kind, 'format', 'the free deterministic pass runs first');
  eq(stages.length, 3, 'then one stage per fact');
  ok(stages[1].label.includes('Vera — anatomy'),
    'and each names the fact, so the status line says something worth reading');
  eq(stages[1].factId, 'f1', 'carrying the fact id for the caller');
  eq(stagesFor([]).length, 1, 'with no facts, only the format pass runs');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
