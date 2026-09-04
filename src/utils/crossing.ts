/**
 * A line drawn between two stories.
 *
 * ── The gap this fills ─────────────────────────────────────────────────────
 *
 * A chat is one character and you. Keep five of them and you have five worlds
 * that never touch, even though they are obviously the same world in your head:
 * the innkeeper in one could plainly have met the courier in another, two of
 * them are about the same siege from different rooms, and a third contradicts
 * both. Nothing in the app has ever been able to say so.
 *
 * A crossing says so. It is a link between one message in one story and one
 * message in another, with a reason attached — and, because the reason is the
 * interesting part, a conversation about it.
 *
 * ── What it deliberately is not ────────────────────────────────────────────
 *
 * It is **not a merge**. Nothing is copied between stories, no transcript
 * moves, and neither story is modified by being crossed. `Throughline` already
 * carries what travels between stories, under the reader's eye, one brief at a
 * time; a crossing is a lighter thing than that — an observation, held outside
 * both stories, that can be deleted without either of them noticing.
 *
 * That is why crossings live in their own global slice rather than on either
 * story: filing one under story A would make it invisible from B, and filing it
 * under both would make deletion a two-sided problem with a wrong answer.
 *
 * Pure: no store, no React, no fetch.
 */

import { CardInfo } from '../types';
import { ChatMsg } from './aiClient';
import { cardToPromptBlock } from './cardContext';

/** One end of a crossing: a specific message in a specific story. */
export interface CrossPoint {
  storyId: string;
  /** Denormalised so a crossing still reads after the story is closed or gone. */
  storyTitle: string;
  messageId: string;
  /** 1-based reading position, for showing where in the story this is. */
  index: number;
  /** Speaker. */
  name: string;
  /** A short quote — enough to recognise the moment without opening it. */
  excerpt: string;
}

/**
 * What kind of observation this is.
 *
 * A closed list rather than free text, because the kind is what the AI
 * discussion is *for* — "these two contradict each other" and "this is where
 * she could walk in" want completely different conversations, and a model given
 * "related" produces the same shapeless paragraph for both.
 */
export type CrossingKind = 'introduce' | 'parallel' | 'contrast' | 'shared' | 'echo';

export interface CrossingKindDef {
  kind: CrossingKind;
  label: string;
  /** Shown under the label when the reader is choosing. */
  hint: string;
  /** The question the AI is actually asked. This is the whole of the feature. */
  ask: string;
}

export const CROSSING_KINDS: readonly CrossingKindDef[] = [
  {
    kind: 'introduce',
    label: 'Bring them in',
    hint: 'One story\'s character walks into the other, here.',
    ask:
      'How would the character from A be introduced into B at this exact moment? '
      + 'Give two or three concrete ways in, each one sentence of setup and one of '
      + 'what changes because of it. Say plainly which of B\'s existing threads each '
      + 'one would disturb, and which it would leave alone.',
  },
  {
    kind: 'parallel',
    label: 'Same thing, twice',
    hint: 'These two beats are doing the same work in different stories.',
    ask:
      'What are these two moments both doing? Name the shared shape in one line, '
      + 'then say what each version has that the other lacks — not which is better, '
      + 'what is different in kind. Finish with the one thing the weaker of the two '
      + 'could take from the stronger without becoming a copy of it.',
  },
  {
    kind: 'contrast',
    label: 'These disagree',
    hint: 'The two stories say incompatible things.',
    ask:
      'What exactly is incompatible between these two? State the contradiction as '
      + 'plainly as you can, in one or two lines. Then give the ways it could be '
      + 'reconciled — including "they are simply different worlds" if that is the '
      + 'honest answer — and say what each reconciliation would cost.',
  },
  {
    kind: 'shared',
    label: 'Same world',
    hint: 'A place, an object, an event both stories touch.',
    ask:
      'What do these two moments share — a place, an object, an event, a rumour? '
      + 'Establish what is definitely the same and what only appears to be. Then '
      + 'describe what each story knows about it that the other does not, and what '
      + 'follows if both are true at once.',
  },
  {
    kind: 'echo',
    label: 'An echo',
    hint: 'A phrase, an image or a beat that repeats across both.',
    ask:
      'What is echoing between these two passages — an image, a phrase, a gesture, '
      + 'a rhythm? Point at the specific words. Then say whether the echo is worth '
      + 'strengthening or worth breaking, and what one change would do it.',
  },
];

export const kindDef = (kind: CrossingKind): CrossingKindDef =>
  CROSSING_KINDS.find(k => k.kind === kind) ?? CROSSING_KINDS[0];

export interface Crossing {
  id: string;
  a: CrossPoint;
  b: CrossPoint;
  kind: CrossingKind;
  /** The reader's own words about why these two are connected. */
  note?: string;
  createdAt: number;
}

/** How much of a message a crossing keeps as its recognisable excerpt. */
export const EXCERPT_CHARS = 220;

export const excerptOf = (content: string): string => {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
};

let seq = 0;
export const crossingId = (): string => `cx${Date.now().toString(36)}${(seq++).toString(36)}`;

export const makeCrossing = (
  a: CrossPoint, b: CrossPoint, kind: CrossingKind = 'introduce', note?: string,
): Crossing => ({
  id: crossingId(),
  // Stored in a stable order so that A→B and B→A are the same crossing, which
  // is what makes `isDuplicate` able to see one.
  ...(a.storyId <= b.storyId ? { a, b } : { a: b, b: a }),
  kind,
  note,
  createdAt: Date.now(),
});

