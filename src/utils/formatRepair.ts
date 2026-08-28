/**
 * AI-semantic formatting repair — the 20% the heuristic can't do.
 *
 * `repairFormatting` (textProcessor) mechanically closes an unterminated
 * quote or emphasis run at the end of its paragraph. That is often the wrong
 * PLACE: in `"the razor was a blade she set it down.` the speech ends after
 * "blade". When the Scene Director rereads a page, passages the heuristic
 * flags as broken are also sent for a semantic fix, which lands as a Lens
 * `format` override (source: 'ai') — presentation-only, undoable, visible in
 * the Lens manager. The source JSON is never touched.
 *
 * Trust rule: the model may ONLY move/insert/delete quote marks and
 * asterisks. A reply that changes any word is discarded (the heuristic
 * repair still applies at render time), so a hallucinating model can never
 * rewrite prose through this path.
 */

import { Message, MessageOverride } from '../types';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { ChatMsg } from './aiClient';
import { askText } from './aiCall';
import { hashContent } from './sceneDirector';
import { repairFormatting } from './textProcessor';

/** True when the heuristic would have to guess — the passage is misformatted. */
export const needsSemanticRepair = (content: string): boolean =>
  repairFormatting(content) !== content;

/** Markup characters the model is allowed to touch. */
const MARKUP = /["“”‘’*_]/g;

/** A passage reduced to its words — must be identical before and after. */
const canon = (s: string): string => s.replace(MARKUP, '').replace(/\s+/g, ' ').trim();

/** Accept a repair only if it changed markup and nothing else. */
export const validRepair = (original: string, fixed: string): boolean =>
  !!fixed.trim() && fixed !== original && canon(original) === canon(fixed);

export const REPAIR_SYSTEM_PROMPT = [
  'You are a copy editor for story prose. The passage you receive has',
  'unbalanced quotation marks or emphasis asterisks (e.g. dialogue that opens',
  'with " but never closes, or *italics* left open).',
  'Fix ONLY the markup: insert, move, or delete quote marks (" “ ”) and',
  'asterisks (*) so the dialogue and emphasis close where they naturally end.',
  'You must NOT add, remove, change, or reorder any words or punctuation',
  'other than those markup characters. Preserve line breaks.',
  'Reply with ONLY the corrected passage — no commentary, no code fences.',
].join('\n');

export const buildRepairMessages = (content: string): ChatMsg[] => [
  { role: 'system', content: REPAIR_SYSTEM_PROMPT },
  { role: 'user', content },
];

/** Strip a code fence if the model wrapped its reply in one anyway. */
export const cleanRepairReply = (raw: string): string => {
  const t = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(t);
  return (fence ? fence[1] : t).trim();
};

interface RepairConfig { base: string; key: string; model: string }

/** One passage → its semantically repaired text, or null when not trustable. */
export const repairPassage = async (
  content: string,
  cfg: RepairConfig,
  signal?: AbortSignal,
): Promise<string | null> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model },
    buildRepairMessages(content),
    {
      label: 'Repairing formatting',
      // Deterministic, and roomy enough to echo the passage back.
      params: { temperature: 0 },
      budget: Math.min(4000, Math.ceil(content.length / 2) + 300),
      signal,
    },
  );
  const fixed = cleanRepairReply(reply);
  return validRepair(content, fixed) ? fixed : null;
};

/* ------------------------------------------------------------------ */
/* Runner — impure glue, same shape as the Scene Director runner.      */
/* ------------------------------------------------------------------ */

/** Broken passages already sent this session (storyId:messageId:hash). */
const attempted = new Set<string>();

/** Passages per page visit, so one page can't burn a batch of requests. */
const MAX_REPAIRS_PER_VISIT = 4;
/** Very long passages are skipped — echoing them back is not worth it. */
const MAX_REPAIR_CHARS = 6000;

let controller: AbortController | null = null;

export const stopRepairs = (): void => {
  controller?.abort();
  controller = null;
};

/**
 * Repair the current page's misformatted AI passages. Fire-and-forget from
 * the Director's cadence; each fix lands as a Lens `format` override the
 * moment it validates. Skips user turns, messages that already carry any
 * override (never fight a reader's edit), and everything already attempted.
 */
export const repairCurrentPage = async (storyId: string): Promise<void> => {
  const app = useAppStore.getState();
  if (!app.aiRepairFormatting || !app.aiBaseUrl || !app.aiModel) return;
  const chain = app.chains[app.currentChainIndex];
  if (!chain) return;
  const cfg = { base: app.aiBaseUrl, key: app.aiApiKey, model: app.aiModel };

  const candidates: Message[] = [];
  const overrides = useAuraV2Store.getState().overridesByStory[storyId];
  for (const m of chain.messages) {
    if (m.role === 'user' || m.content.length > MAX_REPAIR_CHARS) continue;
    if (overrides?.some(o => o.messageId === m.id)) continue;
    if (!needsSemanticRepair(m.content)) continue;
    const key = `${storyId}:${m.id}:${hashContent(m.content)}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    candidates.push(m);
    if (candidates.length >= MAX_REPAIRS_PER_VISIT) break;
  }
  if (!candidates.length) return;

  controller ??= new AbortController();
  const signal = controller.signal;
  for (const msg of candidates) {
    if (signal.aborted) break;
    try {
      const fixed = await repairPassage(msg.content, cfg, signal);
      if (!fixed) continue;
      const override: MessageOverride = {
        messageId: msg.id,
        kind: 'format',
        content: fixed,
        source: 'ai',
        note: 'Auto-repair: balanced broken quotes/emphasis',
        createdAt: Date.now(),
      };
      useAuraV2Store.getState().setOverride(storyId, override);
    } catch (e) {
      if (signal.aborted) break;
      console.error('[FormatRepair] passage failed', e);
    }
  }
  if (controller?.signal === signal && !signal.aborted) controller = null;
};
