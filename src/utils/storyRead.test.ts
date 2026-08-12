/** Run: npx tsx src/utils/storyRead.test.ts */
import { ScenePassage } from './sceneDirector';
import {
  SAMPLE_PASSAGES, STORY_READ_VERSION, StoryRead, buildStoryReadMessages, headHash,
  isStoryReadStale, parseStoryRead, sampleForRead, storyReadBlock,
} from './storyRead';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const P = (id: string, content: string): ScenePassage => ({ messageId: id, name: 'Mara', content });
const story = (n: number): ScenePassage[] =>
  Array.from({ length: n }, (_, i) => P(`m${i}`, `passage ${i} in the lantern room`));

// --- sampling ----------------------------------------------------------------
ok(sampleForRead(story(5)).length === 5, 'a short story is sent whole');
ok(sampleForRead(story(200)).length <= SAMPLE_PASSAGES, 'a long story is sampled, not sent whole');
const s200 = sampleForRead(story(200));
ok(s200[0].messageId === 'm0', 'the sample opens on the opening');
ok(s200[s200.length - 1].messageId === 'm199', 'and ends where the reader actually is');
// Truncating instead of sampling would describe chapter one and call it the book.
const ids = s200.map(p => Number(p.messageId.slice(1)));
ok(ids.some(i => i > 60 && i < 140), 'the middle of the story is represented');
ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'the sample stays in story order');
ok(new Set(ids).size === ids.length, 'no passage is sampled twice');
ok(sampleForRead([]).length === 0, 'an empty story samples to nothing');

// --- staleness ---------------------------------------------------------------
const base = story(20);
const read: StoryRead = {
  v: STORY_READ_VERSION, hash: headHash(base), count: 20,
  arc: 'A story.', cast: [], places: [], motifs: [], createdAt: 0,
};
ok(!isStoryReadStale(read, base), 'a current read is not stale');
ok(isStoryReadStale(undefined, base), 'a missing read is stale');
ok(isStoryReadStale({ ...read, v: 0 }, base), 'a read from an older generation is stale');
ok(!isStoryReadStale(read, []), 'an empty story never asks for a read');

// A chat grows by appending. Re-reading on every new message would turn a
// once-per-story cost into a per-message one.
ok(!isStoryReadStale(read, story(22)), 'a couple of new passages do NOT trigger a re-read');
ok(!isStoryReadStale(read, story(27)), 'nor does steady growth below the threshold');
ok(isStoryReadStale(read, story(28)), 'but substantial growth does — the arc has moved on');

// A different story (or a rewritten opening) is a different read.
const rewritten = [P('m0', 'a completely different beginning'), ...base.slice(1)];
ok(isStoryReadStale(read, rewritten), 'a rewritten opening is stale');
ok(headHash(base) === headHash([...base]), 'the head hash is stable for the same text');

// --- the prompt --------------------------------------------------------------
const msgs = buildStoryReadMessages(base);
ok(msgs.length === 2 && msgs[0].role === 'system', 'the read is a system + user pair');
ok(/JSON object/i.test(msgs[0].content), 'it asks for one object');
ok(/arc|cast|places|motifs/.test(msgs[0].content), 'and names the fields');
ok(/Invent nothing/i.test(msgs[0].content), 'it forbids invention');
ok(/not much yet|too short|too thin/i.test(msgs[0].content), 'it licenses an honest "no shape yet"');
ok(msgs[1].content.includes('passage 0'), 'the passages are in the user message');

// --- parsing -----------------------------------------------------------------
const text = [
  P('a', 'Mara turned the brass key in the lantern room. "Not yet," she said, clipped.'),
  P('b', 'The brass key stayed cold in her pocket all the way to the harbour.'),
];
const reply = JSON.stringify({
  arc: 'A woman avoids using a key she carries everywhere.',
  cast: [
    { name: 'Mara', register: 'clipped, evasive' },
    { name: 'Someone Invented', register: 'warm' },   // not in the text → dropped
    { name: 'Mara', register: 'duplicate' },          // dupe → dropped
  ],
  places: ['lantern room', 'harbour', 'the moon colony'],  // last is invented → dropped
  motifs: ['brass key', 'a motif that never appears'],
});
const parsed = parseStoryRead(reply, text, 1000)!;
ok(!!parsed, 'a good reply parses');
ok(parsed.cast.length === 1 && parsed.cast[0].name === 'Mara', 'only grounded, unique cast survives');
ok(parsed.cast[0].register === 'clipped, evasive', 'the register is kept');
ok(parsed.places.join() === 'lantern room,harbour', 'invented places are dropped');
ok(parsed.motifs.join() === 'brass key', 'invented motifs are dropped');
ok(parsed.v === STORY_READ_VERSION && parsed.count === 2, 'the read is stamped and counted');
ok(parsed.hash === headHash(text), 'and fingerprinted against the story it read');

// Tolerant of the ways models wrap a reply.
const fenced = '```json\n' + JSON.stringify({ arc: 'A short arc.', cast: [], places: [], motifs: [] }) + '\n```';
ok(parseStoryRead(fenced, text)?.arc === 'A short arc.', 'a fenced reply still parses');
const chatty = 'Sure!\n{"arc":"A short arc.","cast":[],"places":[],"motifs":[]}\nHope that helps.';
ok(!!parseStoryRead(chatty, text), 'a chatty reply still parses');
// A brace inside a string must not close the object early.
const braced = '{"arc":"A room with a { in the sign.","cast":[],"places":[],"motifs":[]}';
ok(parseStoryRead(braced, text)?.arc.includes('{'), 'braces inside strings are safe');

ok(parseStoryRead('no json at all', text) === undefined, 'garbage yields no read');
ok(parseStoryRead('{"arc":"","cast":[],"places":[],"motifs":[]}', text) === undefined,
  'an entirely empty read is discarded, not cached as if it were fresh');

// --- the grounding block -----------------------------------------------------
ok(storyReadBlock(undefined) === '', 'no read means no block, not an empty heading');
const block = storyReadBlock(parsed);
ok(block.includes('Mara (clipped, evasive)'), 'the block carries voices');
ok(block.includes('brass key'), 'and the motifs');
ok(block.split('\n').length <= 4, 'the block stays short — it rides on every batch');
const bare = storyReadBlock({ ...parsed, cast: [], places: [], motifs: [] });
ok(bare.split('\n').length === 1 && bare.startsWith('Shape:'), 'empty sections are omitted entirely');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
