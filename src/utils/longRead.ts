/**
 * The long read — one machine for any job too big to fit in a context window.
 *
 * A 556-message roleplay is 300k tokens of material and no model holds it. The
 * app's answer so far was map-reduce (`summarizer.ts`): cut it into chunks,
 * summarise each one alone, fold the results. That works and it has two costs
 * that show up in the output every time.
 *
 * **Each chunk reads blind.** Section 5 does not know that the woman at the
 * door in section 2 was the sister, so it introduces her again as a stranger.
 * Fold twenty of those together and you get a document that repeats itself and
 * contradicts itself, because no pass ever knew what the others found.
 *
 * **Nothing decides the shape.** The reduce step is handed twenty summaries and
 * asked to make one, so the format is whatever the last prompt happened to
 * encourage. A document nobody designed reads like one.
 *
 * So this engine does it the way a person reads a long book with a notebook:
 *
 * 1. **A travelling key.** A small, hard-capped digest — who is where, what is
 *    open, where we just were — rewritten by the model at every pass and handed
 *    to the next one. This is the whole difference between sections that know
 *    each other and sections that do not.
 * 2. **One document, appended to.** Each pass writes the next stretch OF the
 *    document rather than a standalone summary to be merged later.
 * 3. **Flat cost per pass.** Only the key and the document's TAIL travel
 *    forward, never the whole document — otherwise the last pass of a long
 *    story is the most expensive one and the most likely to truncate.
 * 4. **An assembly pass at the end** that writes the front matter (the premise,
 *    the cast, what is still open) from the finished key and the section
 *    headings. The shape is designed once, here, instead of being whatever fell
 *    out of a fold.
 *
 * The job — what document to build and what the key should hold — is data
 * (`LongReadJob`), so a summary, a structural read of the acts, a character
 * chart and a priming brief are four job definitions over one engine rather
 * than four half-implementations of the same traversal.
 *
 * Pure: no store, no React, no fetch. `send` is injected.
 */

import { CardInfo } from '../types';
import { cardToPromptBlock } from './cardContext';
import { ChatMsg } from './aiClient';
import { SummaryPassage, chunkByBudget } from './summarizer';

/* ------------------------------------------------------------------ */
/* The job                                                             */
/* ------------------------------------------------------------------ */

export interface LongReadJob {
  id: string;
  /** Shown to the reader while it runs. */
  label: string;
  /** One line: what this document IS. Goes at the top of every pass. */
  purpose: string;
  /**
   * The shape of the document, taught once and restated on every pass.
   *
   * Restated deliberately: a format given only in the first pass drifts by the
   * fourth, and drift in a document assembled from twenty passes is not a
   * wobble — it is twenty different documents stapled together.
   */
  format: string;
  /** What the travelling key must hold for THIS job. */
  keyBrief: string;
  /** How the front matter is written once the read is done. */
  assemble: string;
}

export const SUMMARY_JOB: LongReadJob = {
  id: 'summary',
  label: 'Reading the whole story',
  purpose: 'a faithful running account of a long story, written for someone who has not read it',
  format: [
    'Write the next stretch as ONE section:',
    '',
    '### <a short title for what happens in this stretch>',
    '<2–5 short paragraphs of plain past-tense prose. Name people the first time',
    'they appear in the DOCUMENT SO FAR, and afterwards use their name alone.>',
    '',
    'No bullet lists, no headers other than the one above, no commentary about',
    'summarising. Write what happened, in order, at the weight it deserves — a',
    'stretch where nothing happened gets two sentences, not two paragraphs.',
  ].join('\n'),
  keyBrief: [
    'WHO: every named person who has appeared, one clause each on who they are.',
    'WHERE: where the story currently is.',
    'OPEN: threads raised and not yet resolved.',
    'LAST: the final beat of this stretch, in one sentence, so the next section '
    + 'can continue from it rather than restart.',
  ].join('\n'),
  assemble: [
    'Write ONLY the front matter that goes above the sections — do not rewrite them.',
    '',
    '# <the story\'s title>',
    '',
    '**<one-sentence premise>**',
    '',
    '## Who',
    '<one line per significant person: name — who they are, where they end up>',
    '',
    '## Still open',
    '<bullets for threads the story never resolved; omit this heading entirely if none>',
  ].join('\n'),
};

