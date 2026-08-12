/**
 * Minimal client for any OpenAI-compatible endpoint (OpenAI, OpenRouter,
 * LM Studio, Ollama, llama.cpp, KoboldCpp…). Given whatever base URL the user
 * pastes, we probe for the working prefix (`/v1` or bare) so they don't have to
 * know it, then talk to `/models` and `/chat/completions`.
 */

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Generation parameters passed straight into the request body. Fields left
 * undefined/null are omitted so the server uses its own defaults. The extended
 * samplers (top_k / min_p / repetition_penalty) are non-standard — only pass
 * them to backends that accept them (llama.cpp, KoboldCpp, text-generation-webui).
 */
export interface SamplerParams {
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  min_p?: number | null;
  repetition_penalty?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  max_tokens?: number | null;
}

/** Build a request body, dropping any param that's null/NaN so it isn't sent. */
const buildBody = (
  model: string, messages: ChatMsg[], stream: boolean, params: SamplerParams = {},
): Record<string, unknown> => {
  const body: Record<string, unknown> = { model, messages, stream };
  for (const [k, v] of Object.entries(params)) {
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) continue;
    body[k] = v;
  }
  return body;
};

import type { AiAdvancedConfig } from '../types';

const stripEnd = (u: string) => u.replace(/\/+$/, '');

/** Heuristic: does this base URL point at a local / LAN backend? */
export const isLocalBase = (raw: string): boolean =>
  /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\/\/10\.|\/\/192\.168\.|\/\/172\.(1[6-9]|2\d|3[01])\./i
    .test(raw || '');

/**
 * Map the reader's advanced controls to request params. OpenAI-safe samplers
 * always go through; the extended ones (top_k / min_p / repetition_penalty) are
 * only attached when the reader opts in, so strict endpoints don't 400.
 */
export const samplerParamsFrom = (a: AiAdvancedConfig): SamplerParams => {
  const p: SamplerParams = {
    temperature: a.temperature,
    top_p: a.topP,
    frequency_penalty: a.frequencyPenalty,
    presence_penalty: a.presencePenalty,
    max_tokens: a.maxTokens > 0 ? a.maxTokens : null,
  };
  if (a.extendedSamplers) {
    p.top_k = a.topK;
    p.min_p = a.minP;
    p.repetition_penalty = a.repetitionPenalty;
  }
  return p;
};

/**
 * Layer the reader's explicit settings over a task's defaults.
 *
 * Plain object spread cannot do this. `samplerParamsFrom` returns every field —
 * `{temperature: null, topP: null, …}` when the reader has set nothing — so
 * `{...taskDefaults, ...readerParams}` overwrites a deliberate `temperature:
 * 0.35` with `null`, `buildBody` then drops it, and the backend's own default
 * applies. The task regime silently evaporates at the one call site that has a
 * reader config, which is every call site in the app and none in the harness
 * scripts — so it measures fixed and ships broken.
 *
 * A null here means "the reader did not choose", not "use the server default".
 */
export const mergeSamplers = (defaults: SamplerParams, reader?: SamplerParams): SamplerParams => {
  const out: SamplerParams = { ...defaults };
  for (const [k, v] of Object.entries(reader ?? {})) {
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
};

/** Candidate base URLs to try, most-likely first. */
export const candidateBases = (raw: string): string[] => {
  let b = stripEnd((raw || '').trim());
  // Drop a pasted endpoint path so we can re-derive it.
  b = stripEnd(b.replace(/\/(chat\/completions|completions|models)$/i, ''));
  const out: string[] = [];
  const add = (x: string) => { if (x && !out.includes(x)) out.push(x); };
  if (/\/v\d+$/.test(b)) add(b);         // already versioned
  else { add(`${b}/v1`); add(b); }       // try /v1 first, then bare
  return out;
};

const authHeaders = (key: string): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

/** Fetch the model list; returns the models and the base that answered. */
export const listModels = async (
  raw: string, key: string,
): Promise<{ models: string[]; base: string }> => {
  let lastErr: unknown;
  for (const base of candidateBases(raw)) {
    try {
      const res = await fetch(`${base}/models`, { headers: authHeaders(key) });
      if (!res.ok) { lastErr = new Error(`${res.status} ${res.statusText}`); continue; }
      const data = await res.json();
      const rows = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : Array.isArray(data) ? data : [];
      const models = rows
        .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name))
        .filter(Boolean);
      return { models, base };
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Could not reach the endpoint.');
};

/** Turn an error response body into a useful message. */
const errorDetail = async (res: Response): Promise<string> => {
  let detail = `${res.status} ${res.statusText}`;
  try { const j = await res.json(); detail = j?.error?.message ?? j?.message ?? detail; } catch { /* ignore */ }
  return detail;
};

/** Non-streaming chat completion. */
export const chatCompletion = async (
  base: string, key: string, model: string, messages: ChatMsg[],
  params: SamplerParams = {}, signal?: AbortSignal,
): Promise<string> => {
  const res = await fetch(`${stripEnd(base)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(buildBody(model, messages, false, params)),
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
};

/**
 * Streaming chat completion (SSE). Calls `onToken` with each text delta as it
 * arrives and resolves with the full concatenated reply. Gracefully falls back
 * to a whole-body read if the server answered with plain JSON despite
 * `stream:true`. Aborting via `signal` resolves with whatever streamed so far.
 */
export const chatCompletionStream = async (
  base: string, key: string, model: string, messages: ChatMsg[],
  params: SamplerParams,
  onToken: (delta: string, full: string) => void,
  signal?: AbortSignal,
): Promise<string> => {
  const res = await fetch(`${stripEnd(base)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(buildBody(model, messages, true, params)),
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res));

  const ctype = res.headers.get('content-type') ?? '';
  // Server ignored stream:true and returned a normal completion — read it whole.
  if (!res.body || !/event-stream|text\/plain/i.test(ctype)) {
    if (ctype.includes('application/json')) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      if (text) onToken(text, text);
      return text;
    }
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const handleData = (payload: string) => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    try {
      const json = JSON.parse(trimmed);
      const choice = json?.choices?.[0];
      // Chat delta, or a legacy text completion chunk.
      const delta: string = choice?.delta?.content ?? choice?.text ?? '';
      if (delta) { full += delta; onToken(delta, full); }
    } catch { /* keep partial lines for the next chunk */ }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines; each event has data: lines.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const evt of events) {
        for (const line of evt.split(/\r?\n/)) {
          const m = line.match(/^data:\s?(.*)$/);
          if (m) handleData(m[1]);
        }
      }
    }
    // Flush any trailing buffered data line.
    for (const line of buffer.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m) handleData(m[1]);
    }
  } catch (e) {
    // An abort surfaces here — keep whatever we have rather than throwing it away.
    if ((e as any)?.name !== 'AbortError') throw e;
  }
  return full;
};
