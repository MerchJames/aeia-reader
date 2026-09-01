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
  KEY_CHARS, LONG_READ_JOBS, SUMMARY_JOB, TIMELINE_JOB, buildAssembleMessages, buildPassMessages, clip,
  keyHistory, keyLabels,
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

/*
 * How a real model actually lays out a reply — and the one rule that matters.
 *
 * Found by running the engine against five plausible layouts (2026-09-01). Four
 * of the five were broken, and the worst was silent: a model that writes its
 * notes BEFORE the section made `text.slice(0, at)` empty, so the section was
 * dropped and the pass thrown away at full cost. A model that varies its layout
 * from pass to pass therefore kept only the passes it happened to format
 * correctly — producing a document about a fragment of the story, with a
 * successful-looking run behind it. That is the bug this block exists for.
 *
 * The asymmetry is the design: losing the notes costs continuity on ONE pass,
 * losing the section costs the pass. So when the layout cannot be read, the
 * section wins and everything becomes the section.
 */
{
  const labels = keyLabels(TIMELINE_JOB.keyBrief);
  ok(labels.includes('WHEN:') && labels.includes('LAST:'),
    'a job\'s note labels are read off its own brief, not hardcoded');

  const notesFirst = parsePass(
    '<<<CARRY>>>\nWHEN: night\nLAST: she left\n\n### Stretch 4\n- **dawn** — she left', 'OLD', labels);
  eq(notesFirst.section, '### Stretch 4\n- **dawn** — she left',
    'notes written first no longer cost the section — the run-losing bug');
  eq(notesFirst.key, 'WHEN: night\nLAST: she left', 'and the notes are still picked up');
  eq(notesFirst.issue, 'recovered', 'reported rather than passed off as a clean pass');

  const bold = parsePass('### S\n- a beat\n**<<<CARRY>>>**\nWHEN: night', 'OLD', labels);
  eq(bold.section, '### S\n- a beat', 'a decorated marker leaves no ** in the document');
  eq(bold.key, 'WHEN: night', 'nor at the head of the notes');
  eq(bold.issue, 'ok', 'and it counts as following the format, because it did');

  const spaced = parsePass('### S\nbody\n<<< carry >>>\nWHEN: night', 'OLD', labels);
  eq(spaced.section, '### S\nbody', 'spacing and case inside the marker are tolerated');

  const fenced = parsePass(
    '```markdown\n### S\n- a beat\n<<<CARRY>>>\nWHEN: night\n```', 'OLD', labels);
  eq(fenced.section, '### S\n- a beat', 'a reply wrapped whole in a fence puts no ``` in the document');
  eq(fenced.key, 'WHEN: night', 'and none in the notes');

  // A section that legitimately contains a code block keeps it — the orphan
  // rule is what distinguishes a wrapper cut in half from real content.
  const withCode = parsePass(
    '### S\n```js\nconst a = 1;\n```\ndone\n<<<CARRY>>>\nWHEN: night', 'OLD', labels);
  ok(withCode.section.includes('```js'), 'a balanced code block inside a section survives');
  ok(withCode.section.endsWith('done'), 'whole');

  // No marker at all: the notes must not land in the reader's document, and
  // the key must still move — otherwise every later pass reads blind and this
  // engine has silently become the map-reduce it was written to replace.
  const none = parsePass(
    '### S\n- a beat\n\nNotes for next time:\nWHEN: night\nLAST: she left', 'OLD', labels);
  eq(none.section, '### S\n- a beat', 'the notes are lifted off by their own labels');
  ok(!none.section.includes('Notes for next time'), 'announcement and all');
  eq(none.key, 'WHEN: night\nLAST: she left', 'and they travel on');
  eq(none.issue, 'no-marker', 'while still being reported as a malformed reply');

  // Without labels there is nothing to cut on, so the section keeps everything
  // rather than having its ending guessed at.
  const blind = parsePass('### S\n- a beat\n\nWHEN: night', 'OLD');
  ok(blind.section.includes('WHEN: night'), 'with no labels, nothing is guessed');
  eq(blind.key, 'OLD', 'and the previous notes travel on');
}

// A whole run against a model that never once gets the layout right must still
// produce every section, and must SAY that it went wrong.
{
  const story: SummaryPassage[] = Array.from({ length: 6 }, (_, i) => ({
    name: 'Mara', content: `beat ${i} ` + 'x'.repeat(900),
  }));
  let n = 0;
  const out = await runLongRead({
    job: TIMELINE_JOB,
    passages: story,
    budgetChars: 2000,
    send: async (messages) => {
      if (/front matter/i.test(messages[0].content)) return '# Front';
      n++;
      return `<<<CARRY>>>\nWHEN: night ${n}\n\n### Stretch ${n}\n- **then** — beat ${n}`;
    },
  });
  eq(out.sections, n, 'every pass that was paid for is in the document');
  ok(out.document.includes('### Stretch 1'), 'including the first');
  ok(out.document.includes(`### Stretch ${n}`), 'and the last');
  eq(out.malformed, n, 'and the run reports that none of them followed the format');
  eq(out.blind, 0, 'the notes still travelled, so no pass read blind');
}

