/**
 * Run: npx tsx src/utils/longRead.test.ts
 *
 * The long read — the engine for anything bigger than a context window.
 *
 * The properties worth pinning are the ones that separate this from the
 * map-reduce it replaces, and each of them fails silently rather than loudly:
 *
 * - the travelling key really reaches the next pass (without it, every section
 *   reads blind and re-introduces people the document already knows);
 * - cost per pass stays FLAT — only the key and the document's tail travel, so
 *   section forty is not the expensive one that truncates;
 * - a model that forgets the marker still contributes its section, because
 *   discarding a reply throws away material that was paid for;
 * - the key cannot grow, however many times a model rewrites it.
 *
 * `send` is a stub throughout: what matters here is what the engine does with
 * the replies, not that fetch works.
 */
import {
  KEY_CHARS, LONG_READ_JOBS, SUMMARY_JOB, buildAssembleMessages, buildPassMessages, clip,
  outlineOf, parsePass, runLongRead, tailOf,
} from './longRead';
import type { SummaryPassage } from './summarizer';
import type { ChatMsg } from './aiClient';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const story = (n: number): SummaryPassage[] =>
  Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'You' : 'Mara', content: `beat ${i} ${'x'.repeat(200)}` }));

/** A stub model that answers in the contract's shape and records what it saw. */
const stub = (label = 'ok') => {
  const seen: { system: string; user: string }[] = [];
  const send = async (msgs: ChatMsg[]) => {
    seen.push({
      system: msgs.filter(m => m.role === 'system').map(m => m.content).join('\n'),
      user: msgs.filter(m => m.role === 'user').map(m => m.content).join('\n'),
    });
    const n = seen.length;
    return `### Section ${n}\n${label} body ${n}\n<<<CARRY>>>\nWHO: Mara\nLAST: beat ${n} ended`;
  };
  return { seen, send };
};

// Parsing the two-part reply.
{
  const r = parsePass('### A\nbody\n<<<CARRY>>>\nWHO: Mara');
  eq(r.section, '### A\nbody', 'the section is what precedes the marker');
  eq(r.key, 'WHO: Mara', 'and the notes are what follows it');

  const forgot = parsePass('### A\njust the section', 'OLD NOTES');
  eq(forgot.section, '### A\njust the section', 'a reply with no marker is still a section');
  eq(forgot.key, 'OLD NOTES', 'and the previous notes travel on rather than being lost');

  const empty = parsePass('### A\nbody\n<<<CARRY>>>\n   ', 'OLD');
  eq(empty.key, 'OLD', 'blank notes do not wipe what we already knew');
}

// The key cannot grow, however enthusiastically it is rewritten.
{
  const huge = parsePass(`x\n<<<CARRY>>>\n${'note '.repeat(2000)}`);
  ok(huge.key.length <= KEY_CHARS, 'the travelling key is hard-capped');
  ok(huge.key.endsWith('…'), 'and says it was cut');
  ok(!clip('short', 100).endsWith('…'), 'something under the cap is untouched');
}

// The carry actually reaches the next pass.
{
  const { seen, send } = stub();
  const r = await runLongRead({
    job: SUMMARY_JOB, passages: story(40), budgetChars: 1200, send, title: 'A Night',
  });
  ok(seen.length > 3, 'a long story takes several passes');
  ok(!/NOTES YOU CARRIED HERE/.test(seen[0].user), 'the first pass carries nothing — there is nothing yet');
  ok(/NOTES YOU CARRIED HERE/.test(seen[1].user), 'the second pass is handed the first pass’s notes');
  ok(seen[1].user.includes('LAST: beat 1 ended'), 'and they are the notes it actually wrote');
  ok(/THE DOCUMENT SO FAR ENDS LIKE THIS/.test(seen[1].user), 'plus the tail it must continue from');
  ok(r.sections >= 3 && r.document.includes('### Section 2'), 'the sections land in the document, in order');
  eq(r.aborted, false, 'and it finished');
}

// Cost per pass is flat: the LAST reading pass is no bigger than the second.
{
  const { seen, send } = stub('padded '.repeat(80));
  await runLongRead({ job: SUMMARY_JOB, passages: story(120), budgetChars: 1200, send });
  const reads = seen.slice(0, -1); // the last call is the assembly pass
  ok(reads.length > 6, 'enough passes to grow a document');
  const second = reads[1].user.length;
  const last = reads[reads.length - 1].user.length;
  ok(last < second * 1.6,
    `the final pass is not bloated by the document behind it (second ${second}, last ${last})`);
}

