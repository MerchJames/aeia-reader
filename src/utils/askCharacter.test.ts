/**
 * Run: npx tsx src/utils/askCharacter.test.ts
 * Pure checks for the interview (no network).
 *
 * The clamp gets most of the attention on purpose. Everything else here is a
 * quality problem — a flat answer, a stray label. A clamp leak is a SPOILER
 * reaching the reader through a feature attached to the thing being spoiled,
 * which is worse than the feature not existing.
 */
import {
  HISTORY_BUDGET, THREAD_TURNS, AskTurn, askSamplers, askSystem, buildAskMessages,
  castOf, clampHistory, hasAside, historyBlock, parseAnswer, readThread, readingCast,
  spokenOnly, splitAnswer, storyCast,
  type HistoryMessage,
} from './askCharacter';
import type { Story } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const story = [
  { id: 'm1', name: 'Elara', content: 'The tavern was warm.' },
  { id: 'm2', name: 'You', content: 'I sat down across from her.' },
  { id: 'm3', name: 'Elara', content: 'She would not meet my eyes.' },
  { id: 'm4', name: 'Elara', content: 'THE BETRAYAL: she was the one who sold them out.' },
  { id: 'm5', name: 'Elara', content: 'THE ENDING: everyone dies at dawn.' },
];

/* ---- the spoiler clamp ---- */

const at3 = clampHistory(story, 'm3');
ok(at3.length === 3 && at3[2].id === 'm3', 'the clamp includes the anchor');
ok(!at3.some(m => m.id === 'm4' || m.id === 'm5'), 'the clamp excludes everything after the anchor');
ok(!historyBlock(at3).includes('BETRAYAL'), 'a later reveal cannot appear in the rendered block');
ok(!historyBlock(at3).includes('ENDING'), 'nor can the ending');

// The first message: a character asked about the opening knows only the opening.
const at1 = clampHistory(story, 'm1');
ok(at1.length === 1 && at1[0].id === 'm1', 'anchoring on the first message yields only it');

// The last message: everything is legitimately known.
ok(clampHistory(story, 'm5').length === 5, 'anchoring on the last message yields the whole story');

// FAIL CLOSED. A confused caller must produce a character who knows nothing,
// never one who knows the ending.
ok(clampHistory(story, 'nope').length === 0, 'an unknown anchor yields NOTHING, not everything');
ok(clampHistory(story, '').length === 0, 'an empty anchor yields nothing');
ok(clampHistory([], 'm1').length === 0, 'an empty story yields nothing');

// Budget trims from the FRONT — the recent beat matters more than the opening —
// and never past the anchor in the process.
const long = Array.from({ length: 40 }, (_, i) => ({
  id: `L${i}`, name: 'N', content: `${i}:${'x'.repeat(400)}`,
}));
const trimmed = clampHistory(long, 'L30', 2000);
ok(trimmed.length > 0 && trimmed.length < 31, `the budget trims the history (kept ${trimmed.length}/31)`);
ok(trimmed[trimmed.length - 1].id === 'L30', 'the anchor survives trimming');
ok(!trimmed.some(m => Number(m.id.slice(1)) > 30), 'trimming never reaches past the anchor');
ok(historyBlock(trimmed).length <= 2000 + long[0].content.length,
  'the kept history respects the budget');

// The anchored message is kept even when it alone blows the budget — otherwise
// the character would be asked about a passage they were not shown.
const huge = [{ id: 'a', name: 'N', content: 'x'.repeat(50) }, { id: 'b', name: 'N', content: 'y'.repeat(9000) }];
const keptHuge = clampHistory(huge, 'b', 1000);
ok(keptHuge.length === 1 && keptHuge[0].id === 'b', 'an over-budget anchor is still included, alone');

ok(HISTORY_BUDGET > 0 && THREAD_TURNS > 0, 'the budgets are real numbers');

/* ---- the interview frame ---- */

