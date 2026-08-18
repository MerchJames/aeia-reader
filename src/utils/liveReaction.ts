/**
 * Live Reaction — reading with someone.
 *
 * Ask Character inverted: instead of you asking and them answering, they speak
 * and you read. Same anchor, same clamp, same cast (visitors included), and the
 * same standing rule — the AI is summoned at an anchor, produces something that
 * belongs to that anchor, and goes away.
 *
 * ─── Two passes, and the first one does not speak ───
 *
 * The obvious build is "call the model on some beats", and it is wrong twice
 * over: 400 beats is 400 calls, and a reaction produced at the END of a passage
 * arrives like a review rather than like a person. So the model is asked to do
 * the marking FIRST:
 *
 *   1. the SCOUT reads a passage and returns the moments this particular person
 *      would break in on — verbatim substrings, no dialogue. Cached per
 *      (message, reactor); a re-read costs nothing.
 *   2. the REACTION fires when the reveal crosses one of those moments. One or
 *      two lines, in their voice, mid-sentence, where a person would actually
 *      say it.
 *
 * That split is also what makes the voice possible: a scout that had to invent
 * the line as well as find the moment does neither well.
 *
 * ─── What they are allowed to know ───
 *
 * Two clamps, and they are not the same clamp.
 *
 * BETWEEN messages: `clampHistory` from `askCharacter`, at the beat, failing
 * closed. An interview is something you choose to ask; a reaction arrives
 * unbidden, so a spoiler lands without you having invited it.
 *
 * WITHIN the message: `visibleText`. The scout necessarily reads a passage
 * before the reader reaches it — that is what makes it a scout — but the
 * reaction is generated against a window. At `upTo` (the default) they see only
 * what you have uncovered and genuinely do not know how the sentence ends,
 * which IS the "watching it with you" frame rather than a decoration on it. At
 * `whole` they have read ahead, and the reaction is knowing.
 *
 * ─── Reader-only by construction ───
 *
 * Nothing here is canon. It never reaches the Lens, an export, the Multiverse
 * graph, or any context assembled for the Director, the summarizer or the
 * assistant — enforced the way Ask Character enforces it, by not wiring it
 * anywhere. This is the one feature in the app that could quietly become a
 * companion chat, and that boundary is the whole reason it can be built.
 */

import { ChatMsg, SamplerParams, chatCompletion, isLocalBase, mergeSamplers } from './aiClient';
import { cardToPromptBlock } from './cardContext';
import {
  HISTORY_BUDGET, HistoryMessage, clampHistory, historyBlock, parseAnswer, type ParsedAnswer,
} from './askCharacter';
import { stripReasoning } from './sceneDirector';
import type { CardInfo } from '../types';

/** How much of the passage the reactor is shown when they speak. */
export type ReactionVisibility = 'upTo' | 'whole';

/** A moment the reactor would break in on — a verbatim substring, no dialogue. */
export interface ReactionCue {
  text: string;
  /** The scout's one-line reason. Never shown to the reactor: it would answer
   *  the question for them, and the line comes back flat. Shown to the READER,
   *  who is entitled to know why their companion is about to interrupt. */
  why?: string;
}

/** A cue resolved to offsets in the text on screen. */
export interface ReactionPoint extends ReactionCue {
  id: string;
  start: number;
  end: number;
}

/** Who is watching with you. A cast member, a visitor, or an uploaded card. */
export interface Reactor {
  name: string;
  /** Their card, when there is one — their author wrote it; a summary is second-hand. */
  card?: CardInfo;
  /** A visitor's dossier block, when the reactor came from another story. */
  dossier?: string;
  /** Reading over your shoulder, or on the other end of a call. */
  frame?: 'room' | 'phone';
}

/**
 * The story BEFORE the passage being read — everything up to the anchor and not
 * the anchor itself.
 *
 * `clampHistory` is right for an interview and wrong here, and the difference
 * is the whole feature. An interview is asked AFTER you have read the beat, so
 * the beat belongs in what the character knows. A reaction happens DURING it —
 * and `clampHistory` includes the anchored message in full, however long it is,
 * which handed the reactor the end of the very sentence they were reacting to
 * while `visibleText` was carefully withholding it. The spoiler came in through
 * the back door, in the block labelled "everything you know".
 *
 * So: prior beats here, and the current passage ONLY through the visibility
 * window. Fails closed exactly as `clampHistory` does — an anchor that is not
 * in the list yields nothing rather than everything.
 */
