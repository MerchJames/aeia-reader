/**
 * A story, rendered to an audiobook.
 *
 * Kokoro only, and not by choice: the browser's `SpeechSynthesis` has no way to
 * capture what it speaks — it drives the audio device directly and exposes no
 * stream — so an offline render is impossible on that engine. The UI says so
 * rather than offering a button that cannot work.
 *
 * The output is one MP3 plus a CUE sheet. MP3 frames concatenate cleanly (this
 * is what `cat *.mp3` does, and every player handles it), which means no
 * encoder dependency and no 10× size penalty from decoding to WAV. The cost is
 * that byte offsets tell you nothing about time, so chapter marks come from
 * decoding each segment's duration — accurate, and the buffer is dropped
 * immediately after it is measured.
 *
 * Long renders are the normal case (a 200-message story is hours of audio), so
 * everything here is abortable, reports progress, and survives a bad segment
 * rather than losing the whole run to one failed request.
 */

import type { Chain, SceneDescriptor, Story } from '../types';
import { kokoroSpeak } from './kokoro';
import { SpeechContext, speechPlanFor } from './speechPlan';
import { WalkOptions, walkStory } from './storyWalk';

export interface AudiobookChapter {
  index: number;
  title: string;
  /** Seconds from the start of the file. */
  startSec: number;
}

export interface AudiobookResult {
  audio: Blob;
  cue: string;
  chapters: AudiobookChapter[];
  totalSec: number;
  /** Segments that could not be synthesised even after a retry. */
  failed: number;
}

export interface RenderOptions {
  base: string;
  apiKey: string;
  /** Kokoro's speed parameter, 0.5–2. */
  speed?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Injected so the unit suite can render without a server. */
  synth?: typeof kokoroSpeak;
  /** Injected likewise; returns a segment's duration in seconds. */
  measure?: (blob: Blob) => Promise<number>;
}

/** `mm:ss:ff` — CUE sheets count frames at 75 per second, not milliseconds. */
export const cueTime = (sec: number): string => {
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * 75);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}:${pad(f)}`;
};

/** A CUE sheet naming each chapter and where it starts. */
export const buildCue = (
  title: string,
  performer: string,
  audioFile: string,
  chapters: AudiobookChapter[],
): string => {
  const esc = (s: string) => s.replace(/"/g, "'");
  const lines = [
    `TITLE "${esc(title)}"`,
    `PERFORMER "${esc(performer)}"`,
    `FILE "${esc(audioFile)}" MP3`,
  ];
  chapters.forEach((ch, i) => {
    lines.push(
      `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`,
      `    TITLE "${esc(ch.title)}"`,
      `    INDEX 01 ${cueTime(ch.startSec)}`,
    );
  });
  return lines.join('\n') + '\n';
};

/** Decode just far enough to read a duration, then let the buffer go. */
const measureBlob = async (blob: Blob): Promise<number> => {
  const Ctor = (window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return 0;
  const ctx = new Ctor();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return buf.duration;
  } catch {
    return 0;
  } finally {
    void ctx.close();
  }
};

export class AbortedError extends Error {
  constructor() { super('Audiobook render cancelled'); this.name = 'AbortedError'; }
}

export const renderAudiobook = async (
  story: Story,
  chains: Chain[],
  walkOpts: WalkOptions,
  speechCtx: SpeechContext,
  scenes: Record<string, SceneDescriptor> | undefined,
  opts: RenderOptions,
): Promise<AudiobookResult> => {
  const walked = walkStory(story, chains, walkOpts);
  const synth = opts.synth ?? kokoroSpeak;
  const measure = opts.measure ?? measureBlob;
  const speed = opts.speed ?? 1;

  // Index the original messages so the plan sees the real object (the walk
  // returns processed text; `speechPlanFor` needs the message itself).
  const byId = new Map(story.messages.map(m => [m.id, m]));

  interface Job { text: string; voice: string; chapter: number; label: string }
  const jobs: Job[] = [];
  for (const ch of walked.chapters) {
    for (const wm of ch.messages) {
      const msg = byId.get(wm.id);
      if (!msg) continue;
      for (const seg of speechPlanFor(msg, speechCtx, scenes?.[wm.id])) {
        if (seg.text.trim()) jobs.push({ text: seg.text, voice: seg.voice, chapter: ch.index, label: wm.name });
      }
    }
  }

  const parts: BlobPart[] = [];
  const chapters: AudiobookChapter[] = [];
  let elapsed = 0;
  let failed = 0;
  let lastChapter = -1;

  for (let i = 0; i < jobs.length; i++) {
    if (opts.signal?.aborted) throw new AbortedError();
    const job = jobs[i];

    if (job.chapter !== lastChapter) {
      chapters.push({ index: job.chapter, title: `Chapter ${job.chapter}`, startSec: elapsed });
      lastChapter = job.chapter;
    }

    let blob: Blob | null = null;
    // One retry, then carry on. Losing an hour of render to a single dropped
    // request would be a far worse failure than a gap of silence.
    for (let attempt = 0; attempt < 2 && !blob; attempt++) {
      try {
        blob = await synth(opts.base, opts.apiKey, job.voice, job.text, speed, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) throw new AbortedError();
        if (attempt === 1) { failed++; blob = null; }
      }
    }

    if (blob) {
      parts.push(blob);
      elapsed += await measure(blob);
    }
    opts.onProgress?.(i + 1, jobs.length, job.label);
  }

  const audio = new Blob(parts, { type: 'audio/mpeg' });
  const performer = story.characterName ?? 'Aeia Reader';
  return {
    audio,
    cue: buildCue(story.title, performer, `${story.title}.mp3`, chapters),
    chapters,
    totalSec: elapsed,
    failed,
  };
};

/** "3h 12m" — how long the finished book runs. */
export const runtimeLabel = (sec: number): string => {
  // Anything under a minute rounds to "0m", which reads as a broken estimate
  // rather than a short one. Say what it means instead.
  if (sec > 0 && sec < 60) return 'under a minute';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/**
 * A rough estimate before anything is synthesised, so the reader can decide
 * whether to start. Speech runs around 150 words a minute; Kokoro's `speed`
 * scales that directly.
 */
export const estimateSeconds = (words: number, speed = 1): number =>
  (words / 150) * 60 / Math.max(0.5, speed);
