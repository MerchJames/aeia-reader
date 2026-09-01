/**
 * A saved job: walk these zones, in this order, into that document.
 *
 * The long read already builds one designed document out of a story too big to
 * hold — sections in order, a travelling key between them, the format restated
 * on every pass so it cannot drift. What it does not do is let the reader
 * choose the sections. `chunkByBudget` cuts the transcript wherever the budget
 * runs out, which is right when the job is "read the whole thing" and wrong
 * when the job is "read the three parts I care about, in the order I care
 * about them".
 *
 * So a zone task is the same engine over a named list. Three differences, and
 * each one is the reason it is a separate thing rather than an option:
 *
 * **The sections are the reader's.** Context zones already exist, already
 * persist, and already render themselves into a prompt block. A task is an
 * ORDER over them, so re-running after editing zone two re-reads zone two and
 * nothing else changes shape.
 *
 * **The form is fixed and belongs to the task, not the run.** This is the whole
 * point: the document's shape is authored once, stored, and restated to the
 * model on every single pass — the property `LongReadJob.format` was built for
 * and the reason a twenty-pass document does not come out as twenty documents
 * stapled together. Re-running a task produces the same shape with new
 * material, rather than whatever the model felt like this time.
 *
 * **It lands as a version of a specific pin.** Not a new pin per run, not a
 * designated "summary pin" — the one the reader chose. Version four of a
 * document is a document with a history; four pins called "Mara's arc" is a
 * mess, and the reader is the one who has to live in the dock.
 *
 * Pure: no store, no React, no fetch. The caller resolves the zones (that needs
 * the store) and injects `send`, exactly as `runLongRead` is called.
 */

import { CardInfo } from '../types';
import { ChatMsg } from './aiClient';
import {
  LongReadJob, PassResult, buildAssembleMessages, buildPassMessages,
  keyHistory, keyLabels, outlineOf, parsePass, tailOf,
} from './longRead';

/* ------------------------------------------------------------------ */
/* The task                                                            */
/* ------------------------------------------------------------------ */

export interface ZoneTask {
  id: string;
  name: string;
  /**
   * The zones to read, IN ORDER. Order is the whole content of this field —
   * a set would lose the one thing the reader is expressing.
   */
  zoneIds: string[];
  /** One line: what this document is. */
  purpose: string;
  /** The fixed shape, restated on every pass. */
  format: string;
  /** What the travelling key must carry between sections. */
  keyBrief: string;
  /**
   * Front matter, written once at the end — or absent.
   *
   * Optional because a fixed-form document often IS its sections: a tracker
   * that gains a row per zone wants no premise written over it, and an assemble
   * pass would rewrite the top of the document on every run, which is precisely
   * the "remaking the form every time" this exists to stop.
   */
  assemble?: string;
  /** The pin this document lives in. Null until the reader picks one. */
  targetPinId: string | null;
  /** A steer applied to every pass, on top of the format. */
  instruction?: string;
  createdAt: number;
  updatedAt: number;
  lastRun?: {
    at: number;
    sections: number;
    /** 1-based version the run produced, or null if it never landed. */
    pinVersion: number | null;
  };
}

/** One zone, resolved to the text it renders as. */
export interface ZoneSection {
  zoneId: string;
  name: string;
  /** `buildZoneBody`'s output. Empty when the zone selects nothing live. */
  body: string;
}

/**
 * Adapt a task to the shape `buildPassMessages` already speaks.
 *
 * Deliberately a conversion rather than a second prompt builder: the pass
 * prompt is where the "restate the format every time" property lives, and a
 * copy of it here would be a copy that drifts.
 */
export const taskToJob = (task: ZoneTask): LongReadJob => ({
  id: task.id,
  label: task.name,
  purpose: task.purpose,
  format: task.format,
  keyBrief: task.keyBrief,
  assemble: task.assemble ?? '',
});

/**
 * Drop the zones that would contribute nothing.
 *
 * An empty zone must not become an empty section: the model is told it is
 * reading section 3 of 5 and handed nothing, and a conscientious one will
 * invent a section rather than admit the stretch was blank. Skipped zones are
 * reported so the panel can say which, rather than the reader finding out from
 * a document that is short.
 */
export const usableSections = (sections: readonly ZoneSection[]): {
  used: ZoneSection[];
  skipped: string[];
} => {
  const used: ZoneSection[] = [];
  const skipped: string[] = [];
  for (const s of sections) {
    if (s.body.trim()) used.push(s);
    else skipped.push(s.name);
  }
  return { used, skipped };
};

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export type ZoneTaskPhase = 'reading' | 'assembling' | 'done';

