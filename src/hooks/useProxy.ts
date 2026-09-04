/**
 * Aeia standing in for the model, while SillyTavern writes.
 *
 * SillyTavern's Custom endpoint points at Aeia. Aeia gets the prompt
 * SillyTavern actually assembled — the card, the world info, the whole context
 * stack, which nothing else in this app has ever been able to see — passes it
 * to the real backend, works on the reply, and answers with both versions.
 * SillyTavern renders the second one as a swipe.
 *
 * `proxyWire.ts` knows the dialect and is tested on its own. This is the part
 * that makes the calls and moves the frames.
 *
 * ── Stage one ──────────────────────────────────────────────────────────────
 *
 * This is the first of four, and it is deliberately almost a passthrough: the
 * request goes out untouched, and the only work done on the reply is
 * `repairFormatting`, which is free, deterministic, and already in the app.
 * That is enough to exercise the whole path end to end — including the second
 * swipe, which only appears when the tidy actually changed something — without
 * any of the judgement that comes later. The pipeline hooks go where the
 * comments say so.
 *
 * ── The one thing the reader has to choose ─────────────────────────────────
 *
 * Post-processing needs the whole reply, and you cannot un-send a token. So
 * either the reply appears immediately and the processed version arrives as a
 * swipe, or nothing appears until the processing is done and then the processed
 * version is the message. There is no third option, and which one is better
 * depends on how heavy their pipeline is — so it is a setting, and it says what
 * it costs.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { candidateBases } from '../utils/aiClient';
import {
  forceFormat, needsPolish, reconcileSteps, tidy, type ReplyStepKind,
} from '../utils/replyPipeline';
import { askText } from '../utils/aiCall';
import { samplerParamsFrom } from '../utils/aiClient';
import { usePreprocess } from './usePreprocess';
import { changedAnything, summarizeRun } from '../utils/preprocess';
import { applyPlan, describePlan, type ChatMsg } from '../utils/promptPipeline';
import { proxyBlocks } from '../utils/proxyBlocks';
import {
  canSwipe, completionBody, deltaEvent, finishEvent, readDelta, readRequest,
  takeEvents, upstreamBody, type ProxyRequest,
} from '../utils/proxyWire';
import { isDesktop } from '../utils/exeBridge';

/** Backstop for the event nudge — a poll this slow costs nothing. */
const POLL_MS = 1500;

/**
 * How much text to put in one outgoing event when Aeia is replaying a reply it
 * already has in full.
 *
 * Sent whole, it would appear in one jump. Small enough to read as typing,
 * large enough that a long reply is not thousands of IPC calls.
 */
const REPLAY_CHARS = 24;

export interface ProxyStatus {
  /** What SillyTavern should be pointed at. */
  address: string | null;
  /** Requests handled this session, newest first, for the panel's log. */
  log: ProxyEntry[];
  error: string | null;
}

export interface ProxyEntry {
  at: number;
  model: string;
  ms: number;
  changed: boolean;
  /** What the request pipeline did, for the panel's log. */
  prompt?: string;
  /** What the response pipeline did. */
  reply?: string;
  error?: string;
}

const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
};

/**
 * Frames for one exchange, written in the order they were made.
 *
 * `invoke` returns a promise per call and nothing promises they settle in the
 * order they were sent. For a stream of prose that is not a detail: two deltas
 * arriving swapped is two words swapped in somebody's story, permanently, with
 * nothing to indicate it happened. So every frame goes through one chain.
 */
const writer = (id: string) => {
  let chain: Promise<unknown> = Promise.resolve();
  const push = (cmd: string, args: Record<string, unknown>) => {
    chain = chain.then(() => call(cmd, { id, ...args }));
    return chain;
  };
  return {
    begin: (sse: boolean) => push('proxy_begin', { sse }),
    chunk: (data: string) => push('proxy_chunk', { data }),
    end: () => push('proxy_end', {}),
    settled: () => chain,
  };
};

/** Break a finished reply into pieces that arrive like typing. */
export const replayChunks = (text: string, size = REPLAY_CHARS): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
};

