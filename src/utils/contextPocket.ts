/**
 * Context pockets: a zone with a job, and a task that runs several of them.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 *
 * A context zone is MATERIAL — a hand-picked set of passages — and nothing
 * else. Which means the reader who wants "all of my own messages, so you can
 * write as me" has to say the second half of that sentence again every time
 * they use the zone, and the reader who wants two of those at once (write as
 * Mara, then reply as me, then narrate around both) cannot express it at all.
 *
 * A POCKET is the missing half: a zone (or a few) plus what it is FOR and, when
 * it writes, how it should sound. Saved, so it is said once.
 *
 * A TASK is then a short ordered crew of them. Zone tasks already walk zones in
 * order into one document; a pocket task walks POCKETS, each with its own
 * material and its own brief, handing what it produced to the next.
 *
 * ── Why this is not an agent framework ─────────────────────────────────────
 *
 * Because the app already has the two pieces one would be built out of, and a
 * third would be a third thing to keep in step. `agentLoop` runs a model that
 * chooses its own tools; `longRead`/`zoneTask` walk a fixed sequence with a
 * travelling digest between stretches. A pocket task is the second of those —
 * the reader decided the order and the parts, which is the whole point — so it
 * is the same sequential walk over a different unit, and the prompt-shape rule
 * it obeys is the same one everything else here obeys:
 *
 *   reference material in the SYSTEM block, prior work next, the instruction
 *   LAST, because attention is U-shaped and the last line is the one that lands
 *   (see `utils/cowrite`, which is where this app worked that out).
 *
 * ── Why the output is always a draft ───────────────────────────────────────
 *
 * A pocket can produce messages, and messages are the story. Nothing here
 * writes into a story: a run returns text, and the reader decides whether it
 * becomes a pin, a Lens proposal to accept or reject, or nothing. That is the
 * same rule the assistant's Lens edits follow, for the same reason.
 *
 * Pure: no store, no React, no fetch. `send` is injected, exactly as in
 * `longRead` and `zoneTask`.
 */

import type { CardInfo } from '../types';
import type { ChatMsg } from './aiClient';

/* ------------------------------------------------------------------ */
/* The pocket                                                          */
/* ------------------------------------------------------------------ */

export interface ContextPocket {
  id: string;
  /** What the reader calls it: "My voice", "Mara", "The scene". */
  name: string;
  /** The zones this pocket reads. Order is theirs. */
  zoneIds: string[];
  /** One or two lines: what this pocket is for. */
  purpose: string;
  /**
   * How it should write, when it writes.
   *
   * Separate from `purpose` because they are used differently: the purpose is
   * true of every step a pocket takes, while the voice only matters when the
   * output is prose. A pocket that only ever summarises has no voice, and
   * inventing one for it would make its summaries read as performance.
   */
  voice?: string;
  createdAt: number;
  updatedAt: number;
}

/** Where a step's output is meant to end up. */
export type PocketOutput = 'drafts' | 'pin' | 'note';

export const OUTPUT_LABEL: Record<PocketOutput, { label: string; hint: string }> = {
  drafts: {
    label: 'Drafts',
    hint: 'Messages to read and keep or discard. Never written into the story.',
  },
  pin: {
    label: 'Pin',
    hint: 'Lands as the next version of the task’s pin.',
  },
  note: {
    label: 'Working note',
    hint: 'Handed to the steps after it, and not kept.',
  },
};

export interface PocketStep {
  id: string;
  pocketId: string;
  /** What this pocket is being asked to do, this time. */
  instruction: string;
  /** How many messages to produce, when that is the kind of thing asked for. */
  count?: number;
  output: PocketOutput;
}

/** A pocket's zones, already resolved to text by the caller. */
export interface PocketSection {
  zoneId: string;
  name: string;
  /** `buildZoneBody`'s output. Empty when the zone selects nothing live. */
  body: string;
}

/* ------------------------------------------------------------------ */
/* Reading a plan                                                      */
/* ------------------------------------------------------------------ */

