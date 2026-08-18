/**
 * ComfyUI.
 *
 * The powerful half of the pair, and the awkward one: there is no "generate an
 * image" endpoint. You POST a whole graph to `/prompt`, get a `prompt_id`, and
 * then find out when it finished by watching. What comes back is a filename you
 * fetch from `/view`.
 *
 * Polling `/history/{id}` rather than the websocket. The websocket gives finer
 * progress, but it is a second connection with its own lifecycle, reconnection
 * and client-id handshake, and this needs one fact: is it done. Polling every
 * 900ms costs nothing on localhost and cannot leave a socket open behind a
 * closed modal.
 *
 * Everything the reader configured — which node holds the prompt, the seed, the
 * size — is worked out in `workflow.ts`, which explains why guessing is not an
 * option there.
 */

import { bareRoot, serviceError } from '../http';
import type { Capability } from '../types';
import type { ImageAdapter, ImageConfig, ImageRequest, ImageResult } from './types';
import { detectMapping, fillWorkflow, parseWorkflow } from './workflow';

const POLL_MS = 900;
/** Give up after this long — a stuck queue must not hang the modal forever. */
const TIMEOUT_MS = 10 * 60 * 1000;

interface HistoryEntry {
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
}

/** The mapping in force: the reader's pins over what detection found. */
const resolveMapping = (config: ImageConfig) => {
  const wf = parseWorkflow(config.workflow);
  if (!wf) return null;
  const detected = detectMapping(wf);
  return { wf, mapping: { ...detected.mapping, ...config.mapping }, detected };
};

export const comfyAdapter: ImageAdapter = {
  id: 'comfy',
  label: 'ComfyUI',

  capabilities(config: ImageConfig): Set<Capability> {
    const caps = new Set<Capability>();
    const resolved = resolveMapping(config);
    if (!resolved) return caps;
    // Capabilities are a property of THIS workflow, not of ComfyUI. A graph
    // with no negative text node genuinely cannot take a negative prompt, and
    // saying otherwise would send one into a void.
    if (resolved.mapping.negative) caps.add('negative');
    if (resolved.mapping.seed) caps.add('seed');
    if (resolved.mapping.reference) caps.add('img2img');
    return caps;
  },

  async probe(config, signal) {
    const root = bareRoot(config.base);
    if (!root) return { up: false, detail: 'no address set' };
    try {
      // `/system_stats` is ComfyUI's own liveness route and needs no queue.
      const res = await fetch(`${root}/system_stats`, { signal });
      if (!res.ok) return { up: false, detail: `system_stats returned ${res.status}` };
    } catch {
      return { up: false, detail: 'no answer at that address' };
    }
    const resolved = resolveMapping(config);
    if (!resolved) {
      return { up: true, detail: 'running — but no workflow loaded yet' };
    }
    if (!resolved.detected.usable && !config.mapping.positive) {
      return { up: true, detail: 'running — the workflow needs a prompt node picked' };
    }
    return { up: true, detail: 'running, workflow ready' };
  },

  async generate(config: ImageConfig, req: ImageRequest): Promise<ImageResult> {
    const resolved = resolveMapping(config);
    if (!resolved) throw new Error('No ComfyUI workflow loaded. Paste one saved in API format.');
    const { wf, mapping } = resolved;
    if (!mapping.positive) {
      throw new Error('This workflow has no prompt node picked — choose one in Settings → Scene images.');
    }

    const seed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
    const filled = fillWorkflow(wf, mapping, {
      prompt: req.prompt,
      negative: mapping.negative ? req.negative ?? '' : undefined,
      width: req.width,
      height: req.height,
      seed: mapping.seed ? seed : undefined,
    });

    const root = bareRoot(config.base);
    const queued = await fetch(`${root}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: filled, client_id: `aeia-${Date.now().toString(36)}` }),
      signal: req.signal,
    });
    if (!queued.ok) throw await serviceError('ComfyUI', queued);
    const { prompt_id: promptId, error } = await queued.json() as { prompt_id?: string; error?: unknown };
    if (!promptId) throw new Error(`ComfyUI refused the workflow${error ? `: ${JSON.stringify(error).slice(0, 200)}` : '.'}`);

    const started = Date.now();
    for (;;) {
      if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (Date.now() - started > TIMEOUT_MS) {
        throw new Error('ComfyUI did not finish within ten minutes — check its queue.');
      }
      await new Promise(r => setTimeout(r, POLL_MS));

      const res = await fetch(`${root}/history/${encodeURIComponent(promptId)}`, { signal: req.signal });
      if (!res.ok) continue;
      const history = await res.json() as Record<string, HistoryEntry>;
      const entry = history?.[promptId];
      if (!entry) {
        // Still queued or running. Progress is unknowable without the socket,
        // so report elapsed time against the timeout rather than pretending.
        req.onProgress?.(Math.min(0.9, (Date.now() - started) / 60_000));
        continue;
      }
      if (entry.status && entry.status.completed === false && entry.status.status_str === 'error') {
        throw new Error('ComfyUI reported an error running the workflow — check its console.');
      }

      const images = Object.values(entry.outputs ?? {}).flatMap(o => o.images ?? []);
      // Prefer a saved output over a preview/temp image, which some graphs also emit.
      const pick = images.find(i => i.type === 'output') ?? images[0];
      if (!pick) {
        if (entry.status?.completed) throw new Error('The workflow finished but produced no image.');
        continue;
      }

      const params = new URLSearchParams({
        filename: pick.filename, subfolder: pick.subfolder ?? '', type: pick.type ?? 'output',
      });
      const img = await fetch(`${root}/view?${params.toString()}`, { signal: req.signal });
      if (!img.ok) throw await serviceError('ComfyUI', img);
      req.onProgress?.(1);
      return { blob: await img.blob(), seed };
    }
  },
};
