/**
 * Cross-character: bringing someone in from another chat.
 *
 * The idea is that a character you have developed across fifty messages in one
 * story can walk into another one, and the host reacts to them properly. The
 * obvious implementation — paste the visitor's transcript into the host's
 * context — is the wrong one, in three separate ways:
 *
 *  1. It blows the budget. Fifty messages is most of a context window spent on
 *     a story that is not the one being read.
 *  2. The host starts quoting the visitor's chat verbatim, because that is what
 *     is in front of it.
 *  3. Worst: the model manufactures a shared history. Nothing in a transcript
 *     says these two have never met, so it assumes they have, and invents the
 *     time they did. That is not a hallucination you can prompt away, because
 *     the absence is not IN the payload.
 *
 * So a visitor is a DOSSIER: a short, structured, frozen brief, generated once
 * from the visitor's own chat at an anchor, and — this is the part that does
 * the work — **shown to the reader and editable before it is ever used**. The
 * hallucination control is a person looking at the payload, not a cleverer
 * prompt. Whatever is wrong in it, you fix, once, and it stays fixed.
 *
 * The negative space is explicit. `WHAT THEY DO NOT KNOW` and a flat statement
 * about whether the two have met are the two lines that stop the host inventing
 * a relationship, and they are asserted by tests for that reason.
 *
 * The spoiler clamp comes free: `clampHistory` from `askCharacter` already
 * refuses to look past an anchor and fails closed on an unknown one, so a
 * dossier is always "them, as of message N of their story", never "them, having
 * read their own ending".
 *
 * Pure except for the injected completion.
 */

import type { CardInfo, Chain, Message } from '../types';
import { ChatMsg } from './aiClient';
import { cardToPromptBlock } from './cardContext';
import { clampHistory, historyBlock, type AskTurn, type HistoryMessage } from './askCharacter';

/** The sections a dossier is made of, in the order they are rendered. */
export const DOSSIER_FIELDS = [
  'who', 'where', 'wants', 'fears', 'knows', 'doesNotKnow', 'voice',
] as const;
export type DossierField = (typeof DOSSIER_FIELDS)[number];

export const FIELD_LABEL: Record<DossierField, string> = {
  who: 'WHO THEY ARE',
  where: 'WHERE THEY ARE IN THEIR OWN STORY',
  wants: 'WHAT THEY WANT',
  fears: 'WHAT THEY FEAR',
  knows: 'WHAT THEY KNOW',
  doesNotKnow: 'WHAT THEY DO NOT KNOW',
  voice: 'HOW THEY TALK',
};

export interface Visitor {
  id: string;
  /** The character being brought in. */
  name: string;
  /** Where they came from, so the reader can find it again. */
  sourceStoryId: string;
  sourceStoryTitle: string;
  /** The beat in THEIR story this is a snapshot of. */
  anchorMessageId: string;
  /** 1-based position of that beat, for "as of message 56". */
  anchorBeat: number;
  fields: Record<DossierField, string>;
  /** Verbatim lines, so the host can hear them rather than be told about them. */
  quotes: string[];
  /**
   * Have the visitor and the host met? Almost always no — and saying so
   * outright is the single most load-bearing line in the payload.
   */
  met: boolean;
  /** Reader's own note, appended verbatim. The escape hatch for everything. */
  note?: string;
  /**
   * How they come into the host story — "she walks in out of the rain and does
   * not sit down". Kept on the visitor, not typed per turn: an entrance that
   * changes every time is not an entrance, it is a new character.
   */
  entrance?: string;
  /** Send their character card alongside the brief when they speak. On by
   *  default — a seven-line brief is not a personality. */
  useCard?: boolean;
  /** Off by default after editing? No — a visitor is active once added. */
  active: boolean;
  createdAt: number;
  /** True once the reader has changed anything, so the UI can stop nagging. */
  edited?: boolean;
}

export const emptyFields = (): Record<DossierField, string> =>
  Object.fromEntries(DOSSIER_FIELDS.map(f => [f, ''])) as Record<DossierField, string>;

/* ------------------------------------------------------------------ */
/* Generating one                                                      */
/* ------------------------------------------------------------------ */

/**
 * How much of the visitor's story the brief is written from.
 *
 * Generous, because this runs ONCE per visitor and the result is a few hundred
 * tokens either way — being stingy here buys nothing and costs the fidelity
 * that makes the character recognisable.
 */