export const TIMELINE_JOB: LongReadJob = {
  id: 'timeline',
  label: 'Building the timeline',
  purpose: 'a timeline of a long story — what happened, in order, with nothing invented between',
  format: [
    'Write the next stretch as ONE section:',
    '',
    '### <a short title for this stretch>',
    '- **<when, in the story\'s own terms — "that evening", "three days later",',
    '  "later the same night">** — <what happened, one sentence>',
    '',
    'One bullet per beat that actually moved the story. A conversation that',
    'changed nothing is not a beat. If the story gives no sense of elapsed time,',
    'write **—** for the when rather than guessing a duration.',
  ].join('\n'),
  keyBrief: [
    'WHEN: where the clock stands now (time of day, days elapsed if the story says).',
    'WHERE: the current place.',
    'OPEN: anything scheduled, promised or threatened that has not happened yet.',
    'LAST: the final beat of this stretch, one sentence.',
  ].join('\n'),
  assemble: [
    'Write ONLY the front matter that goes above the timeline.',
    '',
    '# <the story\'s title> — timeline',
    '',
    '**<one sentence: the span the story covers, in its own terms>**',
    '',
    '## Still to come',
    '<bullets for anything scheduled or promised that never happened; omit the heading if none>',
  ].join('\n'),
};

export const CAST_JOB: LongReadJob = {
  id: 'cast',
  label: 'Reading the cast',
  purpose: 'a character chart for a long story — who everyone is and how they change',
  format: [
    'Write the next stretch as ONE section:',
    '',
    '### Stretch <n>',
    '| Who | What they did here | What it changed |',
    '| --- | --- | --- |',
    '| <name> | <one clause> | <what is different about them now, or "—"> |',
    '',
    'Only people who actually appear in THIS stretch. Somebody merely mentioned',
    'is not in the chart. If a person appears and nothing about them changes,',
    'write "—" in the last column rather than inventing growth.',
  ].join('\n'),
  keyBrief: [
    'WHO: every named person so far — name, one clause on who they are, and their',
    'current state in a few words.',
    'BETWEEN: the relationships that matter, one line each ("Mara ↔ Sable: wary").',
    'LAST: where each of them stands at the end of this stretch.',
  ].join('\n'),
  assemble: [
    'Write ONLY the front matter that goes above the per-stretch tables.',
    '',
    '# <the story\'s title> — cast',
    '',
    '## The people',
    '| Who | Who they are | Where they end up |',
    '| --- | --- | --- |',
    '',
    'One row per person who mattered. Leave the walk-ons out.',
  ].join('\n'),
};

export const PRIMING_JOB: LongReadJob = {
  id: 'priming',
  label: 'Writing a priming brief',
  purpose:
    'a priming brief — everything a model would need to pick this story up and continue it in voice',
  format: [
    'Write the next stretch as ONE section:',
    '',
    '### Stretch <n>',
    '**Established:** <facts now true that a continuation must not contradict —',
    'names, places, what happened, what was said out loud. Bullets.>',
    '**Voice:** <how the characters in this stretch actually speak — sentence',
    'length, habits, one short verbatim line each as evidence.>',
    '',
    'Facts and voice only. Not a summary of events for their own sake — this',
    'document exists so somebody can write the NEXT page without contradicting',
    'the last five hundred.',
  ].join('\n'),
  keyBrief: [
    'CANON: the facts that must not be contradicted, tersest form.',
    'VOICE: how each speaker sounds, one clause each.',
    'OPEN: what is unresolved and could be written into next.',
    'LAST: exactly where the story stands at this moment.',
  ].join('\n'),
  assemble: [
    'Write ONLY the front matter that goes above the sections.',
    '',
    '# Priming — <the story\'s title>',
    '',
    '**Premise:** <one sentence>',
    '',
    '## Voices',
    '<one line per speaker: name — how they sound>',
    '',
    '## Where it stands',
    '<3–6 bullets: the situation a continuation would open on>',
    '',
    '## Do not contradict',
    '<the handful of facts most likely to be got wrong>',
  ].join('\n'),
};

/** Every job the long read can run. */
export const LONG_READ_JOBS: readonly LongReadJob[] = [
  SUMMARY_JOB, TIMELINE_JOB, CAST_JOB, PRIMING_JOB,
];

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The travelling key's ceiling, in characters.
 *
 * Hard-capped rather than trusted: a key is rewritten by the model at every
 * pass, and anything a model rewrites twenty times grows. Left unbounded it
 * becomes a second summary riding along inside the first, and by the last
 * section it is eating the context the actual transcript needs.
 */
