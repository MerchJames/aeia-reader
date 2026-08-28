/**
 * Ask {{char}} — interviewing a character about the beat you just read.
 *
 * This is deliberately NOT a companion chat. Aura's standing rule is that the
 * AI never gets its own room: it is summoned at an anchor, produces something
 * that belongs to that anchor, and goes away. So an interview is anchored to a
 * MESSAGE. Scroll back to beat 12 and you find the questions you asked at beat
 * 12, answered by someone who did not yet know how it ends — which is a more
 * interesting artifact than one global thread, and it is the difference between
 * marginalia and chatbot drift.
 *
 * ─── The spoiler clamp is the whole safety story ───
 *
 * A character prompted with the full transcript knows the ending. Ask "what are
 * you feeling?" at message 12 and the answer can be informed by message 400 —
 * which does not merely disappoint, it damages the reading it is attached to.
 * `clampHistory` is the single place that can happen, it FAILS CLOSED on an
 * unknown anchor, and it is the most heavily tested function in this file.
 *
 * ─── Reader-only by construction ───
 *
 * Nothing said here is canon. These turns must never reach the Lens, an export,
 * the Multiverse graph, or any AI context assembled for the Director, the
 * summarizer or the assistant. That is enforced by not wiring them anywhere:
 * the slice is read by exactly one component.
 */

import { ChatMsg, SamplerParams, isLocalBase } from './aiClient';
import { askText } from './aiCall';
import { cardToPromptBlock } from './cardContext';
import { bucketFor, EmotionBucket } from '../lib/spriteStorage';
import type { CardInfo } from '../types';

/** One line of the interview. `reader` is you; `character` is them. */
export interface AskTurn {
  id: string;
  role: 'reader' | 'character';
  text: string;
  at: number;
  /** Expression bucket for the portrait — parsed from the answer, no extra call. */
  emotion?: EmotionBucket;
  /** Who this turn belongs to: the character who answered, or — on a reader
   *  turn — the character the question was put to. Absent on threads recorded
   *  before group chats were supported; the story's lead is assumed. */
  speaker?: string;
  /** The beat the reader was on when this was said. */
  atMessageId?: string;
  /** That beat's 1-based position, for the "now at beat N" divider. */
  beat?: number;
}

/**
 * Read a stored thread, tolerating the first shape this shipped in.
 *
 * v1 kept one thread PER MESSAGE (`Record<messageId, AskTurn[]>`). The
 * conversation is now continuous across beats — you can ask at beat 40, travel
 * to beat 149 and ask again with everything still in mind — so it is one
 * ordered thread per story. Old per-beat threads are flattened into it rather
 * than dropped.
 */
export const readThread = (raw: unknown): AskTurn[] => {
  if (Array.isArray(raw)) return raw as AskTurn[];
  if (!raw || typeof raw !== 'object') return [];
  const byMessage = raw as Record<string, AskTurn[]>;
  return Object.entries(byMessage)
    .flatMap(([messageId, turns]) =>
      (Array.isArray(turns) ? turns : []).map(t => ({ ...t, atMessageId: t.atMessageId ?? messageId })))
    .sort((a, b) => a.at - b.at);
};

/**
 * Everyone who speaks in this story, in the order they first do.
 *
 * A group chat has no single "the character": the interview subject follows
 * whoever is on screen, and the reader can switch between them. Narrator-ish
 * names are dropped — you cannot interview a narrator — and so is the reader's
 * own character, who is not on the other side of the microphone.
 */
const NOT_A_SPEAKER = /^(narrator|story|system|prompt|note|ooc)$/i;

