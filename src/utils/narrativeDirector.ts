/**
 * Narrative refinery — the LLM restyle pass, GROUNDED on the local extraction.
 *
 * The deterministic extractor ([[narrativeExtractor]]) is not a rewrite engine;
 * restyling to "a different author" is inherently an LLM job. But an ungrounded
 * rewrite drifts — it renames people, invents events. So we feed the model a
 * hard constraint block (entities to keep, the event spine) built from the
 * source, and afterwards `fidelity()` verifies the rewrite honoured it. Source
 * stays sacred: the original JSON is never touched; a rewrite lives in the Lens
 * override layer, reversible in one click.
 */

import { ChatMsg, SamplerParams } from './aiClient';
// The shared stripper, not a third private copy — this one also handles the
// reply that was cut off mid-thought, which the copy here did not.
import { askText, stripReasoning } from './aiCall';

export type RefineMode = 'restyle' | 'grammar' | 'tighten' | 'custom';

export interface RefineInput {
  text: string;
  mode: RefineMode;
  /** restyle → the author/voice to emulate; custom → the free instruction. */
  target?: string;
  /** Constraint block from buildGrounding(extract(text)). */
  grounding: string;
  /**
   * The passage as labeled structural blocks — dialogue/thought/beat/shout,
   * each attributed to a speaker — from `renderNarrativeBlocks(
   * narrativeBlocksFor(...))`. Supplements the raw passage below; never a
   * substitute for it, so a wrong label can't corrupt the rewrite.
   */
  structure?: string;
}

export interface RefineConfig {
  base: string;
  key: string;
  model: string;
  params?: SamplerParams;
}

/** The one-line brief per mode — what the model is allowed to change. */
export const modeBrief = (mode: RefineMode, target?: string): string => {
  switch (mode) {
    case 'restyle':
      return `Rewrite the passage in the voice and style of ${target?.trim() || 'a distinctive literary author'} — match their rhythm, diction, and sentence shapes, but tell the SAME story.`;
    case 'grammar':
      return 'Fix grammar, punctuation, and clarity ONLY. Do not change the voice, tense, POV, or word choice beyond what correctness requires.';
    case 'tighten':
      return 'Tighten the prose: cut redundancy and filler and sharpen the sentences. Keep the voice and every beat.';
    case 'custom':
      return target?.trim() || 'Improve the passage while preserving its meaning.';
  }
};

const SYSTEM = [
  'You are a careful prose editor for a fiction reader. You rewrite ONE passage',
  'to a brief, without changing what happens in it.',
  '',
  'HARD RULES:',
  '1. Keep every named person, place, and thing spelled EXACTLY as given.',
  '2. Keep the same events in the same order. Add no new characters, places, or',
  '   events; drop none. Do not change the point of view or tense unless the brief',
  '   explicitly asks you to.',
  '3. Rewrite only the prose — never invent facts to fill a style.',
  '4. Output ONLY the rewritten passage: no preamble, no explanation, no quotes',
  '   around it, no markdown fences, no notes.',
].join('\n');

/** Build the chat messages for one refinement request. */
export const buildRefineMessages = (input: RefineInput): ChatMsg[] => {
  const user = [
    `Brief: ${modeBrief(input.mode, input.target)}`,
    input.grounding ? `\nConstraints (must hold):\n${input.grounding}` : '',
    input.structure ? `\nPassage structure:\n${input.structure}` : '',
    '\nPassage to rewrite:',
    '"""',
    input.text,
    '"""',
    '\nReturn ONLY the rewritten passage.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
};


/**
 * Clean a reply down to just the prose: drop reasoning, unwrap a stray code
 * fence, peel surrounding quotes, and shed a leading "Here's the rewrite:" line.
 * Returns null when nothing usable is left (so the caller keeps the original).
 */
export const parseRefinement = (reply: string): string | null => {
  let s = stripReasoning(reply || '').trim();
  if (!s) return null;
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)```\s*$/);
  if (fence) s = fence[1].trim();
  // A single preamble line ending in a colon ("Here is the rewritten passage:").
  s = s.replace(/^[^\n]{0,80}:\s*\n+/, '').trim();
  // Whole-text wrapping quotes.
  if (/^["“][\s\S]*["”]$/.test(s) && !s.slice(1, -1).includes('\n\n')) s = s.slice(1, -1).trim();
  return s || null;
};

/** Generate a grounded refinement. Null on empty/garbage reply. */
export const generateRefinement = async (
  input: RefineInput, cfg: RefineConfig, signal?: AbortSignal,
): Promise<string | null> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model },
    buildRefineMessages(input),
    { label: 'Restyling the passage', reader: cfg.params, signal },
  );
  return parseRefinement(reply);
};
