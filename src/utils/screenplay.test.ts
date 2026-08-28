/**
 * Run: npx tsx src/utils/screenplay.test.ts
 *
 * The Script view's formatter.
 *
 * Two properties carry this file.
 *
 * **It does not invent.** A slugline says INT. only where the prose names an
 * interior, prints a time only where one is known, and says CONTINUOUS rather
 * than guessing. This is the same rule the RPG HUD lives by, and for the same
 * reason: screenplay format's whole value is that it is precise, so a confident
 * wrong slugline is worse than a vague right one.
 *
 * **A character cue is a claim, and it has to be the same claim the voice
 * makes.** Attribution comes from the one engine that already feeds multi-voice
 * TTS and the Stage/VN bubbles. A cue that disagreed with the voice reading the
 * line would be worse than no cue at all — so the fallbacks are asserted in
 * order here, not just the happy path.
 */
import {
  ACTION_COLS, LINES_PER_PAGE, buildScript, eighthsLabel, eighthsOf, lineHeight,
  linesForMessage, placePrefix, plainProse, scriptStats, slugFor,
} from './screenplay';
import type { Scene } from './sceneSegment';
import type { Message, SceneDescriptor } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1', index: 0, messageIds: ['m1'], startId: 'm1', endId: 'm1',
  mood: 'neutral', peakTension: 0.3, tensionById: {}, ...over,
});

const msg = (content: string, over: Partial<Message> = {}): Pick<Message, 'id' | 'name' | 'role' | 'content'> =>
  ({ id: 'm1', name: 'Mara', role: 'ai', content, ...over } as never);

const kinds = (lines: { kind: string }[]) => lines.map(l => l.kind);
const texts = (lines: { text: string }[]) => lines.map(l => l.text);

/* ── Inside or out ───────────────────────────────────────────────────────── */
{
  eq(placePrefix('the guardroom'), 'INT.', 'a room is an interior');
  eq(placePrefix('the north road'), 'EXT.', 'a road is an exterior');
  eq(placePrefix(undefined), '', 'nothing known, nothing claimed');
  eq(placePrefix('the place'), '', 'a word the list does not know claims nothing');
  // The one that catches a naive word list out: both words are present, and the
  // scene is outdoors.
  eq(placePrefix('the road outside the tavern'), 'EXT.',
    'the exterior wins — the interior word is the landmark, not the place');
}

/* ── Sluglines ───────────────────────────────────────────────────────────── */
{
  eq(slugFor(scene({ location: 'the guardroom', timeOfDay: 'night' })),
    'INT. THE GUARDROOM - NIGHT', 'everything known');
  eq(slugFor(scene({ location: 'the guardroom' })), 'INT. THE GUARDROOM',
    'no time known, no time printed');
  eq(slugFor(scene({ location: 'the hollow', timeOfDay: 'unknown' })), 'THE HOLLOW',
    'an explicit unknown is still unknown, and the place is not guessed at either');

  // An unchanged time of day is not restated — which is how a script is written.
  const prev = scene({ location: 'the road', timeOfDay: 'night' });
  eq(slugFor(scene({ location: 'the guardroom', timeOfDay: 'night' }), prev),
    'INT. THE GUARDROOM', 'the time is not restated when it has not changed');
  eq(slugFor(scene({ location: 'the guardroom', timeOfDay: 'dawn' }), prev),
    'INT. THE GUARDROOM - DAWN', 'and is when it has');

  // Nothing known at all.
  eq(slugFor(scene(), prev), 'CONTINUOUS', 'no place: we have not moved anywhere nameable');
  eq(slugFor(scene({ timeOfDay: 'dawn' }), prev), 'CONTINUOUS - DAWN',
    'and the time still prints when it changed');
  // The first scene cannot continue from anything.
  eq(slugFor(scene()), 'FADE IN:', 'the story begins — the one transition this file will print');
  eq(slugFor(scene({ timeOfDay: 'night' })), 'FADE IN: - NIGHT', 'with the hour if it is known');
}

