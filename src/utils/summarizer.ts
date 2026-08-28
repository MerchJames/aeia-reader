/**
 * Chunking a story that no single context could hold, and the sheet filler
 * built on it.
 *
 * This was the app's map-reduce summariser: chunk, summarise each chunk alone,
 * fold the results. `utils/longRead.ts` replaced that — it walks the same
 * chunks but carries a digest between them, so section nine knows who section
 * two introduced, which a fold can never recover. What is left here is the part
 * that was always right (budgeting and chunking, still used by both) plus the
 * sheet filler, which genuinely IS map-reduce: rows extracted from one stretch
 * do not need to know about rows from another, they only need de-duplicating.
 */

import { CardInfo } from '../types';
import { cardToPromptBlock } from './cardContext';
import { ChatMsg } from './aiClient';
import { salvageArray } from './aiCall';

export interface SummaryPassage {
  name: string;
  content: string;
}

/** Rough chars-per-token for budgeting (English prose ≈ 4). */
export const CHARS_PER_TOKEN = 4;
/** Fallback context window when the user hasn't set one. */
export const DEFAULT_CONTEXT_TOKENS = 8000;

/**
 * Char budget for one chunk: a fraction (default 80%) of the context window,
 * minus a reserve for the system prompt, format instruction, and reply.
 */
export const estimateBudgetChars = (
  contextTokens: number,
  ratio = 0.8,
  reserveChars = 1500,
): number => {
  const tokens = contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  return Math.max(600, Math.round(tokens * CHARS_PER_TOKEN * ratio) - reserveChars);
};

/**
 * Split passages into contiguous chunks that each fit `budgetChars`. A single
 * passage larger than the budget becomes its own (over-budget) chunk rather
 * than being dropped — the model still summarizes it, just with less headroom.
 */
export const chunkByBudget = (
  passages: SummaryPassage[],
  budgetChars: number,
): SummaryPassage[][] => {
  const budget = Math.max(500, budgetChars);
  const chunks: SummaryPassage[][] = [];
  let cur: SummaryPassage[] = [];
  let size = 0;
  for (const p of passages) {
    const len = p.name.length + p.content.length + 2;
    if (cur.length > 0 && size + len > budget) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
};

const passageText = (chunk: SummaryPassage[]): string =>
  chunk.map(p => (p.name ? `${p.name}: ${p.content}` : p.content)).join('\n\n');

/**
 * How far a run has got. Kept here because the progress store speaks in these
 * terms; the long read maps its own phases onto them.
 */
export type SummaryPhase = 'mapping' | 'reducing';

/** Cap on rows collected into one sheet. */
export const MAX_SHEET_ROWS = 200;

/**
 * Pull the rows out of a reply.
 *
 * The version here was the weakest of the four copies this app grew: strict
 * parse or nothing, so a table cut off at the token limit returned no rows at
 * all rather than the ninety it had already written. The shared one salvages
 * the complete objects and drops only the truncated one.
 */
const extractJsonArray = (raw: string): unknown[] | null => salvageArray(raw);

/** Messages asking the model to extract table rows from one chunk. */
export const buildSheetMapMessages = (
  chunk: SummaryPassage[],
  columns: string[],
  instruction: string,
  card: CardInfo | undefined,
  index: number,
  count: number,
): ChatMsg[] => {
  const cols = columns.join(', ');
  const system = [
    `You are filling a table (columns: ${cols}) from part ${index} of ${count} of a story.`,
    `Return ONLY a JSON array of row objects, each with exactly these keys: ${cols}.`,
    'Include only rows supported by THIS section; invent nothing. Use "" for unknown cells.',
    instruction,
  ].join('\n');

  const user = [
    cardToPromptBlock(card) && `STORY CONTEXT (for grounding only):\n${cardToPromptBlock(card)}`,
    `SECTION ${index}/${count}:\n${passageText(chunk)}`,
    'Return the JSON array of rows for THIS section.',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

/** Parse a reply into rows keyed by exactly `columns` (skips empty rows). */
export const parseRows = (raw: string, columns: string[]): Record<string, string>[] => {
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  const rows: Record<string, string>[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const row: Record<string, string> = {};
    let any = false;
    for (const col of columns) {
      const v = rec[col];
      row[col] = v == null ? '' : String(v).trim();
      if (row[col]) any = true;
    }
    if (any) rows.push(row);
  }
  return rows;
};

export interface RunSheetOptions {
  passages: SummaryPassage[];
  budgetChars: number;
  columns: string[];
  instruction: string;
  card?: CardInfo;
  send: (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  onPhase?: (phase: SummaryPhase, done: number, total: number) => void;
}

/**
 * Fill a sheet by mapping each chunk to rows and accumulating them, deduped by
 * the first column (case-insensitive). Sequential single-model queue; aborting
 * keeps the rows gathered so far.
 */
export const runSheetFill = async (opts: RunSheetOptions): Promise<Record<string, string>[]> => {
  const columns = opts.columns.map(c => c.trim()).filter(Boolean);
  if (columns.length === 0) return [];
  const chunks = chunkByBudget(opts.passages, opts.budgetChars);
  const keyCol = columns[0];
  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) break;
    opts.onPhase?.('mapping', i, chunks.length);
    const msgs = buildSheetMapMessages(chunks[i], columns, opts.instruction, opts.card, i + 1, chunks.length);
    let reply = '';
    try {
      reply = await opts.send(msgs, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) break;
      console.error('[Summarizer] sheet chunk failed', e);
      continue;
    }
    for (const row of parseRows(reply, columns)) {
      const key = (row[keyCol] ?? '').toLowerCase();
      if (!key || seen.has(key)) continue; // dedupe by first column
      seen.add(key);
      rows.push(row);
      if (rows.length >= MAX_SHEET_ROWS) break;
    }
    if (rows.length >= MAX_SHEET_ROWS) break;
  }
  opts.onPhase?.('mapping', chunks.length, chunks.length);
  return rows;
};
