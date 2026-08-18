/**
 * Run: npx tsx src/utils/styleQuotes.test.ts
 *
 * Dialogue styling — the pass that wraps quoted speech in `* *` so themes can
 * colour it.
 *
 * The bug this exists for: the quote body excluded `*`, so ANY line of dialogue
 * containing emphasis was skipped and rendered as narration. Roleplay prose is
 * full of `"You'd stand behind *my* counter?"`, so the styling appeared to work
 * on some lines and not others with no visible reason — which reads as the
 * feature randomly breaking rather than as a rule.
 *
 * The other half is that it must not over-match: a wrap that swallows the rest
 * of a paragraph is worse than no styling at all.
 */
import { processText } from './textProcessor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const q = (s: string) => processText(s, { styleQuotes: true, repairFormatting: false }).processedText;

/* ---- the plain cases that always worked ---- */

ok(q('"Hello," she said.') === '*"Hello,"* she said.', 'a simple quote is wrapped');
ok(q('She said "nothing at all" and left.') === 'She said *"nothing at all"* and left.',
  'a mid-sentence quote is wrapped');
ok(q('“Curly quotes,” he said.') === '*“Curly quotes,”* he said.', 'curly quotes too');
ok(q('No speech here.') === 'No speech here.', 'prose without quotes is untouched');

/* ---- THE regression: emphasis inside speech ---- */

const italic = q('"You\'d stand behind *my* counter?"');
ok(italic.startsWith('*"') && italic.endsWith('"*'), 'a quote containing italics is still wrapped');
ok(italic.includes('_my_'), 'and its inner emphasis survives, as underscores');
ok(!/\*my\*/.test(italic), 'the inner asterisks are gone, so the wrap cannot break');

const bold = q('"A **bold** claim," she said.');
ok(bold.startsWith('*"'), 'a quote containing bold is wrapped');
ok(bold.includes('__bold__'), 'and its bold survives');

const both = q('"***Everything***, all at once."');
ok(both.includes('___Everything___'), 'bold-italic survives too');
ok(both.startsWith('*"') && both.includes('."*'), 'and the wrap still closes');

// Balanced delimiters only: a stray marker must not escape and eat the wrap.
const stray = q('"A lone * asterisk here."');
ok(stray.startsWith('*"') && stray.endsWith('"*'), 'an unbalanced asterisk still wraps');
ok(stray.includes('\\*'), 'and is escaped rather than left to swallow the paragraph');

/* ---- it must not over-match ---- */

// Two separate quotes are two wraps, not one that swallows the narration
// between them — the failure mode a greedy match would produce.
ok(q('"First," she said. "Second," he replied.')
  === '*"First,"* she said. *"Second,"* he replied.',
  'two quotes wrap separately, leaving the narration between them plain');

// A quote spanning a paragraph break is almost always an unclosed quote.
ok(!q('"Unclosed\n\nNext paragraph."').startsWith('*"'), 'a quote across a break is left alone');

// Apostrophes are not speech.
const apos = q("Mrs. Gable's gluten-free rolls, don't you know.");
ok(apos === "Mrs. Gable's gluten-free rolls, don't you know.", 'apostrophes are never treated as quotes');

/* ---- speech vs SCARE QUOTES ----------------------------------------------
 *
 * Quoted words are used for scare quotes, titles, jargon and nicknames all
 * through ordinary prose: `the "charming" rope was not enough`. Styling those
 * as dialogue — and handing them to a character's TTS voice — is wrong in a way
 * a reader notices at once.
 *
 * The reliable signal is punctuation POSITION. Speech carries its terminal mark
 * INSIDE the closing quote, because that is how dialogue is typeset; scare
 * quotes leave the sentence's punctuation outside and sit mid-clause.
 * ------------------------------------------------------------------------- */

const speaks = (src: string, why: string) => ok(q(src) !== src, why);
const narrates = (src: string, why: string) => ok(q(src) === src, why);

narrates('She fell inside the chasm. Of course, the "charming" rope was not enough.',
  'an ironic single word in narration is not dialogue');
narrates('The so-called "expert" had never seen one.', 'nor is a scare-quoted noun');
narrates('They used the word "family" like a threat.', 'nor a word being discussed');
narrates('She read "The Salt Road" twice that winter.', 'nor a title');
// `call` means naming far more often than speaking, so it is NOT an
// attribution verb — and the spoken use has its punctuation inside anyway.
narrates('He called the plan "ambitious".', 'nor something being named');
narrates("She called it 'the arrangement' and left.", 'single quotes get the same judgement');

speaks('"Hello."', 'a full stop inside the quote is speech');
speaks('"Are you coming?"', 'so is a question mark');
speaks('"I never—" he started.', 'so is a broken-off dash');
speaks('"You keep this place warm," she says, and it is not a compliment.',
  'so is the comma before an attribution');
speaks("'Hello,' she said.", 'and British single-quoted speech still reads as speech');
// The exception: an attributed fragment carrying no punctuation of its own.
speaks('She said "nothing at all" and left.', 'a speech verb beside it is enough');
speaks('A sign above the door said "CLOSED" in red paint.',
  'even when what is quoted is not really spoken — the verb is the signal we have');

/* ---- quotes INSIDE quotes ------------------------------------------------
 *
 * `"The 'Silent Observer' becoming the 'Main Attraction'."` is scare quotes
 * inside speech, not a second speaker. Wrapping them put a `*…*` span inside
 * the `*…*` already covering the line: markdown read that as three separate
 * emphasis runs, so the first two words styled as dialogue and the rest of the
 * sentence fell out of it, and Book's renderer produced crossing tags.
 * ------------------------------------------------------------------------- */

const scare = q(`"The 'Silent Observer' becoming the 'Main Attraction'. The gossip would be legendary."`);
ok(scare === `*"The 'Silent Observer' becoming the 'Main Attraction'. The gossip would be legendary."*`,
  'single quotes inside speech are left alone, so the wrap covers the whole line');
ok(!/\*'/.test(scare), 'no nested emphasis is opened inside a wrapped quote');

// Outside speech, single-quoted SPEECH still styles — the rule is about which
// quotes are speech, not about which delimiter was used.
ok(q("'Get out,' she said, and did not look up.")
  === "*'Get out,'* she said, and did not look up.",
  'single-quoted speech in narration still styles');

// Both at once: the narration one wraps, the one inside speech does not.
const mixed = q(`He shrugged. "And you believed 'that'?" she said.`);
ok(mixed.includes(`*"And you believed 'that'?"*`),
  'the outer speech wraps whole, and the single quotes inside it are left intact');
ok(!/\*'that'\*/.test(mixed), 'no nested emphasis is opened inside it');

// The parked spans are restored by position, not by a bare index — a bare one
// would be indistinguishable from a number in the prose.
ok(q('"He was 42 years old," she said.') === '*"He was 42 years old,"* she said.',
  'numbers in the prose survive the round trip');
ok(q('"Room 7 and room 12," he said. "Not 3."')
  === '*"Room 7 and room 12,"* he said. *"Not 3."*',
  'several numbers across several quotes survive');

/* ---- off by default ---- */

ok(processText('"Hi," she said.', { repairFormatting: false }).processedText === '"Hi," she said.',
  'the pass is opt-in');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
