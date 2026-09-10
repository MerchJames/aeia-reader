/**
 * Run: npx tsx src/utils/cowriter.test.ts
 *
 * The cowriter is the reader's companion pointed the other way, and the things
 * that make it a different feature are exactly the things worth asserting: it
 * sees the whole passage, it is told what the author kept, and it is asked for
 * ONE specific note rather than a report.
 *
 * The clamp tests next door prove a companion cannot see the ending. These
 * prove this one CAN — which is not a relaxed rule, it is the opposite rule.
 */
import {
  buildEditMessages, buildNoteMessages, cowriterSystem, editSystem, noteSamplers,
  parseEdit, NOTE_TOKENS,
} from './cowriter';
import { reactionSamplers } from './liveReaction';
import type { Reactor } from './liveReaction';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const WHO: Reactor = { name: 'Carys', frame: 'room', dossier: 'A poet. Impatient with padding.' };
const HISTORY = [
  { id: 'm1', name: 'Mara', content: 'The hearth burned low.' },
  { id: 'm2', name: 'You', content: 'I said nothing.' },
  { id: 'm3', name: 'Mara', content: 'She went to the rail. And the blade came out, and the ship went down.' },
];
const PASSAGE = 'She went to the rail. And the blade came out, and the ship went down.';

const base = {
  reactor: WHO, passage: PASSAGE, targetId: 'm3', history: HISTORY, userName: 'You',
};

/* ── It reads to the end, on purpose ─────────────────────────────────────── */
{
  const all = buildNoteMessages(base).map(m => String(m.content)).join('\n');
  ok(all.includes('the ship went down'),
    'the cowriter sees the END of the passage — the reader-companion is forbidden this, '
    + 'and an editor who has not read to the end is worthless');
  ok(all.includes('all of it'), 'and is told that is what it is looking at');
  ok(all.includes('The hearth burned low.'), 'with the story that led here');
}

/* ── It is asked for a note, not a report ────────────────────────────────── */
{
  const sys = cowriterSystem(WHO);
  ok(/ONE thing/.test(sys), 'one note, not a list');
  ok(/Not a list, not a report, not a rating/.test(sys), 'and explicitly not those');
  ok(/horoscope/.test(sys),
    'with the difference between a note and a platitude spelled out — "consider '
    + 'tightening the prose" is the failure mode');
  ok(/never rewrite the passage for them/.test(sys),
    'it advises, it does not take the pen');
  ok(/helping write this/.test(sys) && !/watching it with them/.test(sys),
    'the frame is writing, not watching');
  ok(sys.includes('[FEELING:'), 'and it still reports a feeling, so the portrait can follow');
}

/* ── The author's own material is the difference ─────────────────────────── */
{
  const withPins = buildNoteMessages({
    ...base, pins: ['Mara never apologises.', 'The ship is not a metaphor.'],
  });
  const text = String(withPins[1].content);
  ok(text.includes('Mara never apologises.'), "what the author kept is in the prompt");
  ok(/drifting from one is\s+the most useful note/.test(text),
    'and the prompt says what to do with it — a note about the story leaving its own '
    + 'rules is worth more than a note about prose');

  ok(!String(buildNoteMessages(base)[1].content).includes('WHAT THEY HAVE KEPT'),
    'and none of that appears when the author has kept nothing');
}

/* ── It does not repeat itself ───────────────────────────────────────────── */
{
  const twice = String(buildNoteMessages({
    ...base, said: ['The third paragraph explains what the second one showed.'],
  })[1].content);
  ok(twice.includes('explains what the second one showed'), 'past notes travel with it');
  ok(/Do not give the same note twice/.test(twice), 'with instructions not to repeat them');
}

/* ── A note is about something ───────────────────────────────────────────── */
{
  eq(base.targetId, 'm3', 'a note names the passage it is about');
  // The seam: this id is what later lets a note become a Lens proposal or a
  // branch comparison. It costs nothing now and cannot be added to notes
  // already written.
  ok(buildNoteMessages(base).length === 2, 'and the request is a plain two-message ask');
}

/* ── Cooler than a gasp ──────────────────────────────────────────────────── */
{
  ok(noteSamplers('http://x/v1').temperature! < reactionSamplers('http://x/v1').temperature!,
    'a note runs cooler than a reaction: a gasp should surprise you, but advice that '
    + 'changes when the passage did not is advice you cannot use');
  ok(NOTE_TOKENS >= 240, 'and has room for a real thought, since it only speaks once a passage');
}

/* ── Editor's view: the change itself ────────────────────────────────────── */
{
  const span = 'the blade came out';
  const msgs = buildEditMessages({ ...base, span });
  const all = msgs.map(m => String(m.content)).join('\n');

  ok(all.includes(span), 'the words they pointed at are quoted exactly');
  ok(all.includes(PASSAGE), 'with the passage around them, so the change fits where it sits');
  ok(/replace exactly these/.test(all), 'and it is told the span is what gets replaced');

  const sys = editSystem(WHO);
  ok(/ONLY the words they pointed at/.test(sys),
    'scoped to the span: a model asked to improve a paragraph returns a different '
    + 'paragraph, and a diff of a different paragraph cannot be judged');
  ok(/same length/.test(sys), 'and roughly the same size');
  ok(/Their voice, not yours/.test(sys),
    'an edit that makes every author sound like the editor is a takeover');
  ok(/return them UNCHANGED/.test(sys),
    'and it is allowed to say the words were already right — otherwise it will '
    + 'always find something to move');

  /* ── Parsing ─────────────────────────────────────────────────────────── */
  const clean = parseEdit('the blade was already out\n[WHY: shows it, does not stage it]');
  eq(clean?.revised, 'the blade was already out', 'the revision comes back');
  eq(clean?.why, 'shows it, does not stage it', 'and the reason');

  eq(parseEdit('just the words')?.revised, 'just the words',
    'a model that forgets the WHY line costs the reason, not the edit');
  eq(parseEdit('just the words')?.why, '', 'which is simply empty');

  eq(parseEdit('```\nthe blade was already out\n```\n[WHY: x]')?.revised,
    'the blade was already out',
    'a fenced answer is unwrapped — models fence prose even when told not to');

  eq(parseEdit('"she said nothing"')?.revised, 'she said nothing',
    'and a span quoted back whole is unquoted');
  eq(parseEdit('"Get out," she said.')?.revised, '"Get out," she said.',
    'but a line that IS dialogue keeps its quotes — the pair has to enclose '
    + 'everything to be the model quoting');

  eq(parseEdit('   '), null, 'nothing usable is nothing');
  eq(parseEdit('[WHY: it is already right]'), null,
    'and a reason with no revision is not an edit');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
