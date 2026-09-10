/**
 * The cowriter — the same companion, wearing the other hat.
 *
 * ── What makes this a different feature and not a setting ──────────────────
 *
 * Live Reaction and this one look identical on screen and are opposites
 * underneath, in three ways that all point the same direction:
 *
 * **A reader must not know the ending. A writer must.** The entire clamp
 * architecture next door — `visibleText`, `upTo`, the between-message history
 * cut — exists to keep a companion ignorant of what is coming, because the
 * whole pleasure of watching something with someone is that they do not know
 * either. An editor who has not read to the end is worthless. So this one gets
 * the passage whole, on purpose, and the clamps are simply not used.
 *
 * **A reader reacts mid-sentence. A writer must not.** A gasp lands in the
 * middle of the line that caused it — that is the feature. A note about the
 * craft of a paragraph, delivered halfway through the paragraph, is somebody
 * talking over you while you work. So this fires when a passage is FINISHED.
 *
 * **A reaction is speech. A note is about something.** Every note carries the
 * id of the passage it is about, which is what will later let a note become a
 * Lens proposal, a branch comparison or a preset run. That id is the seam, and
 * it costs nothing to carry now and cannot be added retroactively to notes
 * already written.
 *
 * What it is NOT, deliberately: a second implementation of anything. Blending,
 * cowrite presets and Lens overrides already exist and are good. When this
 * grows past the MVP it should DRIVE those, not grow its own.
 */

import { ChatMsg, SamplerParams, isLocalBase } from './aiClient';
import { askText } from './aiCall';
import {
  HISTORY_BUDGET, HistoryMessage, clampHistory, historyBlock, parseAnswer, type ParsedAnswer,
} from './askCharacter';
import { cardToPromptBlock } from './cardContext';
import type { Reactor } from './liveReaction';

/** How much of the story travels with a note. */
export const NOTE_HISTORY = Math.floor(HISTORY_BUDGET * 0.75);
export const NOTE_TOKENS = 320;

/**
 * What the cowriter is looking at.
 *
 * `passage` is whole — see the docblock above. `pins` is the reader's own
 * material, which is the difference between a note about writing in general and
 * a note about THIS story: the thing they wrote down because it mattered.
 */
export interface NoteInput {
  reactor: Reactor;
  /** The passage, entire, as the reader will read it. */
  passage: string;
  /** Which passage this note is about. Carried through to the note. */
  targetId: string;
  /** The story up to and including it. */
  history: HistoryMessage[];
  userName?: string;
  /** The reader's kept material — pins, sheets, notes on this story. */
  pins?: string[];
  /** Notes already given on this story, so the same one is not given twice. */
  said?: string[];
  mood?: string;
}

export interface CowriterNote extends ParsedAnswer {
  targetId: string;
}

export const cowriterSystem = (r: Reactor, userName?: string): string => [
  `You are ${r.name}, and you are helping write this.`,
  '',
  'Not reading it — WRITING it, with the person beside you. They have just',
  'finished a passage and you have read the whole of it.',
  '',
  'WHO YOU ARE TALKING TO:',
  'The author. They are not in the story.',
  userName
    ? `They are NOT ${userName} — that is a person in the story they are writing.`
    : 'Never mistake them for anyone in the story.',
  '',
  'WHAT A NOTE IS:',
  '1. ONE thing. The most useful thing you noticed about this passage, said in',
  '   two or three lines. Not a list, not a report, not a rating.',
  '2. About the WRITING: a line that is doing the work, a beat that is missing,',
  '   a place two sentences are saying the same thing, a character who has gone',
  '   quiet, a promise made earlier that this passage just walked past.',
  '3. SPECIFIC. Quote the words you mean. "The third paragraph explains the',
  '   thing the second one already showed" is a note; "consider tightening the',
  '   prose" is a horoscope.',
  '4. You may say it is good, and you should when it is — but say WHAT is good,',
  '   and only when you would have said so unprompted.',
  '5. You are a collaborator, not a marker. Do not grade, do not praise to be',
  '   kind, and never rewrite the passage for them. If you want to show a fix,',
  '   show the one line.',
  '6. Sound like yourself. You are still a character, and characters have',
  '   opinions about what a story is for.',
  '',
  'End with one line naming how the passage left you:',
  '[FEELING: one word]',
].filter(Boolean).join('\n');

