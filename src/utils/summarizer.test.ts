/**
 * Run: npx tsx src/utils/summarizer.test.ts
 *
 * How much story one section of a long read covers.
 *
 * The bug this file exists for had no error, no warning and no failing test.
 * The section budget was derived from the model's CONTEXT WINDOW — so a reader
 * who correctly told the app their model holds 128k tokens was handed a budget
 * of 417,930 characters, their whole 400-message chat became ONE chunk, and the
 * "summary" was a single reply about a quarter of a million characters. A model
 * given that much text in one go writes about the end of it. The report was
 * "it completely missed the beginning", and the setting that caused it was the
 * one the reader had filled in correctly.
 *
 * The window answers "how much CAN I fit". A section needs "how much SHOULD one
 * cover". Those were the same question while windows were small and stopped
 * being the same question years ago.
 *
 * So the property below is the whole fix, and it is worth stating as a rule:
 * **the context window may only ever make a section smaller.**
 */
import {
  DETAIL_CHARS, DETAIL_OUTPUT, READ_DETAILS, chunkByBudget,
  estimateBudgetChars, sectionBudget,
} from './summarizer';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** A mid-size SillyTavern log: 400 messages, ~700 chars each. */
const story = Array.from({ length: 400 }, () => ({ name: 'Mara', content: 'x'.repeat(700) }));
const chars = story.reduce((n, p) => n + p.name.length + p.content.length + 2, 0);
const sectionsAt = (budget: number) => chunkByBudget(story, budget).length;

// The rule.
{
  for (const ctx of [0, 4096, 8192, 32_768, 131_072, 1_000_000]) {
    ok(sectionBudget('normal', ctx) <= DETAIL_CHARS.normal,
      `a ${ctx || 'default'}-token window never widens a section past what Normal asks for`);
  }
  ok(sectionBudget('normal', 1_000_000) === DETAIL_CHARS.normal,
    'an enormous window simply stops being the constraint');
  ok(sectionBudget('normal', 2048) < DETAIL_CHARS.normal,
    'a small one still shrinks the section, because it must');
  ok(sectionBudget('exhaustive', 131_072) < sectionBudget('brief', 131_072),
    'and detail, not the window, is what orders the settings');
}

// The regression, stated as the number the reader actually experienced.
{
  const before = estimateBudgetChars(131_072, 0.8);
  eq(sectionsAt(before), 1,
    'THE BUG: sized by a 128k window, a 400-message chat was one chunk and one pass');
  const after = sectionBudget('normal', 131_072, 0.8);
  ok(sectionsAt(after) >= 10,
    'sized by detail, the same chat is walked in a dozen or more sections');
  ok(sectionsAt(sectionBudget('detailed', 131_072)) > sectionsAt(after),
    'and asking for more detail really does mean more passes');
}

// Every setting walks the story rather than gulping it, at every window size a
// reader might plausibly have set.
{
  for (const d of READ_DETAILS) {
    for (const ctx of [0, 8192, 32_768, 131_072]) {
      const n = sectionsAt(sectionBudget(d.id, ctx));
      ok(n > 1, `${d.id} at ${ctx || 'default'} tokens never collapses to a single pass`);
    }
  }
}

// Chunking still covers everything, with nothing dropped or duplicated.
{
  const chunks = chunkByBudget(story, sectionBudget('normal', 0));
  eq(chunks.flat().length, story.length, 'every message lands in exactly one section');
  eq(chunks.flat()[0], story[0], 'starting with the first');
  eq(chunks.flat()[story.length - 1], story[story.length - 1], 'and ending with the last');
  ok(chunks.every(c => c.length > 0), 'and no section is empty');
}

// Output room. Left unstated it was the endpoint's default, which on several of
// the backends this app names as tested is small enough to cut a section off
// mid-sentence — indistinguishable, to the reader, from a model that writes badly.
{
  for (const d of READ_DETAILS) {
    ok(DETAIL_OUTPUT[d.id] >= 800, `${d.id} asks for room to write a section`);
  }
  ok(DETAIL_OUTPUT.exhaustive > DETAIL_OUTPUT.brief,
    'and a more detailed section is given more of it');
}

// Nothing can produce a budget too small to hold a passage.
{
  ok(sectionBudget('exhaustive', 1) >= 600, 'a nonsense context still yields a usable floor');
  ok(sectionBudget('brief', -5) >= 600, 'and so does a negative one');
  eq(chunkByBudget([], 1000).length, 0, 'an empty story is no sections, not one empty one');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
