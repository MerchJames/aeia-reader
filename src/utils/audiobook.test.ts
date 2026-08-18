/**
 * Run: npx tsx src/utils/audiobook.test.ts
 *
 * A render is hours long and needs a running Kokoro, so the synthesiser and the
 * duration probe are injected. What is worth pinning without a server is the
 * bookkeeping: chapter marks land at the right SECOND (byte offsets in a
 * concatenated MP3 tell you nothing about time), a dropped segment costs a gap
 * rather than the whole run, and cancelling actually stops.
 */
import type { Chain, Story } from '../types';
import {
  AbortedError, buildCue, cueTime, estimateSeconds, renderAudiobook, runtimeLabel,
} from './audiobook';
import type { SpeechContext } from './speechPlan';
import { speechPlanFor, voiceCastFor } from './speechPlan';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const msg = (id: string, name: string, content: string) =>
  ({ id, name, role: (name === 'You' ? 'user' : 'ai') as 'user' | 'ai', content });

const story = {
  id: 's1', title: 'A Night at the Hearth', format: 'sillytavern',
  characterName: 'Mara', userName: 'You', messageCount: 3, importedAt: 1,
  messages: [
    msg('m1', 'Mara', 'The hearth had burned down. "You think I did not know," she said.'),
    msg('m2', 'You', 'I said nothing.'),
    msg('m3', 'Ilex', 'The road ran down toward the water.'),
  ],
  highlights: [],
} as unknown as Story;

const chains: Chain[] = [
  { id: 'c1', messages: story.messages.slice(0, 2), starred: false },
  { id: 'c2', messages: story.messages.slice(2), starred: false },
];

const ctx: SpeechContext = {
  cast: ['Mara', 'You', 'Ilex'],
  characterName: 'Mara',
  userName: 'You',
  multiVoice: true,
  kokoroVoice: 'af_bella',
  kokoroUserVoice: 'am_michael',
  ttsVoiceByCharacter: {},
};

/* ---- the plan (shared with live TTS) ---- */

// A quote attributed to the message's OWN author merges back into narration —
// `buildSpeechPlan` does that on purpose, so a character reading their own
// dialogue is not chopped into a dozen one-line clips.
const solo = speechPlanFor(story.messages[0] as never, ctx);
ok(solo.length === 1, 'a speaker quoting themselves stays one segment');

// A quote belonging to someone ELSE is what multi-voice exists for.
const twoHander = speechPlanFor(
  msg('m9', 'Mara', 'She waited. Ilex said, "The road is closed." Then silence.') as never,
  ctx,
);
ok(twoHander.length >= 2, 'another character’s line becomes its own segment');
ok(new Set(twoHander.map(s => s.voice)).size >= 2, 'and gets its own voice');
ok(twoHander.every(s => !!s.voice), 'every segment is cast to a voice');

const single = speechPlanFor(story.messages[0] as never, { ...ctx, multiVoice: false });
ok(single.length === 1, 'single-voice reads the message whole');

// An explicit casting choice must beat the automatic one.
const pinned = speechPlanFor(
  story.messages[2] as never,
  { ...ctx, ttsVoiceByCharacter: { Ilex: 'bm_george' } },
);
ok(pinned[0].voice === 'bm_george', 'a hand-cast voice wins');

// Casting is deterministic — the same story must not re-cast on every render.
const a = voiceCastFor(story, ctx).map(v => v.voice).join();
const b = voiceCastFor(story, ctx).map(v => v.voice).join();
ok(a === b, 'auto-casting is deterministic');

ok(speechPlanFor(msg('x', 'Mara', '   ') as never, ctx).length === 0, 'an empty message plans nothing');

/* ---- CUE timing ---- */

ok(cueTime(0) === '00:00:00', 'zero is the start of the file');
ok(cueTime(61) === '01:01:00', 'a minute and a second');
ok(cueTime(3600) === '60:00:00', 'CUE counts minutes past an hour, not hours');
// 75 frames per second is the CUE standard, not 100 or 1000.
ok(cueTime(1.5) === '00:01:37', 'fractions become 75ths of a second');
ok(cueTime(-5) === '00:00:00', 'a negative time clamps rather than corrupting the sheet');

const cue = buildCue('A Night', 'Mara', 'a.mp3', [
  { index: 1, title: 'Chapter 1', startSec: 0 },
  { index: 2, title: 'Chapter 2', startSec: 125.5 },
]);
ok(cue.includes('FILE "a.mp3" MP3'), 'the sheet names the audio file');
ok(cue.includes('TRACK 01 AUDIO') && cue.includes('TRACK 02 AUDIO'), 'one track per chapter');
ok(cue.includes('INDEX 01 02:05:37'), 'a chapter starts at its measured time');
ok(!buildCue('He said "hi"', 'M', 'a.mp3', []).includes('"hi"'), 'quotes in a title cannot break the sheet');

