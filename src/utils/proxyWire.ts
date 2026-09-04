/**
 * Speaking OpenAI's chat-completions dialect, in both directions.
 *
 * Aeia stands between SillyTavern and the model: it reads the request
 * SillyTavern made, calls the real backend, and answers in the same shape. This
 * module is the part that knows that shape. It makes no calls and holds no
 * state — the runner does that — so every rule here is testable on its own,
 * which matters because these rules are the difference between a reply
 * appearing correctly and a reply appearing mangled in somebody's story.
 *
 * ── The rule that this file exists for ─────────────────────────────────────
 *
 * SillyTavern renders a second choice as a second SWIPE, which is how the
 * original survives beside the processed version. That works — and it is armed
 * with a trap.
 *
 * Its streaming reader routes each event by `choices[0].index`: index 0 is the
 * message, and index N ≥ 1 goes to swipe N. But that routing only happens when
 * SillyTavern itself asked for more than one response. If it did not, an event
 * with index 1 does NOT become a swipe — it falls through and is APPENDED TO
 * THE MESSAGE. The reader would get the processed reply with the original glued
 * onto the end of it.
 *
 * The request says which case we are in: `n`. So the second choice is emitted
 * only when the incoming request asked for two, and `canSwipe` below is that
 * decision, tested from both sides.
 *
 * Verified in SillyTavern 1.18.0: `public/scripts/openai.js` — `multiswipeSources`
 * contains CUSTOM, `canMultiSwipe = settings.n > 1 && …`, and the stream reader
 * does `swipes[parsed.choices[0].index - 1] += …`.
 */

/** The bits of SillyTavern's request that change what we do. */
export interface ProxyRequest {
  model: string;
  /** Whether to answer as an event stream. */
  stream: boolean;
  /** How many responses were asked for. Two or more means swipes are read. */
  n: number;
  messages: unknown[];
  /** Everything else, passed through untouched. */
  rest: Record<string, unknown>;
}

/** Read what SillyTavern sent. `null` when it is not a completion request. */
export const readRequest = (raw: string): ProxyRequest | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return null;

  const { model, stream, n, messages, ...rest } = body;
  return {
    model: typeof model === 'string' ? model : '',
    stream: stream === true,
    // Absent means one. A non-number is not a count.
    n: typeof n === 'number' && Number.isFinite(n) ? n : 1,
    messages,
    rest,
  };
};

/**
 * May we send the original back as a second choice?
 *
 * The whole trap, in one predicate. When SillyTavern did not ask for two, a
 * second choice is not a swipe — it is extra text on the end of the reply.
 */
export const canSwipe = (request: Pick<ProxyRequest, 'n'>): boolean => request.n > 1;

/**
 * The request to send upstream.
 *
 * `n` is forced back to 1 whatever SillyTavern asked for: we are not asking the
 * model for two takes, we are producing the second one ourselves. Sending n=2
 * would bill for a take nobody reads and, on a local backend, generate twice.
 *
 * Everything else is passed through verbatim, including sampler settings we
 * have never heard of. A proxy that only forwarded the fields it recognised
 * would silently drop the reader's own configuration.
 */
export const upstreamBody = (request: ProxyRequest, messages: unknown[], model?: string): string =>
  JSON.stringify({
    ...request.rest,
    model: model || request.model,
    messages,
    stream: request.stream,
    n: 1,
  });

/* ------------------------------------------------------------------ */
/* Answering                                                           */
/* ------------------------------------------------------------------ */

const id = () => `chatcmpl-aeia-${Math.random().toString(36).slice(2, 10)}`;

/** One streamed delta, addressed to a choice — 0 is the message, 1+ are swipes. */
export const deltaEvent = (text: string, choice: number, model: string, made = id()): string =>
  JSON.stringify({
    id: made,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: choice, delta: { content: text }, finish_reason: null }],
  });

/** The final event of one choice. */
export const finishEvent = (choice: number, model: string, made = id()): string =>
  JSON.stringify({
    id: made,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: choice, delta: {}, finish_reason: 'stop' }],
  });

/**
 * A whole answer in one body, for a request that did not want a stream.
 *
 * The non-streaming path has no `n` condition on it — SillyTavern's
 * `extractMultiSwipes` takes every extra choice — but the same rule is applied
 * anyway. Two paths that disagree about when a second version appears would be
 * a bug the reader hits only when they toggle streaming.
 */
export const completionBody = (
  texts: string[], model: string, made = id(),
): string => JSON.stringify({
  id: made,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: texts.map((content, index) => ({
    index,
    message: { role: 'assistant', content },
    finish_reason: 'stop',
  })),
});

/* ------------------------------------------------------------------ */
/* Reading the backend                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pull the text out of one upstream event.
 *
 * Backends differ in ways that are not worth a taxonomy: some send
 * `delta.content`, some `message.content`, some `text`. All three are read, in
 * that order, and anything else yields nothing rather than throwing — one
 * unrecognised keep-alive event must not end a reply.
 */
export const readDelta = (raw: string): string => {
  if (!raw || raw === '[DONE]') return '';
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return '';
  }
  const choice = (value as { choices?: unknown[] })?.choices?.[0] as
    | { delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown }
    | undefined;
  if (!choice) return '';
  const from = choice.delta?.content ?? choice.message?.content ?? choice.text;
  return typeof from === 'string' ? from : '';
};

/** The whole reply out of a non-streamed upstream response. */
export const readWhole = (raw: string): string => readDelta(raw);

/**
 * Split an event-stream buffer into complete payloads.
 *
 * Returns what it could read and whatever is left over, because a chunk off the
 * socket routinely ends mid-event. A parser that assumed otherwise would drop a
 * token every few hundred, which is exactly the kind of corruption nobody
 * notices until it is in a saved story.
 */
export const takeEvents = (buffer: string): { events: string[]; rest: string } => {
  const events: string[] = [];
  let rest = buffer;
  for (;;) {
    // Both separators are in the wild; some servers use bare newlines.
    const at = Math.min(
      ...[rest.indexOf('\n\n'), rest.indexOf('\r\n\r\n')].filter(i => i >= 0).concat([Infinity]),
    );
    if (!Number.isFinite(at)) break;
    const block = rest.slice(0, at);
    rest = rest.slice(at + (rest.startsWith('\r\n\r\n', at) ? 4 : 2));
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');
    if (data) events.push(data);
  }
  return { events, rest };
};
