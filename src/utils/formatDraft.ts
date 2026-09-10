/**
 * Turning "here's roughly what I want" into a form.
 *
 * `FormatDrop` takes a form the reader already has. This is the other case: the
 * reader has a draft, a half-remembered layout, or just a sentence about what
 * they want the document to contain. Handing that to the long read as-is
 * produces a different document every pass, because there is no shape in it to
 * restate.
 *
 * ── What this asks for, and what it refuses ────────────────────────────────
 *
 * The model is asked for **a template and nothing else**. Not a filled-in
 * example, not an explanation of the template, not a preamble. That is a thing
 * models are bad at, so `readDraft` does not trust the instruction: it strips a
 * fence, drops a leading sentence about the answer, and then checks that what
 * is left is actually a form.
 *
 * The check matters more than it looks. A prose answer that slips through
 * becomes the `format` of a twenty-pass read — restated verbatim on every pass
 * — and the reader finds out at the end. Refusing here costs one retry.
 *
 * ── Why the placeholders are instructions ──────────────────────────────────
 *
 * `renderFormatInstruction` restates the reader's literal template on every
 * pass, so whatever sits in the value positions is being sent twenty times and
 * is being read by the model as guidance. `"name": "Marcus"` teaches it to
 * write about Marcus. `"name": "the character's name"` teaches it what the
 * field is for. So the prompt asks for the second, and `exampleValues` is the
 * warning the panel shows when it gets the first anyway.
 *
 * Pure: no store, no React, no fetch. `useFormatDraft` does the calling.
 */

import { MAX_TEMPLATE_CHARS, detectFormatKind, parseFormat } from './formatSpec';

/** An idea longer than this is already a document; there is nothing to draft. */
export const MAX_IDEA_CHARS = 4000;

/** Shapes the reader can ask for. `auto` lets the model choose. */
export type DraftShape = 'auto' | 'json' | 'markdown' | 'outline';

const SHAPE_RULE: Record<DraftShape, string> = {
  auto:
    'Choose the simplest shape that fits: a JSON object for data with clear'
    + ' fields, markdown headings for a written document, or an indented outline'
    + ' for a list of labelled points.',
  json: 'The form must be a single JSON object.',
  markdown: 'The form must be markdown headings, with nothing under them but placeholders.',
  outline: 'The form must be an indented outline of `label: placeholder` lines.',
};

export const ideaProblem = (idea: string): string | null => {
  const trimmed = idea.trim();
  if (!trimmed) return 'Describe what you want the document to contain, or paste a draft of it.';
  if (trimmed.length > MAX_IDEA_CHARS) {
    return `That is ${trimmed.length.toLocaleString()} characters. Paste the shape you want, not a`
      + ' filled-in copy of it.';
  }
  return null;
};

/**
 * The prompt.
 *
 * The rule about placeholders comes before the reader's idea, and the "no
 * prose" rule comes last, because a model reads the end of an instruction most
 * carefully and the last thing it is told is the thing most often obeyed.
 */
export const buildDraftPrompt = (idea: string, shape: DraftShape = 'auto'): string => [
  'Turn the following into a blank FORM: the structure of a document, with no content in it.',
  '',
  SHAPE_RULE[shape],
  '',
  'Rules:',
  '- Every value position holds a short instruction saying what belongs there —'
  + ' "the character\'s full name", "one line per visible injury". Never an example'
  + ' answer, never a real name, never invented detail.',
  '- Keep it to the fields that were actually asked for. Do not add fields you think'
  + ' would be nice.',
  `- Keep the whole form under ${MAX_TEMPLATE_CHARS} characters.`,
  '',
  'What is wanted:',
  idea.trim(),
  '',
  'Reply with the form itself and nothing else — no explanation before it, no note after it.',
].join('\n');

/* ------------------------------------------------------------------ */
/* Reading the answer                                                  */
/* ------------------------------------------------------------------ */