export const useProxy = (enabled: boolean, onEntry?: (entry: ProxyEntry) => void) => {
  const live = enabled && isDesktop();
  // The reply pass, shared with the browser bridge. One implementation of
  // "check this against the reader's pins", not two that drift.
  const preprocess = usePreprocess();
  const preprocessRef = useRef(preprocess);
  preprocessRef.current = preprocess;
  /** Exchanges already being worked on, so a poll cannot start one twice. */
  const busy = useRef(new Set<string>());
  const report = useRef(onEntry);
  report.current = onEntry;

  const handle = useCallback(async (id: string, body: string) => {
    const started = Date.now();
    const app = useAppStore.getState();
    const request = readRequest(body);

    if (!request) {
      await call('proxy_fail', { id, message: 'Aeia could not read that request.' });
      return;
    }

    const base = candidateBases(app.proxyBaseUrl || app.aiBaseUrl)[0];
    const key = app.proxyApiKey || app.aiApiKey;
    if (!base) {
      await call('proxy_fail', {
        id,
        message: 'Aeia has no model to pass this to — set the writing backend on its proxy screen.',
      });
      return;
    }

    /*
     * The request pipeline.
     *
     * Everything SillyTavern assembled arrives here — the card, the world info,
     * the persona, the lot — and this is the only place in Aeia that has ever
     * seen it. The reader's material is woven in where they asked for it, and
     * the plan is applied to a copy: in the browser path the array handed over
     * is the LIVE one SillyTavern is about to send.
     */
    const plan = proxyBlocks(app);
    const shaped = applyPlan(request.messages as ChatMsg[], plan);
    const messages = shaped.messages;
    const promptNote = describePlan(shaped);

    /*
     * The response pipeline, in the reader's own order.
     *
     * Every step is wrapped: a step that throws leaves the text exactly as it
     * found it and the rest still run. A pipeline that could lose a reply
     * because one optional pass failed would be worse than no pipeline, and the
     * reader would have no way to tell which step did it.
     */
    const steps = reconcileSteps(app.proxyReply).filter(s => s.enabled);
    const notes: string[] = [];

    const runStep = async (kind: ReplyStepKind, text: string): Promise<string> => {
      switch (kind) {
        case 'tidy':
          return tidy(text);
        case 'format':
          // The reader's own formatting rules, applied for real rather than at
          // render time — this text is on its way into SillyTavern's chat file.
          return forceFormat(text, {
            autoFormatRules: app.autoFormatRules,
            paragraphSpacing: app.paragraphSpacing,
            dialogueOwnLine: app.dialogueOwnLine,
            smartTypography: app.smartTypography,
            styleQuotes: app.styleQuotes,
            role: 'ai',
          });
        case 'check': {
          const run = await preprocessRef.current(text, {
            storyId: app.proxyStoryId || undefined,
          });
          if (changedAnything(run)) notes.push(summarizeRun(run));
          return run.text;
        }
        case 'polish': {
          // Only when the text is still unbalanced, so a clean reply costs
          // nothing. Same guard the export tidy uses.
          if (!needsPolish(text)) return text;
          const fixed = await askText(
            { base, key, model: app.proxyModel || app.aiModel },
            [
              {
                role: 'system',
                content: 'You repair broken punctuation in prose. Close unclosed quotation marks '
                  + 'and emphasis markers. Change NOTHING else — not a word, not the order, not '
                  + 'the spelling. Reply with the corrected passage and nothing else.',
              },
              { role: 'user', content: text },
            ],
            {
              label: 'Polishing',
              params: { temperature: 0 },
              reader: samplerParamsFrom(app.aiAdvanced),
              budget: Math.min(6000, Math.ceil(text.length / 3) + 512),
            },
          );
          // A reply that changed the LENGTH wildly rewrote the passage rather
          // than repairing it. Keep ours — a tidy that rewrites the story is
          // worse than a stray quotation mark.
          const sane = fixed.trim() && Math.abs(fixed.length - text.length) < text.length * 0.25;
          if (sane) notes.push('punctuation polished');
          return sane ? fixed.trim() : text;
        }
        default:
          return text;
      }
    };

    const process = async (text: string): Promise<{ text: string; note?: string }> => {
      let out = text;
      for (const step of steps) {
        try {
          out = await runStep(step.kind, out);
        } catch {
          // This step did nothing. The others still run, and the reader keeps
          // what the model wrote.
        }
      }
      return { text: out, note: notes.length ? notes.join(' · ') : undefined };
    };

    const out = writer(id);
    const model = request.model || 'aeia';
    /*
     * Live, or after the pass?
     *
     * Streaming the raw reply through as it generates means nothing is ever
     * slower than it is today and the processed version arrives as a swipe.
     * Waiting means the processed version is the message, at the cost of the
     * reader watching a spinner for the whole generation. The reader picks; the
     * only thing that would be wrong is to claim one and do the other.
     */
    const liveFirst = app.proxyPrimary === 'original' && request.stream;

    try {
      if (liveFirst) await out.begin(true);
      const raw = await generate(base, key, request, messages, app.proxyModel,
        liveFirst ? piece => { void out.chunk(deltaEvent(piece, 0, model)); } : undefined);

      const { text: processed, note: replyNote } = await process(raw);
      const changed = processed !== raw;
      const withSwipe = changed && canSwipe(request);

      if (liveFirst) {
        await out.chunk(finishEvent(0, model));
        if (withSwipe) {
          // Choice 1 becomes swipe 2. Sent whole: nobody watches a swipe they
          // have not turned to, so pacing it would only cost IPC calls.
          await out.chunk(deltaEvent(processed, 1, model));
          await out.chunk(finishEvent(1, model));
        }
        await out.end();
      } else {
        await deliver(out, request, processed, raw, withSwipe, model);
      }

      report.current?.({
        at: started, model: request.model, ms: Date.now() - started, changed,
        prompt: promptNote, reply: replyNote,
      });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      // `proxy_fail` becomes a 502 while nothing has been written, and an
      // apology inside the stream once something has. Rust decides which,
      // because Rust is the one that knows whether the head has gone out.
      await call('proxy_fail', { id, message: `Aeia could not reach the model: ${message}` });
      report.current?.({
        at: started, model: request.model, ms: Date.now() - started, changed: false, error: message,
      });
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;

    const drain = async () => {
      if (stopped) return;
      try {
        const pending = await call<{ id: string; body: string }[]>('proxy_take_requests');
        for (const item of pending) {
          if (busy.current.has(item.id)) continue;
          busy.current.add(item.id);
          // Not awaited: a second request arriving while the first is still
          // generating must not queue behind it. SillyTavern can have two in
          // flight — a message and a background summary, say — and the Rust
          // side gives each its own socket.
          void handle(item.id, item.body).finally(() => busy.current.delete(item.id));
        }
      } catch {
        // The listener is not up, or the app is closing. The next tick tries
        // again; nothing here is worth a message to the reader.
      }
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        // The nudge from Rust. The poll below is only a backstop for a missed
        // event — without this, every reply would start a poll interval late.
        unlisten = await listen('aeia://proxy-request', () => { void drain(); });
      } catch { /* no event channel; the poll carries it */ }
    })();

    const tick = () => {
      void drain();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [live, handle]);
};

/* ------------------------------------------------------------------ */
/* Talking to the real model                                           */
/* ------------------------------------------------------------------ */

/**
 * Call the backend, return the whole reply, and optionally pass it on as it
 * arrives.
 *
 * Streaming is always requested upstream, even when the text is only collected
 * here: a long generation on a local backend would otherwise sit behind one
 * response timeout, and a stream keeps the connection producing.
 */
const generate = async (
  base: string, key: string, request: ProxyRequest, messages: unknown[], model: string,
  onDelta?: (text: string) => void,
): Promise<string> => {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: upstreamBody({ ...request, stream: true }, messages, model),
  });
  if (!response.ok) {
    throw new Error(`the model answered ${response.status} ${response.statusText}`.trim());
  }
  if (!response.body) throw new Error('the model sent no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = takeEvents(buffer);
    buffer = rest;
    for (const event of events) {
      if (event === '[DONE]') continue;
      const piece = readDelta(event);
      if (!piece) continue;
      text += piece;
      onDelta?.(piece);
    }
  }
  // A backend that ignored `stream` and answered with one JSON body.
  if (!text && buffer.trim()) {
    text = readDelta(buffer.trim());
    if (text) onDelta?.(text);
  }
  return text;
};

