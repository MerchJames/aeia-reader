/**
 * Run: npx tsx src/utils/zoneTask.test.ts
 *
 * The saved job: these zones, in this order, into that document.
 *
 * The property this file exists for is the one the reader asked for in the
 * first place — **the form is not remade every time.** A document assembled
 * from five passes where only the first pass was told the shape comes back as
 * five documents stapled together, and it does so quietly: every section is
 * individually plausible and the whole is incoherent. So the format is asserted
 * to be present in EVERY pass, not just the first, and the assertion is written
 * against the last pass because that is the one that drifts.
 *
 * Two failures below it, both silent:
 *
 * **An empty zone becoming an empty section.** The model is told it is reading
 * section 3 of 5, handed nothing, and writes a section anyway — inventing a
 * stretch of a story the reader never selected. Skipped zones must not be
 * counted, and must be reported by name so the panel can say what happened.
 *
 * **Losing the order.** A reader who ordered three zones by hand has asserted
 * that two follows one. If the sections arrive in any other order, or the
 * travelling key does not reach the next pass, the document is a fold — which
 * is the thing `longRead` was written to stop being.
 */
import {
  type ZoneSection, type ZoneTask,
  runZoneTask, taskFromJob, taskToJob, usableSections,
} from './zoneTask';
import { SUMMARY_JOB } from './longRead';
import type { ChatMsg } from './aiClient';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const FORMAT = '### <title>\n<two paragraphs, past tense, no bullets>';