export interface ZoneTaskRunOptions {
  task: ZoneTask;
  /** The task's zones, resolved and in the task's order. */
  sections: readonly ZoneSection[];
  card?: CardInfo;
  title?: string;
  send: (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  /** `zoneName` is the section being read, for a progress line worth reading. */
  onPhase?: (phase: ZoneTaskPhase, done: number, total: number, zoneName?: string) => void;
}

export interface ZoneTaskResult {
  document: string;
  /** The notes the read ended with. */
  key: string;
  sections: number;
  /** Passes whose reply did not follow the format — see LongReadResult.malformed. */
  malformed: number;
  /** Zones that selected nothing, by name. */
  skipped: string[];
  aborted: boolean;
}

/**
 * Read the zones in order into one document.
 *
 * Strictly sequential, with no concurrent mode. `runLongRead` offers one and
 * calls it "strictly worse"; here it would be worse still, because a reader who
 * ordered three zones by hand is asserting that section two follows section one
 * — and passes that cannot see each other cannot honour an order.
 */
export const runZoneTask = async (opts: ZoneTaskRunOptions): Promise<ZoneTaskResult> => {
  const { used, skipped } = usableSections(opts.sections);
  const total = used.length;
  if (!total) {
    return { document: '', key: '', sections: 0, skipped, aborted: false, malformed: 0 };
  }

  const job = taskToJob(opts.task);
  const labels = keyLabels(opts.task.keyBrief);
  let malformed = 0;
  const parts: string[] = [];
  let doc = '';
  let key = '';
  /** What was known after each zone — the front matter reads the whole arc. */
  const keys: string[] = [];

  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) break;
    const section = used[i];
    opts.onPhase?.('reading', i, total, section.name);
    const messages = buildPassMessages({
      job,
      // The zone arrives already formatted by `buildZoneBody` — its own header,
      // its own index, its branchlines in the tail. Passed as one nameless
      // passage so `passageText` hands it through untouched rather than
      // prefixing a speaker onto a block that is not a speech.
      section: [{ name: '', content: section.body }],
      index: i + 1,
      total,
      key,
      tail: tailOf(doc),
      card: opts.card,
      instruction: opts.task.instruction,
      sectionLabel: section.name,
    });
    const out: PassResult = parsePass(await opts.send(messages, opts.signal), key, labels);
    if (out.issue !== 'ok') malformed++;
    if (out.section) {
      parts.push(out.section);
      doc = doc ? `${doc}\n\n${out.section}` : out.section;
    }
    key = out.key;
    keys.push(key);
  }

  opts.onPhase?.('reading', total, total);
  const body = parts.join('\n\n');
  if (!body) {
    return { document: '', key, sections: 0, skipped, aborted: !!opts.signal?.aborted, malformed };
  }

  // Front matter, only when the task asked for one and the run finished. A
  // half-read document must not be given a confident summary of an ending
  // nobody reached — the same rule `runLongRead` follows.
  let front = '';
  if (opts.task.assemble?.trim() && !opts.signal?.aborted) {
    opts.onPhase?.('assembling', total, total);
    try {
      front = (await opts.send(
        buildAssembleMessages(job, outlineOf(body), key, opts.card, opts.title, keyHistory(keys)),
        opts.signal,
      )).trim();
    } catch { front = ''; }
  }
  opts.onPhase?.('done', total, total);

  return {
    document: front ? `${front}\n\n${body}` : body,
    key,
    sections: parts.length,
    skipped,
    malformed,
    aborted: !!opts.signal?.aborted,
  };
};

/* ------------------------------------------------------------------ */
/* Starting points                                                     */
/* ------------------------------------------------------------------ */

/**
 * A blank task, seeded from one of the long read's jobs.
 *
 * The four jobs are the formats this app has already thought hardest about, and
 * a reader building their first task should start from one rather than from an
 * empty textarea. The copy is deliberate: editing a task must never edit the
 * built-in job it came from.
 */
export const taskFromJob = (
  job: LongReadJob, name: string, id: string, now = Date.now(),
): ZoneTask => ({
  id,
  name,
  zoneIds: [],
  purpose: job.purpose,
  format: job.format,
  keyBrief: job.keyBrief,
  assemble: job.assemble,
  targetPinId: null,
  createdAt: now,
  updatedAt: now,
});
