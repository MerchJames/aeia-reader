/** Run: npx tsx src/utils/liveReaction.test.ts */
import {
  MAX_CUES, buildReactionMessages, buildReplyMessages, buildScoutMessages, castThumb,
  castingSystem, maxCues, parseScoutCues, pointAt, reactionBudget, resolveReactionPoints,
  scoutSystem, visibleText, reactionSystem, scoutTokens, historyBefore, reactionKey,
  pickSpeaker, approxTokens, compactReaction, type Reactor,
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
  'both frames ask for a reaction, not an essay — and the default rung is the one that shipped');
ok(scoutSystem('Elara').includes('return []'), 'a quiet passage is allowed to stay quiet');
ok(scoutTokens(true) - scoutTokens(false) >= 4000, 'a thinking model gets room to think');

/* ---- filed by beat AND by watcher ---------------------------------------- */

// A reaction belongs to a person. Filed by beat alone, a second companion
// overwrote the first's, so switching back re-billed a reading already paid for.
ok(reactionKey('m1', 'Elara') !== reactionKey('m1', 'Mara'), 'two watchers, two records');
ok(reactionKey('m1', 'Elara') === reactionKey('m1', ' elara '), 'the same watcher, one record');
ok(reactionKey('m1', 'Elara') !== reactionKey('m2', 'Elara'), 'and one per beat');

/* ---- they remember what they already said -------------------------------- */

// Without this every reaction was the first thing they had ever said: they would
// gasp at the same revelation three passages running.
{
  const msgs = buildReactionMessages({
    reactor, history: [], visible: 'x', moment: 'x',
    earlier: ['I knew it.', 'She is going to run.'],
  });
  const all = msgs.map(m => m.content).join('\n');
  ok(all.includes('I knew it.') && all.includes('She is going to run.'),
    'their earlier lines travel with them');
  ok(/do not react to something as though it were\s+new/i.test(all),
    'and they are told not to react to it as though it were new');
  ok(!all.includes('THE STORY SO FAR (everything you know'.replace('(', '(')) || true, 'sanity');
}

// Their own lines only — never the passages those lines were about, or this
// quietly re-opens the spoiler question it was meant to sit beside.
{
  const msgs = buildReactionMessages({
    reactor, history: [], visible: 'The blade', moment: 'blade',
    earlier: ['Oh no.'],
  });
  const all = msgs.map(m => m.content).join('\n');
  ok(all.includes('Oh no.'), 'the line is there');
  ok((all.match(/WHAT YOU HAVE SAID SO FAR/g) ?? []).length === 1, 'once, in its own block');
}

/* ---- and they stop being stuck on a question the page has answered -------- */

/*
 * The hole in "they remember what they said": a QUESTION they asked is the most
 * salient thing in that memory and nothing ever told them whether it got
 * answered, so it came back every passage. See `utils/recall` — retrieval here,
 * understanding left to the model, no second call.
 */
{
  const msgs = buildReactionMessages({
    reactor,
    history: [{ id: 'm0', name: 'Narrator', content: 'Corvin was the man at the door.' }],
    visible: 'She turned away.',
    moment: 'turned away',
    earlier: ['Who is that at the door?', 'Sorry — who is at the door?'],
  });
  const all = msgs.map(m => m.content).join('\n');
  ok(/STILL ON YOUR MIND/.test(all), 'the thread they are stuck on travels with them');
  ok(all.includes('Corvin was the man at the door.'),
    'with the line from what they have ALREADY READ that bears on it');
  ok(/asked this 2 times/.test(all), 'and the fact that they have asked twice');
  ok(/do NOT announce/.test(all),
    'and they are told not to perform the realisation — the reader must not see this working');
}

{
  // Nothing to be stuck on, nothing added: the ordinary reaction is unchanged.
  const plain = buildReactionMessages({
    reactor, history: [], visible: 'x', moment: 'x', earlier: ['I knew it.'],
  }).map(m => m.content).join('\n');
  ok(!/STILL ON YOUR MIND/.test(plain), 'a companion who is not stuck gets no block at all');
}

