/**
 * Run: npx tsx src/utils/expressive.test.ts
 *
 * Reveal pacing — the beats between words, and the beat after the last one.
 *
 * The bug this exists for: the read floor after a finished passage was ADDED to
 * the reveal instead of being a floor on the total time on screen, and it
 * switched off above 30 words. So the last word of every short message sat
 * there doing nothing for up to 2.4 extra seconds, and a 31-word message got
 * two full seconds LESS screen time than a 30-word one. Neither is a taste
 * question: one is double-counting, the other is non-monotonic.
 */
import { dwellMs, holdMsAt, holdSpeedScale, insideQuote, isShoutWord, pacingFor, rateMultiplier } from './expressive';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

/* ---- the read floor ------------------------------------------------------ */

// What the streamer actually waits: the floor, less the time the reveal already
// spent showing the words. This is the whole fix in one line.
const wait = (words: number, speed: number, revealMs: number, messagePause = 400) =>
  Math.max(0, messagePause, dwellMs(words, speed) - revealMs);
/** Total time the passage is on screen — reveal plus whatever is left to wait. */
const onScreen = (words: number, speed: number, revealMs: number) =>
  revealMs + wait(words, speed, revealMs);

// Monotonic: a longer passage never leaves the screen sooner than a shorter one.
// (A 20-word reveal takes ~1s at speed 50 in character mode; 40 words ~2s.)
const revealFor = (words: number) => words * 50;
for (let w = 1; w < 120; w++) {
  ok(onScreen(w, 50, revealFor(w)) >= onScreen(w - 1, 50, revealFor(w - 1)) - 1e-9,
    `${w} words is on screen at least as long as ${w - 1}`);
}

// The old cliff, named: 30 vs 31 words used to differ by two seconds.
ok(Math.abs(onScreen(31, 50, revealFor(31)) - onScreen(30, 50, revealFor(30))) < 400,
  'there is no cliff at 30 words');

// The reveal counts toward the floor rather than preceding it: the same words
// are on screen for the same total time however fast they were typed out.
ok(wait(10, 50, 0) > wait(10, 50, 600), 'a passage that took longer to reveal waits less after');
ok(Math.abs(onScreen(10, 50, 0) - onScreen(10, 50, 600)) < 1e-9,
  'and the total on-screen time comes out identical');
// `messagePause` is a separate minimum GAP between messages, so it still
// applies once the floor is satisfied — it is not part of the reading time.
ok(onScreen(10, 50, 1200) === 1200 + 400, 'the message pause survives underneath the floor');

// A message that already outlasted its floor waits only the message pause.
ok(wait(8, 50, 9000) === 400, 'a slow reveal owes nothing beyond the message pause');
ok(wait(8, 50, 9000, 0) === 0, 'and nothing at all when the reader set no pause');

// Speed-scaled, like every other beat.
ok(dwellMs(20, 90) < dwellMs(20, 50) && dwellMs(20, 50) < dwellMs(20, 10),
  'a faster reader is held for less');
ok(dwellMs(20, 100) / dwellMs(20, 1) === holdSpeedScale(100) / holdSpeedScale(1),
  'the floor scales by exactly the same curve the dramatic holds use');

// Bounds: never unbounded, never negative, safe on nonsense.
ok(dwellMs(100_000, 50) === dwellMs(2400, 50), 'the floor saturates rather than growing forever');
ok(dwellMs(0, 50) > 0 && dwellMs(-5, 50) === dwellMs(0, 50), 'an empty passage still gets a beat');

/* ---- the beats inside the reveal ---------------------------------------- */

const cfg = pacingFor('expressive');
const line = 'She stopped. The door was open.\n\nOutside, it had begun to rain.';

ok(holdMsAt(line, line.indexOf('stopped.') + 8, cfg) === cfg.sentenceHold,
  'a sentence-final mark holds a beat');
ok(holdMsAt(line, line.indexOf('stopped.') + 7, cfg) === 0, 'mid-word holds nothing');
ok(holdMsAt(line, line.indexOf('\n\n') + 2, cfg) === cfg.paragraphHold,
  'a blank line holds the longer paragraph beat');
ok(holdMsAt(line, line.indexOf('\n\n') + 1, cfg) === 0,
  'a single newline is a wrap, not a scene break');
ok(holdMsAt(line, 0, cfg) === 0 && holdMsAt(line, line.length + 5, cfg) === 0,
  'out-of-range positions are safe');

// An abbreviation is not a sentence end for the reveal either — but this one is
// deliberately left alone: holdMsAt fires on any '.' before whitespace, which
// costs one sentenceHold and is far cheaper than getting it wrong the other way.
ok(pacingFor('cinematic').sentenceHold > pacingFor('subtle').sentenceHold,
  'intensity lengthens the dramatic beats');
ok(pacingFor('nonsense' as never) === pacingFor('expressive'),
  'an unknown intensity falls back to the tuned preset');

/* ---- quote state, which decides linger vs quicken ------------------------ */

const speech = 'He said "come inside" and shut the door.';
ok(insideQuote(speech, speech.indexOf('come') + 1), 'a position inside quotes reads as dialogue');
ok(!insideQuote(speech, speech.length - 2), 'and after the closing quote it does not');
ok(rateMultiplier(speech, speech.indexOf('come') + 1, cfg) === cfg.dialogueMul,
  'dialogue lingers');
ok(rateMultiplier(speech, speech.length - 2, cfg) === cfg.actionMul, 'narration quickens');

ok(isShoutWord('STOP!') && !isShoutWord('Stop') && !isShoutWord('I'),
  'a shout needs two capital letters and no lowercase');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