/* ── Markdown out, paragraphs kept ───────────────────────────────────────── */
{
  eq(plainProse('## Heading\n\nOne.\n\nTwo.'), 'Heading\n\nOne.\n\nTwo.',
    'the blank line between paragraphs survives — it becomes the break between action blocks');
  eq(plainProse('She **did** not *move*.'), 'She did not move.', 'markers go');
  eq(plainProse('a\n\n\n\n\nb'), 'a\n\nb', 'a run of blank lines is one break');
  eq(plainProse('```\ncode\n```\nafter'), 'after', 'a code fence is not prose');
  // A picture is not prose. Unwrapping it as a link left `!alt` behind, and a
  // comic panel captioned itself `!the guardroom`.
  eq(plainProse('before ![the guardroom](x.png) after'), 'before after',
    'an inline image leaves nothing behind, not even its alt text');
  eq(plainProse('![only](x.png)'), '', 'a paragraph that is only a picture is not a beat');
  eq(plainProse('a [link](p.html) here'), 'a link here', 'but a real link keeps its words');
}

/* ── One passage into script lines ───────────────────────────────────────── */
{
  const lines = linesForMessage(
    msg('She did not move.\n\n"You are late," the captain said.\n\nShe kept her hands still.'),
    undefined, { cast: ['Mara'] },
  );
  eq(kinds(lines), ['action', 'character', 'dialogue', 'action'],
    'narration, then a cue and its line, then narration');
  eq(texts(lines)[1], 'MARA', 'the cue is upper case');
  eq(texts(lines)[2], 'You are late',
    'the attribution comma goes with the attribution clause the format deleted');

  // Consecutive lines from one speaker are ONE block. A cue repeated over every
  // sentence is how a script says the speaker CHANGED.
  const run = linesForMessage(
    msg('"One." "Two." "Three."'), undefined, { cast: ['Mara'] });
  eq(kinds(run), ['character', 'dialogue'], 'three sentences, one speaker, one block');
  eq(texts(run)[1], 'One. Two. Three.', 'joined in order');

  // Narration between two lines is a beat, so the cue comes back.
  const broken = linesForMessage(
    msg('"One." She looked away. "Two."'), undefined, { cast: ['Mara'] });
  eq(kinds(broken), ['character', 'dialogue', 'action', 'character', 'dialogue'],
    'stage business between two lines restarts the block');

  eq(linesForMessage(msg('   '), undefined), [], 'an empty passage produces nothing');
}

/* ── Attribution, in the order the engine tries it ───────────────────────── */
{
  // 1. The Director's read wins.
  const directed: SceneDescriptor = {
    messageId: 'm1', hash: 'h', mood: 'tense', tension: 0.5, createdAt: 0,
    dialogue: [{ text: 'You are late', speaker: 'Kaelen' }],
  } as SceneDescriptor;
  const a = linesForMessage(msg('"You are late," he said.'), directed, { cast: ['Mara'] });
  eq(texts(a)[0], 'KAELEN', 'the Director’s attribution beats the heuristic');

  // 2. The heuristic, from the narration beside the line.
  const b = linesForMessage(msg('"You are late," Kara said.'), undefined, { cast: ['Mara', 'Kara'] });
  eq(texts(b)[0], 'KARA', 'a named speaker beside a speech verb');

  // 3. The passage's own author, when nothing names anyone.
  const c = linesForMessage(msg('"You are late."'), undefined, { cast: ['Mara'] });
  eq(texts(c)[0], 'MARA', 'otherwise the passage’s own character is speaking');

  // A user turn with no name at all still gets a cue rather than a blank one.
  const d = linesForMessage(
    msg('"I had a reason."', { id: 'm2', name: '', role: 'user' }), undefined);
  eq(texts(d)[0], 'YOU', 'an unnamed user turn is YOU, not an empty cue');
}