/** A one-line description of what a pocket holds, for the picker. */
export const pocketSummary = (pocket: ContextPocket): string => {
  const zones = pocket.zoneIds.length;
  const material = zones === 0 ? 'no zones yet' : `${zones} zone${zones === 1 ? '' : 's'}`;
  return pocket.purpose.trim()
    ? `${material} · ${pocket.purpose.trim().replace(/\s+/g, ' ').slice(0, 70)}`
    : material;
};

/**
 * Steps that cannot run, and why.
 *
 * Reported rather than skipped. A crew of three that quietly ran as two
 * produces a document with a hole in it and no way to tell that is what
 * happened — the same reasoning as `usableSections` in `zoneTask`, one level up.
 */
export const planProblems = (
  steps: readonly PocketStep[],
  pockets: readonly ContextPocket[],
  sectionsFor: (pocketId: string) => readonly PocketSection[],
): string[] => {
  const out: string[] = [];
  if (!steps.length) out.push('This task has no steps yet.');
  steps.forEach((step, i) => {
    const pocket = pockets.find(p => p.id === step.pocketId);
    const where = `Step ${i + 1}`;
    if (!pocket) { out.push(`${where} names a pocket that no longer exists.`); return; }
    if (!step.instruction.trim()) out.push(`${where} (${pocket.name}) has no instruction.`);
    const usable = sectionsFor(pocket.id).filter(s => s.body.trim());
    if (!usable.length) out.push(`${where} (${pocket.name}) has no material — its zones are empty.`);
  });
  return out;
};

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

/** How much of the work so far a later step is shown. */
export const HANDOFF_CHARS = 6000;

/** The most recent stretch of prior work, cut on a paragraph. */
export const handoffOf = (prior: string, cap = HANDOFF_CHARS): string => {
  const text = prior.trim();
  if (text.length <= cap) return text;
  const cut = text.slice(text.length - cap);
  const at = cut.indexOf('\n\n');
  return at === -1 ? cut : cut.slice(at + 2);
};

export interface PocketPromptInput {
  pocket: ContextPocket;
  sections: readonly PocketSection[];
  step: PocketStep;
  /** 1-based position in the plan, and how many steps there are. */
  index: number;
  total: number;
  /** What the earlier steps produced. */
  prior?: string;
  card?: CardInfo;
  title?: string;
}

/**
 * One step's request.
 *
 * The shape is the app's standing rule about where things go, and the order is
 * load-bearing rather than tidy:
 *
 *   SYSTEM  — who this pocket is, what its material is, and the material itself.
 *             Grounding belongs at the top, where it is read as fact rather
 *             than as one more thing in the conversation.
 *   USER    — what the crew has produced so far, then the instruction, LAST.
 *
 * The instruction is the final line of the final message on purpose. Every
 * feature in this app that got that wrong produced something plausible and
 * off-brief, and every one that got it right stopped.
 */
export const buildPocketMessages = (input: PocketPromptInput): ChatMsg[] => {
  const { pocket, sections, step, index, total, prior, card, title } = input;
  const usable = sections.filter(s => s.body.trim());

  const system: string[] = [
    `You are working on "${title ?? 'a story'}" as one part of a task the reader has laid out — `
    + `step ${index} of ${total}.`,
    '',
    `## Your part: ${pocket.name}`,
    pocket.purpose.trim() || 'No purpose was given; follow the instruction exactly.',
  ];
  if (pocket.voice?.trim()) {
    system.push('', '## The voice you write in', pocket.voice.trim());
  }
  if (card?.name || card?.description) {
    system.push('', '## The character card', [
      card.name && `Name: ${card.name}`,
      card.description && `Description: ${card.description}`,
      card.personality && `Personality: ${card.personality}`,
      card.scenario && `Scenario: ${card.scenario}`,
    ].filter(Boolean).join('\n'));
  }

  system.push(
    '',
    '## Your material',
    usable.length
      ? 'Everything below was hand-picked by the reader for this part of the task. '
        + 'It is not the whole story, and the passages may not be contiguous — do not '
        + 'assume anything about what lies between them.'
      : 'The reader gave this part no material. Say so rather than inventing any.',
  );
  usable.forEach(s => {
    system.push('', `### ${s.name}`, s.body);
  });

  const user: string[] = [];
  const handoff = handoffOf(prior ?? '');
  if (handoff) {
    user.push(
      '## What the earlier steps produced',
      'This is the work so far. Continue from it; do not repeat it.',
      '',
      handoff,
      '',
    );
  }
  if (step.output === 'drafts' && step.count && step.count > 1) {
    user.push(
      `Write ${step.count} separate messages. Separate each from the next with a line `
      + 'containing only `---`, and write nothing else between them — no numbering, no '
      + 'commentary, no headings.',
      '',
    );
  }
  // Last. Always last.
  user.push(step.instruction.trim() || 'Do your part.');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') },
  ];
};

