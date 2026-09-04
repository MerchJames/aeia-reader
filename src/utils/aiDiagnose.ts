/**
 * Turning a failed endpoint into a sentence the reader can act on.
 *
 * ── Why this is worth a module ─────────────────────────────────────────────
 *
 * Connecting a local model is the single hardest thing this app asks of anyone,
 * and every way it goes wrong produces the same useless string: `TypeError:
 * Failed to fetch`. That one message covers a server that is not running, a
 * port typed wrong, an `https` URL to an `http` server, and — most often, and
 * least guessably — a server that IS running and simply refuses requests from
 * a web page it does not know about.
 *
 * A reader who is told "Failed to fetch" tries a different model. A reader who
 * is told "LM Studio is running but is refusing requests from this page — turn
 * on CORS in its server settings" fixes it in ten seconds.
 *
 * ── The judgement calls ────────────────────────────────────────────────────
 *
 * These are guesses, and they are written as guesses. A browser deliberately
 * refuses to tell a page WHY a cross-origin fetch failed — distinguishing
 * "nothing is listening" from "it refused us" is exactly the information the
 * same-origin policy exists to hide. So the wording offers the likely causes in
 * order of likelihood rather than asserting one, and never says something
 * definite that it cannot know.
 *
 * `401` and `404` are different: the server answered, so those are facts.
 *
 * Pure: no fetch, no React, no store. The call that fails lives in `aiClient`.
 */

export type FailureKind =
  /** The request never got an answer: down, wrong port, or CORS. */
  | 'unreachable'
  /** Answered, but rejected the key. */
  | 'auth'
  /** Answered, but has no such route — often a base URL one level off. */
  | 'route'
  /** Answered, but does not have that model. */
  | 'model'
  /** Answered with a server-side failure. */
  | 'server'
  /** Answered with something that was not a completion. */
  | 'shape'
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  /** One line, in the reader's terms. */
  title: string;
  /** What to try, most likely first. */
  fixes: string[];
  /** The raw error, kept so a support conversation has something exact. */
  raw: string;
}

const has = (haystack: string, ...needles: string[]) =>
  needles.some(n => haystack.includes(n));

/**
 * A local address, where the CORS explanation is the likely one.
 *
 * A remote endpoint that will not answer is usually offline or misspelled; a
 * LOCAL one that will not answer is usually running perfectly and declining to
 * talk to a web page. Same symptom, different first suggestion, and getting
 * the order right is most of this module's value.
 */