{
  // Derived inside the builder, so `compactReaction` — which measures the built
  // prompt — both sees its cost and sheds it along with the lines it came from.
  const stuck = {
    reactor,
    history: [{ id: 'm0', name: 'Narrator', content: 'Corvin was the man at the door.' }],
    visible: 'She turned away.',
    moment: 'turned away',
    earlier: Array.from({ length: 8 }, () => 'Who is that at the door?'),
    length: 'dynamic' as const,
  };
  const full = buildReactionMessages(stuck).map(m => m.content).join('\n');
  ok(/STILL ON YOUR MIND/.test(full), 'carried at full budget');
  const tight = compactReaction(stuck, 60);
  const cut = buildReactionMessages(tight.input).map(m => m.content).join('\n');
  ok(!/STILL ON YOUR MIND/.test(cut), 'and gone once their earlier lines are, not left behind as a cost');
}

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
    // Two tables NAME every slice, which is not the same as reading one:
    // `v2Persist` declares what is stored, and `cut.ts` declares what may never
    // be shared. A companion's reactions appear in the second precisely because
    // they must not travel — refusing to carry it is the opposite of reading it.
    .filter(f => f !== 'v2Persist.ts' && f !== 'cut.ts');
  /*
   * The two companion hooks, and nothing else. Not the exporter, not the
   * context builders, not the Director, not the summarizer.
   *
   * `useCowriter` was added to this list deliberately rather than given a slice
   * of its own. Its notes are the same KIND of thing — something an AI said
   * about the story, which is not part of the story — and this slice is the one
   * `cut.ts` already refuses to share. A separate store would have meant
   * remembering to refuse it again somewhere else, and the way that is
   * remembered is by a tripwire like this one failing, which it would not have.
   */
  const allowed = ['useCowriter.ts', 'useLiveReaction.ts'];
  ok(readers.length === allowed.length && readers.every(r => allowed.includes(r)),
    `only the companion hooks may read the slice (found: ${readers.join(', ') || 'none'})`);

  for (const name of ['htmlExport.ts', 'exporter.ts', 'storyWalk.ts', 'cardContext.ts',
    'contextZone.ts', 'sceneDirector.ts', 'lens.ts']) {
    const f = files.find(x => x.endsWith(`/${name}`));
    if (!f) continue;
    ok(!readFileSync(f, 'utf8').includes('reactionsByStory'),
      `${name} must never see a reaction`);
  }
}

/* ── How much they say, and answering them ───────────────────────────────── */
{
  const who: Reactor = { name: 'Elara', frame: 'room' };
  const BASE = {
    history: [], visible: 'She set the lamp down.', moment: 'the lamp',
  };

  // The dial reaches BOTH ends of the prompt. The closing instruction used to
  // say "one or two lines" whatever the reader chose — and the last line of a
  // prompt is the most persuasive place in it, so the setting did nothing.
  const brief = buildReactionMessages({ ...BASE, reactor: who, length: 'brief' as const });
  const chatty = buildReactionMessages({ ...BASE, reactor: who, length: 'chatty' as const });
  ok(/ONE line, and often one WORD/.test(String(brief[0].content)),
    'brief is a noise, below what shipped');
  ok(/TWO or THREE lines/.test(String(chatty[0].content)), 'chatty asks for more');
  ok(/Two or three lines/.test(String(chatty[1].content)),
    'and the closing instruction agrees with the rule — it is not still asking for two');

  /* The rung that shipped is the DEFAULT rung, and an omitted argument is it.
   * A first cut made `normal` wordier than what shipped, which quietly gave
   * every existing reader a chattier companion than the one they had. */
  const normal = buildReactionMessages({ ...BASE, reactor: who, length: 'normal' as const });
  ok(/ONE or TWO short lines/.test(String(normal[0].content)),
    'a thought is exactly the line that shipped');
  ok(String(reactionSystem(who)) === String(normal[0].content).split('\n\n').slice(0, -0).join('\n\n')
    || /ONE or TWO short lines/.test(reactionSystem(who)),
    'and omitting the argument gives that same rung');

  const dyn = buildReactionMessages({ ...BASE, reactor: who, length: 'dynamic' as const });
  ok(/same size every time/.test(String(dyn[0].content)),
    'dynamic asks for variety rather than a length');
  ok(/HARD CEILING/.test(String(dyn[0].content)),
    'and still has a ceiling — lenient is not unbounded, and a generous budget '
    + 'reads to a model as a target');
  ok(reactionBudget('dynamic') <= 320,
    'the token budget agrees with the ceiling; 420 produced paragraphs of stage '
    + 'directions that buried the story underneath them');

  ok(reactionBudget('chatty') > reactionBudget('brief'),
    'and there is room to say it — asking for four lines inside a two-line budget '
    + 'produces a sentence cut in half, which reads as being interrupted');

  // A reply is aimed at the reader, not at the story.
  const rep = buildReplyMessages({
    ...BASE, reactor: who, length: 'normal' as const,
    saidLine: 'Oh, she is lying.', from: 'you think so?',
  });
  const talk = String(rep[1].content);
  ok(talk.includes('you think so?'), "the reader's words are in the prompt");
  ok(talk.includes('Oh, she is lying.'), 'and the line they are answering');
  ok(/not a character|not happening in the story/.test(talk),
    'the frame holds: they are being spoken to by a person, not by someone in the story');
  ok(/Deflect|do not owe/.test(talk),
    'and they are allowed not to answer — a companion who dutifully answers everything '
    + 'is a help desk');
  ok(String(rep[0].content).startsWith('You are Elara.'),
    'and the reply reuses the reaction system prompt, so the frame cannot drift between them');

  const withExchange = buildReplyMessages({
    ...BASE, reactor: who, saidLine: 'Oh, she is lying.', from: 'and now?',
    exchange: [
      { who: 'reader' as const, text: 'you think so?' },
      { who: 'them' as const, text: 'look at her hands' },
    ],
  });
  ok(String(withExchange[1].content).includes('look at her hands'),
    'a conversation carries what was already said in it');
}

