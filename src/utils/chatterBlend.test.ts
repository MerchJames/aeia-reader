/**
 * Run: npx tsx src/utils/chatterBlend.test.ts
 *
 * A blend is offered to the reader as an alternate version of their own scene.
 * Every way it can go wrong produces something that READS FINE:
 *
 *   - a summary is coherent and half the story is gone;
 *   - a reply narrated "around" the reader is a finished passage with the
 *     reader written out of it;
 *   - an invented room is the best-written paragraph in the chat.
 *
 * Nothing throws in any of those cases, so the assertions here are about
 * measurement and refusal, and the numbers below are the thresholds. Moving one
 * is a decision about which of those three gets through.
 */

import type { Chain, Message } from '../types';
import {
  MAX_SOURCE_CHARS, MIN_TURN_CHARS,
  addLensChain, blendProblem, blendSource, buildBlendPrompt, chainsFor, describeBlend,
  blendMap, distinctive, isStale, makeLensChain, readBlend, removeLensChain, retention,
  sameBlends,
} from './chatterBlend';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++; else { fail++; console.error('✗', msg); }
};
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const msg = (id: string, role: 'user' | 'ai', name: string, content: string): Message =>
  ({ id, role, name, content });

const chainOf = (...messages: Message[]): Chain =>
  ({ id: 'chain-1', messages, starred: false });

const USER = 'I crossed the room and pulled the curtain back. "Is anyone still out there?" '
  + 'I put my hand flat against the cold window glass.';
const AI = 'Vela watched the curtain move. "Nobody has been out there for hours," she said, '
  + 'not looking up from the map. The window fogged under his palm, and she finally raised '
  + 'her head. "Come away from there."';

const good = chainOf(msg('m1', 'user', 'You', USER), msg('m2', 'ai', 'Vela', AI));

/* ── What can be blended ─────────────────────────────────────────────────── */

eq(blendProblem(good), null, 'a turn and its reply can be blended');

eq(
  blendProblem(chainOf(msg('m1', 'user', 'You', USER))) !== null, true,
  'a chain with no reply in it cannot',
);
eq(
  blendProblem(chainOf(msg('m1', 'ai', 'Vela', AI))) !== null, true,
  'and neither can a reply with no turn',
);
ok(
  !!blendProblem(chainOf(msg('m1', 'user', 'You', 'ok'), msg('m2', 'ai', 'Vela', AI))),
  'a one-word turn has nothing in it to weave',
);
ok(
  MIN_TURN_CHARS >= 8,
  'and the floor for that is a handful of characters, not a sentence',
);
ok(
  !!blendProblem(chainOf(
    msg('m1', 'user', 'You', 'x'.repeat(MAX_SOURCE_CHARS)),
    msg('m2', 'ai', 'Vela', AI),
  )),
  'a chapter-length passage is refused: rearranging that is rewriting it',
);

const hidden = chainOf(
  msg('m1', 'user', 'You', USER),
  { ...msg('m2', 'ai', 'Narrator', 'Out of character note.'), hidden: true },
  msg('m3', 'ai', 'Vela', AI),
);
const hiddenSource = blendSource(hidden)!;
ok(
  !hiddenSource.aiText.includes('Out of character'),
  // The reader already said they did not want it in the story. Folding it into
  // a passage would put it back, and permanently.
  'a hidden message is left out of the blend entirely',
);
eq(hiddenSource.messageIds, ['m1', 'm3'], 'and out of what the blend stands in for');

/* ── The prompt ──────────────────────────────────────────────────────────── */

const source = blendSource(good)!;
const prompt = buildBlendPrompt(source).replace(/\s+/g, ' ');
ok(prompt.includes(USER.slice(0, 30)), 'the prompt carries the reader’s turn');
ok(prompt.includes(AI.slice(0, 30)), 'and the reply');
ok(prompt.includes('Add nothing'), 'and forbids invention');
ok(prompt.includes('You are rearranging, not editing'), 'and says what the job is');
ok(
  /do not leave anything out\.?$/i.test(prompt.trim()),
  // Last, because the last instruction is the one most obeyed, and losing
  // material is the failure that looks most like success.
  'and the last thing it says is not to lose anything',
);
ok(prompt.includes('Vela'), 'both speakers are named so they stay distinct');