export const KEY_CHARS = 1400;
/** How much of the document's tail travels forward (see §3 above). */
export const TAIL_CHARS = 1200;
/** Section headings sent to the assembly pass. */
export const OUTLINE_CHARS = 2000;

const SECTION_MARK = '<<<SECTION>>>';
const CARRY_MARK = '<<<CARRY>>>';

/** Trim to a cap without cutting mid-word. */
export const clip = (s: string, cap: number): string => {
  const t = s.trim();
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const space = cut.lastIndexOf(' ');
  return `${(space > cap * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** The tail of the document, from a heading boundary where one is near. */
export const tailOf = (doc: string, cap = TAIL_CHARS): string => {
  if (doc.length <= cap) return doc.trim();
  const tail = doc.slice(doc.length - cap);
  const head = tail.indexOf('\n### ');
  return (head > 0 ? tail.slice(head + 1) : tail).trim();
};

/** Just the section headings, for the assembly pass. */
export const outlineOf = (doc: string, cap = OUTLINE_CHARS): string =>
  clip((doc.match(/^###\s+.*$/gm) ?? []).join('\n'), cap);

/* ------------------------------------------------------------------ */
/* One pass                                                            */
/* ------------------------------------------------------------------ */

export interface PassInput {
  job: LongReadJob;
  /** This stretch of the story, in order. */
  section: SummaryPassage[];
  index: number;
  total: number;
  /** The travelling key from the previous pass ('' on the first). */
  key: string;
  /** The tail of the document so far ('' on the first). */
  tail: string;
  card?: CardInfo;
  /** The reader's own steer, applied to every pass. */
  instruction?: string;
  /**
   * What this stretch IS, when the sections were chosen rather than cut.
   *
   * A long read slices by budget, so "stretch 2 of 5" is the truest thing that
   * can be said about a section. A zone task walks a list the reader named —
   * "Act I", then "The siege" — and the name is the only thing distinguishing
   * one section from the next. Losing it means every pass reads as an arbitrary
   * slice of a continuous story, which is exactly what these are not.
   */
  sectionLabel?: string;
}

const passageText = (chunk: SummaryPassage[]): string =>
  chunk.map(p => (p.name ? `${p.name}: ${p.content}` : p.content)).join('\n\n');

/**
 * Build one pass.
 *
 * The reply carries BOTH the new section and the rewritten key, in one call,
 * separated by markers. Two calls per section would double the cost of every
 * long read for a digest that the model has just finished thinking about
 * anyway — it is cheaper and more coherent to ask for it while the material is
 * still in front of it.
 */
export const buildPassMessages = (input: PassInput): ChatMsg[] => {
  const { job } = input;
  const card = cardToPromptBlock(input.card);
  const first = input.index === 1;

  const system = [
    `You are building ${job.purpose}.`,
    `You are reading it in ${input.total} stretches, in order. This is stretch ${input.index}.`,
    '',
    'FORMAT — the section you write now:',
    job.format,
    '',
    `Then, after a line containing exactly ${CARRY_MARK}, rewrite the notes you`,
    'are carrying forward. They are for YOU on the next stretch, not for the',
    'reader — nobody ever sees them. Keep them under',
    `${KEY_CHARS} characters; drop what no longer matters rather than appending.`,
    job.keyBrief,
    '',
    'Answer with the section, then the marker, then the notes. Nothing else.',
    // Spelled out because both mistakes are common and both used to be
    // expensive: notes written first cost the whole section, and a reply
    // wrapped in a fence put ``` in the middle of the reader's document.
    'The SECTION COMES FIRST, always. Never write the notes before it.',
    'Do not wrap your reply in a code fence.',
    'Never invent events. If a stretch is unclear, say less.',
  ].join('\n');

  const user = [
    card && `STORY CONTEXT (grounding only):\n${card}`,
    input.key && `NOTES YOU CARRIED HERE:\n${input.key}`,
    input.tail && `THE DOCUMENT SO FAR ENDS LIKE THIS — continue from it, do not repeat it:\n${input.tail}`,
    first
      ? 'This is the beginning of the story.'
      : `Stretches 1–${input.index - 1} are already written. Do not summarise them again.`,
    `--- ${input.sectionLabel
      ? `${input.sectionLabel.toUpperCase()} — SECTION ${input.index} OF ${input.total}`
      : `STRETCH ${input.index} OF ${input.total}`} ---\n${passageText(input.section)}`,
    input.instruction && `THE READER ASKS: ${input.instruction}`,
    `Write section ${input.index}, then ${CARRY_MARK}, then your notes.`,
  ].filter(Boolean).join('\n\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

/**
 * How well one reply followed the format.
 *
 * Reported rather than swallowed. Every one of these used to be handled
 * silently, which meant a run could pay for twelve passes, keep three, and tell
 * the reader nothing — they found out from a document that covered the last
 * quarter of their story and had no way to know why.
 */
export type PassIssue =
  /** Section, marker, notes, in that order. */
  | 'ok'
  /** No marker at all: the notes could not be separated and the key stood still. */
  | 'no-marker'
  /** The layout was wrong and the section had to be dug out of it. */
  | 'recovered';

export interface PassResult {
  section: string;
  key: string;
  issue: PassIssue;
}

/** The marker, however the model decorated it. */
const CARRY_CORE = /<<<\s*CARRY\s*>>>/i;
/** Emphasis and fence characters a model wraps a marker in. */
const DECORATION = /[\s*_~`]+/;

/**
 * Strip a fence the model opened and never closed on this side of the marker.
 *
 * Only when the count is ODD — a section that legitimately contains a balanced
 * code block keeps it. An orphan is the tell that the reply was wrapped whole
 * and the split cut the wrapper in half.
 */
const dropOrphanFence = (s: string): string => {
  if (((s.match(/```/g) ?? []).length) % 2 !== 1) return s;
  return s.replace(/^\s*```[a-z]*[ \t]*\n?/i, '').replace(/\n?[ \t]*```\s*$/, '').trim();
};

