/**
 * The agent turn: send, run what it asked for, send again, until it answers.
 *
 * Three things make this more than a `while` loop, and all three are borrowed
 * from Codex's own harness because they are the problems every agent loop meets
 * in the same order.
 *
 * **A ceiling on steps.** A model that misreads a tool result will ask for it
 * again, and again. The cap is not a safety net for a rare case; it is the
 * ordinary behaviour of a small local model on a bad day, and this app is aimed
 * squarely at small local models.
 *
 * **Repeats are answered from cache.** A model that asks twice for the same
 * thing in one turn gets the same result back with a note saying so, rather
 * than a second read at full price. That breaks the commonest loop before the
 * step cap has to, and it costs nothing.
 *
 * **Compaction.** Tool results accumulate in the working history and are
 * re-sent on every subsequent step, so a long turn's last request carries every
 * read it ever made. When the working history outgrows its budget, the older
 * part is summarised into a handoff note and replaced — the same trick
 * `longRead` uses to walk a story no context can hold, applied to the
 * conversation instead. The prompt follows Codex's checkpoint format (progress,
 * decisions, constraints, what remains, critical references), which is written
 * for exactly this: another model picking up work in flight.
 *
 * What compaction deliberately CANNOT touch is the system prompt. In this app
 * that is the story — the transcript, the card, the pins, the throughline — and
 * it is the grounding every step depends on. If the system prompt alone will
 * not fit, no amount of compacting the conversation will help, and the honest
 * outcome is to say so rather than summarise in circles.
 *
 * Pure: no store, no React, no fetch. `send` is injected, exactly as in
 * `longRead`, which is what makes the whole loop testable without a model.
 */

import { ChatMsg } from './aiClient';
import {
  AgentStep, MAX_CALLS_PER_STEP, ToolContext, ToolCall,
  parseToolCalls, renderToolResult, runToolCall, stripToolCalls,
} from './agentTools';

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/** Chars per token, matching `summarizer.ts` so the two budget the same way. */
export const CHARS_PER_TOKEN = 4;

/**
 * How many steps one turn may take.
 *
 * Eight is room for "list the pins, read the one they meant, read the zone it
 * came from, write it back" twice over. A turn that has not finished by then is
 * not about to.
 */
export const MAX_STEPS = 8;

/** Working messages kept verbatim through a compaction. */
export const KEEP_TAIL = 4;

/** The handoff note's ceiling, for the same reason `longRead.KEY_CHARS` has one. */
export const SUMMARY_CHARS = 2000;

/**
 * Marks a compacted history to the model that receives it.
 *
 * Phrased as "another model was working on this" rather than "you said" because
 * that is true — the summary is a rewrite, not a transcript — and because a
 * model told it wrote something it cannot remember writing will start
 * apologising instead of working.
 */
export const SUMMARY_PREFIX =
  'Earlier in this turn you were looking things up. Here is a summary of what '
  + 'you found and decided, so you can build on it instead of repeating it:';

export const COMPACT_PROMPT = [
  'Summarise the work so far so it can be continued without the detail.',
  '',
  'Include:',
  '- What has been established, and any decisions already made',
  '- Constraints and preferences the reader has stated',
  '- What is still to do, as clear next steps',
  '- Any specific values that must survive: pin ids, message numbers, names',
  '',
  'Be terse and structured. Write it for yourself, not for the reader — nobody',
  'else sees it. Do not write a tool directive.',
].join('\n');

export const estimateChars = (messages: readonly ChatMsg[]): number =>
  messages.reduce((n, m) => n + m.content.length, 0);