/* ── Retention ───────────────────────────────────────────────────────────── */

ok(!distinctive('the and that with').length, 'furniture words are not distinctive');
ok(distinctive('curtain window').includes('curtain'), 'content words are');
eq(retention('curtain window glass', 'the curtain and the glass'), 2 / 3, 'retention is a share of the SOURCE');
eq(
  retention('curtain', 'curtain and a hundred new words about nothing at all'), 1,
  // Otherwise a blend could improve its score by inventing, which is the exact
  // thing the other half of this file refuses.
  'and adding words never improves it',
);
eq(retention('', 'anything'), 1, 'nothing to keep is not a failure to keep it');

/* ── The three failures ──────────────────────────────────────────────────── */

const summary = readBlend('She told him to come away from the window.', source);
ok(!!summary.rejected, 'a summary is refused');
ok((summary.rejected ?? '').includes('shorter'), 'and told it summarised');

const invented = readBlend(
  `${USER} ${AI} The house had been empty since the flood took the lower road, and the `
  + 'lamps in the hall had not been lit for a season. Outside, snow had begun again, '
  + 'settling on the sill and on the broken gate beyond it, and somewhere below a door '
  + 'moved in its frame. She thought about the letter she had not opened, and about the '
  + 'winter still to come, and about how long a person could stay in one house before it '
  + 'stopped being a house at all and became only a place to wait in.',
  source,
);
ok(!!invented.rejected, 'a blend that grew a new scene is refused');
ok((invented.rejected ?? '').includes('longer'), 'and told it invented');

const eraseUser = readBlend(
  'Vela watched. "Nobody has been out there for hours," she said, not looking up from '
  + 'the map. She finally raised her head. "Come away from there." She had said it before '
  + 'and would say it again before the night was out, and neither of them believed it.',
  source,
);
ok(!!eraseUser.rejected, 'a blend that wrote the reader out is refused');
ok(
  (eraseUser.rejected ?? '').includes('your own turn'),
  'and says so in those words, because it is the failure that looks most finished',
);

eq(readBlend('', source).rejected !== null, true, 'an empty answer is refused');
eq(readBlend('   \n ', source).rejected !== null, true, 'and so is whitespace');

/* ── The one that works ──────────────────────────────────────────────────── */

const woven =
  'I crossed the room and pulled the curtain back. Vela watched it move. "Is anyone still '
  + 'out there?" — "Nobody has been out there for hours," she said, not looking up from the '
  + 'map. I put my hand flat against the cold window glass, and it fogged under my palm. '
  + 'She finally raised her head. "Come away from there."';

const result = readBlend(woven, source);
eq(result.rejected, null, 'a real rearrangement is accepted');
ok(result.keptUser > 0.5 && result.keptAi > 0.5, 'with most of both halves intact');
ok(describeBlend(result).includes('%'), 'and the reader is told the numbers');

const fenced = readBlend('```\n' + woven + '\n```', source);
eq(fenced.rejected, null, 'a fenced answer is unwrapped');
ok(fenced.text.startsWith('I crossed'), 'and the fence is gone');

/* ── Becoming a chain ────────────────────────────────────────────────────── */

const withImage: Chain = chainOf(
  { ...msg('m1', 'user', 'You', USER), images: ['data:image/png;base64,AAA'] },
  msg('m2', 'ai', 'Vela', AI),
);
const lens = makeLensChain(blendSource(withImage)!, woven, withImage);
eq(lens.messages.length, 1, 'a blend is one message, because that is what a blend is');
eq(lens.messages[0].role, 'ai', 'narrative, not the reader talking');
eq(lens.messages[0].name, 'Vela', 'in the character’s name');
eq(
  lens.messages[0].images, ['data:image/png;base64,AAA'],
  // A picture attached to a turn is part of the moment. Dropping it would be
  // losing content through a feature whose whole promise is that it loses none.
  'and pictures from either half come along',
);
eq(
  makeLensChain(source, woven, good).messages[0].id,
  makeLensChain(source, 'something else', good).messages[0].id,
  'the message id comes from the chain, so re-blending replaces rather than piles up',
);