export const historyBefore = (
  messages: HistoryMessage[], anchorId: string, budget = HISTORY_BUDGET,
): HistoryMessage[] => {
  const upto = clampHistory(messages, anchorId, budget);
  if (!upto.length) return [];
  return upto[upto.length - 1].id === anchorId ? upto.slice(0, -1) : upto;
};

/* ------------------------------------------------------------------ */
/* Pass 1 — the scout                                                  */
/* ------------------------------------------------------------------ */

/** At most this many moments per passage. A companion who talks over every
 *  line is not a companion, and the reader cannot turn down the volume. */
export const MAX_CUES = 3;
/** A moment is a phrase, not a paragraph — see `cleanCues`. */
export const MAX_CUE_CHARS = 140;

export const scoutSystem = (name: string): string => [
  `You are choosing when ${name} would speak.`,
  '',
  'A reader is about to read a passage one word at a time, with',
  `${name} beside them — watching it with them, the way you watch a film with`,
  'someone who cannot keep quiet. Your ONLY job right now is to say WHERE they',
  'would break in. You are not writing what they say. Do not write dialogue.',
  '',
  'Return JSON and nothing else:',
  '[ { "text": <verbatim substring of the passage>, "why": <a few words> } ]',
  '',
  'RULES:',
  `1. "text" MUST be copied EXACTLY from the passage — the same characters, in`,
  '   the same order. A paraphrase is useless: the reader\'s screen is matched',
  '   against it character by character and anything invented is discarded.',
  '2. Mark the moment they would react TO — the few words that land, the turn,',
  '   the thing that stops you. Not a whole sentence, and never a paragraph.',
  `3. At most ${MAX_CUES}, and fewer is better. Most passages earn ONE. A quiet`,
  '   passage earns none: return [] and let them read it in silence. Someone who',
  '   comments on everything is someone you stop listening to.',
  `4. Choose what THIS person would react to, not what anyone would. ${name}`,
  '   notices what they care about and misses what they do not — a fighter and a',
  '   physician stop at different words in the same sentence.',
  '5. Never mark the very first words of the passage. There is nothing to react',
  '   to yet.',
].join('\n');

export interface ScoutInput {
  reactor: Reactor;
  /** The passage as the READER will see it (processed, not raw). */
  passage: string;
  /** The story so far, already clamped by the caller at this beat. */
  history: HistoryMessage[];
  userName?: string;
  /** The Director's read of this beat, when there is one. */
  mood?: string;
}

export const buildScoutMessages = (input: ScoutInput): ChatMsg[] => {
  const who = [input.reactor.dossier, cardToPromptBlock(input.reactor.card)]
    .filter(Boolean).join('\n\n');
  const setup = [
    'WHAT THEY HAVE SEEN SO FAR (they know this and nothing after it):',
    '"""',
    historyBlock(input.history, input.userName) || '(nothing yet — this is the opening)',
    '"""',
    '',
    'THE PASSAGE THEY ARE ABOUT TO READ WITH YOU:',
    '"""',
    input.passage,
    '"""',
    input.mood ? `\nThis beat reads as: ${input.mood}` : '',
    '',
    `Where would ${input.reactor.name} break in? JSON only.`,
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: [scoutSystem(input.reactor.name), who].filter(Boolean).join('\n\n') },
    { role: 'user', content: setup },
  ];
};

/** The first JSON array in a reply, tolerating fences and preamble. */
const firstArray = (raw: string): unknown => {
  const s = stripReasoning(raw ?? '');
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
};

/**
 * Keep only cues that name a real, short span of the passage.
 *
 * Verbatim-only for the same reason the Director's cues are: the reveal is
 * matched against these offsets character by character, so a paraphrase does
 * not fire late — it never fires at all, silently. Better to drop it here,
 * where a test can see it.
 */
