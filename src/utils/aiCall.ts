/**
 * One call layer over `aiClient`, owning the four things every AI feature in
 * this app has been re-solving on its own: BUDGET, REASONING, SALVAGE, RETRY.
 *
 * The case for it is written in the repo's own history. Three scale bugs landed
 * on the same day in July — an under-sized `max_tokens`, a fatal `JSON.parse`,
 * and a staleness check blind to feature generation — and each was fixed in
 * exactly ONE of the twenty-odd places that needed it. The Director learned to
 * strip a chain of thought; Ask Character, the visitor brief, the recap, the
 * summariser, the sheets and the image prompt did not, so on a thinking model
 * they hand the reader `<think>` and call it prose. The balanced-brace scanner
 * that rescues a truncated JSON reply exists four times, in four files, in four
 * slightly different states of repair.
 *
 * So: one place. A feature says what it wants back and how much room it needs;
 * this decides what to send, what to do with a reply that thought too long, and
 * how to get an answer out of prose wrapped around JSON.
 *
 * What this deliberately does NOT own:
 * - **Prompt shape.** Every feature keeps its own voice; nothing here edits a
 *   message.
 * - **Streaming.** `chatCompletionStream` stays as it is — the reader's own
 *   chat is the only consumer, and it needs the deltas, not a return value.
 * - **Feature-specific retries.** The Director splits a failed batch in half
 *   because passages are divisible; nothing else here is. That logic stays with
 *   the thing that understands it.
 */

import { ChatMsg, SamplerParams, chatCompletion, mergeSamplers } from './aiClient';

/* ------------------------------------------------------------------ */
/* Reasoning                                                           */
/* ------------------------------------------------------------------ */

/**
 * Reasoning models spend their output budget THINKING before they answer.
 *
 * A budget sized against the answer alone means a thinking model burns the
 * whole allowance on its chain of thought and the answer never arrives — the
 * reply parses to nothing and the feature looks broken on a model that works
 * perfectly well. `max_tokens` is a CEILING, not a spend, so this headroom
 * costs a model that does not think exactly nothing, which is why it is asked
 * for up front rather than after the first failure.
 */
export const REASONING_HEADROOM = 4000;

/** Does this reply carry a chain of thought? */
export const hasReasoning = (raw: string): boolean =>
  /<think(?:ing)?\b|<reasoning\b/i.test(raw);

/**
 * A reply cut off mid-thought: opened its reasoning and never closed it. The
 * definitive sign the budget was too small — and the case where retrying
 * SMALLER cannot help, because the cost was the thinking, not the task.
 */
export const truncatedInReasoning = (raw: string): boolean =>
  hasReasoning(raw) && !/<\/(?:think(?:ing)?|reasoning)>/i.test(raw);

/**
 * Drop the chain of thought before anything else looks at the reply.
 *
 * It matters most where a reply is parsed: the salvage scanner below hunts for
 * balanced braces, and a model reasoning ABOUT a JSON schema is full of them —
 * so without this its deliberation can be parsed as the answer.
 */
export const stripReasoning = (raw: string): string =>
  raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    // An unclosed block means the reply was truncated mid-thought: everything
    // from the tag on is thinking, and none of it is an answer.
    .replace(/<think(?:ing)?\b[\s\S]*$/i, '')
    .replace(/<reasoning\b[\s\S]*$/i, '');

/** Strip a ```fence``` if the whole reply is wrapped in one. */
export const stripFence = (raw: string): string => {
  const t = raw.trim();
  const m = t.match(/^```(?:[a-z]+)?\s*\n?([\s\S]*?)\n?```$/i);
  return (m ? m[1] : t).trim();
};

/* ------------------------------------------------------------------ */
/* Salvage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Walk a string once, reporting every balanced top-level `{…}` or `[…]`.
 *
 * String-aware, so a brace inside a quoted line ("she said, {no}") cannot throw
 * the depth count off — which is the bug every hand-rolled version of this has
 * had at least once.
 */
const spans = (raw: string, open: string, close: string): string[] => {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) { if (depth === 0) start = i; depth++; continue; }
    if (c === close) {
      depth--;
      if (depth === 0 && start >= 0) { out.push(raw.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0; // stray brace — keep scanning
    }
  }
  return out;
};

/**
 * Get an ARRAY out of a model reply, however it was wrapped.
 *
 * Strict first: the widest `[ … ]` in the reply. Then salvage: scan for
 * balanced top-level objects and parse each on its own, keeping the ones that
 * survive. That second pass is the difference between a reply truncated at the
 * token limit costing one item and costing the whole batch — which, at ten
 * passages a request, is the difference between the Director working at scale
 * and appearing to do nothing.
 */
export const salvageArray = (reply: string): unknown[] | null => {
  const raw = stripFence(stripReasoning(reply ?? ''));
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to salvage */ }
  }
  const out: unknown[] = [];
  for (const s of spans(raw.slice(Math.max(start, 0)), '{', '}')) {
    try { out.push(JSON.parse(s)); } catch { /* drop the truncated one */ }
  }
  return out.length ? out : null;
};

/**
 * Get one OBJECT out of a model reply.
 *
 * Widest-first, because a model that explains itself before answering often
 * quotes a fragment of the schema on the way — and the fragment is never the
 * answer. Falls back to the LAST complete object, which is where a model that
 * corrects itself puts the version it means.
 */
