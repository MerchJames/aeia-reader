/**
 * A passage broken into structural blocks — dialogue, thought, beat, shout
 * and narration — for handing prose STRUCTURE to the LLM, not just the raw
 * text. Narrative Refinery and Lens both ask a model to rewrite a passage
 * without losing track of who said or thought what; a flat wall of prose
 * makes that an inference the model has to redo every time, and it does not
 * always get it right on a passage with more than one voice in it.
 *
 * This reuses the same channel marks and speaker-attribution engine already
 * shared by TTS, the Stage/VN bubble and `screenplay.ts`'s Script view — see
 * `dialogueSegments.ts`. `screenplay.ts`'s `linesForMessage` is the closest
 * relative: it already segments a message into typed, attributed lines, but
 * strips `**`/`'` markers before segmenting (screenplay format has no notion
 * of an inner thought), so it only ever tells dialogue from narration. This
 * module keeps all four marks.
 *
 * Pure: no store, no React, no JSX.
 */

import { DialogueAttribution, aiSpeakerFor, attributeSpeaker } from './dialogueSegments';
import { stripAttribution } from './screenplay';

export type NarrativeBlockKind = 'dialogue' | 'thought' | 'beat' | 'shout' | 'narration';

export interface NarrativeBlock {
  kind: NarrativeBlockKind;
  /** Who said/thought it. Narration carries the passage's author too, but
   *  `renderNarrativeBlocks` leaves it off the label — it isn't anyone's line. */
  speaker: string;
  text: string;
}

export interface NarrativeBlockOptions {
  /** Everyone who might speak — the same roster the bubbles and TTS use. */
  cast?: string[];
  /** The Director's per-quote attribution, preferred over the heuristic. */
  dialogue?: DialogueAttribution[];
}

/**
 * Markdown stripped down to plain prose, EXCEPT the four channel markers —
 * `screenplay.ts`'s `plainProse` minus its final marker-stripping step,
 * which is exactly the thing that must survive here to be classified.
 */
const stripToProse = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * An unmistakable sentinel, not bare digits — prose is full of literal
 * numbers ("it was 3 AM", "page 7"), so a bare-digit placeholder would
 * collide with real text and corrupt the narration around it. A distinctive
 * ASCII token rather than `bookLayout.ts`'s private-use codepoints, purely so
 * it stays easy to read/edit in this file — it never reaches the caller, so
 * what it looks like doesn't matter.
 */
const PLACEHOLDER_RE = /@@NB(\d+)@@/g;
const placeholder = (i: number): string => `@@NB${i}@@`;

/**
 * One passage as narrative blocks, in document order.
 *
 * Each of the four marks is claimed in turn — shout before beat (its
 * four-star delimiter would otherwise be half-eaten by the two-star rule),
 * then dialogue, then thought — and replaced with a numbered placeholder, so
 * whatever prose is left between placeholders is exactly the narration, in
 * the order it was written. Same claiming strategy as `bookLayout.ts`'s
 * channel-aware `renderInline`.
 *
 * Beat and shout are attributed to the passage's own author uniformly — no
 * attempt is made to detect one nested inside another character's quoted
 * dialogue, the same simplification the per-character color feature makes.
 */
export const narrativeBlocksFor = (
  text: string,
  author: string,
  opts: NarrativeBlockOptions = {},
): NarrativeBlock[] => {
  const cast = [...new Set((opts.cast ?? []).map(c => c.trim()).filter(Boolean))];
  const claimed: NarrativeBlock[] = [];
  let s = stripToProse(text);
  if (!s) return [];

  s = s.replace(/\*\*\*\*([^*]+)\*\*\*\*/g, (_m, t) => {
    claimed.push({ kind: 'shout', speaker: author, text: t.trim() });
    return placeholder(claimed.length - 1);
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => {
    claimed.push({ kind: 'beat', speaker: author, text: t.trim() });
    return placeholder(claimed.length - 1);
  });
  // A quoted line's trailing comma exists only to attach the "she said" that
  // follows it — same cleanup as screenplay.ts's flushDialogue, extended to
  // thought since "'not again,' she thought" carries the identical clause.
  const stripComma = (t: string) => t.trim().replace(/,\s*$/, '');

  // Dialogue — attribution mirrors screenplay.ts's linesForMessage exactly:
  // the Director's per-quote read first, then the narration-context guess,
  // then the passage's own author.
  s = s.replace(/(["“])([^"“”\n]+)(["”])/g, (m, _o, body, _c, offset: number) => {
    const before = s.slice(Math.max(0, offset - 160), offset);
    const after = s.slice(offset + m.length, offset + m.length + 160);
    const speaker = aiSpeakerFor(body, opts.dialogue)
      ?? attributeSpeaker(before, after, cast)
      ?? author;
    claimed.push({ kind: 'dialogue', speaker, text: stripComma(body) });
    return placeholder(claimed.length - 1);
  });
  // Thought/aside — closed-only boundary rule, same as textProcessor's aside
  // wrap: an apostrophe (don't, readin') opens nothing.
  s = s.replace(/(^|[\s({[—–-])'([^'\n]+)'(?=[\s.,!?;:)}\]—–-]|$)/g, (_m, pre, t) => {
    claimed.push({ kind: 'thought', speaker: author, text: stripComma(t) });
    return `${pre}${placeholder(claimed.length - 1)}`;
  });

  const out: NarrativeBlock[] = [];
  const parts = s.split(PLACEHOLDER_RE);
  // String.split with a capturing regex alternates: text, captured group,
  // text, captured group, …, text.
  parts.forEach((part, i) => {
    if (i % 2 === 1) { out.push(claimed[Number(part)]); return; }
    for (const para of part.split(/\n{2,}/)) {
      // A bare "Kara said." is the clause the cue above already carries —
      // printed again here it's noise, not information. Same drop rule as
      // screenplay.ts's action lines.
      const p = stripAttribution(para).trim();
      if (p) out.push({ kind: 'narration', speaker: author, text: p });
    }
  });
  return out;
};

const KIND_LABEL: Record<NarrativeBlockKind, string> = {
  dialogue: 'Dialogue', thought: 'Thought', beat: 'Beat', shout: 'Shout', narration: 'Narration',
};

/** Render blocks into the labeled-block format the AI reads — plain text,
 *  matching `narrativeExtractor.ts`'s `buildGrounding` convention. */
export const renderNarrativeBlocks = (blocks: NarrativeBlock[]): string =>
  blocks
    .filter(b => b.text)
    .map(b => (b.kind === 'narration'
      ? `[Narration]\n${b.text}`
      : `[${KIND_LABEL[b.kind]} - ${b.speaker}]\n${b.text}`))
    .join('\n\n');