/* ── The parenthetical is spent once ─────────────────────────────────────── *
 * A note under every cue is the classic amateur tell, and it is also wrong: an
 * emotion read for the PASSAGE is not a note on every sentence in it. */
{
  const d: SceneDescriptor = {
    messageId: 'm1', hash: 'h', mood: 'tense', tension: 0.5, createdAt: 0,
    speaker: { name: 'Mara', emotion: 'Bitter' },
  } as SceneDescriptor;
  const lines = linesForMessage(
    msg('"One." She looked away. "Two." She looked away again. "Three."'), d, { cast: ['Mara'] });
  const parens = lines.filter(l => l.kind === 'parenthetical');
  eq(parens.length, 1, 'exactly one parenthetical, however many times she speaks');
  eq(parens[0].text, 'bitter', 'and it is lower case, as a parenthetical is written');

  // It belongs to its owner. A read of Mara's mood is not a note on Kaelen.
  const other: SceneDescriptor = { ...d, speaker: { name: 'Kaelen', emotion: 'Bitter' } } as SceneDescriptor;
  const notMine = linesForMessage(msg('"One."'), other, { cast: ['Mara'] });
  ok(!notMine.some(l => l.kind === 'parenthetical'),
    'an emotion read for someone else is not printed over this speaker');
}

/* ── Page arithmetic ─────────────────────────────────────────────────────── */
{
  eq(lineHeight({ kind: 'character', text: 'MARA', messageId: 'm' }), 1,
    'a cue is one line and carries no blank after it — the dialogue follows immediately');
  eq(lineHeight({ kind: 'action', text: 'x', messageId: 'm' }), 2,
    'an action block is its rows plus the blank line after it');
  eq(lineHeight({ kind: 'action', text: 'x'.repeat(ACTION_COLS * 2), messageId: 'm' }), 3,
    'and wraps at the column width');

  // Eighths of a page — the unit a schedule is built from.
  const short = [{ kind: 'action' as const, text: 'x', messageId: 'm' }];
  eq(eighthsOf(short), 1, 'a scene never rounds away to nothing');
  const full = Array.from({ length: LINES_PER_PAGE }, () => (
    { kind: 'action' as const, text: 'x', messageId: 'm' }));
  eq(eighthsOf(full), 16, 'fifty-five action blocks is two pages — two rows each');

  eq(eighthsLabel(3), '3/8', 'less than a page');
  eq(eighthsLabel(8), '1', 'exactly one page is not written 1 0/8');
  eq(eighthsLabel(19), '2 3/8', 'and the mixed form otherwise');
}

/* ── The whole script ────────────────────────────────────────────────────── */
{
  const messages = [
    msg('She waited.', { id: 'm1' }),
    msg('"Late again."', { id: 'm2' }),
    msg('The road was empty.', { id: 'm3' }),
  ];
  const scenes = [
    scene({ id: 's1', messageIds: ['m1', 'm2'], location: 'the guardroom', timeOfDay: 'night' }),
    scene({ id: 's2', index: 1, messageIds: ['m3'], location: 'the north road' }),
  ];
  const script = buildScript(messages, scenes, undefined, { cast: ['Mara'] });
  eq(script.length, 2, 'two scenes');
  eq(script[0].number, 1, 'numbered from one');
  eq(script[0].slug, 'INT. THE GUARDROOM - NIGHT', 'with its heading');
  eq(script[0].lines[0].kind, 'slug', 'and the heading is the first line on the page');
  eq(script[1].slug, 'EXT. THE NORTH ROAD', 'the second scene moves outdoors');

  // A scene whose passages are all missing is not a scene — printing an empty
  // heading for it makes the sidebar count disagree with the page.
  const ghost = buildScript(messages, [...scenes, scene({ id: 's3', index: 2, messageIds: ['gone'] })],
    undefined, {});
  eq(ghost.length, 2, 'a scene with nothing in it does not get a heading');
  eq(ghost[1].number, 2, 'and the numbering stays contiguous');

  const stats = scriptStats(script);
  eq(stats.scenes, 2, 'the stats count what is on the page');
  ok(stats.minutes >= 1, 'a script always runs at least a minute');
  ok(stats.pages > 0, 'and has a length');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