// The failure that made a document read as map-reduce: notes never move.
{
  const story: SummaryPassage[] = Array.from({ length: 4 }, () => ({
    name: 'Mara', content: 'x'.repeat(900),
  }));
  const out = await runLongRead({
    job: TIMELINE_JOB,
    passages: story,
    budgetChars: 1000,
    send: async (messages) =>
      (/front matter/i.test(messages[0].content) ? '# Front' : '### S\njust prose, no notes'),
  });
  ok(out.blind > 0, 'a run whose notes never move says so');
  eq(out.malformed, out.sections, 'and marks every pass as malformed');
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

/*
 * The front matter is written by the blindest step in the run.
 *
 * It receives the section HEADINGS and the notes — and the notes used to be the
 * final key alone, which is end-state by design ("WHEN: where the clock stands
 * now", "LAST: the final beat") and rewritten at every pass with an instruction
 * to drop what no longer matters. So the model asked for the premise, the cast
 * and what is still open had seen a table of contents and a note about the last
 * night of the story, and wrote front matter about the ending. On a long read
 * that is the first thing the reader looks at.
 *
 * The fix is the whole arc — and its own trap is recency: a cap that keeps the
 * recent notes and drops the early ones rebuilds the same bug with more steps.
 */
{
  const stages = ['WHEN: night one\nWHERE: the inn', 'WHEN: night four\nWHERE: the gate'];
  const h = keyHistory(stages);
  ok(h.includes('the inn'), 'the history carries the beginning');
  ok(h.includes('the gate'), 'and the end');
  ok(h.indexOf('the inn') < h.indexOf('the gate'), 'oldest first, so it reads as an arc');
  ok(/after stretch 1/.test(h), 'each stage says where in the read it was taken');

  eq(keyHistory([]), '', 'no notes, no block');
  eq(keyHistory(['', '   ']), '', 'and blank ones are not stages');
  const dup = keyHistory(['WHO: Mara', 'WHO: Mara', 'WHO: Mara and Sable']);
  eq((dup.match(/after stretch/g) ?? []).length, 2,
    'a pass whose notes did not change is not a stage of its own');

  // The trap. Twenty fat stages over a small cap: every one must survive,
  // thinner — never the last few at full width.
  const many = Array.from({ length: 20 }, (_, i) => `WHERE: place ${i} ` + 'x'.repeat(900));
  const capped = keyHistory(many, 3000);
  ok(capped.length <= 3200, 'the block has a ceiling');
  eq((capped.match(/after stretch/g) ?? []).length, 20,
    'and EVERY stage is still represented — dropping the early ones is the bug');
  ok(capped.includes('place 0'), 'including the first');
  ok(capped.includes('place 19'), 'and the last');
}

// The assembly pass actually receives it.
{
  const plain = buildAssembleMessages(SUMMARY_JOB, '### A', 'END STATE');
  ok(plain[1].content.includes('END STATE'),
    'with no history, the single key is still sent — old callers are unchanged');

  const withArc = buildAssembleMessages(
    SUMMARY_JOB, '### A', 'END STATE', undefined, 'A Story',
    keyHistory(['WHERE: the inn', 'WHERE: the gate']),
  );
  ok(withArc[1].content.includes('the inn'), 'with one, the whole arc goes instead');
  ok(withArc[1].content.includes('EACH STAGE'), 'under a header saying what it is');
  ok(/WHOLE story, not its ending/i.test(withArc[0].content),
    'and the model is told to describe the story rather than its end');
}

// End to end: the front matter can see the first stretch of a long read.
{
  const seen: string[] = [];
  let n = 0;
  await runLongRead({
    job: TIMELINE_JOB,
    passages: Array.from({ length: 8 }, () => ({ name: 'Mara', content: 'x'.repeat(900) })),
    budgetChars: 1000,
    send: async (messages) => {
      if (/front matter/i.test(messages[0].content)) { seen.push(messages[1].content); return '# Front'; }
      n++;
      return `### S${n}\n- a beat\n<<<CARRY>>>\nWHERE: place ${n}`;
    },
  });
  ok(n > 2, 'the run took several passes');
  ok(seen[0].includes('place 1'),
    'and the front matter was written knowing where the story STARTED');
  ok(seen[0].includes(`place ${n}`), 'as well as where it ended');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