/**
 * Strip a code fence, if the whole answer is one.
 *
 * Only when the answer IS the fence. A reply with prose around a fence is a
 * reply that ignored the instruction, and pulling the fence out of it would
 * hide that — `looksLikeForm` should get its say instead.
 */
const unfence = (raw: string): string => {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```[a-z0-9]*\s*\n([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
};

/** A line that introduces the answer rather than being part of it. */
const PREAMBLE = /^(here(?:'s| is| are)\b|sure[,!.]|certainly[,!.]|of course[,!.]|below is\b|this is\b|i(?:'ve| have)\b)/i;

const dropPreamble = (text: string): string => {
  const lines = text.split('\n');
  // One line only. A model that wrote three paragraphs of preamble did not
  // follow the instruction, and quietly deleting them would let a reply that
  // is mostly prose pass as a form.
  if (lines.length > 1 && PREAMBLE.test(lines[0].trim()) && lines[0].trim().endsWith(':')) {
    return lines.slice(1).join('\n').trim();
  }
  return text;
};

/**
 * Is this a form rather than a paragraph about one?
 *
 * `parseFormat` already recognises JSON, XML, markdown and outlines. What it
 * does NOT do is refuse: plain text is a legitimate hand-written form, so
 * `formatProblem` lets it through, and rightly. Here the text came from a model
 * that was told not to write prose, so the standard is higher: either the
 * parser recognised a shape, or there are labelled lines.
 */
export const looksLikeForm = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (detectFormatKind(trimmed) !== 'plain') return true;
  const labelled = trimmed
    .split('\n')
    .filter(line => /^\s*(?:[-*+]\s*)?[^:\n]{1,48}:(?:\s|$)/.test(line))
    .length;
  return labelled >= 2;
};

/**
 * Values that look like content rather than instructions.
 *
 * Not a refusal — a warning. The model may have written a perfectly good form
 * with one placeholder that happens to read like an answer, and refusing that
 * would send the reader round again for nothing. But since the template is
 * restated on every pass, a form full of example content quietly steers twenty
 * passes toward that content, and the reader should be told before they commit.
 */
export const exampleValues = (text: string): string[] => {
  const out: string[] = [];
  const spec = parseFormat(text);
  for (const field of spec.fields) {
    const hint = (field.hint ?? '').trim();
    if (!hint) continue;
    // An instruction says what goes there and reads like a description; a
    // capitalised noun with no verb-ish words in it is usually an example.
    const words = hint.split(/\s+/);
    if (words.length > 6) continue;
    if (/^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(hint) && !/^(The|A|An|One|Each|Any)\b/.test(hint)) {
      out.push(`${field.path}: “${hint}”`);
    }
  }
  return out.slice(0, 5);
};

export interface DraftResult {
  /** The form, ready to hand to `parseFormat`. Empty when refused. */
  text: string;
  /** Why it was refused, or null. */
  rejected: string | null;
  /** Placeholders that read like content. Advisory. */
  examples: string[];
}

/**
 * Read what the model sent back.
 *
 * Never throws, and never returns prose as a form. Everything it refuses is
 * something a reader would otherwise discover twenty passes into a run.
 */
export const readDraft = (reply: string): DraftResult => {
  const text = dropPreamble(unfence(reply ?? ''));
  const nothing = (rejected: string): DraftResult => ({ text: '', rejected, examples: [] });

  if (!text.trim()) return nothing('The model sent nothing back.');
  if (text.length > MAX_TEMPLATE_CHARS) {
    return nothing(
      `The model wrote ${text.length.toLocaleString()} characters. A form has to be restated on`
      + ' every pass, so it has to be shorter — try describing fewer sections.',
    );
  }
  if (!looksLikeForm(text)) {
    return nothing(
      'The model explained a form instead of writing one. Try again, or paste the shape you want'
      + ' into the box above yourself.',
    );
  }
  return { text, rejected: null, examples: exampleValues(text) };
};
