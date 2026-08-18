/** Run: npx tsx src/utils/liveReaction.test.ts */
import {
  MAX_CUES, buildReactionMessages, buildScoutMessages, parseScoutCues, pointAt,
  resolveReactionPoints, scoutSystem, visibleText, reactionSystem, scoutTokens,
  historyBefore,
} from './liveReaction';
import { clampHistory } from './askCharacter';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const PASSAGE = 'She stood at the rail. And the blade was going to sever them, one last time. '
  + 'Behind her the lamps went out, one after another, and nobody spoke.';

/* ---- the scout's output is matched against the screen, so it must be exact -- */

{
  const cues = parseScoutCues(JSON.stringify([
    { text: 'the blade was going to sever them', why: 'she is in danger' },
  ]), PASSAGE);
  eq(cues.length, 1, 'a verbatim moment is kept');
  eq(cues[0].why, 'she is in danger', 'and so is the scout\'s reason');
}

// A paraphrase does not fire late — it never fires at all, because the reveal is
// matched character by character. Dropping it here is the only place it shows.
eq(parseScoutCues(JSON.stringify([{ text: 'the knife was about to cut them' }]), PASSAGE).length, 0,
  'a paraphrase is discarded rather than silently never firing');

eq(parseScoutCues(JSON.stringify([{ text: PASSAGE }]), PASSAGE).length, 0,
  'the whole passage is not a moment');
eq(parseScoutCues(JSON.stringify([{ text: 'a' }]), PASSAGE).length, 0, 'nor is one letter');

// The model reaching for four is exactly the failure mode the cap exists for.
{
  const many = ['She stood at the rail', 'the blade', 'the lamps went out', 'nobody spoke', 'one last time'];
  const cues = parseScoutCues(JSON.stringify(many.map(text => ({ text }))), PASSAGE);
  eq(cues.length, MAX_CUES, 'no more than three moments survive');
}

eq(parseScoutCues(JSON.stringify([{ text: 'the blade' }, { text: 'The Blade' }]), PASSAGE).length, 1,
  'the same moment twice is one moment');

// Reasoning models: the Director learned this the hard way, and a scout reply is
// a bare JSON array, which is exactly what deliberation ABOUT a JSON array
// looks like.
{
  const thinking = '<think>Maybe [{"text": "the lamps"}] would work, or something else.</think>\n'
    + '[{"text": "nobody spoke"}]';
  const cues = parseScoutCues(thinking, PASSAGE);
  eq(cues.length, 1, 'thinking is stripped before the array is read');
  eq(cues[0].text, 'nobody spoke', 'so the answer is the answer, not the deliberation');
}

eq(parseScoutCues('I would react when she stood at the rail.', PASSAGE).length, 0,
  'a chatty non-answer yields nothing');
eq(parseScoutCues('```json\n[{"text": "one last time"}]\n```', PASSAGE)[0]?.text, 'one last time',
  'a fenced reply still parses');

/* ---- offsets ------------------------------------------------------------- */

{
  const pts = resolveReactionPoints(PASSAGE, [
    { text: 'nobody spoke' }, { text: 'the blade' },
  ]);
  eq(pts.length, 2, 'both moments resolve');
  ok(pts[0].start < pts[1].start, 'and come back in reading order, not the order asked for');
  eq(PASSAGE.slice(pts[0].start, pts[0].end), 'the blade', 'the offsets are the words');
}

// Two reactions on the same words is one companion talking over themselves.
{
  const pts = resolveReactionPoints('the blade and the blade', [
    { text: 'the blade' }, { text: 'the blade' },
  ]);
  eq(pts.length, 2, 'a repeated phrase resolves to its next free occurrence');
  ok(pts[0].end <= pts[1].start, 'and the two never overlap');
}
eq(resolveReactionPoints(PASSAGE, [{ text: 'not in here at all' }]).length, 0,
  'a moment that is not on the page resolves to nothing');

/* ---- firing -------------------------------------------------------------- */

{
  const pts = resolveReactionPoints(PASSAGE, [{ text: 'the blade' }, { text: 'nobody spoke' }]);
  const spoken = new Set<string>();
  ok(!pointAt(pts, 5, spoken), 'nothing fires before the reveal reaches the words');
  ok(!pointAt(pts, pts[0].end - 1, spoken), 'not even one character short of them');
  const first = pointAt(pts, pts[0].end, spoken)!;
  eq(first.text, 'the blade', 'it fires the moment the words are fully on screen');
  spoken.add(first.id);
  ok(!pointAt(pts, pts[0].end, spoken), 'and does not fire twice');
  eq(pointAt(pts, PASSAGE.length, spoken)?.text, 'nobody spoke', 'the next one waits its turn');
}

/* ---- the within-message clamp — the whole point of the feature ------------ */

{
  const pts = resolveReactionPoints(PASSAGE, [{ text: 'the blade' }]);
  const seen = visibleText(PASSAGE, pts[0].end);
  ok(seen.endsWith('the blade'), 'at upTo they see exactly as far as the words that landed');
  ok(!seen.includes('sever'), 'and NOT how the sentence ends');
  ok(!seen.includes('nobody spoke'), 'nor anything later in the passage');
  eq(visibleText(PASSAGE, pts[0].end, 'whole'), PASSAGE, 'at whole they have read ahead');
}
eq(visibleText('abc', 99), 'abc', 'a cue past the end of the text clamps to the text');
eq(visibleText('abc', -5), '', 'and a negative one to nothing');

/* ---- what actually reaches the model ------------------------------------- */