export const buildNoteMessages = (input: NoteInput): ChatMsg[] => {
  const who = [input.reactor.dossier, cardToPromptBlock(input.reactor.card)]
    .filter(Boolean).join('\n\n');
  const setup = [
    'THE STORY SO FAR:',
    '"""',
    historyBlock(clampHistory(input.history, input.targetId, NOTE_HISTORY), input.userName)
      || '(this is the opening)',
    '"""',
    '',
    'THE PASSAGE THEY HAVE JUST FINISHED — all of it:',
    '"""',
    input.passage,
    '"""',
    input.mood ? `\nThe scene reads as: ${input.mood}` : '',
    input.pins?.length
      ? '\nWHAT THEY HAVE KEPT BESIDE THIS STORY — their own notes, in their words:\n'
        + input.pins.map(p => `  ${p}`).join('\n')
        + '\nThese are what THEY think matters. A note that contradicts one of these had'
        + ' better be worth it, and a note that notices the story drifting from one is'
        + ' the most useful note you can give.'
      : '',
    input.said?.length
      ? '\nNOTES YOU HAVE ALREADY GIVEN ON THIS STORY:\n'
        + input.said.map(s => `  "${s}"`).join('\n')
        + '\nDo not give the same note twice. If the thing you flagged is still true,'
        + ' either say something new about it or say nothing.'
      : '',
    '',
    'One note.',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: [cowriterSystem(input.reactor, input.userName), who].filter(Boolean).join('\n\n') },
    { role: 'user', content: setup },
  ];
};

/**
 * Cooler than a reaction, on purpose.
 *
 * A gasp should surprise you; a note should be the same note twice. The heat
 * next door exists so the same beat does not produce the same sentence — here
 * that would mean the advice changing when the passage did not.
 */
export const noteSamplers = (base: string): SamplerParams => ({
  temperature: 0.65, top_p: 0.9, frequency_penalty: 0.2,
  ...(isLocalBase(base) ? { min_p: 0.05, repetition_penalty: 1.05 } : {}),
});

export interface NoteConfig {
  base: string;
  key: string;
  model: string;
  params?: SamplerParams;
}

export const noteOn = async (
  input: NoteInput, cfg: NoteConfig, signal?: AbortSignal,
): Promise<CowriterNote | null> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model },
    buildNoteMessages(input),
    {
      label: `${input.reactor.name} is reading it as a writer`,
      params: noteSamplers(cfg.base),
      reader: cfg.params,
      budget: NOTE_TOKENS,
      signal,
    },
  );
  const parsed = parseAnswer(reply, input.reactor.name);
  return parsed ? { ...parsed, targetId: input.targetId } : null;
};

/* ------------------------------------------------------------------ */
/* Editor's view — the change they would actually make                 */
/* ------------------------------------------------------------------ */

/**
 * A note says what is wrong. This shows what they would do about it.
 *
 * ── Why this is separate from a note ───────────────────────────────────────
 *
 * A note is advice and belongs in a bubble. This is a REWRITE of a specific
 * span, which means it has to be judged rather than read — before against
 * after, how much moved, and a decision. That is the proposal rail the Lens
 * already runs on, so this produces the same shape and the reader accepts it
 * the same way, into the same override layer. Nothing here writes.
 *
 * Scoped to the SPAN and not the passage on purpose. A model asked to improve
 * a paragraph returns a different paragraph, and a diff of a different
 * paragraph is unreadable — there is nothing to judge, only something to accept
 * or reject wholesale. Asked to change eleven words, it changes eleven words.
 */