// The assembly pass gets the headings and the notes — never the whole body.
{
  const { seen, send } = stub();
  await runLongRead({ job: SUMMARY_JOB, passages: story(40), budgetChars: 1200, send, title: 'A Night' });
  const final = seen[seen.length - 1];
  ok(/front matter/i.test(final.system), 'the last call is the assembly pass');
  ok(final.user.includes('### Section 1'), 'it sees the outline');
  ok(!final.user.includes('ok body 1'), 'and not the prose under it');
  ok(final.user.includes('A Night'), 'it is told what the story is called');
}

// Stopping keeps what was read, and refuses to invent a conclusion for it.
{
  const controller = new AbortController();
  let calls = 0;
  const send = async () => {
    if (++calls === 2) controller.abort();
    return `### S${calls}\nbody\n<<<CARRY>>>\nWHO: Mara`;
  };
  const r = await runLongRead({
    job: SUMMARY_JOB, passages: story(60), budgetChars: 1200, send, signal: controller.signal,
  });
  ok(r.aborted, 'it reports being stopped');
  ok(r.document.includes('### S1'), 'what was read is kept');
  ok(!/front matter/i.test(r.document), 'but no front matter is written over a half-read story');
}

// Concurrency: faster, blind, and honest about it.
{
  let inFlight = 0, peak = 0;
  const send = async (msgs: ChatMsg[]) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    const user = msgs.find(m => m.role === 'user')?.content ?? '';
    ok(!user.includes('NOTES YOU CARRIED HERE'), 'a parallel pass carries no notes — there are none to carry');
    return '### S\nbody\n<<<CARRY>>>\nWHO: Mara';
  };
  const r = await runLongRead({
    job: SUMMARY_JOB, passages: story(60), budgetChars: 1200, send, concurrency: 4,
  });
  ok(peak > 1, 'passes really do run at once');
  ok(r.sections > 1, 'and every section still lands');
}

// Helpers.
{
  eq(outlineOf('### One\nprose\n\n### Two\nmore'), '### One\n### Two', 'the outline is the headings alone');
  const doc = `### A\n${'x'.repeat(3000)}\n### B\ntail text`;
  ok(tailOf(doc).length <= 1300, 'the tail is bounded');
  ok(tailOf(doc).startsWith('### '), 'and starts at a heading, not mid-sentence');
}

// The prompt teaches the format on EVERY pass, not just the first.
{
  const msgs = buildPassMessages({
    job: SUMMARY_JOB, section: story(2), index: 7, total: 9, key: 'k', tail: 't',
  });
  const system = msgs[0].content;
  ok(system.includes('### <a short title'), 'the format is restated on a late pass');
  ok(system.includes('stretch 7'), 'and the pass knows where it is');
  ok(msgs[1].content.includes('Stretches 1–6 are already written'),
    'and is told not to summarise what is already written');
}

// Every job is a complete definition. A job missing a piece produces a document
// that looks fine and drifts — the format is what stops twenty passes becoming
// twenty different documents, and the key brief is what stops them reading blind.
{
  eq(LONG_READ_JOBS.length, 4, 'summary, timeline, cast and priming');
  eq(new Set(LONG_READ_JOBS.map(j => j.id)).size, LONG_READ_JOBS.length, 'ids are unique');
  for (const job of LONG_READ_JOBS) {
    ok(job.purpose.length > 20, `${job.id}: says what the document is`);
    ok(job.format.includes('###'), `${job.id}: gives the section a heading to hang on`);
    ok(job.keyBrief.includes('LAST'), `${job.id}: carries where it just was, so the next pass continues`);
    ok(job.assemble.includes('#'), `${job.id}: knows what its front matter looks like`);
    // The prompt has to survive being read out of context on pass 30.
    const msgs = buildPassMessages({ job, section: story(2), index: 3, total: 5, key: 'k', tail: 't' });
    ok(msgs[0].content.includes(job.format), `${job.id}: the format travels on every pass`);
    ok(buildAssembleMessages(job, '### A', 'notes').length === 2, `${job.id}: assembles`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