export const parseScoutCues = (raw: string, passage: string): ReactionCue[] => {
  const arr = firstArray(raw);
  if (!Array.isArray(arr)) return [];
  const hay = passage.toLowerCase();
  const out: ReactionCue[] = [];
  const seen = new Set<string>();
  for (const c of arr) {
    const text = typeof (c as ReactionCue)?.text === 'string' ? (c as ReactionCue).text.trim() : '';
    if (text.length < 3 || text.length > MAX_CUE_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key) || !hay.includes(key)) continue;
    seen.add(key);
    const why = typeof (c as ReactionCue)?.why === 'string'
      ? (c as ReactionCue).why!.trim().slice(0, 120) : undefined;
    out.push(why ? { text, why } : { text });
    if (out.length >= MAX_CUES) break;
  }
  return out;
};

/**
 * Cues → offsets in the text on screen, in reading order and never overlapping.
 *
 * Overlap matters more here than it does for a performance cue: two reactions
 * firing on the same words is one companion talking over themselves.
 */
export const resolveReactionPoints = (
  text: string, cues: ReactionCue[] | undefined,
): ReactionPoint[] => {
  if (!cues?.length || !text) return [];
  const hay = text.toLowerCase();
  const taken: ReactionPoint[] = [];
  for (const c of cues) {
    const needle = c.text.trim().toLowerCase();
    if (needle.length < 3) continue;
    // Walk forward past anything already claimed, so a repeated phrase resolves
    // to its next free occurrence rather than colliding on the first.
    let i = hay.indexOf(needle);
    while (i >= 0 && taken.some(t => i < t.end && i + needle.length > t.start)) {
      i = hay.indexOf(needle, i + 1);
    }
    if (i < 0) continue;
    taken.push({ ...c, id: `rx-${i}-${needle.length}`, start: i, end: i + needle.length });
  }
  return taken.sort((a, b) => a.start - b.start);
};

/** The first point the reveal has reached but not yet spoken for. */
export const pointAt = (
  points: ReactionPoint[], revealed: number, spoken: ReadonlySet<string>,
): ReactionPoint | undefined =>
  points.find(p => revealed >= p.end && !spoken.has(p.id));

/* ------------------------------------------------------------------ */
/* Pass 2 — the reaction                                               */
/* ------------------------------------------------------------------ */

/**
 * How much of the passage they can see when they speak.
 *
 * `upTo` is the default and the point of the feature: they are watching it with
 * you, so they see what you have uncovered and no more. Cutting at the END of
 * the cue and not at the reveal cursor is deliberate — the words they are
 * reacting to have to be in front of them, and the reader is at most a few
 * characters further on.
 */
export const visibleText = (
  full: string, cueEnd: number, mode: ReactionVisibility = 'upTo',
): string => (mode === 'whole' ? full : full.slice(0, Math.max(0, Math.min(cueEnd, full.length))));

export const reactionSystem = (r: Reactor, userName?: string): string => {
  const phone = r.frame === 'phone';
  return [
    `You are ${r.name}.`,
    '',
    phone
      ? 'You are on the phone with a READER who is reading a story to you as they'
        + ' go. You cannot see the page. You are hearing it unfold.'
      : 'You are sitting with a READER who is reading a story, and you are reading'
        + ' it over their shoulder, at their pace, one line at a time.',
    '',
    'WHO YOU ARE WITH — get this right or the whole thing collapses:',
    'The reader is NOT in the story. They are not a character, they have never met',
    'you, and nothing they say happens in the world of the story.',
    userName
      ? `In particular they are NOT ${userName}. ${userName} is a person in the story;`
        + ' the reader has only watched them.'
      : 'Never mistake the reader for anyone in the story.',
    '',
    'HOW TO REACT:',
    '1. ONE or TWO short lines. This is a noise you make at a screen, not a',
    '   speech. "Oh my god." "No. No, don\'t." "…I knew it." A single word is a',
    '   perfectly good reaction.',
    '2. React to the moment quoted below — the bit that just landed. Not the',
    '   whole passage, not the story, not what it all means.',
    '3. You have read exactly as far as the text below and NOT ONE WORD further.',
    '   You do not know what happens next. Guessing at it is the one thing that',
    '   ruins this — if you want to guess, guess out loud and be WRONG, the way a',
    '   person does.',
    '4. You are a person watching a story, not a critic and not a narrator. Do not',
    '   summarise, do not analyse, do not tell the reader what to feel, and never',
    '   continue the story yourself.',
    '5. Sound like yourself. Someone who swears, swears; someone who goes quiet,',
    '   goes quiet.',
    '',
    'End your reply with one line naming how you feel right now:',
    '[FEELING: one word]',
  ].filter(Boolean).join('\n');
};