const looksLocal = (base: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i
    .test(base.trim());

export const diagnose = (error: unknown, base: string, model: string): Diagnosis => {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const low = raw.toLowerCase();
  const local = looksLocal(base);

  // Answered and rejected the key. A fact, not a guess.
  if (has(low, '401', 'unauthorized', 'invalid api key', 'incorrect api key')) {
    return {
      kind: 'auth',
      title: 'The endpoint rejected the API key.',
      fixes: local
        ? ['Most local servers ignore the key entirely — try clearing it.',
          'If your server was started with an API key, paste that exact key.']
        : ['Check the key for a stray space or a missing character.',
          'Make sure the key belongs to this provider, not a different one.'],
      raw,
    };
  }

  if (has(low, '403', 'forbidden')) {
    return {
      kind: 'auth',
      title: 'The endpoint accepted the request but refused it.',
      fixes: ['The key may be valid but lack access to this model.',
        'Some providers require billing to be set up before any request works.'],
      raw,
    };
  }

  /**
   * Checked BEFORE the 404 branch, and it has to be.
   *
   * "model not found" contains "not found", so a route check that runs first
   * swallows every missing-model error and tells the reader to fix a base URL
   * that was correct all along. The tests hold this order in place.
   */
  if (has(low, 'model not found', 'no such model', 'unknown model', 'model_not_found')
    || (has(low, 'model') && has(low, 'does not exist'))) {
    return {
      kind: 'model',
      title: model ? `The endpoint has no model called “${model}”.` : 'No model was chosen.',
      fixes: ['Press Connect & load models and pick one from the list.',
        'Local servers often want the exact filename, capitals and all.'],
      raw,
    };
  }

  // A 404 on a chat endpoint almost always means the base URL is one level off.
  if (has(low, '404', 'not found')) {
    return {
      kind: 'route',
      title: 'The server answered, but has nothing at that address.',
      fixes: [
        `Try the base URL without a path — just the host and port, like ${
          local ? 'http://localhost:1234' : 'https://api.example.com'}.`,
        'Do not include /v1 or /chat/completions; those are added for you.',
        'If your server is behind a prefix, include only that prefix.',
      ],
      raw,
    };
  }

  if (has(low, '429', 'rate limit', 'quota', 'insufficient_quota')) {
    return {
      kind: 'server',
      title: 'The endpoint is rate-limiting or out of quota.',
      fixes: ['Wait a moment and try again.',
        'If this is a paid provider, check the balance on your account.'],
      raw,
    };
  }

  if (has(low, '500', '502', '503', '504', 'internal server error', 'bad gateway')) {
    return {
      kind: 'server',
      title: 'The endpoint answered with an error of its own.',
      fixes: ['The model may still be loading — local servers report this while warming up.',
        'Check the server’s own log; the reason will be there rather than here.'],
      raw,
    };
  }

  if (has(low, 'json', 'unexpected token', 'not valid')) {
    return {
      kind: 'shape',
      title: 'The endpoint answered with something that was not a completion.',
      fixes: ['This is usually a proxy or a login page answering instead of the model.',
        'Open the base URL in a browser tab and see what comes back.'],
      raw,
    };
  }

  /**
   * The one that matters, and the one a browser will not explain.
   *
   * `Failed to fetch` covers "nothing is listening" and "it is listening and
   * refused a cross-origin request" identically, on purpose — telling a page
   * which is which is a thing the same-origin policy exists to prevent. So both
   * are offered, local-first, in the order they actually occur.
   */
  if (has(low, 'failed to fetch', 'networkerror', 'load failed', 'could not reach',
    'err_connection', 'econnrefused', 'fetch failed')) {
    return {
      kind: 'unreachable',
      title: local
        ? 'No answer from that address — the server is not running, or is refusing this page.'
        : 'No answer from that address.',
      fixes: local
        ? [
          'Turn on CORS in your server: LM Studio has a toggle in Developer settings, '
          + 'Ollama needs OLLAMA_ORIGINS=*, KoboldCpp is fine by default.',
          'Check the server is actually running, and that the port matches.',
          'Use http:// for a local server, not https://.',
        ]
        : [
          'Check the address for a typo.',
          'If you are offline, this is expected.',
          'Some providers block requests made directly from a browser.',
        ],
      raw,
    };
  }

  if (has(low, 'abort')) {
    return { kind: 'unknown', title: 'The test was cancelled.', fixes: [], raw };
  }

  return {
    kind: 'unknown',
    title: 'The endpoint could not be reached.',
    fixes: ['Check the base URL, then press Connect & load models to see what it offers.'],
    raw,
  };
};

/**
 * What a successful test should say.
 *
 * Names the model that actually answered rather than the one that was asked
 * for: some endpoints quietly substitute, and a reader who sees a different
 * name here has learnt something true and slightly surprising rather than
 * being told "connected" about a model they are not using.
 */
export const describeSuccess = (model: string, reply: string, ms: number): string => {
  const speed = ms < 1200 ? '' : ` in ${(ms / 1000).toFixed(1)}s`;
  const named = model ? `“${model}” answered${speed}.` : `The endpoint answered${speed}.`;
  return reply.trim() ? `${named} Ready to use.` : `${named} It replied with nothing, which usually `
    + 'means the model loaded but produced no text — try a different one.';
};