export const VISITOR_BUDGET = 24_000;

export interface DossierInput {
  characterName: string;
  storyTitle: string;
  userName?: string;
  card?: CardInfo;
  /** The visitor's own messages, flat and in order. */
  messages: HistoryMessage[];
  anchorMessageId: string;
  /** Who they are about to meet, so the brief is written for that meeting. */
  hostName?: string;
}

export const buildDossierMessages = (input: DossierInput): ChatMsg[] => {
  const clamped = clampHistory(input.messages, input.anchorMessageId, VISITOR_BUDGET);
  const card = cardToPromptBlock(input.card);

  const system = [
    'You write a short factual brief about one character, to be handed to a',
    'DIFFERENT story so that story can react to them correctly.',
    '',
    'Answer with exactly these labelled lines and nothing else:',
    'WHO: <two sentences — who they are, how they carry themselves>',
    'WHERE: <one sentence — their situation at this point in their own story>',
    'WANTS: <one sentence>',
    'FEARS: <one sentence>',
    'KNOWS: <the facts they could act on, semicolon-separated>',
    'DOESNOTKNOW: <what they have NOT learned, semicolon-separated>',
    'VOICE: <how they speak — sentence length, vocabulary, what they do instead',
    '  of answering, any verbal habit. Be specific enough to imitate.>',
    'QUOTE: <a verbatim line of theirs from the transcript>',
    '  …repeat QUOTE up to six times, choosing lines from DIFFERENT points in',
    '  the story and favouring ones that show how they talk rather than what',
    '  happened.',
    '',
    'RULES:',
    '- Use ONLY the transcript and the card below. Invent nothing.',
    '- DOESNOTKNOW is the most important line. It is what stops the receiving',
    '  story from assuming a shared history. If they have not left their own',
    '  town, say so. Never write "nothing" — there is always something.',
    '- The QUOTE lines must be copied word for word from the transcript.',
    '- Write about them in the third person. Do not speak as them.',
  ].join('\n');

  const user = [
    `Character: ${input.characterName}`,
    `From the story: "${input.storyTitle}"`,
    input.hostName ? `They are about to appear in a different story, alongside: ${input.hostName}.` : '',
    card ? `\n${card}` : '',
    '',
    clamped.length
      ? `--- THEIR STORY, UP TO THIS POINT ---\n${historyBlock(clamped, input.userName)}`
      : '--- THEIR STORY ---\n(no transcript available; work from the card alone)',
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

const LINE = /^\s*(WHO|WHERE|WANTS|FEARS|KNOWS|DOESNOTKNOW|DOES NOT KNOW|VOICE|QUOTE)\s*:\s*(.+)$/i;

const KEY_TO_FIELD: Record<string, DossierField> = {
  WHO: 'who',
  WHERE: 'where',
  WANTS: 'wants',
  FEARS: 'fears',
  KNOWS: 'knows',
  DOESNOTKNOW: 'doesNotKnow',
  'DOES NOT KNOW': 'doesNotKnow',
  VOICE: 'voice',
};

/**
 * Read the model's answer into fields.
 *
 * Tolerant on purpose — a model that wraps the answer in a code fence, or
 * bolds the labels, has still answered. What it must not do is silently
 * produce an EMPTY dossier that then goes into a prompt looking authoritative:
 * `parseDossier` reports what it found so the caller can refuse.
 */
export const parseDossier = (raw: string): { fields: Record<DossierField, string>; quotes: string[] } => {
  const fields = emptyFields();
  const quotes: string[] = [];
  const text = raw.replace(/```[a-z]*\n?|```/gi, '');
  for (const line of text.split('\n')) {
    // Bold FIRST, then the bullet: stripping `- ` from `**WHO:**` would eat one
    // asterisk of the pair and leave `*WHO:` behind, which matches nothing.
    const cleaned = line.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/, '');
    const m = LINE.exec(cleaned);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const value = m[2].trim().replace(/^["'“]|["'”]$/g, '').trim();
    if (!value) continue;
    if (key === 'QUOTE') {
      if (quotes.length < 8) quotes.push(value);
      continue;
    }
    const field = KEY_TO_FIELD[key];
    if (field && !fields[field]) fields[field] = value;
  }
  return { fields, quotes };
};

/** Enough of a dossier to be worth showing: who they are and the negative space. */
export const isUsable = (fields: Record<DossierField, string>): boolean =>
  !!fields.who.trim() && !!fields.doesNotKnow.trim();

/* ------------------------------------------------------------------ */
/* Rendering it into a prompt                                          */
/* ------------------------------------------------------------------ */

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/**
 * One visitor as a prompt block.
 *
 * Fenced with a header and footer because the host's own transcript follows,
 * and a brief that bleeds into the story reads as part of it. Every line names
 * the visitor's story explicitly — "from another story" appears twice, on
 * purpose, since the single most common failure is the host treating the
 * visitor as someone it already knows.
 */
export const visitorBlock = (v: Visitor, hostName?: string): string => {
  const lines: string[] = [
    `=== VISITOR: ${v.name} — from another story ("${v.sourceStoryTitle}"), as of their message ${v.anchorBeat} ===`,
  ];
  for (const f of DOSSIER_FIELDS) {
    const value = v.fields[f]?.trim();
    if (value) lines.push(`${FIELD_LABEL[f]}: ${clamp(value, 600)}`);
  }
  if (v.quotes.length) {
    // On their own lines: run together with slashes, a model reads them as one
    // long sentence and imitates none of them.
    lines.push('THINGS THEY HAVE SAID, WORD FOR WORD:');
    for (const q of v.quotes.slice(0, 8)) lines.push(`  "${clamp(q, 300)}"`);
  }
  if (v.note?.trim()) lines.push(`THE READER ADDS: ${clamp(v.note.trim(), 600)}`);
  lines.push(
    v.met
      ? `${v.name} AND ${hostName ?? 'this story’s characters'} HAVE MET BEFORE.`
      : `${v.name} AND ${hostName ?? 'this story’s characters'} HAVE NEVER MET. `
        + 'There is no shared history between them. Do not invent one.',
  );
  lines.push(`=== END VISITOR: ${v.name} ===`);
  return lines.join('\n');
};

/**
 * Every active visitor, as one block for the assistant's system prompt.
 *
 * Joins `cardContext`'s family of block builders (`cardToPromptBlock`,
 * `pinsToPromptBlock`, `sheetsToPromptBlock`) and is assembled the same way.
 */
export const visitorsToPromptBlock = (
  visitors: Visitor[] | undefined,
  hostName?: string,
): string => {
  const active = (visitors ?? []).filter(v => v.active && isUsable(v.fields));
  if (!active.length) return '';
  return [
    '--- VISITING CHARACTERS ---',
    'These people are NOT part of the story text below. They come from other',
    'stories the reader keeps, and are here so this story can react to them.',
    'Everything you know about them is in these briefs — if a brief does not say',
    'it, it did not happen.',
    '',
    ...active.map(v => visitorBlock(v, hostName)),
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* Letting them speak                                                  */
/* ------------------------------------------------------------------ */

/** Default cut of the HOST story, when the caller names no budget of its own. */
export const SCENE_BUDGET = 5000;

export interface VisitorTurnInput {
  visitor: Visitor;
  hostTitle: string;
  hostCharacter?: string;
  hostUser?: string;
  /** The host story, as the reader's chosen CONTEXT SCOPE selected it. */
  scene: HistoryMessage[];
  /** What that scope was, so the model knows what it is and is not seeing. */
  sceneLabel?: string;
  /** How much of it to send. The reader picked a scope; honour it. */
  sceneBudget?: number;
  /**
   * The visitor's own card, when the reader has left it switched on.
   *
   * Their author wrote it; a summary of it is second-hand. The first version
   * of this sent the dossier alone, on the principle that only what the reader
   * can see should travel — and the characters came out generic, because a
   * seven-line brief is not a personality. The card is the fix, and the panel
   * says outright that it is being sent, which keeps the principle intact:
   * nothing travels that the reader has not been told about.
   */
  card?: CardInfo;
  /** Optional steer for this one turn ("have her refuse"). */
  instruction?: string;
}

/**
 * Write one turn AS the visitor.
 *
 * The brief is the authority on what they KNOW — that is what stops a shared
 * history being invented. The card is the authority on how they SOUND. Those
 * are different jobs and the prompt says which is which, because a card that
 * contradicts the brief about events must lose.
 */
export const buildVisitorTurnMessages = (input: VisitorTurnInput): ChatMsg[] => {
  const { visitor: v } = input;
  const brief = visitorBlock(v, input.hostCharacter);
  const card = cardToPromptBlock(input.card);

  const system = [
    `You are ${v.name}. Write ONE turn of story as ${v.name}, in this scene.`,
    '',
    brief,
    card ? `\n${card}\n` : '',
    'RULES:',
    card
      ? `- The card above is how ${v.name} SOUNDS and what they are like. The brief`
        + ' is what they KNOW and where they are. Where the two disagree about'
        + ' events, the brief wins.'
      : `- Everything you know about ${v.name} is in the brief above.`,
    '- Do not invent history, relationships or events that neither states.',
    v.met
      ? ''
      : `- ${v.name} has never met anyone in this scene. Write them as a stranger:`
        + ' no shared past, no familiarity, no names they were never told.',
    `- Write them speaking and behaving as themselves — their own diction,`
    + ' rhythm and habits, not a neutral narrator wearing their name.',
    '- Write only their turn: their actions, their speech, what they notice.',
    `- Do NOT write for ${input.hostCharacter ?? 'the other characters'}`
      + `${input.hostUser ? ` or for ${input.hostUser}` : ''}, and do not narrate their thoughts.`,
    '- Prose, in the tense and person the scene below uses. No headings, no',
    '  commentary, no stage directions about the writing.',
  ].filter(Boolean).join('\n');

  const scene = clampHistory(
    input.scene,
    input.scene[input.scene.length - 1]?.id ?? '',
    input.sceneBudget ?? SCENE_BUDGET,
  );

  // How they arrive. Kept on the visitor rather than typed each time: an
  // entrance that changes every turn is not an entrance, it is a new character.
  const entrance = v.entrance?.trim();

  const user = [
    `The story is "${input.hostTitle}".`,
    input.sceneLabel ? `You are being shown: ${input.sceneLabel}.` : '',
    entrance ? `How ${v.name} comes into it: ${entrance}` : `${v.name} has just arrived in it.`,
    '',
    scene.length
      ? `--- THE SCENE SO FAR ---\n${historyBlock(scene, input.hostUser)}`
      : '--- THE SCENE ---\n(the story has not started yet; open it)',
    '',
    '---',
    input.instruction?.trim()
      ? `Write ${v.name}'s next turn. ${input.instruction.trim()}`
      : `Write ${v.name}'s next turn.`,
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

/* ------------------------------------------------------------------ */
/* Interviewing a visitor — the Ask Character frame                    */
/* ------------------------------------------------------------------ */

export interface VisitorAskInput {
  visitor: Visitor;
  /** Their own card, when the reader has left it switched on. */
  card?: CardInfo;
  hostTitle: string;
  hostCharacter?: string;
  /** What the READER is called in the host story — a person, not the interviewer. */
  hostUser?: string;
  /**
   * The host story up to the anchored beat, already clamped by the caller.
   *
   * Framed as the scene they have WALKED INTO, not as their own memory. That
   * distinction is the whole difference between a visitor and a cast member:
   * the host cast lived through this, the visitor read none of it.
   */
  scene: HistoryMessage[];
  /** The passage the interview is anchored to. */
  anchorText: string;
  /** Prior turns in the interview, oldest first. */
  turns: AskTurn[];
  question: string;
  /** Director's read of the beat, when there is one. */
  mood?: string;
}

/** How many prior interview turns are replayed. Mirrors `askCharacter`. */
const REPLAY = 8;

/**
 * Interview a visiting character.
 *
 * The same frame `askCharacter` uses — out of scene, answering rather than
 * performing, first person, a `[FEELING: …]` sidecar — with one structural
 * difference that matters: a cast member knows the story because they lived it,
 * while a visitor knows their OWN story (from the brief) and has only just
 * arrived in this one. Handing them the host transcript as "everything you
 * know" would make them a cast member with amnesia.
 *
 * Answers are parsed by `parseAnswer` from `askCharacter`, so a visitor's reply
 * is cleaned, labelled and expression-tagged exactly like anyone else's.
 */
export const buildVisitorAskMessages = (input: VisitorAskInput): ChatMsg[] => {
  const v = input.visitor;
  const card = cardToPromptBlock(input.card);

  const system = [
    `You are ${v.name}. You are being INTERVIEWED, out of scene, by a READER —`,
    'someone reading a story from the outside. Think of it as an actor stepping',
    'off set to talk about a scene they have just walked onto.',
    '',
    'WHO YOU ARE:',
    visitorBlock(v, input.hostCharacter),
    card ? `\n${card}` : '',
    '',
    'WHERE YOU ARE:',
    `You come from another story. You have just arrived in "${input.hostTitle}",`,
    'which is not yours. You have read none of it and lived none of it — you know',
    'only what you can see and hear now, quoted below.',
    v.entrance?.trim() ? `You came into it like this: ${v.entrance.trim()}` : '',
    v.met
      ? ''
      : '\nYou have never met anyone here. Do not recognise them, do not use names'
        + ' nobody has told you, and do not refer to a shared past — there is none.',
    '',
    'WHO YOU ARE TALKING TO — get this right or the whole thing collapses:',
    'The interviewer is NOT in either story. They are not a character, they have',
    'never met you, and nothing they say happens in any world.',
    input.hostUser
      ? `They are NOT ${input.hostUser}. ${input.hostUser} is a person in the story`
        + ' you have walked into; the interviewer only watched.'
      : '',
    '',
    'HOW TO ANSWER:',
    '1. First person, in your own voice. Speak as yourself, not about yourself.',
    `2. If you are asked about anything in "${input.hostTitle}" beyond what is`,
    '   quoted below, say plainly that you have only just got here.',
    '3. If you are asked about your OWN story, answer from the brief above and',
    '   nothing else. Do not invent events it does not mention.',
    '4. This is NOT part of either story. Do not advance a plot, do not narrate',
    '   new events, do not act on the interviewer.',
    '5. Two to four sentences unless asked to go deeper.',
    '6. You may use *small actions* sparingly. Do not open with one.',
    '',
    'End your reply with one line naming how you feel right now:',
    '[FEELING: one word]',
  ].filter(Boolean).join('\n');

  const setup = [
    `THE SCENE YOU HAVE WALKED INTO — this is all you have seen of "${input.hostTitle}":`,
    '"""',
    historyBlock(input.scene, input.hostUser) || '(nothing yet — you have arrived early)',
    '"""',
    '',
    'THE MOMENT YOU ARE BEING ASKED ABOUT:',
    '"""',
    input.anchorText.slice(0, 2400),
    '"""',
    input.mood ? `\nThe mood of this beat reads as: ${input.mood}` : '',
  ].filter(Boolean).join('\n');

  const msgs: ChatMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: setup },
    { role: 'assistant', content: "I'm here. Ask me." },
  ];
  // Replay, with other voices attributed rather than put in this one's mouth —
  // the same discipline `buildAskMessages` uses for a group interview.
  for (const t of input.turns.slice(-REPLAY)) {
    const who = t.speaker;
    if (t.role === 'character') {
      if (!who || who === v.name) msgs.push({ role: 'assistant', content: t.text });
      else msgs.push({ role: 'user', content: `[${who}, asked the same thing just now, answered:] ${t.text}` });
      continue;
    }
    const addressed = who && who !== v.name ? `(to ${who}) ` : '';
    msgs.push({ role: 'user', content: `${addressed}${t.text}` });
  }
  msgs.push({ role: 'user', content: input.question.trim() });
  return msgs;
};


/* ------------------------------------------------------------------ */
/* The flat message list a dossier is written from                     */
/* ------------------------------------------------------------------ */

/** A story's messages as `HistoryMessage[]`, hidden ones dropped. */
export const historyFrom = (messages: Message[]): HistoryMessage[] =>
  messages
    .filter(m => !m.hidden && m.content.trim())
    .map(m => ({ id: m.id, name: m.name, content: m.content }));

/** Same, from derived chains (what the reader actually has open). */
export const historyFromChains = (chains: Chain[]): HistoryMessage[] =>
  historyFrom(chains.flatMap(c => c.messages));

export type Completer = (messages: ChatMsg[]) => Promise<string>;

/**
 * Generate a dossier. Throws rather than returning an empty one — a brief with
 * no content would go into the host's prompt looking authoritative and saying
 * nothing, which is worse than not having a visitor at all.
 */
export const buildDossier = async (
  input: DossierInput,
  complete: Completer,
): Promise<Pick<Visitor, 'fields' | 'quotes'>> => {
  const raw = await complete(buildDossierMessages(input));
  const parsed = parseDossier(raw);
  if (!isUsable(parsed.fields)) {
    throw new Error(
      'The model did not produce a usable brief — it needs at least who they are and what they do not know.',
    );
  }
  return parsed;
};