const sys = askSystem('Elara', 'Rook');
ok(/INTERVIEW/i.test(sys), 'the frame says this is an interview');
ok(/do not know what happens next/i.test(sys), 'the frame forbids knowing the future');
ok(/NOT part of the story/i.test(sys), 'the frame says this is not canon');
ok(/[Dd]o NOT advance the plot/.test(sys), 'the frame forbids advancing the scene — cards push toward this');
ok(sys.includes('Elara') && sys.includes('Rook'), 'the frame names both sides');
ok(/FEELING/.test(sys), 'the frame asks for the expression sidecar');

const msgs = buildAskMessages({
  characterName: 'Elara',
  userName: 'Rook',
  card: { name: 'Elara', personality: 'guarded, devout' },
  history: at3,
  anchorText: 'She would not meet my eyes.',
  turns: [],
  question: 'What were you thinking?',
  mood: 'tense',
});
ok(msgs[0].role === 'system' && msgs[0].content.includes('guarded, devout'), 'the card grounds the voice');
ok(msgs[1].content.includes('The tavern was warm'), 'the setup carries the clamped history');
ok(!msgs.some(m => m.content.includes('BETRAYAL')), 'no message in the request carries a later beat');
ok(msgs[1].content.includes('tense'), 'the Director’s mood reaches the prompt');
ok(msgs[msgs.length - 1].content === 'What were you thinking?', 'the question is the last turn');
ok(msgs[msgs.length - 1].role === 'user', 'and it is asked as the user');

// A thread replays as a real conversation, so prior answers are the model's own.
const turns: AskTurn[] = [
  { id: 't1', role: 'reader', text: 'Were you afraid?', at: 1 },
  { id: 't2', role: 'character', text: 'Of course I was.', at: 2 },
];
const threaded = buildAskMessages({
  characterName: 'Elara', history: at3, anchorText: 'x', turns, question: 'Of what?',
});
const roles = threaded.map(m => m.role).join(',');
ok(roles.endsWith('user,assistant,user'), `the thread alternates correctly (${roles})`);
ok(threaded.some(m => m.role === 'assistant' && m.content === 'Of course I was.'),
  'a prior answer replays as the assistant');

// Only the last N turns replay, so a long interview cannot grow unbounded.
const many: AskTurn[] = Array.from({ length: 30 }, (_, i) => ({
  id: `x${i}`, role: i % 2 ? 'character' : 'reader', text: `t${i}`, at: i,
}));
const capped = buildAskMessages({ characterName: 'E', history: [], anchorText: 'x', turns: many, question: 'q' });
ok(capped.length <= THREAD_TURNS + 4, `a long thread stays bounded (${capped.length} messages)`);
ok(capped.some(m => m.content === 't29'), 'the most recent turns are the ones kept');
ok(!capped.some(m => m.content === 't0'), 'the oldest turns are dropped');

// With no story yet, the character is told so rather than handed an empty block.
const fresh = buildAskMessages({ characterName: 'E', history: [], anchorText: 'x', turns: [], question: 'q' });
ok(/only just begun/.test(fresh[1].content), 'an empty history reads as a beginning, not a blank');

/* ---- parsing the answer ---- */

const a1 = parseAnswer('I was terrified, if you must know.\n[FEELING: fear]', 'Elara');
ok(a1?.text === 'I was terrified, if you must know.', 'the feeling sidecar is stripped from the text');
ok(a1?.emotion === 'fear', 'the sidecar maps onto an expression bucket');

ok(parseAnswer('Elara: I said nothing.', 'Elara')?.text === 'I said nothing.', 'a name prefix is stripped');
ok(parseAnswer('**Elara:** I said nothing.', 'Elara')?.text === 'I said nothing.', 'a bolded name prefix is stripped (colon inside)');
ok(parseAnswer('**Elara**: I said nothing.', 'Elara')?.text === 'I said nothing.', 'a bolded name prefix is stripped (colon outside)');
ok(parseAnswer('Elara stood by the door.', 'Elara')?.text === 'Elara stood by the door.',
  'a leading name WITHOUT a colon is left alone');
ok(parseAnswer('I said nothing about Elara: really.', 'Elara')?.text.startsWith('I said nothing'),
  'a name mid-sentence is not mistaken for a prefix');

