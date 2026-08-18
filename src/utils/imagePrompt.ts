/**
 * Turning a passage into an image prompt.
 *
 * The step between "this beat" and "a picture", and the reason the feature can
 * be simple: the reader never writes prompt syntax. They press a button on a
 * passage, a model reads that passage and writes the prompt in whichever
 * dialect their backend speaks, and they SEE it before anything is generated.
 *
 * Two rules hold this together.
 *
 * 1. **The picture describes THIS beat, not the story.** The model is given the
 *    passage, its scene descriptor if the Director has read it, and nothing
 *    else narrative — a prompt assembled from the whole chat produces a generic
 *    portrait of the character rather than the moment you were reading.
 * 2. **What people look like is not the model's to invent.** The appearance
 *    sheet is prepended VERBATIM, outside the model's output, so it cannot
 *    drift between one picture and the next. Asking a language model to
 *    remember a face across calls is exactly the thing it cannot do.
 *
 * Pure except for the one completion call, which is injected.
 */

import type { CardInfo, SceneDescriptor } from '../types';
import { ChatMsg } from './aiClient';
import { ImagePreset, composeNegative, composePrompt, presetById } from './imagePresets';

/** The one AI call this module makes, injected so it can be tested without one. */
export type Completer = (messages: ChatMsg[]) => Promise<string>;

export interface PromptInput {
  /** The passage, already resolved and processed — what the reader can see. */
  text: string;
  /** Who is in it, for the appearance sheets. */
  speaker?: string;
  characterName?: string;
  userName?: string;
  /** The Director's read of this beat, when it has one. */
  scene?: SceneDescriptor;
  card?: CardInfo;
  /** Appearance sheets by lowercased character name. */
  appearance?: Record<string, string>;
  presetId: string;
  negativeExtra?: string;
}

export interface DraftPrompt {
  prompt: string;
  negative: string;
  preset: ImagePreset;
  /** The sheet text that was prepended, so the UI can show what it added. */
  appearanceUsed: string;
  /** Which characters' sheets were used — for the seed lock. */
  characters: string[];
}

/** Longest passage handed to the prompt writer. A picture is one moment. */
const MAX_PASSAGE = 2400;

/**
 * Appearance for everyone plausibly in frame: the speaker, plus the story's
 * lead when they are someone else and the passage names them.
 */
export const castFor = (input: PromptInput): string[] => {
  const names = new Set<string>();
  const add = (n?: string) => {
    const key = n?.trim().toLowerCase();
    if (key && key !== 'narrator' && key !== 'story' && key !== 'system') names.add(key);
  };
  add(input.speaker);
  const lead = input.characterName?.trim().toLowerCase();
  if (lead && !names.has(lead) && new RegExp(`\\b${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(input.text)) {
    names.add(lead);
  }
  return [...names];
};

/** The appearance sheets in force, joined. */
export const appearanceFor = (input: PromptInput): { text: string; characters: string[] } => {
  const characters = castFor(input);
  const sheets = characters
    .map(c => input.appearance?.[c]?.trim())
    .filter((s): s is string => !!s);
  return { text: sheets.join(', '), characters };
};

/**
 * The scene facts worth handing over. Deliberately short: mood, place and time
 * are what a picture can actually show, and the rest of a descriptor
 * (tension curves, audio cues) would only crowd out the passage.
 */
const sceneLine = (scene?: SceneDescriptor): string => {
  if (!scene) return '';
  const bits = [
    scene.location ? `place: ${scene.location}` : '',
    scene.timeOfDay ? `time: ${scene.timeOfDay}` : '',
    scene.mood ? `mood: ${scene.mood}` : '',
    // `fx` is the Director's particle read (fog, snow, embers) — the one part
    // of the weather track a still picture can show.
    scene.fx ? `in the air: ${scene.fx}` : '',
    scene.shot ? `framing: ${scene.shot}` : '',
  ].filter(Boolean);
  return bits.length ? `The Director read this beat as — ${bits.join(', ')}.` : '';
};

export const buildPromptMessages = (input: PromptInput): ChatMsg[] => {
  const preset = presetById(input.presetId);
  const passage = input.text.length > MAX_PASSAGE
    ? `${input.text.slice(0, MAX_PASSAGE)}…`
    : input.text;

  const system = [
    'You turn one passage of a story into a prompt for an image generator.',
    '',
    'RULES:',
    `- ${preset.instruction}`,
    '- Describe ONE moment from this passage — the most visually striking one.',
    '- Describe only what a camera could see. No names, no dialogue, no plot, no',
    '  inner thoughts, no words that would appear as text in the picture.',
    '- Do NOT describe hair colour, eye colour, age, build or clothing that the',
    '  passage does not state: those come from a separate character sheet and',
    '  yours would contradict it.',
    '- Output the prompt and nothing else. No preamble, no quotes, no explanation.',
  ].join('\n');

  const user = [
    input.characterName ? `Story character: ${input.characterName}.` : '',
    input.userName ? `The reader's persona: ${input.userName}.` : '',
    sceneLine(input.scene),
    input.card?.scenario ? `Setting: ${input.card.scenario.slice(0, 400)}` : '',
    '',
    'PASSAGE:',
    passage,
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

/** Strip the wrapper a chatty model puts around a one-line answer. */
export const cleanPrompt = (raw: string): string =>
  raw
    .replace(/^```[a-z]*\n?|```$/gim, '')
    .replace(/^\s*(?:prompt|positive(?: prompt)?)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Draft a prompt for a beat. The result is meant to be SHOWN and edited before
 * anything is generated — that review step is what keeps this from being a slot
 * machine, and what makes a gallery, a queue and a re-roll pile unnecessary.
 */
export const draftPrompt = async (
  input: PromptInput,
  complete: Completer,
): Promise<DraftPrompt> => {
  const preset = presetById(input.presetId);
  const { text: appearanceUsed, characters } = appearanceFor(input);
  const scene = cleanPrompt(await complete(buildPromptMessages(input)));
  if (!scene) throw new Error('The model returned nothing usable for this passage.');
  return {
    prompt: composePrompt(preset, appearanceUsed, scene),
    negative: composeNegative(preset, input.negativeExtra ?? ''),
    preset,
    appearanceUsed,
    characters,
  };
};

/**
 * A first appearance sheet from the character card, so the reader edits
 * something rather than facing an empty box.
 *
 * Heuristic and deliberately shallow — it lifts the physical sentences out of a
 * card's description and leaves the rest. A card that says nothing about how
 * someone looks yields nothing, which is the honest answer.
 */
const PHYSICAL = /\b(hair|eyes?|skin|tall|short|slender|slim|build|freckl|scar|tattoo|beard|wears?|wearing|dressed|clothes|clothing|coat|dress|robe|armou?r|uniform|complexion|braid|curls?|ponytail)\b/i;

export const appearanceFromCard = (card: CardInfo | undefined): string => {
  const source = [card?.description, card?.personality].filter(Boolean).join(' ');
  if (!source) return '';
  const sentences = source.split(/(?<=[.!?])\s+/).filter(s => PHYSICAL.test(s));
  if (!sentences.length) return '';
  return sentences
    .join(' ')
    .replace(/\{\{char\}\}/gi, card?.name ?? '')
    .replace(/\{\{user\}\}/gi, 'the reader')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
};