export const castOf = (
  messages: { name: string; role?: string }[], userName?: string,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const name = (m.name ?? '').trim();
    if (!name || m.role === 'user' || NOT_A_SPEAKER.test(name)) continue;
    if (userName && name.toLowerCase() === userName.trim().toLowerCase()) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

/** How much story the character is allowed to have in mind, in characters. */
export const HISTORY_BUDGET = 6000;
/** Extra share of the budget spent making sure every voice is represented. */
const SPEAKER_RESERVE = 0.25;
/** Longest a rescued turn may be — proof the speaker exists, not their story. */
const MAX_RESCUED_CHARS = 400;
/** How many prior interview turns are replayed, so a thread stays coherent. */
export const THREAD_TURNS = 8;

export interface HistoryMessage {
  id: string;
  name: string;
  content: string;
}

/**
 * The story the character is allowed to know: everything up to and INCLUDING
 * the anchored message, and not one word past it.
 *
 * Fails closed. An anchor that is not in the list yields nothing rather than
 * everything — if the caller is confused about where the reader is, the safe
 * answer is a character who knows nothing, not one who knows the ending.
 */
export const clampHistory = (
  messages: HistoryMessage[],
  anchorId: string,
  budget = HISTORY_BUDGET,
): HistoryMessage[] => {
  const idx = messages.findIndex(m => m.id === anchorId);
  if (idx < 0) return [];
  const upto = messages.slice(0, idx + 1);

  // Keep the most RECENT context — the beat being asked about matters more than
  // the opening — walking backwards until the budget is spent. The anchored
  // message itself is always included, however long it is.
  const out: HistoryMessage[] = [];
  const taken = new Set<string>();
  let used = 0;
  for (let i = upto.length - 1; i >= 0; i--) {
    const m = upto[i];
    const cost = m.content.length + m.name.length + 2;
    if (out.length && used + cost > budget) break;
    out.unshift(m);
    taken.add(m.id);
    used += cost;
  }

  /*
   * …then make sure nobody in the story is missing from it entirely.
   *
   * A pure recency window is right for a two-hander and quietly wrong for a
   * group chat: whoever has been talking lately fills the budget, and a
   * character who spoke earlier falls off the end completely. Measured on a
   * 42-message chat, the window kept 16 messages and ONE speaker — so the
   * system prompt named Bram in the cast while the transcript contained not one
   * word he had ever said, and the interviewee could not be asked about him.
   * That reads as the model being stupid; it was the payload being empty.
   *
   * So every voice present before the anchor keeps at least their most recent
   * turn, paid for out of a small reserve on top of the budget. Bounded on
   * purpose: it is one line each, not a second transcript.
   */
  const seen = new Set(out.map(m => m.name.trim().toLowerCase()));
  const rescued: HistoryMessage[] = [];
  let spare = Math.round(budget * SPEAKER_RESERVE);
  for (let i = upto.length - 1; i >= 0 && spare > 0; i--) {
    const m = upto[i];
    const who = m.name.trim().toLowerCase();
    if (!who || seen.has(who) || taken.has(m.id)) continue;
    seen.add(who);
    // A long-winded turn is trimmed rather than skipped: the point is that the
    // character EXISTS in the transcript and said something recognisable.
    const clipped = m.content.length > MAX_RESCUED_CHARS
      ? `${m.content.slice(0, MAX_RESCUED_CHARS)}…`
      : m.content;
    rescued.push({ ...m, content: clipped });
    spare -= clipped.length + m.name.length + 2;
  }
  if (!rescued.length) return out;

  // Back into reading order — a transcript out of sequence is worse than a
  // short one, because the model will infer a sequence from it.
  const order = new Map(messages.map((m, i) => [m.id, i]));
  return [...rescued, ...out].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
};

/**
 * Render the clamped history as a transcript the model can read.
 *
 * The reader-character's turns are relabelled from "You" to their actual name.
 * Left as "You", every line the protagonist spoke reads as the INTERVIEWER
 * speaking — which is exactly how the character ends up thinking the person
 * asking the questions is the person from the story.
 */
export const historyBlock = (messages: HistoryMessage[], userName?: string): string => {
  const label = (name: string) =>
    userName && /^(you|user|\{\{user\}\})$/i.test(name.trim()) ? userName : name;

  /*
   * In a GROUP chat each turn gets a rule above it.
   *
   * `Name: content` is unambiguous when there are two people and one line each.
   * It stops being unambiguous the moment a passage is three paragraphs long
   * and contains quoted speech of its own — the next `Bram:` reads as a line
   * INSIDE Mara's narration rather than as Bram taking a turn, and the model
   * ends up attributing half the chat to whoever spoke last. That is what "it
   * ignores the other character's messages" looks like from the outside: the
   * words were in the payload and the turn boundary was not.
   *
   * Only when it is actually needed. A two-hander is easier to read compactly,
   * and rules between every line of a back-and-forth are noise.
   */
  const speakers = new Set(messages.map(m => label(m.name).trim().toLowerCase()));
  if (speakers.size <= 2) {
    return messages.map(m => `${label(m.name)}: ${m.content}`).join('\n\n');
  }
  return messages
    .map(m => `--- ${label(m.name)} ---\n${m.content}`)
    .join('\n\n');
};

export interface AskInput {
  /** Who is being interviewed right now. */
  characterName: string;
  /** The rest of the cast. Named so the subject can be asked ABOUT them — an
   *  interview in a group chat is as much about what they make of each other. */
  cast?: string[];
  /** What the reader is called, so the character can address them. */
  userName?: string;
  card?: CardInfo;
  /** Already clamped by `clampHistory` — this function does not re-clamp. */
  history: HistoryMessage[];
  /** The passage the bubble is anchored to. */
  anchorText: string;
  /** Prior turns in this thread, oldest first. */
  turns: AskTurn[];
  /** What the reader just asked. */
  question: string;
  /** The Director's read of this beat, when there is one — sharpens the voice. */
  mood?: string;
  /** True when the reader has moved to a LATER beat since the last question, so
   *  the character knows more now than they did earlier in this conversation. */
  movedOn?: boolean;
}

/**
 * The interview frame.
 *
 * Character cards are written for roleplay CONTINUATION — they push the model
 * to act, narrate, and advance the scene. Ask such a card "what are you
 * feeling?" and you get a stage direction instead of an answer. So the frame
 * has to say, in as many words, that this is out of scene and the job is to
 * answer rather than to perform.
 */
export const askSystem = (
  characterName: string, userName?: string, cast: string[] = [],
): string => [
  `You are ${characterName}. You are being INTERVIEWED, out of scene, by a READER —`,
  'someone who has been reading your story from the outside. Think of it as an',
  'actor stepping off set to talk about the scene they just shot.',
  '',
  'WHO YOU ARE TALKING TO — get this right or the whole thing collapses:',
  'The interviewer is NOT in your story. They are not a character, they have never',
  'met you, and nothing they say happens in the world of the story.',
  userName
    ? `In particular they are NOT ${userName}. ${userName} is a person in your story;`
      + ' the interviewer is a stranger who has only WATCHED that person. Never address'
      + ` the interviewer as ${userName}, never answer as though they did the things`
      + ` ${userName} did, and never treat their questions as ${userName} speaking to you.`
    : 'Never mistake the interviewer for anyone in the story.',
  '',
  ...(cast.length ? [
    `ALSO IN THIS STORY: ${cast.join(', ')}.`,
    'You may be asked what you make of any of them — answer from your OWN',
    'experience of them, not from anything they would say about themselves. If',
    'one of them has already answered in this interview you will see it below,',
    'marked as theirs; you are free to agree, disagree, or be stung by it.',
    '',
  ] : []),
  'HOW TO ANSWER:',
  '1. First person, in your own voice. Speak as yourself, not about yourself.',
  '2. You know ONLY what you have lived through up to the passage quoted below.',
  '   You do not know what happens next. If you are asked, say so plainly and in',
  '   character — guessing at your own future is the one thing that ruins this.',
  '3. This conversation is NOT part of the story. Do NOT advance the plot, do not',
  '   narrate new events, do not act on the interviewer or move the scene along.',
  '4. Answer the question that was actually asked. Interiority is the point: what',
  '   you felt, what you noticed, what you did not say out loud, what you would',
  '   take back. Be candid, or be evasive if that is who you are — but answer.',
  '5. Two to four sentences unless you are asked to go deeper. A short honest',
  '   answer beats a paragraph of atmosphere.',
  '6. You may use *small actions* sparingly if they carry something words cannot.',
  '   Do not open with one.',
  '',
  'End your reply with one line naming how you feel right now:',
  '[FEELING: one word]',
].join('\n');

/** Build the request for one interview turn. */
export const buildAskMessages = (input: AskInput): ChatMsg[] => {
  const card = cardToPromptBlock(input.card);
  const system = [
    askSystem(input.characterName, input.userName, input.cast ?? []), card,
  ].filter(Boolean).join('\n\n');

  const setup = [
    input.userName
      ? `THE STORY SO FAR (everything you know — nothing after this has happened yet).`
        + ` Note that ${input.userName} below is a person IN the story, not the person`
        + ' asking you these questions:'
      : 'THE STORY SO FAR (everything you know — nothing after this has happened yet):',
    '"""',
    historyBlock(input.history, input.userName) || '(nothing yet — the story has only just begun)',
    '"""',
    '',
    'THE MOMENT YOU ARE BEING ASKED ABOUT:',
    '"""',
    input.anchorText.slice(0, 2400),
    '"""',
    input.mood ? `\nThe mood of this beat reads as: ${input.mood}` : '',
    input.movedOn
      ? '\nNOTE: since the earlier questions in this conversation you have lived'
        + ' through more of the story. Answer from where you stand NOW. If what you'
        + ' said before no longer holds, say so — that change is the interesting part.'
      : '',
  ].filter(Boolean).join('\n');

  // The setup goes in ONE user turn, then the thread replays as a real
  // conversation, so the model treats prior answers as its own words.
  const msgs: ChatMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: setup },
    { role: 'assistant', content: "I'm here. Ask me." },
  ];
  // Replay the thread. In a group chat the transcript holds several voices, so
  // only the SUBJECT's own answers come back as theirs — another character's
  // answer is handed over as something they can see and react to, attributed,
  // rather than being put in their mouth.
  for (const t of input.turns.slice(-THREAD_TURNS)) {
    const who = t.speaker;
    if (t.role === 'character') {
      if (!who || who === input.characterName) {
        msgs.push({ role: 'assistant', content: t.text });
      } else {
        msgs.push({ role: 'user', content: `[${who}, asked the same thing just now, answered:] ${t.text}` });
      }
      continue;
    }
    const addressed = who && who !== input.characterName ? `(to ${who}) ` : '';
    msgs.push({ role: 'user', content: `${addressed}${t.text}` });
  }
  msgs.push({ role: 'user', content: input.question.trim() });
  return msgs;
};

