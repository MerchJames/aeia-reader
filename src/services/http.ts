/**
 * The bits every service client was writing for itself.
 *
 * Aura talks to three optional local servers and, before this file, each one
 * had grown its own copy of the same three helpers. `kokoro.ts` and
 * `audioLibrary.ts` held a character-for-character duplicate of `apiRoot`;
 * `aiClient.ts` solved the same problem a third way. Three copies is three
 * chances for a base URL to be normalized differently from the one the reader
 * typed, and the symptom of that is "the server is running but Aura says it
 * isn't" — which is unfalsifiable from the UI.
 *
 * Pure, no store, no React, no fetch of its own beyond the two thin wrappers.
 */

/** Trailing slashes are the single most common thing to paste by accident. */
export const stripEnd = (u: string): string => (u ?? '').trim().replace(/\/+$/, '');

/**
 * Normalize a base URL to its `/vN` API root, adding `/v1` when the reader
 * pasted a bare host. An already-versioned URL is left alone, so
 * `http://localhost:8880/v1` does not become `.../v1/v1`.
 *
 * `fallback` covers the services that ship with a known default port and
 * should work with the field left empty.
 */
export const apiRoot = (base: string, fallback = ''): string => {
  const b = stripEnd(base) || stripEnd(fallback);
  if (!b) return '';
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
};

/**
 * The BARE root, with no version segment — health endpoints live beside the
 * API rather than inside it (`/health`, not `/v1/health`), which is why
 * `audioServiceUp` deliberately did not use `apiRoot`.
 */
export const bareRoot = (base: string, fallback = ''): string =>
  stripEnd(base) || stripEnd(fallback);

export const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

/**
 * A failed response as an error worth showing a person: which service, what
 * status, and the first 200 characters of whatever it said. The clamp matters —
 * some backends answer a 500 with an entire HTML error page, and an alert
 * containing a stylesheet helps nobody.
 */
export const serviceError = async (label: string, res: Response): Promise<Error> => {
  const body = await res.text().catch(() => '');
  const trimmed = body.trim().slice(0, 200);
  return new Error(`${label} ${res.status}${trimmed ? `: ${trimmed}` : ` ${res.statusText}`}`);
};

export interface JsonOptions {
  apiKey?: string;
  signal?: AbortSignal;
  /** Service name for the error message, e.g. "Kokoro". */
  label?: string;
  headers?: Record<string, string>;
}

/** POST JSON, throw a readable error, return the parsed body. */
export const postJson = async <T>(url: string, body: unknown, opts: JsonOptions = {}): Promise<T> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.apiKey ?? ''), ...opts.headers },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await serviceError(opts.label ?? 'Service', res);
  return res.json() as Promise<T>;
};

/** POST JSON, expect bytes back (audio, images). */
export const postForBlob = async (url: string, body: unknown, opts: JsonOptions = {}): Promise<Blob> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.apiKey ?? ''), ...opts.headers },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await serviceError(opts.label ?? 'Service', res);
  return res.blob();
};

/**
 * GET JSON, returning `null` instead of throwing.
 *
 * The read paths in this app are all optional enrichment — a library search, a
 * voice list — and every one of them already had its own try/catch returning an
 * empty result. An unreachable server is a normal state here, not an error.
 */
export const getJsonOrNull = async <T>(url: string, opts: JsonOptions = {}): Promise<T | null> => {
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders(opts.apiKey ?? ''), ...opts.headers },
      signal: opts.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
};