ok(parseAnswer('<think>plan</think>Nothing.', 'Elara')?.text === 'Nothing.', 'reasoning preambles are dropped');
ok(parseAnswer('No sidecar here.', 'Elara')?.emotion === 'neutral', 'a missing sidecar reads as neutral');
ok(parseAnswer('[FEELING: rage]I am fine.', 'Elara')?.emotion === 'anger', 'a leading sidecar still parses');
ok(parseAnswer('', 'Elara') === null, 'an empty reply yields null');
ok(parseAnswer('[FEELING: sad]', 'Elara') === null, 'a reply that is ONLY a sidecar yields null');
ok(parseAnswer('<think>only thinking</think>', 'Elara') === null, 'a reply that is only reasoning yields null');
// A character whose name contains regex metacharacters must not blow up.
ok(parseAnswer('Hi.', 'Dr. (Wren) [x]')?.text === 'Hi.', 'a name with regex characters is safe');

/* ---- the dialogue-only view ---- */

// The noise in an interview answer is stage directions, not narration — cards
// push the model toward acting, and this is the switch that hides it.
ok(spokenOnly('*She looks away.* I was afraid.') === 'I was afraid.', 'a stage direction is stripped');
ok(spokenOnly('I was afraid. *Her hands shook.* I still am.') === 'I was afraid. I still am.',
  'a mid-answer direction is stripped and the spacing closes up');
ok(spokenOnly('(aside)\nI said nothing.') === 'I said nothing.', 'a parenthetical line is stripped');
ok(spokenOnly('I said nothing.') === 'I said nothing.', 'plain speech is untouched');

// Never leave an empty bubble — that reads as the character refusing to answer.
ok(spokenOnly('*She turns away.*') === '*She turns away.*', 'an all-action reply falls back to the whole reply');
ok(spokenOnly('   ') === '', 'blank stays blank');
// Emphasis inside a sentence is not a stage direction, but it is indistinguishable
// from one, so the fallback is what protects the reader here.
ok(spokenOnly('*Never.*') === '*Never.*', 'a one-word emphatic answer survives via the fallback');

// The parts drive the hover-to-reveal view, so the split has to be exact.
const parts = splitAnswer('I was afraid. *Her hands shook.* I still am.');
ok(parts.length === 3, `three runs (${parts.length})`);
ok(parts[1].aside && parts[1].text === '*Her hands shook.*', 'the middle run is the aside');
ok(!parts[0].aside && !parts[2].aside, 'the speech either side is not');
ok(parts.map(p => p.text).join('') === 'I was afraid. *Her hands shook.* I still am.',
  'the parts reassemble into the original, so nothing is lost on hover');
ok(splitAnswer('Just speech.').length === 1, 'an answer with no aside is one run');
ok(hasAside('*She looks away.* I was afraid.'), 'an answer with a direction has something to reveal');
ok(!hasAside('I was afraid.'), 'a plain answer has nothing to reveal');
// All-action would strip to nothing, so the view has nothing to offer either.
ok(!hasAside('*She turns away.*'), 'an all-action reply is shown whole, not hidden');

/* ---- the thread runs across beats ---- */

// The conversation is continuous: ask at beat 40, travel to 149, ask again.
const flat: AskTurn[] = [
  { id: 'a', role: 'reader', text: 'q1', at: 1, atMessageId: 'm3', beat: 3 },
  { id: 'b', role: 'character', text: 'a1', at: 2, atMessageId: 'm3', beat: 3 },
];
ok(readThread(flat) === flat, 'a thread already in the new shape is passed through');
ok(readThread(undefined).length === 0, 'no thread is an empty thread');
ok(readThread(null).length === 0, 'null is an empty thread');

// v1 stored one thread PER MESSAGE. Those must be folded into the running
// conversation in time order, not dropped on the reader's floor.
const legacy = {
  m5: [{ id: 'c', role: 'character', text: 'later', at: 20 }],
  m1: [{ id: 'd', role: 'reader', text: 'earlier', at: 10 }],
};
const migrated = readThread(legacy);
ok(migrated.length === 2, 'legacy per-beat threads are flattened');
ok(migrated[0].text === 'earlier' && migrated[1].text === 'later', 'and put back in time order');
ok(migrated[0].atMessageId === 'm1' && migrated[1].atMessageId === 'm5',
  'each turn remembers the beat it was asked at');