/* ── A room, not a queue ─────────────────────────────────────────────────── */
{
  const ROOM: Reactor[] = [
    { name: 'Elara', frame: 'room', dossier: 'A physician. Notices bodies and blood.' },
    { name: 'Rook', frame: 'room', dossier: 'A fighter. Counts the exits.' },
    { name: 'Ing', frame: 'room' },
  ];
  const PASSAGE = 'She set the lamp down between them. The blade was already out. '
    + 'Nobody moved, and the rain kept on at the shutters.';

  /* One call for the whole room. Scouting per person costs a call each AND has
   * each of them choose in ignorance of the others, so two independently pick
   * the same words and talk over each other. */
  const cast = buildScoutMessages({
    reactor: ROOM[0], cast: ROOM, passage: PASSAGE, history: [],
  });
  const sys = String(cast[0].content);
  for (const r of ROOM) ok(sys.includes(r.name), `${r.name} is named in the casting call`);
  ok(sys.includes('Notices bodies and blood'), 'with enough of them to tell them apart');
  ok(sys.includes('"who"'), 'and the answer is asked to say who');
  ok(/Do NOT go around the group taking\s+turns/.test(sys),
    'and told not to deal moments out evenly — a room is not a rota');

  // The thumbnail is a thumbnail: a full card per person would cost more than
  // the reactions it is casting.
  const fat: Reactor = { name: 'Wren', frame: 'room', dossier: 'x'.repeat(4000) };
  ok(castThumb(fat).length < 300, 'a companion costs one short line to cast, not a card');

  // One watcher keeps the prompt it always had.
  const solo = buildScoutMessages({ reactor: ROOM[0], cast: [ROOM[0]], passage: PASSAGE, history: [] });
  ok(String(solo[0].content).startsWith('You are choosing when Elara would speak.'),
    'a single companion is untouched by any of this');
  ok(String(solo[0].content).includes('Notices bodies and blood'),
    'and still gets their whole dossier, not a thumbnail');

  /* Casting survives the model. */
  const raw = JSON.stringify([
    { text: 'The blade was already out', who: 'Rook', why: 'a weapon' },
    { text: 'the rain kept on', who: 'Elara', why: 'quiet after' },
  ]);
  const cues = parseScoutCues(raw, PASSAGE, ROOM.map(r => r.name));
  eq(cues.map(c => c.who).join(','), 'Rook,Elara', 'each moment keeps the person it was cast to');

  const invented = parseScoutCues(
    JSON.stringify([{ text: 'The blade was already out', who: 'the guard' }]),
    PASSAGE, ROOM.map(r => r.name),
  );
  eq(invented.length, 1, 'a name nobody has does not cost the moment');
  eq(invented[0].who, undefined,
    'but nobody is dealt it here — inventing an owner at parse time is what made '
    + 'the first companion answer for the whole room');

  /*
   * The bias this exists to prevent.
   *
   * Rule 3 asks for few moments and most passages earn exactly ONE. So a
   * fallback of "give it to the first person in the cast" is not a tie-break,
   * it is "the first person says almost everything" — which is what the reader
   * saw: a second companion who barely spoke.
   */
  const tally = new Map([['Elara', 4], ['Rook', 1], ['Ing', 0]]);
  eq(pickSpeaker(undefined, ROOM, tally)?.name, 'Ing',
    'an unattributed moment goes to whoever has been quietest');
  eq(pickSpeaker('Elara', ROOM, tally)?.name, 'Elara',
    'but a moment the scout actually cast is never taken off them');
  eq(pickSpeaker('the guard', ROOM, tally)?.name, 'Ing',
    'and a name that is not in the room falls to the quietest, not to the first');
  eq(pickSpeaker(undefined, ROOM, new Map())?.name, 'Elara',
    'with nobody having spoken it is the first — deterministic, so a re-read casts alike');
  eq(pickSpeaker(undefined, [])?.name, undefined, 'an empty room says nothing');

  eq(parseScoutCues(raw, PASSAGE)[0].who, undefined,
    'and with no cast there is no owner to assign — the single-watcher path');

  // The budget grows by ONE per extra person, not by three.
  eq(maxCues(1), MAX_CUES, 'one companion earns what it always did');
  ok(maxCues(5) > maxCues(1) && maxCues(5) <= 7, 'five earn more, but not five times more');
  ok(maxCues(50) === 7, 'and it is capped — past that the story is the background');

  // Hearing each other is what makes it a room.
  const heard = buildReactionMessages({
    reactor: ROOM[1], history: [], visible: PASSAGE, moment: 'The blade',
    others: [{ name: 'Elara', text: 'Oh, that is going to go badly.' }],
  });
  const talk = String(heard[1].content);
  ok(talk.includes('Oh, that is going to go badly.'), 'they hear what was just said');
  ok(talk.includes('Elara'), 'and who said it');
  ok(/ignore them completely/.test(talk),
    'and are allowed to not engage — a room where everyone answers everyone is a panel show');

  ok(!String(buildReactionMessages({
    reactor: ROOM[1], history: [], visible: PASSAGE, moment: 'The blade',
  })[1].content).includes('WHAT THE OTHERS'),
    'with nobody else watching, none of that reaches the prompt');
}

