/**
 * What happens to a reply on its way back from the model.
 *
 * ── Why this is a list and not a row of switches ───────────────────────────
 *
 * It was two checkboxes: tidy, and check-against-pins. That could not express
 * the thing the reader actually wants to say, which is an ORDER. Formatting
 * before a contradiction check and formatting after it are different
 * operations: the check quotes a sentence from the text it was given, and if
 * formatting has since moved that sentence the repair lands on nothing.
 *
 * So it is a list, it runs top to bottom, and the reader can see and reorder
 * it. Each step says what it costs, because two of them cost model calls and a
 * reader should not discover that from their bill.
 *
 * ── The steps ──────────────────────────────────────────────────────────────
 *
 * `tidy` — close a dangling quote or asterisk. Deterministic, instant, free.
 *
 * `format` — the reader's own formatting rules, applied for real. Aeia has
 * always had these as a READING layer: the story on disk is untouched and the
 * page is drawn differently. Here the text is on its way into SillyTavern's
 * chat file, so applying them makes them permanent — which is what "force
 * format" means and why it is off by default.
 *
 * `check` — ask a model whether the reply contradicts the reader's material,
 * and repair at most a few sentences. Costs several calls per reply.
 *
 * `polish` — ask a model to close punctuation `tidy` could not. One call, and
 * only when the text is still unbalanced after everything above, so a clean
 * reply costs nothing.
 *
 * Pure: the deterministic steps run here, the two that need a model are
 * executed by the caller. Nothing here fetches.
 */

import type { AutoFormatRule, Role } from '../types';
import { processText, repairFormatting } from './textProcessor';

export type ReplyStepKind = 'tidy' | 'format' | 'check' | 'polish';

export interface ReplyStep {
  kind: ReplyStepKind;
  enabled: boolean;
}

export const DEFAULT_REPLY_STEPS: ReplyStep[] = [
  { kind: 'tidy', enabled: true },
  { kind: 'format', enabled: false },
  { kind: 'check', enabled: false },
  { kind: 'polish', enabled: false },
];

export const STEP_INFO: Record<ReplyStepKind, {
  label: string;
  hint: string;
  /** What running it costs, said plainly. */
  cost: string;
  /** True when it calls a model — the caller has to run these. */
  model: boolean;
}> = {
  tidy: {
    label: 'Tidy the shape',
    hint: 'Closes a dangling quote or asterisk. Changes no words.',
    cost: 'free',
    model: false,
  },
  format: {
    label: 'Force format',
    hint: 'Applies your own formatting rules — spacing, dialogue on its own line, '
      + 'smart punctuation, your markup rules — to the text itself rather than just to how '
      + 'it is drawn. This is written into SillyTavern.',
    cost: 'free',
    model: false,
  },
  check: {
    label: 'Check against my material',
    hint: 'Asks whether the reply contradicts what you picked above, and repairs at most a '
      + 'few sentences. Never rewrites the whole reply.',
    cost: 'up to 6 calls',
    model: true,
  },
  polish: {
    label: 'Polish punctuation',
    hint: 'Asks a model to close what the tidy could not. Only runs when the text is still '
      + 'unbalanced, so a clean reply costs nothing.',
    cost: '0–1 calls',
    model: true,
  },
};

/** The order steps are shown and run in. */
export const stepOrder = (steps: readonly ReplyStep[]): ReplyStepKind[] =>
  steps.map(s => s.kind);

/** Move a step up or down, returning a new list. */
export const moveStep = (
  steps: readonly ReplyStep[], kind: ReplyStepKind, by: -1 | 1,
): ReplyStep[] => {
  const at = steps.findIndex(s => s.kind === kind);
  const to = at + by;
  if (at < 0 || to < 0 || to >= steps.length) return [...steps];
  const out = [...steps];
  [out[at], out[to]] = [out[to], out[at]];
  return out;
};

export const toggleStep = (steps: readonly ReplyStep[], kind: ReplyStepKind): ReplyStep[] =>
  steps.map(s => (s.kind === kind ? { ...s, enabled: !s.enabled } : s));

/**
 * Repair a list that has drifted from the code.
 *
 * Settings persist across versions. A step added later would be missing from
 * every existing reader's list, and one removed would linger in it — so the
 * stored order is honoured for what still exists, and anything new is appended
 * switched off rather than silently turned on for people who never asked.
 */
export const reconcileSteps = (stored: unknown): ReplyStep[] => {
  const list = Array.isArray(stored) ? stored : [];
  const seen = new Set<string>();
  const out: ReplyStep[] = [];
  for (const item of list) {
    const kind = (item as ReplyStep)?.kind;
    if (!kind || !(kind in STEP_INFO) || seen.has(kind)) continue;
    seen.add(kind);
    out.push({ kind, enabled: !!(item as ReplyStep).enabled });
  }
  for (const step of DEFAULT_REPLY_STEPS) {
    if (!seen.has(step.kind)) out.push({ kind: step.kind, enabled: false });
  }
  return out;
};

/** One line for the panel: what this pipeline does, in order. */
export const describeSteps = (steps: readonly ReplyStep[]): string => {
  const on = steps.filter(s => s.enabled);
  if (!on.length) return 'nothing — the reply is passed through';
  return on.map(s => STEP_INFO[s.kind].label.toLowerCase()).join(' → ');
};

/** How many model calls this pipeline could make per reply. */
export const modelCost = (steps: readonly ReplyStep[]): number =>
  steps.filter(s => s.enabled && STEP_INFO[s.kind].model).length;

/* ------------------------------------------------------------------ */
/* The deterministic steps                                             */
/* ------------------------------------------------------------------ */

/** Everything `format` needs from the reader's settings. */
export interface FormatConfig {
  autoFormatRules: AutoFormatRule[];
  paragraphSpacing: boolean;
  dialogueOwnLine: boolean;
  smartTypography: boolean;
  styleQuotes: boolean;
  role?: Role;
}

/**
 * The reader's formatting rules, applied to the text for real.
 *
 * `processText` is the same function the page uses to DRAW a message, called
 * with the same settings. The difference is only what happens to the result:
 * on the page it is thrown away after painting, and here it is what
 * SillyTavern stores.
 *
 * Name substitution and OOC handling are deliberately not passed. Those are
 * reading conveniences — `{{char}}` resolved for display is right, `{{char}}`
 * resolved in the saved chat destroys a template that SillyTavern re-resolves
 * per persona.
 */
export const forceFormat = (text: string, config: FormatConfig): string =>
  // `processText` returns a record because the reading path wants more than the
  // string; here only the text is wanted.
  processText(text, {
    autoFormat: true,
    autoFormatRules: config.autoFormatRules,
    paragraphSpacing: config.paragraphSpacing,
    dialogueOwnLine: config.dialogueOwnLine,
    smartTypography: config.smartTypography,
    styleQuotes: config.styleQuotes,
    repairFormatting: false,
    substituteNames: false,
    role: config.role,
  }).processedText;

export const tidy = (text: string): string => repairFormatting(text);

/** Does this still look unbalanced enough to be worth a model call? */
export const needsPolish = (text: string): boolean => {
  const quotes = (text.match(/["“”]/g)?.length ?? 0) % 2 !== 0;
  const stars = (text.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0) % 2 !== 0;
  return quotes || stars;
};