// Travelling forward tells the character they have lived more since.
const moved = buildAskMessages({
  characterName: 'Elara', history: at3, anchorText: 'x', turns: flat, question: 'again?', movedOn: true,
});
ok(/lived\s+through more of the story/.test(moved[1].content), 'a jump forward is stated in the prompt');
ok(/no longer holds/.test(moved[1].content), 'and the character is invited to contradict their earlier answer');
const stayed = buildAskMessages({
  characterName: 'Elara', history: at3, anchorText: 'x', turns: flat, question: 'again?',
});
ok(!/lived through more/.test(stayed[1].content), 'staying on the same beat says nothing about moving');

/* ---- group chats: several voices, one interview ---- */

const group = [
  { name: 'Elara', role: 'assistant' },
  { name: 'You', role: 'user' },
  { name: 'Mara', role: 'assistant' },
  { name: 'Elara', role: 'assistant' },
  { name: 'Narrator', role: 'assistant' },
  { name: '', role: 'assistant' },
];
const cast = castOf(group, 'You');
ok(cast.join(',') === 'Elara,Mara', `the cast is the speakers, in first-appearance order (${cast.join(',')})`);
ok(!cast.includes('Narrator'), 'a narrator is not interviewable');
ok(!cast.includes('You'), 'nor is the reader’s own character');
ok(castOf([{ name: 'Elara', role: 'assistant' }, { name: 'elara', role: 'assistant' }]).length === 1,
  'the same name in different case is one person');

// The subject is told who else is around, so they can be asked about them.
const groupSys = askSystem('Elara', 'Rook', ['Mara', 'Tobin']);
ok(/ALSO IN THIS STORY: Mara, Tobin/.test(groupSys), 'the frame names the rest of the cast');
ok(/your OWN\s+experience of them/i.test(groupSys.replace(/\n/g, ' ')),
  'and asks for their own view, not a summary');
ok(!/ALSO IN THIS STORY/.test(askSystem('Elara', 'Rook')), 'a solo chat says nothing about a cast');

// THE group feature: one character can see what another said and react to it.
const crossThread: AskTurn[] = [
  { id: 'q1', role: 'reader', text: 'Did you trust her?', at: 1, speaker: 'Mara' },
  { id: 'a1', role: 'character', text: 'Not for a second.', at: 2, speaker: 'Mara' },
  { id: 'q2', role: 'reader', text: 'And you?', at: 3, speaker: 'Elara' },
];
const cross = buildAskMessages({
  characterName: 'Elara', cast: ['Mara'], history: at3, anchorText: 'x',
  turns: crossThread, question: 'Well?',
});
const mara = cross.find(m => m.content.includes('Not for a second.'))!;
ok(mara.role === 'user', 'another character’s answer is NOT put in this one’s mouth');
ok(/\[Mara, .*answered:\]/.test(mara.content), 'it is handed over attributed, so they can react to it');
ok(cross.some(m => m.content.includes('(to Mara) Did you trust her?')),
  'a question put to someone else is marked as such');
ok(cross.some(m => m.role === 'user' && m.content === 'And you?'),
  'a question put to THIS character carries no address prefix');

// Their own earlier answers still come back as their own.
const ownThread: AskTurn[] = [
  { id: 'a', role: 'reader', text: 'Were you afraid?', at: 1, speaker: 'Elara' },
  { id: 'b', role: 'character', text: 'Yes.', at: 2, speaker: 'Elara' },
];
const own = buildAskMessages({
  characterName: 'Elara', cast: ['Mara'], history: at3, anchorText: 'x', turns: ownThread, question: 'Why?',
});
ok(own.some(m => m.role === 'assistant' && m.content === 'Yes.'), 'their own answer replays as theirs');

// A thread recorded before group support has no speaker — assume the subject's.
const legacyTurns: AskTurn[] = [{ id: 'l', role: 'character', text: 'Old answer.', at: 1 }];
const legacyMsgs = buildAskMessages({
  characterName: 'Elara', history: at3, anchorText: 'x', turns: legacyTurns, question: 'q',
});
ok(legacyMsgs.some(m => m.role === 'assistant' && m.content === 'Old answer.'),
  'an unattributed old turn is treated as the subject’s own');