export interface ReactionInput {
  reactor: Reactor;
  /** The story so far, already clamped at this beat by the caller. */
  history: HistoryMessage[];
  /** The passage, cut to what they are allowed to see — see `visibleText`. */
  visible: string;
  /** The words that just landed. */
  moment: string;
  userName?: string;
  /** What they have already said about THIS passage, so they do not repeat it. */
  said?: string[];
  mood?: string;
}

export const buildReactionMessages = (input: ReactionInput): ChatMsg[] => {
  const who = [input.reactor.dossier, cardToPromptBlock(input.reactor.card)]
    .filter(Boolean).join('\n\n');
  const setup = [
    'THE STORY SO FAR (everything you know — nothing after this has happened):',
    '"""',
    historyBlock(input.history, input.userName) || '(nothing yet — this is the opening)',
    '"""',
    '',
    'WHAT IS ON THE PAGE RIGHT NOW — you have read exactly this much:',
    '"""',
    input.visible,
    '"""',
    '',
    'THE WORDS THAT JUST LANDED:',
    '"""',
    input.moment,
    '"""',
    input.mood ? `\nThis beat reads as: ${input.mood}` : '',
    input.said?.length
      ? '\nYou have already said, in this same passage:\n'
        + input.said.map(s => `  "${s}"`).join('\n')
        + '\nDo not repeat yourself. If you have nothing new, say something short.'
      : '',
    '',
    'React. One or two lines.',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: [reactionSystem(input.reactor, input.userName), who].filter(Boolean).join('\n\n') },
    { role: 'user', content: setup },
  ];
};

/**
 * A VOICE task, so it varies — the same beat twice must not produce the same
 * sentence. Mirrors `askSamplers`, but hotter and shorter: a reaction that
 * reads as considered is not a reaction.
 */
export const reactionSamplers = (base: string): SamplerParams => ({
  temperature: 0.95, top_p: 0.95, frequency_penalty: 0.35, presence_penalty: 0.1,
  ...(isLocalBase(base) ? { min_p: 0.05, repetition_penalty: 1.08 } : {}),
});

/** One or two lines. The ceiling is a guard, not a target. */
export const REACTION_TOKENS = 160;
/** The scout returns three short strings; it needs nothing like the same room.
 *  Reasoning models get headroom the same way the Director does. */
export const scoutTokens = (reasoning = false): number => 400 + (reasoning ? 4000 : 0);

export interface ReactionConfig {
  base: string;
  key: string;
  model: string;
  params?: SamplerParams;
}

/** Pass 1. Returns [] rather than throwing — a scout that fails is silence. */
export const scoutPassage = async (
  input: ScoutInput, cfg: ReactionConfig, signal?: AbortSignal,
): Promise<ReactionCue[]> => {
  const reply = await chatCompletion(
    cfg.base, cfg.key, cfg.model, buildScoutMessages(input),
    mergeSamplers({ temperature: 0.4, top_p: 0.9, max_tokens: scoutTokens(true) }, cfg.params),
    signal,
  );
  return parseScoutCues(reply, input.passage);
};

/** Pass 2. Null when nothing usable came back. */
export const reactAt = async (
  input: ReactionInput, cfg: ReactionConfig, signal?: AbortSignal,
): Promise<ParsedAnswer | null> => {
  const reply = await chatCompletion(
    cfg.base, cfg.key, cfg.model, buildReactionMessages(input),
    mergeSamplers({ ...reactionSamplers(cfg.base), max_tokens: REACTION_TOKENS }, cfg.params),
    signal,
  );
  return parseAnswer(reply, input.reactor.name);
};