/* ------------------------------------------------------------------ */
/* Answering SillyTavern                                               */
/* ------------------------------------------------------------------ */

/**
 * Write the answer back, in whichever shape was asked for.
 *
 * The second choice is sent ONLY when the request asked for more than one
 * response. That is not a nicety: SillyTavern routes a second choice to a swipe
 * only when it requested two, and otherwise appends it to the message — so
 * sending it unasked would put the original on the end of every reply.
 */
const deliver = async (
  out: ReturnType<typeof writer>,
  request: ProxyRequest,
  processed: string,
  original: string,
  withSwipe: boolean,
  model: string,
): Promise<void> => {
  if (!request.stream) {
    await out.begin(false);
    await out.chunk(completionBody(withSwipe ? [processed, original] : [processed], model));
    await out.end();
    return;
  }

  await out.begin(true);
  // Replayed in pieces rather than sent whole: the reply is finished, but
  // arriving all at once reads as a glitch where arriving as typing reads as
  // the story being written.
  for (const piece of replayChunks(processed)) await out.chunk(deltaEvent(piece, 0, model));
  await out.chunk(finishEvent(0, model));

  if (withSwipe) {
    await out.chunk(deltaEvent(original, 1, model));
    await out.chunk(finishEvent(1, model));
  }
  await out.end();
};