const FEELING = /\[\s*FEELING\s*:\s*([^\]]{1,32})\]/i;

export interface ParsedAnswer {
  text: string;
  emotion: EmotionBucket;
}

/**
 * Clean one reply into something worth showing: reasoning preambles gone, the
 * feeling sidecar lifted out and removed, and a `Name:` prefix stripped (models
 * love to re-label their own dialogue when the system prompt names a speaker).
 * Returns null when nothing is left.
 */
export const parseAnswer = (raw: string, characterName: string): ParsedAnswer | null => {
  let text = (raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  const feeling = text.match(FEELING)?.[1]?.trim();
  text = text.replace(FEELING, '');

  // Drop a leading speaker label. The colon can fall either side of the closing
  // markdown — `**Elara:**` and `**Elara**:` are both common — but a colon must
  // be there somewhere, or "Elara stood up" would lose her name.
  const name = characterName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name) {
    text = text.replace(
      new RegExp(`^\\s*[*_"']*\\s*${name}\\s*(?::\\s*[*_"']*|[*_"']*\\s*:)\\s*`, 'i'),
      '',
    );
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  return { text, emotion: bucketFor(feeling) };
};

/** One run of an answer: either what they said, or the business around it. */
export interface AnswerPart {
  text: string;
  /** True for narration/stage business — hidden in the dialogue-only view. */
  aside: boolean;
}

/** Straight and curly quotes, so a model's smart quotes still count as speech. */
const QUOTED = /(["“][^"”\n]{2,}["”])/g;
const ACTION = /(\*[^*\n]+\*)|(^[ \t]*[([][^)\]\n]*[)\]][ \t]*$)/gm;

/**
 * Split an answer into what was SAID and everything around it.
 *
 * This is the Phone Chat dialogue view, applied to an interview. Two cases,
 * because an interview answer comes back either way:
 *
 *  - If the reply contains quoted speech, the quotes are the dialogue and all
 *    the narration between them is the aside.
 *  - If it does not (an interview answer is often unquoted first person), the
 *    asides are the *stage directions* that character cards push the model
 *    toward relentlessly.
 *
 * The first version only ever handled the second case, so on any reply without
 * asterisks the view button did nothing at all — which is exactly how it read.
 */
export const splitAnswer = (text: string): AnswerPart[] => {
  const cut = (re: RegExp, asideIsMatch: boolean): AnswerPart[] => {
    const parts: AnswerPart[] = [];
    let cursor = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > cursor) parts.push({ text: text.slice(cursor, m.index), aside: !asideIsMatch });
      parts.push({ text: m[0], aside: asideIsMatch });
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), aside: !asideIsMatch });
    return parts.filter(p => p.text !== '');
  };

  // Quoted speech present → the quotes are the dialogue, the rest is around it.
  if (QUOTED.test(text)) return cut(QUOTED, false);
  // Otherwise the whole reply is speech, minus its stage directions.
  return cut(ACTION, true);
};

