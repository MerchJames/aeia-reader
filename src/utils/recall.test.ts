/** Run: npx tsx src/utils/recall.test.ts */
import {
  MAX_ANSWER_CHARS, answerFor, askedIn, contentWords, openThreads, recallBlock, sentences,
} from './recall';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ---- what counts as a thread ---------------------------------------- */

eq(askedIn('Wait, who is that at the door?').length, 1, 'a question is a thread');
eq(askedIn('I wonder what the lantern was for.').length, 1,
  'and so is the one phrasing that asks without a question mark');
eq(askedIn('What?').length, 0, 'but a question with nothing in it is punctuation, not a thread');
eq(askedIn('Really?! No.').length, 0, 'same for a bare exclamation');
eq(askedIn('God. Who is Corvin? I hate this.').length, 1,
  'the question is picked out of the line around it');
eq(askedIn('She should not have opened it.').length, 0, 'a statement is not a thread');

/* ---- retrieval, and its refusal to guess ----------------------------- */

const PAGE = 'The lamps went out one by one. Corvin was the man at the door, and he had '
  + 'been waiting since the spring. Nobody spoke.';

eq(answerFor('Who is that at the door?', PAGE),
  'Corvin was the man at the door, and he had been waiting since the spring.',
  'the line that bears on the question is found');
eq(answerFor('Who is Corvin?', PAGE),
  'Corvin was the man at the door, and he had been waiting since the spring.',
  'and found by the name in it');
eq(answerFor('What happened to the ship?', PAGE), undefined,
  'a question the page has not touched gets nothing — silence beats a wrong line');
eq(answerFor('Who is the man?', PAGE), undefined,
  'and one short word is not distinctive enough to answer on — "man" is half the story');
eq(answerFor('Who is that?', PAGE), undefined,
  'a question made only of stopwords is about nothing findable');
eq(answerFor('Who is Corvin?', 'Who is Corvin?'), undefined,
  'the question quoted back out of the transcript settles nothing');
ok((answerFor('Who is Corvin?', `Corvin ${'and the lamps '.repeat(30)} door.`) ?? '').length === 0,
  'a whole paragraph is not an answer');
ok(MAX_ANSWER_CHARS < 400, 'the cap is a line, not a page');

/* ---- collapsing a loop ---------------------------------------------- */

{
  const earlier = [
    'Who is that at the door?',
    'She looks tired.',
    'Seriously though, who is at the door?',
    'Oh, that is grim.',
  ];
  const threads = openThreads(earlier, PAGE);
  eq(threads.length, 1, 'the same question asked twice is one thread');
  eq(threads[0].asked, 2, 'and it knows it was asked twice');
  ok(!!threads[0].answer, 'and it carries the line that answers it');
}

{
  const earlier = ['Who is Corvin?', 'What happened to the ship?', 'Where is the lantern now?'];
  const threads = openThreads(earlier, PAGE, 2);
  eq(threads.length, 2, 'only a couple travel — a memory, not a briefing');
  eq(threads[0].question, 'What happened to the ship?', 'newest first when nothing repeats');
  eq(threads[1].answer, undefined, 'an unanswered thread still travels, marked as such');
}

{
  const earlier = ['Who is Corvin?', 'a', 'b', 'c', 'Wait — who is Corvin?', 'Where is the lantern?'];
  const threads = openThreads(earlier, PAGE, 1);
  eq(threads[0].asked, 2, 'a loop beats a newer question for the one slot');
  eq(threads[0].question, 'Wait — who is Corvin?', 'and travels in its latest phrasing');
}

eq(openThreads([], PAGE).length, 0, 'nothing said, nothing carried');
eq(openThreads(['She looks tired.'], PAGE).length, 0, 'nothing asked, nothing carried');

/* ---- the block itself, which must not become a performance ----------- */

eq(recallBlock([]), '', 'a companion who is not stuck gets no block at all');

{
  const block = recallBlock(openThreads(['Who is Corvin?', 'Who is Corvin?'], PAGE));
  ok(block.includes('Who is Corvin?'), 'their own words go back to them');
  ok(block.includes('Corvin was the man at the door'), 'with the line that bears on it');
  ok(/asked this 2 times/.test(block), 'and the fact that they are looping');
  ok(/do NOT announce/.test(block), 'told not to perform the realisation — the reader must not see this');
  ok(/React to/.test(block), 'and told this is background, not the subject');
}

{
  const block = recallBlock(openThreads(['What happened to the ship?'], PAGE));
  ok(/Nothing has answered it yet/.test(block), 'an unanswered thread says so');
  ok(/let it sit/.test(block), 'and asks them to drop it rather than ask again');
}

/* ---- the small pieces ------------------------------------------------ */

ok(!contentWords('what is that there').length, 'a line of stopwords identifies nothing');
eq(sentences('One. Two! Three?').length, 3, 'sentences split on the marks');
eq(sentences('One\nTwo').length, 2, 'and on line breaks');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