const task = (extra: Partial<ZoneTask> = {}): ZoneTask => ({
  id: 't-1',
  name: "Mara's arc",
  zoneIds: ['z-1', 'z-2', 'z-3'],
  purpose: 'a running account of one character',
  format: FORMAT,
  keyBrief: 'WHO / WHERE / OPEN / LAST',
  targetPinId: 'pin-a1',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const zones: ZoneSection[] = [
  { zoneId: 'z-1', name: 'Act I', body: 'ACT ONE TEXT' },
  { zoneId: 'z-2', name: 'The siege', body: 'SIEGE TEXT' },
  { zoneId: 'z-3', name: 'After', body: 'AFTER TEXT' },
];

/** A `send` that writes a section named after whatever it was given. */
const recorder = () => {
  const sent: ChatMsg[][] = [];
  const send = async (messages: ChatMsg[]) => {
    sent.push(messages);
    const user = messages[1].content;
    if (/front matter/i.test(messages[0].content)) return '# THE FRONT MATTER';
    const which = user.match(/--- (.+?) —/)?.[1] ?? 'UNKNOWN';
    return `### ${which}\nprose for ${which}.\n<<<CARRY>>>\nLAST: end of ${which}`;
  };
  return { send, sent };
};

/* ------------------------------------------------------------------ */
/* The form, on every pass                                             */
/* ------------------------------------------------------------------ */

{
  const r = recorder();
  await runZoneTask({ task: task(), sections: zones, send: r.send });
  eq(r.sent.length, 3, 'one pass per zone, and no assemble pass when none was asked for');
  ok(r.sent.every(m => m[0].content.includes(FORMAT)),
    'the format reaches EVERY pass — this is the whole reason a task is a saved thing');
  ok(r.sent[2][0].content.includes(FORMAT),
    'including the last one, which is where a format given once has drifted');
  ok(r.sent.every(m => m[0].content.includes('WHO / WHERE / OPEN / LAST')),
    'and so does the brief for the notes it carries forward');
}

/* ------------------------------------------------------------------ */
/* The order, and the key that travels along it                        */
/* ------------------------------------------------------------------ */

{
  const r = recorder();
  const out = await runZoneTask({ task: task(), sections: zones, send: r.send });
  eq(out.sections, 3, 'every zone contributed a section');
  const order = out.document.split('\n\n').map(s => s.split('\n')[0]);
  eq(order[0], '### ACT I', 'the first zone is the first section');
  eq(order[1], '### THE SIEGE', 'the second is the second');
  eq(order[2], '### AFTER', 'and the reader\'s order is the document\'s order');

  ok(r.sent[0][1].content.includes('This is the beginning'),
    'the first pass is told it is the beginning');
  ok(r.sent[1][1].content.includes('LAST: end of ACT I'),
    'the second pass carries the notes the first one wrote');
  ok(r.sent[2][1].content.includes('LAST: end of THE SIEGE'),
    'and the third carries the second\'s — the key travels the whole way');
  ok(r.sent[2][1].content.includes('ACT ONE TEXT') === false,
    'while the zone TEXT does not, so cost stays flat across a long task');
  ok(r.sent[1][1].content.includes('THE DOCUMENT SO FAR'),
    'each pass sees the tail it is continuing from');
}

// The zone's NAME must reach the model. Without it every section is "stretch N"
// and the reader's chosen structure is invisible to the thing writing it.
{
  const r = recorder();
  await runZoneTask({ task: task(), sections: zones, send: r.send });
  ok(r.sent[1][1].content.includes('THE SIEGE'), 'a section is named, not numbered');
  ok(r.sent[1][1].content.includes('SECTION 2 OF 3'), 'and still knows where it sits');
}

/* ------------------------------------------------------------------ */
/* Empty zones                                                         */
/* ------------------------------------------------------------------ */

{
  const { used, skipped } = usableSections([
    zones[0], { zoneId: 'z-x', name: 'Cut scenes', body: '   ' }, zones[1],
  ]);
  eq(used.length, 2, 'a zone that selects nothing is not a section');
  eq(skipped[0], 'Cut scenes', 'and is reported by name');
}

{
  const r = recorder();
  const out = await runZoneTask({
    task: task(),
    sections: [zones[0], { zoneId: 'z-2', name: 'Empty', body: '' }, zones[2]],
    send: r.send,
  });
  eq(out.sections, 2, 'the empty zone contributed nothing');
  eq(out.skipped.join(), 'Empty', 'and the run says which zone it was');
  eq(r.sent.length, 2, 'no request was spent on it');
  ok(r.sent[1][1].content.includes('SECTION 2 OF 2'),
    'and the sections that remain are numbered contiguously — never "2 of 3" with a hole');
}

{
  const r = recorder();
  const out = await runZoneTask({
    task: task(), sections: [{ zoneId: 'z-1', name: 'Empty', body: '' }], send: r.send,
  });
  eq(r.sent.length, 0, 'a task whose zones are all empty sends nothing at all');
  eq(out.document, '', 'and produces no document');
  eq(out.skipped.length, 1, 'while still explaining itself');
}

/* ------------------------------------------------------------------ */
/* Front matter                                                        */
/* ------------------------------------------------------------------ */

{
  const r = recorder();
  const out = await runZoneTask({
    task: task({ assemble: SUMMARY_JOB.assemble }), sections: zones, send: r.send,
  });
  eq(r.sent.length, 4, 'a task that wants front matter pays for one more pass');
  ok(out.document.startsWith('# THE FRONT MATTER'), 'and it goes on top');
  ok(out.document.includes('### ACT I'), 'over the sections, which are not rewritten');
}

// The default is no front matter, because rewriting the top of the document on
// every run is exactly the "remaking the form each time" a task exists to stop.
{
  const r = recorder();
  const out = await runZoneTask({ task: task(), sections: zones, send: r.send });
  ok(!out.document.includes('FRONT MATTER'), 'without one, the document is its sections');
}

/* ------------------------------------------------------------------ */
/* Stopping                                                            */
/* ------------------------------------------------------------------ */

{
  const controller = new AbortController();
  const r = recorder();
  let n = 0;
  const send = async (m: ChatMsg[]) => { if (++n === 2) controller.abort(); return r.send(m); };
  const out = await runZoneTask({
    task: task({ assemble: SUMMARY_JOB.assemble }), sections: zones, send, signal: controller.signal,
  });
  eq(out.aborted, true, 'stopping is reported');
  eq(out.sections, 2, 'with the sections that were finished');
  ok(!out.document.includes('FRONT MATTER'),
    'and no front matter, which would describe an ending nobody reached');
}

/* ------------------------------------------------------------------ */
/* Seeding from a built-in job                                         */
/* ------------------------------------------------------------------ */

{
  const seeded = taskFromJob(SUMMARY_JOB, 'My account', 't-9', 100);
  eq(seeded.format, SUMMARY_JOB.format, 'a new task starts from a format worth starting from');
  eq(seeded.zoneIds.length, 0, 'with no zones yet');
  eq(seeded.targetPinId, null, 'and nowhere to land until the reader says');
  seeded.format = 'edited';
  eq(SUMMARY_JOB.format.includes('edited'), false,
    'and editing it never reaches back into the built-in job');

  const job = taskToJob(task());
  eq(job.format, FORMAT, 'the task converts to the shape buildPassMessages speaks');
  eq(job.assemble, '', 'with no assemble step unless one was authored');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