/** Trim to a cap without cutting mid-word — the same clip `longRead` uses. */
export const clip = (s: string, cap: number): string => {
  const t = (s ?? '').trim();
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const space = cut.lastIndexOf(' ');
  return `${(space > cap * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The room the conversation has, once the story has taken its share.
 *
 * Negative when the system prompt alone overruns the window — see the note at
 * the top about why that is reported rather than compacted away.
 */
export const workingBudget = (systemChars: number, contextTokens: number, replyTokens: number): number =>
  Math.round((contextTokens > 0 ? contextTokens : 8000) * CHARS_PER_TOKEN)
  - systemChars
  - Math.max(0, replyTokens) * CHARS_PER_TOKEN;

/** Is the working history over budget, with enough of it to be worth folding? */
export const shouldCompact = (
  working: readonly ChatMsg[], budget: number, keepTail = KEEP_TAIL,
): boolean => budget > 0 && working.length > keepTail + 1 && estimateChars(working) > budget;

/** Ask for the handoff note. */
export const buildCompactMessages = (
  system: string, head: readonly ChatMsg[],
): ChatMsg[] => [
  { role: 'system', content: `${system}\n\n${COMPACT_PROMPT}` },
  {
    role: 'user',
    content: `THE WORK SO FAR:\n\n${head.map(m => `[${m.role}] ${m.content}`).join('\n\n')}`,
  },
];

/**
 * Fold the head into one note and keep the tail verbatim.
 *
 * The tail matters more than it looks: the last tool result is usually the
 * material the model is mid-way through using, and a summary of it is not a
 * substitute for it. Codex keeps the recent items for the same reason.
 */
export const applyCompaction = (
  working: readonly ChatMsg[], summary: string, keepTail = KEEP_TAIL,
): ChatMsg[] => {
  const note = clip(summary, SUMMARY_CHARS);
  if (!note) return [...working];
  const tail = working.slice(-keepTail);
  return [{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${note}` }, ...tail];
};

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export type AgentStop = 'answer' | 'max-steps' | 'aborted' | 'empty';

export interface AgentRunOptions {
  /** The full system prompt, catalogue included. Never compacted. */
  system: string;
  /** The conversation up to now. */
  history: readonly ChatMsg[];
  ctx: ToolContext;
  send: (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;
  maxSteps?: number;
  /** Chars the working history may occupy; `workingBudget` computes it. */
  budgetChars?: number;
  signal?: AbortSignal;
  /** Each tool call as it happens, so the panel can show the work. */
  onStep?: (step: AgentStep, index: number) => void;
  /** Prose the model wrote alongside a call — shown while the turn runs. */
  onText?: (text: string) => void;
  onCompact?: () => void;
}

export interface AgentRunResult {
  /** The answer, with every directive stripped out. */
  text: string;
  steps: AgentStep[];
  compactions: number;
  stop: AgentStop;
}

/** A stable key for "the model already asked this". */
const callKey = (c: ToolCall): string => `${c.tool}:${JSON.stringify(c.args)}`;

export const runAgentTurn = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
  const maxSteps = Math.max(1, opts.maxSteps ?? MAX_STEPS);
  const budget = opts.budgetChars ?? 0;
  const steps: AgentStep[] = [];
  const seen = new Map<string, AgentStep>();
  let working: ChatMsg[] = [...opts.history];
  let compactions = 0;
  let said = '';

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return { text: said, steps, compactions, stop: 'aborted' };

    if (shouldCompact(working, budget)) {
      const head = working.slice(0, working.length - KEEP_TAIL);
      try {
        const summary = await opts.send(buildCompactMessages(opts.system, head), opts.signal);
        working = applyCompaction(working, summary);
        compactions++;
        opts.onCompact?.();
      } catch {
        // A failed compaction is not a failed turn. Send it over budget and let
        // the endpoint decide — the alternative is abandoning work the reader
        // has already paid for because a summary request timed out.
      }
    }

    const reply = await opts.send([{ role: 'system', content: opts.system }, ...working], opts.signal);
    const prose = stripToolCalls(reply);
    const calls = parseToolCalls(reply).slice(0, MAX_CALLS_PER_STEP);

    if (!calls.length) {
      // No directive means the model is answering. An empty reply after tool
      // work is not an answer, though — it is a model that lost the thread, and
      // the reader is better served by the last thing it actually said.
      const text = prose || said;
      return { text, steps, compactions, stop: text ? 'answer' : 'empty' };
    }

    if (prose) { said = said ? `${said}\n\n${prose}` : prose; opts.onText?.(said); }
    working = [...working, { role: 'assistant', content: reply }];

    for (const call of calls) {
      if (opts.signal?.aborted) return { text: said, steps, compactions, stop: 'aborted' };
      const key = callKey(call);
      const prior = seen.get(key);
      const result = prior
        ? { ...prior.result, repeated: true, note: 'You already ran this in this turn; the result is unchanged.' }
        : await runToolCall(call, opts.ctx);
      const entry: AgentStep = { call, result };
      if (!prior) seen.set(key, entry);
      steps.push(entry);
      opts.onStep?.(entry, steps.length - 1);
      working = [...working, { role: 'user', content: renderToolResult(entry) }];
    }
  }

  // Out of steps with tools still being called. Say what was done rather than
  // returning nothing — the writes already landed and the reader must be told.
  return { text: said, steps, compactions, stop: 'max-steps' };
};