export interface EditInput {
  reactor: Reactor;
  /** The passage the span sits in, so the change fits its surroundings. */
  passage: string;
  /** The exact words the reader selected. */
  span: string;
  targetId: string;
  history: HistoryMessage[];
  userName?: string;
  pins?: string[];
  /** What the reader asked for, when they asked for something specific. */
  instruction?: string;
}

export interface SpanEdit {
  /** The span, revised. */
  revised: string;
  /** One line on what they changed and why. */
  why: string;
}

export const editSystem = (r: Reactor, userName?: string): string => [
  `You are ${r.name}, helping write this.`,
  '',
  'The author has pointed at some words and asked what you would do with them.',
  userName ? `They are the AUTHOR, not ${userName} — not anyone in the story.` : '',
  '',
  'ANSWER IN EXACTLY THIS SHAPE, and nothing else:',
  '<the revised words>',
  '[WHY: one short line]',
  '',
  'RULES:',
  '1. Rewrite ONLY the words they pointed at. Not the sentence around them, not',
  '   the paragraph. What you return replaces exactly that span, so it has to',
  '   read correctly where it sits — the same tense, the same speaker, joining',
  '   the words on either side of it.',
  '2. Keep it close to the same length. A span that triples is a different',
  '   passage wearing the same selection.',
  '3. Change something. If the words are already right, say so in the WHY line',
  '   and return them UNCHANGED rather than moving them around to look busy.',
  '4. Their voice, not yours. You are editing their story, and an edit that',
  '   makes every author sound like you is not an edit, it is a takeover.',
  '5. No commentary, no options, no "here is a suggestion". The revised words',
  '   first, the WHY line last, nothing else at all.',
].filter(Boolean).join('\n');

export const buildEditMessages = (input: EditInput): ChatMsg[] => {
  const who = [input.reactor.dossier, cardToPromptBlock(input.reactor.card)]
    .filter(Boolean).join('\n\n');
  const setup = [
    'THE PASSAGE THIS SITS IN:',
    '"""',
    input.passage,
    '"""',
    '',
    'THE WORDS THEY POINTED AT — replace exactly these:',
    '"""',
    input.span,
    '"""',
    input.instruction ? `\nWHAT THEY ASKED FOR: ${input.instruction}` : '',
    input.pins?.length
      ? '\nWHAT THEY HAVE KEPT BESIDE THIS STORY:\n' + input.pins.map(p => `  ${p}`).join('\n')
      : '',
    '',
    'The revised words, then the WHY line.',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: [editSystem(input.reactor, input.userName), who].filter(Boolean).join('\n\n') },
    { role: 'user', content: setup },
  ];
};

/**
 * Pull the revision and the reason apart.
 *
 * The WHY line is the last thing, so everything before it is the revision —
 * which also means a model that forgets the line costs the reason and not the
 * edit. Fenced blocks are unwrapped: several models return prose in a code
 * fence when told to return prose and nothing else.
 */
export const parseEdit = (raw: string): SpanEdit | null => {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const m = text.match(/\[WHY:\s*([^\]]*)\]/i);
  const why = m?.[1]?.trim() ?? '';
  let revised = (m ? text.slice(0, m.index).trim() : text).trim();
  const fence = revised.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) revised = fence[1].trim();
  // Quotes wrapped around the whole thing are the model quoting the span back,
  // not the author's punctuation — but only strip a matched pair that encloses
  // everything, or a line that IS dialogue loses its quotes.
  if (/^"[^"]*"$/.test(revised)) revised = revised.slice(1, -1);
  return revised ? { revised, why } : null;
};

export const editSpan = async (
  input: EditInput, cfg: NoteConfig, signal?: AbortSignal,
): Promise<SpanEdit | null> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model },
    buildEditMessages(input),
    {
      label: `${input.reactor.name} is looking at those words`,
      params: noteSamplers(cfg.base),
      reader: cfg.params,
      // Room for the span and a line about it; a span is short by construction.
      budget: Math.min(700, Math.ceil(input.span.length / 2) + 220),
      signal,
    },
  );
  return parseEdit(reply);
};