/* ---- sampling ---- */

const local = askSamplers('http://localhost:5001/v1');
const remote = askSamplers('https://api.openai.com/v1');
ok((local.temperature ?? 0) > 0.5,
  'a voice task samples warm — asking twice and getting the same sentence breaks the illusion');
ok(remote.repetition_penalty === undefined, 'non-OpenAI samplers are not sent to a remote endpoint');
ok(local.repetition_penalty !== undefined, 'but they are sent locally');


/* --- a group transcript needs turn boundaries ----------------------------- */

/*
 * "Name: content" stops being unambiguous once a passage is three paragraphs
 * long and contains quoted speech of its own: the next "Bram:" reads as a line
 * inside Mara's narration rather than as Bram taking a turn. From the outside
 * that looks like the model ignoring the other character — the words were in
 * the payload and the turn boundary was not.
 */
{
  const group: HistoryMessage[] = [
    { id: '1', name: 'Mara', content: 'She turned away.\n\n"Bram: he never listens," she muttered.' },
    { id: '2', name: 'Bram', content: 'I heard that.' },
    { id: '3', name: 'Elara', content: 'Both of you, quiet.' },
  ];
  const block = historyBlock(group);
  ok(block.includes('--- Bram ---'), 'each turn in a group chat gets a rule of its own');
  ok(block.includes('--- Elara ---'), 'for every speaker');
  ok(block.indexOf('--- Bram ---') > block.indexOf('Bram: he never listens'),
    'so a name inside the prose cannot be mistaken for the next turn');
}

// A two-hander keeps the compact form — rules between every line of a
// back-and-forth are noise, not clarity.
{
  const pair: HistoryMessage[] = [
    { id: '1', name: 'Mara', content: 'one' },
    { id: '2', name: 'You', content: 'two' },
  ];
  ok(historyBlock(pair) === 'Mara: one\n\nYou: two', 'two voices stay compact');
}

/* --- every voice survives the window ------------------------------------- */

/*
 * A pure recency window is right for a two-hander and quietly wrong for a group
 * chat. Measured before the fix: 42 messages in, the window kept 16 — all of
 * them Mara — so the system prompt named Bram in the cast while the transcript
 * held not one word he had ever said. The interviewee could not be asked about
 * him, which reads as the model being stupid and was the payload being empty.
 */
{
  const many: HistoryMessage[] = [
    { id: 'b1', name: 'Bram', content: 'I buried the key under the third stone.' },
  ];
  for (let i = 0; i < 40; i++) {
    many.push({ id: `m${i}`, name: 'Mara', content: 'Mara talks at length. '.repeat(14) });
  }
  many.push({ id: 'anchor', name: 'Mara', content: 'She looked at the stones.' });

  const kept = clampHistory(many, 'anchor');
  ok(kept.some(m => m.name === 'Bram'), 'a voice from early in the chat is not dropped entirely');
  ok(kept[0].name === 'Bram', 'and comes back in reading order, not bolted on the end');
  ok(kept.filter(m => m.name === 'Bram').length === 1,
    'one turn each — this is proof they exist, not a second transcript');
  ok(kept[kept.length - 1].id === 'anchor', 'the anchor is still the last thing they know');
  ok(!kept.some(m => many.indexOf(m) > many.findIndex(x => x.id === 'anchor')),
    'and nothing past it ever gets in');
}

// A long-winded rescued turn is trimmed, not skipped.
{
  const long = 'x'.repeat(2000);
  const msgs: HistoryMessage[] = [{ id: 'e1', name: 'Bram', content: long }];
  for (let i = 0; i < 40; i++) msgs.push({ id: `m${i}`, name: 'Mara', content: 'talk. '.repeat(40) });
  msgs.push({ id: 'anchor', name: 'Mara', content: 'end' });
  const bram = clampHistory(msgs, 'anchor').find(m => m.name === 'Bram');
  ok(!!bram && bram.content.length < 600, 'a rescued turn is clipped to a recognisable size');
}