const HISTORY = [
  { id: 'm1', name: 'Mara', content: 'The hearth burned low.' },
  { id: 'm2', name: 'Mara', content: 'She went to the rail.' },
  { id: 'm3', name: 'Mara', content: 'And then the ship went down with everyone aboard.' },
];
const reactor = { name: 'Elara' };

{
  // The between-message clamp is askCharacter's, unchanged, and it fails closed.
  const clamped = clampHistory(HISTORY, 'm2');
  const msgs = buildReactionMessages({
    reactor, history: clamped, visible: 'She went to the rail. And the blade',
    moment: 'the blade',
  });
  const all = msgs.map(m => m.content).join('\n');
  ok(all.includes('The hearth burned low.'), 'what they have read is in the prompt');
  ok(!all.includes('the ship went down'), 'and the ending is not');
  ok(!all.includes('sever'), 'nor the rest of the sentence they are reacting to');
  ok(all.includes('the blade'), 'the moment itself is quoted for them');
}

eq(clampHistory(HISTORY, 'no-such-beat').length, 0,
  'an unknown anchor yields NOTHING — a reaction arrives unbidden, so this fails closed');
eq(historyBefore(HISTORY, 'no-such-beat').length, 0, 'and the same for the reaction clamp');

/*
 * The leak this exists for, caught by the e2e that reads the request body.
 * `clampHistory` includes the anchored message IN FULL — right for an interview
 * asked after the beat, catastrophic during one: the end of the very sentence
 * they were reacting to arrived in the block labelled "everything you know",
 * while `visibleText` was carefully withholding it one paragraph below.
 */
{
  const before = historyBefore(HISTORY, 'm2');
  eq(before.length, 1, 'the passage being read is not in the history');
  eq(before[0].id, 'm1', 'only what came before it is');
  ok(clampHistory(HISTORY, 'm2').some(m => m.id === 'm2'),
    "…which is exactly where the interview's clamp differs, and rightly so");

  const msgs = buildReactionMessages({
    reactor, history: before, visible: 'She went to the rail. And the blade', moment: 'the blade',
  });
  const all = msgs.map(m => m.content).join('\n');
  ok(!all.includes('And then the ship went down'), 'no later beat reaches them');
  ok(!/rail\. And the blade was going/.test(all), 'and no unrevealed part of THIS passage either');
}

{
  const msgs = buildReactionMessages({
    reactor, history: [], visible: 'x', moment: 'x',
    said: ['Oh my god.'],
  });
  ok(msgs.map(m => m.content).join('\n').includes('Oh my god.'),
    'what they already said in this passage comes back, so they do not repeat it');
}

// The scout must not be handed the line to write, and the reason must not be
// handed to the reactor — it would answer the question for them.
{
  const msgs = buildScoutMessages({ reactor, passage: PASSAGE, history: [] });
  const all = msgs.map(m => m.content).join('\n');
  ok(/do not write dialogue/i.test(all), 'the scout is told not to write the line');
  ok(all.includes(PASSAGE), 'and is given the passage to mark');
}
{
  const msgs = buildReactionMessages({
    reactor, history: [], visible: 'x', moment: 'x',
  });
  ok(!msgs.map(m => m.content).join('\n').includes('she is in danger'),
    "the scout's reason never reaches the reactor");
}

ok(reactionSystem({ name: 'Elara', frame: 'phone' }).includes('phone'), 'the phone frame reads as a call');
ok(reactionSystem({ name: 'Elara' }).includes('over their shoulder'), 'and the default as the room');
ok(reactionSystem({ name: 'Elara', frame: 'phone' }).includes('ONE or TWO short lines'),
  'both frames ask for a reaction, not an essay');
ok(scoutSystem('Elara').includes('return []'), 'a quiet passage is allowed to stay quiet');
ok(scoutTokens(true) - scoutTokens(false) >= 4000, 'a thinking model gets room to think');

/* ---- the boundary, enforced rather than promised ------------------------- */

/*
 * Ask Character's reader-only guarantee is kept by NOT WIRING IT ANYWHERE — the
 * slice is read by exactly one component. That is a real guarantee and an
 * invisible one: nothing stops the next person from reading it somewhere else,
 * and the comment saying they must not is the only thing in the way.
 *
 * Live Reaction speaks WITHOUT BEING ASKED, so its boundary is the only thing
 * standing between a reading companion and a companion chat. Worth a tripwire.
 */
{
  const files = readdirSync(join(SRC, 'components')).map(f => join(SRC, 'components', f))
    .concat(readdirSync(join(SRC, 'utils')).map(f => join(SRC, 'utils', f)))
    .concat(readdirSync(join(SRC, 'hooks')).map(f => join(SRC, 'hooks', f)))
    .filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

  const readers = files.filter(f => readFileSync(f, 'utf8').includes('reactionsByStory'))
    .map(f => f.split('/').pop()!)
    // The persistence table names every slice; declaring one is not reading it.
    .filter(f => f !== 'v2Persist.ts');
  // The hook that drives it, and nothing else. Not the exporter, not the
  // context builders, not the Director, not the summarizer.
  ok(readers.length === 1 && readers[0] === 'useLiveReaction.ts',
    `only the Live Reaction hook may read the slice (found: ${readers.join(', ') || 'none'})`);

  for (const name of ['htmlExport.ts', 'exporter.ts', 'storyWalk.ts', 'cardContext.ts',
    'contextZone.ts', 'sceneDirector.ts', 'lens.ts']) {
    const f = files.find(x => x.endsWith(`/${name}`));
    if (!f) continue;
    ok(!readFileSync(f, 'utf8').includes('reactionsByStory'),
      `${name} must never see a reaction`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