/**
 * Why this pair cannot be crossed, or null.
 *
 * The same-story rule is the one that matters. Two points in one story already
 * have a relationship — the story between them — and the whole value of a
 * crossing is that it spans two things which otherwise never meet. Allowing it
 * would turn the board into a second, worse annotation layer over one chat.
 */
export const crossingProblem = (a: CrossPoint, b: CrossPoint): string | null => {
  if (a.storyId === b.storyId) {
    return 'Both ends are in the same story. A crossing links two different stories — '
      + 'inside one, the story itself is already the link.';
  }
  if (!a.messageId || !b.messageId) return 'Both ends need a message.';
  return null;
};

/** True when this pair is already crossed, whichever way round it was drawn. */
export const isDuplicate = (list: readonly Crossing[], a: CrossPoint, b: CrossPoint): boolean =>
  list.some(c =>
    (c.a.messageId === a.messageId && c.b.messageId === b.messageId)
    || (c.a.messageId === b.messageId && c.b.messageId === a.messageId));

/** Add one, refusing a duplicate rather than stacking it. */
export const addCrossing = (list: readonly Crossing[], next: Crossing): Crossing[] =>
  isDuplicate(list, next.a, next.b) ? [...list] : [...list, next];

export const removeCrossing = (list: readonly Crossing[], id: string): Crossing[] =>
  list.filter(c => c.id !== id);

export const updateCrossing = (
  list: readonly Crossing[], id: string, patch: Partial<Omit<Crossing, 'id'>>,
): Crossing[] => list.map(c => (c.id === id ? { ...c, ...patch } : c));

/** Every crossing touching a story, either end. */
export const crossingsFor = (list: readonly Crossing[], storyId: string): Crossing[] =>
  list.filter(c => c.a.storyId === storyId || c.b.storyId === storyId);

/** Every crossing between exactly these two stories. */
export const crossingsBetween = (
  list: readonly Crossing[], one: string, two: string,
): Crossing[] => list.filter(c =>
  (c.a.storyId === one && c.b.storyId === two) || (c.a.storyId === two && c.b.storyId === one));

/** The end of a crossing that is NOT in this story — "what it connects to". */
export const otherEnd = (crossing: Crossing, storyId: string): CrossPoint =>
  (crossing.a.storyId === storyId ? crossing.b : crossing.a);

/**
 * Which stories are worth putting on the board.
 *
 * Ordered by how connected they already are, so opening the board a second time
 * shows the work rather than the library. Ties break on title for stability —
 * a board whose columns reshuffle on every open is a board nobody trusts.
 */
export const suggestedStories = (
  list: readonly Crossing[],
  stories: readonly { id: string; title: string }[],
): { id: string; title: string; crossings: number }[] =>
  stories
    .map(s => ({ ...s, crossings: crossingsFor(list, s.id).length }))
    .sort((x, y) => y.crossings - x.crossings || x.title.localeCompare(y.title));

/** One line for a list row. */
export const crossingSummary = (c: Crossing): string =>
  `${kindDef(c.kind).label}: ${c.a.storyTitle} #${c.a.index} ↔ ${c.b.storyTitle} #${c.b.index}`;

/* ------------------------------------------------------------------ */
/* Talking about one                                                   */
/* ------------------------------------------------------------------ */

export interface CrossingPromptInput {
  crossing: Crossing;
  /** Fuller context around each end, when the caller can supply it. */
  aContext?: string;
  bContext?: string;
  aCard?: CardInfo;
  bCard?: CardInfo;
  /** The reader's own question, if they asked one instead of using the kind's. */
  question?: string;
}

/**
 * The request that discusses one crossing.
 *
 * Two rules encoded here, both learned the hard way elsewhere in this app:
 *
 * **The two stories are labelled and kept apart.** A model handed two passages
 * with no frame will blend them into one and answer about the blend — which
 * reads plausible and is useless, because the entire question is what happens
 * at the boundary. A and B are named, in that order, every time.
 *
 * **It is told these are separate chats.** Otherwise it assumes a continuity
 * that is not there and quietly invents the connective tissue the reader is
 * asking it to help design.
 */
export const buildCrossingMessages = (input: CrossingPromptInput): ChatMsg[] => {
  const { crossing: c } = input;
  const def = kindDef(c.kind);
  const cardA = cardToPromptBlock(input.aCard);
  const cardB = cardToPromptBlock(input.bCard);

  const system = [
    'You are helping a writer who keeps several separate roleplay chats and is looking',
    'at two moments from two DIFFERENT ones, side by side.',
    '',
    'These are separate stories. They share no continuity unless the writer says so —',
    'do not assume events, characters or places carry over, and never write as though',
    'the two are already one story.',
    '',
    'Answer about the SPECIFIC passages given. Concrete over general: name the people,',
    'quote the words, point at the beat. No preamble, no summary of what you were',
    'shown, no offer to continue.',
  ].join('\n');

  const side = (label: string, p: CrossPoint, context?: string, card?: string) => [
    `--- ${label}: "${p.storyTitle}", message ${p.index}, ${p.name} ---`,
    card ? `${card}\n` : '',
    context?.trim() || p.excerpt,
  ].filter(Boolean).join('\n');

  const user = [
    side('STORY A', c.a, input.aContext, cardA),
    '',
    side('STORY B', c.b, input.bContext, cardB),
    '',
    c.note ? `THE WRITER'S NOTE ON WHY THESE ARE CONNECTED:\n${c.note}\n` : '',
    'THE QUESTION:',
    input.question?.trim() || def.ask,
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

/** What the turn is labelled in the chat thread. */
export const crossingScopeLabel = (c: Crossing): string =>
  `⤫ ${kindDef(c.kind).label} — ${c.a.storyTitle} ↔ ${c.b.storyTitle}`;