export const salvageObject = <T = unknown>(reply: string): T | null => {
  const raw = stripFence(stripReasoning(reply ?? ''));
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) as T; } catch { /* salvage */ }
  }
  const found = spans(raw, '{', '}');
  for (let i = found.length - 1; i >= 0; i--) {
    try { return JSON.parse(found[i]) as T; } catch { /* keep looking */ }
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* The call                                                            */
/* ------------------------------------------------------------------ */

/** Where to send it. */
export interface AiTarget {
  base: string;
  key: string;
  model: string;
}

export interface AskOptions {
  /** What to call this errand in the activity meter the reader watches. */
  label?: string;
  signal?: AbortSignal;
  /** The feature's own sampling regime. */
  params?: SamplerParams;
  /**
   * The reader's advanced settings. Merged LAST so their choice wins, via
   * `mergeSamplers` rather than a spread — an all-null reader config would
   * otherwise overwrite the feature's regime with nulls and hand the request
   * back to the backend's creative-writing defaults.
   */
  reader?: SamplerParams;
  /**
   * Room for the ANSWER, in tokens; reasoning headroom is added on top.
   *
   * Leave it out and no `max_tokens` is sent at all, so the endpoint's own
   * default applies — which is what most of these call sites did before there
   * was a layer here, and quietly capping a reader's summary at some number I
   * picked would be a regression dressed as a cleanup.
   */
  budget?: number;
  /**
   * Retry once, with double the headroom, when the model thinks itself out of
   * room. Default true: it is the one failure that a plain retry actually fixes.
   */
  retryOnThink?: boolean;
}

/** A reply, and what happened getting it. */
export interface AiReply {
  /** The answer with any chain of thought removed — what a caller should use. */
  text: string;
  /** Exactly what came back, for a caller that needs to see the thinking. */
  raw: string;
  /** The model thought before answering. */
  reasoned: boolean;
  /** It ran out of room mid-thought, even after the retry. */
  truncated: boolean;
}

/**
 * The `max_tokens` for one attempt, or undefined to let the endpoint decide.
 *
 * Pulled out as a pure function because it is the only part of `ask` worth
 * pinning in a test — the rest is fetch — and because getting it wrong is
 * invisible: too small silently truncates an answer, and a cap where there was
 * none is a regression that only shows up on somebody's long summary.
 */
export const requestBudget = (budget: number | undefined, attempt: 0 | 1): number | undefined => {
  if (attempt === 0) return budget === undefined ? undefined : budget + REASONING_HEADROOM;
  return (budget === undefined ? 0 : budget + REASONING_HEADROOM) + REASONING_HEADROOM * 2;
};

/** Everything a request needs, assembled in one place. */
const send = async (
  t: AiTarget, messages: ChatMsg[], opts: AskOptions, budget?: number,
): Promise<string> => chatCompletion(
  t.base, t.key, t.model, messages,
  mergeSamplers(
    budget === undefined ? { ...opts.params } : { ...opts.params, max_tokens: budget },
    opts.reader,
  ),
  opts.signal,
  opts.label ?? 'Thinking',
);

/**
 * Ask, and get back an answer with the thinking taken out.
 *
 * The retry is the whole point of this function existing. A model that thinks
 * itself out of room returns something that looks like a refusal and is
 * actually a budget error, and every feature that did not know the difference
 * reported it to the reader as "the model gave nothing usable".
 */
export const ask = async (
  t: AiTarget, messages: ChatMsg[], opts: AskOptions = {},
): Promise<AiReply> => {
  let raw = await send(t, messages, opts, requestBudget(opts.budget, 0));
  if (truncatedInReasoning(raw) && opts.retryOnThink !== false && !opts.signal?.aborted) {
    // Once, with more room. Twice would just be slower on a model that always
    // overruns, and the reader is sitting in front of this.
    //
    // With no declared budget the cap was the endpoint's own, and some local
    // backends default it low enough that a chain of thought alone overruns it
    // — so the retry names a generous ceiling rather than repeating the request
    // that just failed.
    raw = await send(t, messages, opts, requestBudget(opts.budget, 1));
  }
  return {
    text: stripReasoning(raw).trim(),
    raw,
    reasoned: hasReasoning(raw),
    truncated: truncatedInReasoning(raw),
  };
};

/** `ask`, when all the caller wants is the words. */
export const askText = async (
  t: AiTarget, messages: ChatMsg[], opts: AskOptions = {},
): Promise<string> => (await ask(t, messages, opts)).text;

/**
 * Ask for JSON and get it, or get null — never a throw.
 *
 * A model that answers in prose, in a fence, or half-way through a sentence is
 * an ordinary Tuesday, not an exception. Callers that threw on `JSON.parse`
 * took the whole feature down with them; callers that return null degrade to
 * their own floor, which every feature here already has.
 */
export const askJson = async <T>(
  t: AiTarget, messages: ChatMsg[], opts: AskOptions & { shape?: 'array' | 'object' } = {},
): Promise<T | null> => {
  const { raw } = await ask(t, messages, opts);
  return (opts.shape === 'array'
    ? salvageArray(raw) as T | null
    : salvageObject<T>(raw));
};