/**
 * Split a drafts step's reply back into messages.
 *
 * A model asked for five messages will separate them the way it was told to,
 * most of the time. When it does not, one long draft is a far better failure
 * than five fragments cut on a guess — so nothing is split unless the separator
 * we asked for is actually there.
 */
export const splitDrafts = (reply: string): string[] => {
  const text = reply.trim();
  if (!text) return [];
  const parts = text.split(/\n\s*---+\s*\n/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [text];
};

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface PocketStepResult {
  stepId: string;
  pocketId: string;
  pocketName: string;
  output: PocketOutput;
  text: string;
  /** For a drafts step, the reply split into separate messages. */
  drafts: string[];
}

export interface PocketRunOptions {
  steps: readonly PocketStep[];
  pockets: readonly ContextPocket[];
  /** A pocket's zones, resolved. Called once per step, so late edits are seen. */
  sectionsFor: (pocketId: string) => readonly PocketSection[];
  card?: CardInfo;
  title?: string;
  send: (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  onStep?: (done: number, total: number, pocketName: string) => void;
}

export interface PocketRunResult {
  results: PocketStepResult[];
  /** Every step that produced something to keep, joined — the task's document. */
  document: string;
  /** Steps that could not run, by their position. */
  skipped: string[];
  aborted: boolean;
}

/**
 * Run the steps in order, each seeing what the ones before it made.
 *
 * Sequential, with no concurrent mode, and for a stronger reason than in
 * `zoneTask`: a reader who wrote "Mara speaks, then I answer, then narrate
 * around both" has expressed a dependency, not a preference. Steps that cannot
 * see each other cannot honour it.
 *
 * A 'note' step is working material: its text is handed on and does not appear
 * in the document. That is what makes the reader's third pocket — the one that
 * stitches the other two together — expressible without its scaffolding
 * turning up in the result.
 */
export const runPockets = async (opts: PocketRunOptions): Promise<PocketRunResult> => {
  const results: PocketStepResult[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  let prior = '';
  const total = opts.steps.length;

  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) break;
    const step = opts.steps[i];
    const pocket = opts.pockets.find(p => p.id === step.pocketId);
    if (!pocket) { skipped.push(`Step ${i + 1}`); continue; }

    const sections = opts.sectionsFor(pocket.id);
    if (!sections.some(s => s.body.trim())) {
      skipped.push(`Step ${i + 1} (${pocket.name})`);
      continue;
    }

    opts.onStep?.(i, total, pocket.name);
    const reply = await opts.send(buildPocketMessages({
      pocket,
      sections,
      step,
      index: i + 1,
      total,
      prior,
      card: opts.card,
      title: opts.title,
    }), opts.signal);

    const text = reply.trim();
    if (!text) { skipped.push(`Step ${i + 1} (${pocket.name}) — the model returned nothing`); continue; }

    const drafts = step.output === 'drafts' ? splitDrafts(text) : [];
    results.push({
      stepId: step.id,
      pocketId: pocket.id,
      pocketName: pocket.name,
      output: step.output,
      text,
      drafts,
    });

    // Everything is handed on — including a note, which exists only to be
    // handed on — but only the keepable steps become the document.
    prior = prior ? `${prior}\n\n## ${pocket.name}\n${text}` : `## ${pocket.name}\n${text}`;
    if (step.output !== 'note') kept.push(`## ${pocket.name}\n\n${text}`);
  }

  opts.onStep?.(total, total, '');
  return {
    results,
    document: kept.join('\n\n'),
    skipped,
    aborted: !!opts.signal?.aborted,
  };
};