/* ---- the render ---- */

const run = async () => {
  const spoken: string[] = [];
  const synth = async (_b: string, _k: string, voice: string, text: string) => {
    spoken.push(`${voice}:${text.slice(0, 12)}`);
    return new Blob([new Uint8Array(64)], { type: 'audio/mpeg' });
  };
  const measure = async () => 10;   // every segment is 10 seconds

  const out = await renderAudiobook(story, chains, {}, ctx, undefined, {
    base: 'http://x', apiKey: '', synth, measure,
  });

  ok(out.audio.type === 'audio/mpeg', 'the output is an mp3');
  ok(out.audio.size === spoken.length * 64, 'every segment is concatenated, none lost');
  ok(out.failed === 0, 'nothing failed');
  ok(out.chapters.length === 2, 'one chapter mark per chain');
  ok(out.chapters[0].startSec === 0, 'the first chapter starts at zero');
  // THE bookkeeping property, stated exactly: chapter 1 holds two messages,
  // each one segment, each 10s — so chapter 2 begins at 20s. If offsets were
  // taken from byte counts instead of decoded durations, this is the assertion
  // that would fail.
  const ch1Segments = speechPlanFor(story.messages[0] as never, ctx).length
    + speechPlanFor(story.messages[1] as never, ctx).length;
  ok(out.chapters[1].startSec === ch1Segments * 10,
    `chapter 2 starts after chapter 1's audio (${out.chapters[1].startSec}s)`);
  ok(out.totalSec === spoken.length * 10, 'total runtime is the sum of the segments');
  ok(out.cue.includes('TRACK 02'), 'the sheet has both chapters');

  // Progress must be reported, or a multi-hour render looks like a hang.
  const seen: number[] = [];
  await renderAudiobook(story, chains, {}, ctx, undefined, {
    base: 'http://x', apiKey: '', synth, measure,
    onProgress: (done, total) => { seen.push(done); ok(total > 0, 'progress knows the total'); },
  });
  ok(seen.length > 0 && seen[seen.length - 1] === seen.length, 'progress counts every segment');

  // One bad segment costs a gap, not the run.
  let calls = 0;
  const flaky = async (...args: Parameters<typeof synth>) => {
    calls++;
    if (calls <= 2) throw new Error('502');   // fails twice => one segment lost
    return synth(...args);
  };
  const partial = await renderAudiobook(story, chains, {}, ctx, undefined, {
    base: 'http://x', apiKey: '', synth: flaky, measure,
  });
  ok(partial.failed === 1, 'a segment that fails twice is counted');
  ok(partial.audio.size > 0, 'and the rest of the book is still rendered');

  // Retry: a single transient failure must NOT lose the segment.
  let once = 0;
  const blip = async (...args: Parameters<typeof synth>) => {
    if (++once === 1) throw new Error('transient');
    return synth(...args);
  };
  const retried = await renderAudiobook(story, chains, {}, ctx, undefined, {
    base: 'http://x', apiKey: '', synth: blip, measure,
  });
  ok(retried.failed === 0, 'a transient failure is retried and recovered');

  // Cancelling stops, and says so.
  const ctrl = new AbortController();
  let n = 0;
  const slow = async (...args: Parameters<typeof synth>) => {
    if (++n === 2) ctrl.abort();
    return synth(...args);
  };
  let aborted = false;
  try {
    await renderAudiobook(story, chains, {}, ctx, undefined, {
      base: 'http://x', apiKey: '', synth: slow, measure, signal: ctrl.signal,
    });
  } catch (e) {
    aborted = e instanceof AbortedError;
  }
  ok(aborted, 'cancelling throws AbortedError rather than returning half a book');

  /* ---- labels ---- */
  ok(runtimeLabel(0) === '0m', 'zero runtime reads as 0m');
  ok(runtimeLabel(17) === 'under a minute', 'a short book says so rather than rounding to 0m');
  ok(runtimeLabel(125) === '2m', 'minutes round');
  ok(runtimeLabel(11520) === '3h 12m', 'hours and minutes');
  ok(estimateSeconds(150) === 60, '150 words is about a minute');
  ok(estimateSeconds(150, 2) === 30, 'and half that at double speed');

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

void run();
