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
  castOf, clampHistory, hasAside, historyBlock, parseAnswer, readThread, spokenOnly, splitAnswer,
} from './askCharacter';

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

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
