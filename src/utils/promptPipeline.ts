/**
 * Working on the prompt before the model sees it.
 *
 * ── Why this is the valuable half ──────────────────────────────────────────
 *
 * Everything Aeia could do until now happened after the fact: read the reply,
 * judge it, repair a sentence. That is worth something, but it is arguing with
 * a decision already made. The prompt is where the decision is made — and until
 * Aeia sat between SillyTavern and the model, it had never seen one. The card,
 * the world info, the persona, the whole assembled context stack: all of it
 * arrives here, and a pin placed in the right part of it is worth more than any
 * amount of correction afterwards.
 *
 * ── The rules, and why each one exists ─────────────────────────────────────
 *
 * **Nothing is mutated.** SillyTavern hands over the same array it is about to
 * send, and in the browser path it hands over the *live* one. A pipeline that
 * edited in place would corrupt the prompt even when it decided to do nothing.
 * Every function here returns new objects.
 *
 * **A block goes in whole or not at all.** When the budget runs out the
 * remaining blocks are skipped and reported. Half a fact is worse than no
 * fact — a model given "her left arm is" will confidently finish the sentence.
 *
 * **The reader's turn is never dropped.** Filters can remove context; the last
 * user message is the instruction, and a prompt without it is not the reader's
 * prompt any more.
 *
 * **Placement follows the attention curve.** Long contexts are read best at
 * their ends: reference material near the top, the instruction last. That is
 * why `slot` exists rather than everything being appended, and why
 * `instructionLast` is offered at all.
 *
 * Pure: no store, no React, no fetch. The material is gathered by the caller.
 */

/** One message in an OpenAI-style prompt. */
export interface ChatMsg {
  role: string;
  content: string;
  [key: string]: unknown;
}

/** Where a block of material goes. */
export type Slot =
  /** Folded in beside the system prompt, at the top of the context. */
  | 'system'
  /** Just before the reader's last turn, so it is close to the instruction. */
  | 'before-last-user'
  /** After everything, in the highest-attention position there is. */
  | 'end';

export interface PromptBlock {
  id: string;
  title: string;
  text: string;
  slot: Slot;
}

export interface PromptPlan {
  blocks: PromptBlock[];
  /**
   * Total characters of injected material allowed.
   *
   * A limit rather than a promise of quality: past a point, more context makes
   * output worse, and the reader with forty pins should find out from this
   * number rather than from their story going vague.
   */
  budget?: number;
  /** Drop context messages containing any of these, case-insensitively. */
  drop?: string[];
  /** Move the reader's last turn to the very end, if something follows it. */
  instructionLast?: boolean;
}

export interface PromptResult {
  messages: ChatMsg[];
  /** Titles of the blocks that went in, in order. */
  injected: string[];
  /** Blocks that did not fit, with the reason. */
  skipped: { title: string; reason: string }[];
  /** How many context messages the filters removed. */
  dropped: number;
  /** Characters of material added. */
  added: number;
}

export const DEFAULT_BUDGET = 8000;

/** How a block is wrapped, so a model can tell it from the story. */
export const blockText = (block: PromptBlock): string =>
  `[${block.title}]\n${block.text.trim()}`;

const lastIndexOfRole = (messages: readonly ChatMsg[], role: string): number => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return i;
  return -1;
};

/**
 * Apply a plan to a prompt.
 *
 * The order matters and is fixed: drop first (so filtered messages cannot
 * consume budget or shift the anchors), then inject, then reorder. Injecting
 * before dropping would place a block relative to a message that is about to
 * disappear.
 */
export const applyPlan = (input: readonly ChatMsg[], plan: PromptPlan): PromptResult => {
  const budget = plan.budget ?? DEFAULT_BUDGET;
  const skipped: PromptResult['skipped'] = [];
  const injected: string[] = [];

  /* ---- Drop ---- */
  let messages = input.map(m => ({ ...m }));
  let dropped = 0;
  if (plan.drop?.length) {
    const needles = plan.drop.map(d => d.toLowerCase()).filter(Boolean);
    const keepAt = lastIndexOfRole(messages, 'user');
    messages = messages.filter((m, i) => {
      // The instruction is never a candidate, whatever it happens to contain.
      if (i === keepAt) return true;
      const hit = needles.some(n => (m.content ?? '').toLowerCase().includes(n));
      if (hit) dropped++;
      return !hit;
    });
  }

  /* ---- Inject ---- */
  let added = 0;
  const bySlot: Record<Slot, string[]> = { system: [], 'before-last-user': [], end: [] };
  for (const block of plan.blocks) {
    const text = blockText(block);
    if (!block.text.trim()) {
      skipped.push({ title: block.title, reason: 'it is empty' });
      continue;
    }
    if (added + text.length > budget) {
      // Whole or not at all: a truncated fact is a confidently wrong fact.
      skipped.push({ title: block.title, reason: 'the context budget was already full' });
      continue;
    }
    bySlot[block.slot].push(text);
    injected.push(block.title);
    added += text.length;
  }

  if (bySlot.system.length) {
    const body = bySlot.system.join('\n\n');
    const at = messages.findIndex(m => m.role === 'system');
    if (at >= 0) {
      // Appended to the existing system message rather than added beside it:
      // several system turns in a row is a shape some backends collapse and
      // others refuse, and neither is worth risking for a formatting choice.
      messages[at] = { ...messages[at], content: `${messages[at].content}\n\n${body}` };
    } else {
      messages.unshift({ role: 'system', content: body });
    }
  }

  if (bySlot['before-last-user'].length) {
    const at = lastIndexOfRole(messages, 'user');
    const block: ChatMsg = { role: 'system', content: bySlot['before-last-user'].join('\n\n') };
    if (at >= 0) messages.splice(at, 0, block);
    else messages.push(block);
  }

  if (bySlot.end.length) {
    messages.push({ role: 'system', content: bySlot.end.join('\n\n') });
  }

  /* ---- Reorder ---- */
  if (plan.instructionLast) {
    const at = lastIndexOfRole(messages, 'user');
    if (at >= 0 && at !== messages.length - 1) {
      const [turn] = messages.splice(at, 1);
      messages.push(turn);
    }
  }

  return { messages, injected, skipped, dropped, added };
};

/** A line for the reader: what this run actually did to the prompt. */
export const describePlan = (result: PromptResult): string => {
  const parts: string[] = [];
  if (result.injected.length) {
    parts.push(`added ${result.injected.length} block${result.injected.length === 1 ? '' : 's'}`
      + ` (${result.added.toLocaleString()} chars)`);
  }
  if (result.dropped) parts.push(`dropped ${result.dropped}`);
  if (result.skipped.length) parts.push(`${result.skipped.length} did not fit`);
  return parts.length ? parts.join(' · ') : 'passed through unchanged';
};