/* ── Living with them ────────────────────────────────────────────────────── */

/*
 * The map handed to `buildChains`.
 *
 * A key present means "show a blend for this chain". Absent means "leave it
 * alone" — the distinction matters because the store uses it to decide whether
 * to rebuild the chains at all, and a map that helpfully filled in every chain
 * with its own messages would rebuild the whole story on every write.
 */
eq(blendMap([lens], {}), {}, 'with nothing selected, nothing is substituted');
eq(
  blendMap([lens], { 'chain-1': lens.id }), { 'chain-1': lens.messages },
  'selecting a blend puts its messages in',
);
eq(
  blendMap([lens], { 'chain-1': 'deleted-id' }), {},
  'a selection pointing at a blend that is gone substitutes nothing',
);
eq(
  blendMap([{ ...lens, messages: [] }], { 'chain-1': lens.id }), {},
  // Never blank. Every other layer in this app has the same rule, and here it
  // would be a chain that renders as nothing at all.
  'and neither does a blend with nothing in it',
);
eq(
  blendMap([{ ...lens, chainId: 'other' }], { 'chain-1': lens.id }), {},
  'a blend belonging to a different chain is never used here',
);
eq(blendMap(undefined, undefined), {}, 'and a story with neither is empty, not a throw');

/*
 * The comparison that decides whether to rebuild.
 *
 * Identity on the arrays, not deep equality: this runs from an effect that
 * fires on every v2 write, and deep-comparing every blended passage of a long
 * story on each of them would be felt.
 */
ok(sameBlends({}, {}), 'two empty maps are the same');
ok(sameBlends({ a: lens.messages }, { a: lens.messages }), 'so are two holding the same array');
ok(!sameBlends({}, { a: lens.messages }), 'adding one is a change');
ok(!sameBlends({ a: lens.messages }, {}), 'and so is removing it');
ok(!sameBlends({ a: lens.messages }, { a: [...lens.messages] }), 'a fresh array counts as a change');

/* ── Working off the real messages, not a blend already showing ──────────── */

// What a chain looks like once `buildChains` has substituted a blend into it.
const blended: Chain = {
  ...withImage,
  messages: lens.messages,
  sourceMessages: withImage.messages,
};

ok(
  !isStale(lens, blended),
  // Comparing against `messages` here would find one blend message where two
  // source ids were recorded, and report every applied blend as stale — the
  // switcher would mark its own selection out of date the moment you made it.
  'a chain that is SHOWING this blend is not stale because of it',
);
eq(
  blendSource(blended)?.messageIds, ['m1', 'm2'],
  // Blending a blend would weave a passage with itself and lose whatever the
  // first pass dropped, with no way back to the original.
  'and re-blending one works from the story’s own messages, not the blend',
);
eq(
  blendSource(blended)?.userText, USER,
  'so the reader’s real turn is what goes into the second attempt',
);

ok(!isStale(lens, withImage), 'a blend of the chain as it stands is not stale');
ok(
  isStale(lens, chainOf(msg('m1', 'user', 'You', USER))),
  'one whose chain lost a message is',
);
ok(
  isStale(lens, chainOf(msg('m2', 'ai', 'Vela', AI), msg('m1', 'user', 'You', USER))),
  'and so is one whose messages were reordered',
);

const many = addLensChain(addLensChain([], lens), { ...lens, id: 'other', label: 'Blended' });
eq(many.length, 1, 'a second blend with the same label replaces the first');
eq(
  addLensChain([lens], { ...lens, id: 'other', label: 'Tighter' }).length, 2,
  'but a differently named one sits beside it',
);
eq(chainsFor(many, 'chain-1').length, 1, 'blends can be found by chain');
eq(chainsFor(many, 'nope').length, 0, 'and not by the wrong one');
eq(removeLensChain(many, 'other').length, 0, 'and removed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