/**
 * Just the spoken words. Falls back to the whole reply when stripping would
 * leave nothing, because an empty bubble reads as the character refusing to
 * answer rather than as a view setting.
 */
export const spokenOnly = (text: string): string => {
  const spoken = splitAnswer(text)
    .filter(p => !p.aside)
    .map(p => p.text)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
  return spoken || text.trim();
};

/** Does this answer have anything the dialogue-only view would hide? */
export const hasAside = (text: string): boolean =>
  splitAnswer(text).some(p => p.aside) && spokenOnly(text) !== text.trim();

/**
 * Sampling for a VOICE task. Unlike the Director (a reading task, decoded
 * greedily so a re-read is reproducible) this one should vary: asking the same
 * question twice and getting the identical sentence back would break the
 * illusion the feature exists to create.
 */
export const askSamplers = (base: string): SamplerParams => ({
  temperature: 0.85, top_p: 0.95, frequency_penalty: 0.2, presence_penalty: 0,
  ...(isLocalBase(base) ? { min_p: 0.05, repetition_penalty: 1.05 } : {}),
});

/** Short answers by design — the frame asks for 2-4 sentences. */
export const ASK_TOKENS = 420;

export interface AskConfig {
  base: string;
  key: string;
  model: string;
  params?: SamplerParams;
}

/** Put one question to the character. Null when nothing usable came back. */
export const askCharacter = async (
  input: AskInput, cfg: AskConfig, signal?: AbortSignal,
): Promise<ParsedAnswer | null> => {
  // Through the shared layer, which strips a chain of thought before the words
  // reach the reader. A thinking model used to answer this interview with its
  // own deliberation about how the character would answer — in the character's
  // speech bubble, in their voice's place.
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model },
    buildAskMessages(input),
    {
      label: `Asking ${input.characterName}`,
      params: askSamplers(cfg.base),
      reader: cfg.params,
      budget: ASK_TOKENS,
      signal,
    },
  );
  return parseAnswer(reply, input.characterName);
};

/**
 * Openers offered when a thread is empty. Phrased as an interviewer would —
 * about the beat on screen, never about the character in the abstract, because
 * "what's your favourite food" is the exact question that turns this back into
 * a chatbot.
 */
export const OPENERS = [
  'What was going through your head just then?',
  'What did you not say out loud?',
  'How did that land for you?',
  'Is there anything you would take back?',
] as const;