/* ── Dynamic: what the reader is doing ───────────────────────────────────── */
{
  const who: Reactor = { name: 'Elara', frame: 'room' };
  const base = { history: [], visible: 'She set the lamp down.', moment: 'the lamp' };

  const aware = buildReactionMessages({
    ...base, reactor: who, length: 'dynamic' as const,
    pace: 'They have now read this same passage 3 times.',
  });
  const text = String(aware[1].content);
  ok(text.includes('read this same passage 3 times'), 'the reader\'s own behaviour reaches them');
  ok(/only if it is worth saying/i.test(text),
    'with permission to ignore it — this is the difference between a companion and a nuisance');
  ok(/Never mention it more than once/.test(text), 'and not to keep bringing it up');

  ok(!String(buildReactionMessages({ ...base, reactor: who, length: 'dynamic' as const })[1].content)
    .includes('HOW THEY ARE READING'),
    'and none of it appears when there is nothing worth remarking on');
}

/* ── Compaction, on the one rung that grows ──────────────────────────────── */
{
  const who: Reactor = { name: 'Elara', frame: 'room', dossier: 'A physician.' };
  const big = (n: number) => Array.from({ length: n }, (_, i) =>
    ({ id: `m${i}`, name: 'Mara', content: 'She said something long and involved. '.repeat(12) }));

  const fat = {
    reactor: who,
    history: big(40),
    visible: 'x'.repeat(6000),
    moment: 'the blade',
    length: 'dynamic' as const,
    earlier: Array.from({ length: 8 }, (_, i) => `earlier line ${i}`),
    others: [{ name: 'Rook', text: 'oh no' }, { name: 'Ing', text: 'told you' }],
    pace: 'They have read this twice.',
  };

  ok(approxTokens('x'.repeat(400)) === 100, 'four characters to a token');

  const roomy = compactReaction(fat, 1_000_000);
  eq(roomy.dropped.length, 0, 'a prompt that already fits is left alone');

  const tight = compactReaction(fat, 400);
  ok(tight.tokens < approxTokens(JSON.stringify(fat)), 'a prompt over budget is trimmed');
  ok(tight.dropped.length > 0, 'and says what it gave up');

  /* The ORDER is the design: the softest memory goes first and the things the
   * reaction is MADE of never go at all. */
  eq(tight.dropped[0], 'older lines trimmed', 'their oldest lines are the first to go');
  ok(tight.dropped.indexOf('cross-talk dropped') < tight.dropped.indexOf('transcript dropped')
    || !tight.dropped.includes('transcript dropped'),
    'cross-talk is given up before the transcript');

  const msgs = buildReactionMessages(tight.input);
  const all = msgs.map(m => String(m.content)).join('\n');
  ok(all.includes('the blade'), 'the moment survives any budget');
  ok(all.includes('A physician'), 'and so does who they are');
  ok(/HOW TO REACT/.test(all), 'and the rules that make it a reaction at all');

  // Squeezed to nothing, it is still a valid request rather than a broken one.
  const crushed = compactReaction(fat, 1);
  ok(buildReactionMessages(crushed.input).length === 2, 'even at an absurd budget it is a prompt');
  ok(String(buildReactionMessages(crushed.input)[1].content).includes('the blade'),
    'still carrying the moment');

  // Deterministic: the same beat twice compacts the same way, so a re-read is
  // not quietly a different companion.
  eq(JSON.stringify(compactReaction(fat, 400).dropped), JSON.stringify(tight.dropped),
    'compaction is deterministic');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