// The two-hander case must be untouched — this is the common one.
{
  const pair: HistoryMessage[] = [
    { id: 'a', name: 'Mara', content: 'one' },
    { id: 'b', name: 'You', content: 'two' },
    { id: 'c', name: 'Mara', content: 'three' },
  ];
  ok(clampHistory(pair, 'c').length === 3, 'a short two-hander is unchanged');
}

ok(clampHistory([{ id: 'a', name: 'Mara', content: 'x' }], 'nope').length === 0,
  'and it still fails closed on an unknown anchor');


/* ── Who is in a story, branches included ────────────────────────────────── */
{
  /*
   * A branch's messages live on the TIMELINE, not on the story. So a group chat
   * attached as a what-if to a solo story is, as far as `story.messages` goes,
   * still a story with one character in it — and everything keyed off that
   * count behaves as though it were solo, while the reader can plainly see
   * several people talking.
   */
  const solo = {
    userName: 'You',
    messages: [
      { name: 'Mara', role: 'assistant' },
      { name: 'You', role: 'user' },
    ],
    timelines: [{
      messages: [
        { name: 'Elara', role: 'assistant' },
        { name: 'You', role: 'user' },
        { name: 'Rook', role: 'assistant' },
      ],
    }],
  };

  const cast = storyCast(solo);
  ok(cast.includes('Mara'), 'the main timeline is in the cast');
  ok(cast.includes('Elara') && cast.includes('Rook'),
    'and so is everyone who only ever speaks inside an attached branch');
  ok(!cast.includes('You'), 'the reader is not a character');
  ok(cast.length === 3, 'three speakers, so this story is not solo');

  ok(storyCast({ messages: [{ name: 'Mara', role: 'assistant' }] }).length === 1,
    'a story with no branches is unchanged');
  ok(storyCast({}).length === 0, 'and an empty story has nobody in it');

  // Same name in the trunk and a branch is one person.
  ok(storyCast({
    messages: [{ name: 'Mara', role: 'assistant' }],
    timelines: [{ messages: [{ name: 'mara', role: 'assistant' }] }],
  }).length === 1, 'and a speaker who appears in both is counted once');
}

/* ── Who is in the story the reader is LOOKING AT ────────────────────────── */
{
  /*
   * The over-correction of the block above: sweeping every branch is the right
   * answer to "does this story have more than one voice" and the wrong one for
   * a list of faces, which put a group chat's whole cast into the settings of a
   * trunk where none of them ever speak.
   */
  const story = {
    userName: 'You',
    messages: [
      { id: 'a', role: 'assistant', name: 'Mara', content: 'one' },
      { id: 'b', role: 'user', name: 'You', content: 'two' },
      { id: 'c', role: 'assistant', name: 'Mara', content: 'three' },
    ],
    timelines: [{
      id: 'tl-1', name: 'what if', forkIndex: 2, addedAt: 0,
      messages: [
        { id: 'd', role: 'assistant', name: 'Elara', content: 'four' },
        { id: 'e', role: 'assistant', name: 'Rook', content: 'five' },
      ],
    }],
  } as unknown as Story;

  const trunk = readingCast(story);
  ok(trunk.length === 1 && trunk[0] === 'Mara',
    'on the trunk, only the people who actually speak on the trunk');

  const branch = readingCast({ ...story, activeTimeline: 'tl-1' } as Story);
  ok(branch.includes('Elara') && branch.includes('Rook'),
    'opening the branch is what introduces its cast');
  ok(branch.includes('Mara'), 'along with everyone shared up to the fork');

  // A face given on a branch must not become unreachable on the trunk — no row
  // to change it, no × to clear it, still in use inside the branch.
  const kept = readingCast(story, ['Elara']);
  ok(kept.includes('Elara') && !kept.includes('Rook'),
    'someone who already has a picture is kept wherever they speak, and nobody else');
  ok(kept[0] === 'Mara', 'the people on the page come first');

  ok(readingCast(story, ['  ELARA  ']).includes('Elara'),
    'and the name is matched the way every other name in this file is');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