/** Where the document proper resumes — every job's format opens with a heading. */
const headingAt = (s: string): number => {
  const m = s.match(/(?:^|\n)#{1,6} /);
  return m?.index === undefined ? -1 : (m.index === 0 ? 0 : m.index + 1);
};

/**
 * The labels a job's notes use ("WHO:", "LAST:"), read off its own brief.
 *
 * Lets a reply that forgot the marker still have its notes lifted off the end
 * rather than left in the reader's document, without this function having to
 * know anything about which job it is.
 */
export const keyLabels = (keyBrief: string): string[] =>
  (keyBrief.match(/^[A-Z][A-Z ]{1,14}:/gm) ?? []).map(s => s.trim());

/**
 * Split a reply into the section and the notes.
 *
 * Fails soft, but in ONE direction only: **the section is never lost.** Losing
 * the notes costs continuity on the next pass; losing the section costs the
 * pass, and a run that drops half its passes produces a document about the
 * wrong half of the story while reporting success. That asymmetry is the whole
 * design of this function — when the layout cannot be read, everything becomes
 * the section.
 *
 * @param labels the job's note labels, from `keyLabels`. Optional; without them
 *   a reply that omits the marker keeps its notes in the section rather than
 *   having them guessed at.
 */
export const parsePass = (reply: string, previousKey = '', labels: string[] = []): PassResult => {
  const text = (reply ?? '').replace(SECTION_MARK, '').trim();
  const m = text.match(CARRY_CORE);

  if (!m || m.index === undefined) {
    // No marker. Try to lift the notes off the end by their own labels, so the
    // model's private working does not end up in the reader's document.
    const at = labels.length
      ? labels
        .map(l => {
          const hit = text.match(new RegExp(`(?:^|\\n)[ \\t*_>-]*${l}`, 'i'));
          return hit?.index === undefined ? -1 : hit.index;
        })
        .filter(i => i > 0)
        .sort((a, b) => a - b)[0] ?? -1
      : -1;
    if (at > 0) {
      return {
        // A model that announces its notes ("Notes for next time:") leaves the
        // announcement on the section side of the cut. It is not prose and it
        // is not a heading, so it would sit in the reader's document as litter.
        section: dropOrphanFence(text.slice(0, at).trim())
          .replace(/\n[ \t*_>-]*(?:notes?|carry(?:ing)?|carried)\b[^\n]{0,40}:?[ \t*_]*$/i, '')
          .trim(),
        key: clip(text.slice(at).trim(), KEY_CHARS) || previousKey,
        issue: 'no-marker',
      };
    }
    return { section: dropOrphanFence(text), key: previousKey, issue: 'no-marker' };
  }

  const before = dropOrphanFence(text.slice(0, m.index).replace(new RegExp(`${DECORATION.source}$`), ''));
  const after = dropOrphanFence(
    text.slice(m.index + m[0].length).replace(new RegExp(`^${DECORATION.source}`), ''),
  );

  if (before) {
    return {
      section: before,
      key: clip(after, KEY_CHARS) || previousKey,
      issue: 'ok',
    };
  }

  // Nothing before the marker: the model wrote its notes first. The section is
  // still in there — this is the case that used to return an empty section and
  // throw the whole pass away.
  const h = headingAt(after);
  if (h > 0) {
    return {
      section: after.slice(h).trim(),
      key: clip(after.slice(0, h).trim(), KEY_CHARS) || previousKey,
      issue: 'recovered',
    };
  }
  // Cannot tell the two apart. Keep it all as the section rather than none of
  // it, and leave the previous notes travelling.
  return { section: after, key: previousKey, issue: 'recovered' };
};

/** The final pass: front matter over a finished body. */
/** How much of the run's accumulated notes reach the assembly pass. */
export const HISTORY_CHARS = 6000;

/**
 * Every stage of the read, condensed for the pass that writes the front matter.
 *
 * The assembly pass used to receive the outline and the FINAL key, and that is
 * not enough to write what it is asked for. The key is deliberately end-state —
 * the timeline job's own brief says "WHEN: where the clock stands NOW", "LAST:
 * the final beat" — and it is rewritten at every pass with an instruction to
 * "drop what no longer matters". So the model asked to write the premise, the
 * cast and what is still open had seen a table of contents and a note about the
 * last night of the story. It could not describe the beginning because nothing
 * had told it what the beginning was.
 *
 * The trap in fixing this is recency, the same one `tasteBlock` guards against:
 * a cap that keeps the most recent notes and drops the rest reproduces the
 * original bug with more steps. So when the history will not fit, EVERY stage
 * is clipped to an equal share rather than the early ones being dropped — a
 * thinner view of the whole read beats a complete view of its end.
 */
export const keyHistory = (keys: readonly string[], cap = HISTORY_CHARS): string => {
  // A pass whose notes did not change said nothing new; two identical entries
  // in a row are noise in a document meant to show how things developed.
  const kept: string[] = [];
  for (const k of keys) {
    const t = (k ?? '').trim();
    if (t && t !== kept[kept.length - 1]) kept.push(t);
  }
  if (!kept.length) return '';

  const label = (i: number) => `--- after stretch ${i + 1} ---`;
  const whole = kept.map((k, i) => `${label(i)}\n${k}`).join('\n\n');
  if (whole.length <= cap) return whole;

  // Equal shares, floored so a very long run still says something per stage.
  const overhead = kept.reduce((n, _, i) => n + label(i).length + 2, 0);
  const share = Math.max(120, Math.floor((cap - overhead) / kept.length));
  return kept.map((k, i) => `${label(i)}\n${clip(k, share)}`).join('\n\n');
};

export const buildAssembleMessages = (
  job: LongReadJob, outline: string, key: string, card?: CardInfo, title?: string,
  /**
   * The notes from every stage, oldest first (`keyHistory`). When present it
   * replaces the single end-state key — it contains it, and more.
   */
  history?: string,
): ChatMsg[] => [
  {
    role: 'system',
    content: [
      `You are finishing ${job.purpose}. The body is written; you add the front matter.`,
      '',
      job.assemble,
      '',
      'Use ONLY what the outline and notes below contain. Invent nothing.',
      history
        ? 'The notes are a record of what was known at each stage, oldest first. '
          + 'Read them as one arc: the front matter describes the WHOLE story, not its ending.'
        : '',
    ].filter(Boolean).join('\n'),
  },
  {
    role: 'user',
    content: [
      title && `The story is called "${title}".`,
      cardToPromptBlock(card),
      history
        ? `WHAT WAS KNOWN AT EACH STAGE OF THE READ:\n${history}`
        : (key && `NOTES FROM THE READ:\n${key}`),
      `SECTION HEADINGS, IN ORDER:\n${outline}`,
      'Write the front matter only.',
    ].filter(Boolean).join('\n\n'),
  },
];

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export type LongReadPhase = 'reading' | 'assembling' | 'done';

export interface LongReadOptions {
  job: LongReadJob;
  passages: SummaryPassage[];
  budgetChars: number;
  card?: CardInfo;
  title?: string;
  instruction?: string;
  /**
   * How many passes may be in flight at once.
   *
   * 1 (the default) is the coherent mode: each pass sees the notes the previous
   * one wrote, which is the entire reason this engine exists. Higher is faster
   * and strictly worse — parallel passes cannot carry notes to each other, so
   * they read blind and the seams show. Offered because a fifty-section read on
   * a slow local model is otherwise a coffee break, but never the default.
   */
  concurrency?: number;
  send: (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  onPhase?: (phase: LongReadPhase, done: number, total: number) => void;
}

export interface LongReadResult {
  /** The finished document: front matter, then the sections in order. */
  document: string;
  /** The notes the read ended with — reusable to prime another job. */
  key: string;
  sections: number;
  /** True when the run was stopped early; the document is what it got to. */
  aborted: boolean;
  /**
   * Passes whose reply did not follow the format.
   *
   * Surfaced so a poor document has a stated cause. A model that ignores the
   * carry marker turns this engine back into the map-reduce it replaced — every
   * pass reading blind — and the only symptom is prose that repeats itself.
   */
  malformed: number;
  /** Passes that never handed notes forward, so the next one read blind. */
  blind: number;
}

/** Read a whole story into one document. */
export const runLongRead = async (opts: LongReadOptions): Promise<LongReadResult> => {
  const sections = chunkByBudget(opts.passages, opts.budgetChars);
  const total = sections.length;
  if (!total) {
    return { document: '', key: '', sections: 0, aborted: false, malformed: 0, blind: 0 };
  }

  const lanes = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1), 8));
  const parts: string[] = [];
  const labels = keyLabels(opts.job.keyBrief);
  /** What was known after each pass — the assembly pass reads the whole arc. */
  const keys: string[] = [];
  let key = '';
  let malformed = 0;
  let blind = 0;
  const tally = (out: PassResult, carried: string) => {
    if (out.issue !== 'ok') malformed++;
    // "Blind" is about the NEXT pass: the notes did not move on, so it will
    // read this stretch of the story with nothing from the one before it.
    if (out.key === carried) blind++;
  };

  const passFor = (i: number, carriedKey: string, tail: string) =>
    buildPassMessages({
      job: opts.job,
      section: sections[i],
      index: i + 1,
      total,
      key: carriedKey,
      tail,
      card: opts.card,
      instruction: opts.instruction,
    });

  if (lanes === 1) {
    // The coherent path: every pass reads the notes the last one wrote.
    let doc = '';
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) break;
      opts.onPhase?.('reading', i, total);
      const out = parsePass(await opts.send(passFor(i, key, tailOf(doc)), opts.signal), key, labels);
      tally(out, key);
      if (out.section) {
        parts.push(out.section);
        doc = doc ? `${doc}\n\n${out.section}` : out.section;
      }
      key = out.key;
      keys.push(key);
    }
  } else {
    // The fast path. No notes travel, because there is nobody to travel from —
    // every lane starts where the story starts. Sections come back in order
    // regardless of which finished first.
    const done: (PassResult | null)[] = new Array(total).fill(null);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= total || opts.signal?.aborted) return;
        done[i] = parsePass(await opts.send(passFor(i, '', ''), opts.signal), '', labels);
        opts.onPhase?.('reading', done.filter(Boolean).length, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, total) }, worker));
    for (const d of done) {
      if (!d) continue;
      if (d.issue !== 'ok') malformed++;
      if (d.section) parts.push(d.section);
    }
    // Every lane read blind by construction, which is what this mode trades.
    blind = total;
    // Each lane's notes are still a record of ITS stretch, so the assembly pass
    // gets the whole arc here too — it is the one step that benefits from the
    // fast path having read every part of the story, even if blindly.
    for (const d of done) if (d?.key) keys.push(d.key);
    key = done.filter(Boolean).map(d => d!.key).filter(Boolean).join('\n');
    key = clip(key, KEY_CHARS);
  }

  opts.onPhase?.('reading', total, total);
  const body = parts.join('\n\n');
  if (!body) {
    return {
      document: '', key, sections: 0, aborted: !!opts.signal?.aborted, malformed, blind,
    };
  }

  // Front matter, unless we were stopped — a half-read story should not be
  // handed a confident premise for an ending nobody reached.
  let front = '';
  if (!opts.signal?.aborted) {
    opts.onPhase?.('assembling', 0, 1);
    try {
      front = (await opts.send(
        buildAssembleMessages(
          opts.job, outlineOf(body), key, opts.card, opts.title, keyHistory(keys),
        ),
        opts.signal,
      )).trim();
    } catch { front = ''; }
  }
  opts.onPhase?.('done', total, total);

  return {
    document: front ? `${front}\n\n${body}` : body,
    key,
    sections: parts.length,
    aborted: !!opts.signal?.aborted,
    malformed,
    blind,
  };
};
