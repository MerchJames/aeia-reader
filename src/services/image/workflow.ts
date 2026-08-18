/**
 * Reading a ComfyUI workflow well enough to fill in the blanks.
 *
 * A ComfyUI graph is not an API — it is a whole program the reader assembled,
 * and no two look alike. To put a prompt into one we have to find which node
 * holds the positive text, which holds the negative, which holds the seed and
 * which sets the size. Everything here works on the API-format JSON that
 * ComfyUI's "Save (API Format)" produces: `{ "<nodeId>": { class_type, inputs } }`.
 *
 * The two prompts are the hard part, because they are the SAME node type
 * (`CLIPTextEncode`) and nothing in the node says which is which. What does say
 * is the sampler: `KSampler.inputs.positive` and `.negative` are links of the
 * form `[nodeId, slot]`, so the sampler names them. Guessing by node order, or
 * by which one mentions "bad quality", works on the workflows you tested and
 * fails on the reader's.
 *
 * When it cannot tell, it says so and names what it found rather than picking.
 * A silently wrong guess here produces a picture generated from the NEGATIVE
 * prompt, which looks like the feature being bad rather than misconfigured.
 *
 * Pure module — parsing and rewriting only, no fetch.
 */

import type { WorkflowMapping } from './types';

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type Workflow = Record<string, WorkflowNode>;

export interface Detection {
  mapping: Partial<WorkflowMapping>;
  /** Reader-facing notes — what was found, and what could not be. */
  notes: string[];
  /** True when the workflow can be driven at all (a positive prompt was found). */
  usable: boolean;
}

/** Node types that hold a text prompt. */
const TEXT_NODES = new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner']);
/** Node types that carry a seed. */
const SEED_NODES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'RandomNoise']);
/** Node types that set the latent size. */
const SIZE_NODES = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImagePresets']);

export const parseWorkflow = (text: string): Workflow | null => {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // The UI-format export has a top-level `nodes` array and cannot be sent to
    // /prompt at all — catching it here beats a 400 with no explanation.
    if (Array.isArray((parsed as { nodes?: unknown }).nodes)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.length) return null;
    if (!entries.every(([, v]) => !!v && typeof v === 'object' && 'class_type' in (v as object))) return null;
    return parsed as Workflow;
  } catch {
    return null;
  }
};

/** `[nodeId, slot]` link → nodeId, else null. */
const linkTarget = (v: unknown): string | null =>
  Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;

const findByType = (wf: Workflow, types: Set<string>): string[] =>
  Object.entries(wf).filter(([, n]) => types.has(n.class_type)).map(([id]) => id);

/**
 * Work out which node is which.
 *
 * The sampler is the authority on positive vs negative. Only when there is no
 * sampler — or it does not link to text nodes — does this fall back to a
 * single-text-node graph, and if it still cannot tell it refuses.
 */
export const detectMapping = (wf: Workflow): Detection => {
  const notes: string[] = [];
  const mapping: Partial<WorkflowMapping> = {};

  const samplers = findByType(wf, SEED_NODES);
  const texts = findByType(wf, TEXT_NODES);

  // --- the two prompts, named by the sampler that consumes them ---
  let namedBySampler = false;
  for (const id of samplers) {
    const inputs = wf[id].inputs ?? {};
    const pos = linkTarget(inputs.positive);
    const neg = linkTarget(inputs.negative);
    if (pos && wf[pos] && TEXT_NODES.has(wf[pos].class_type)) {
      mapping.positive = pos;
      namedBySampler = true;
    }
    if (neg && wf[neg] && TEXT_NODES.has(wf[neg].class_type)) mapping.negative = neg;
    if (namedBySampler) break;
  }

  if (namedBySampler) {
    notes.push(`Prompt: node ${mapping.positive} (named by sampler ${samplers[0]})`);
    if (mapping.negative) notes.push(`Negative: node ${mapping.negative}`);
    else notes.push('No negative prompt in this workflow — negatives will be dropped.');
  } else if (texts.length === 1) {
    mapping.positive = texts[0];
    notes.push(`Prompt: node ${texts[0]} (the only text node)`);
  } else if (texts.length > 1) {
    notes.push(
      `Found ${texts.length} text nodes (${texts.join(', ')}) and no sampler linking them. `
      + 'Pick which one is the prompt.',
    );
  } else {
    notes.push('No CLIPTextEncode node found — this does not look like a text-to-image workflow.');
  }

  // --- seed ---
  const seedNode = samplers.find(id => 'seed' in (wf[id].inputs ?? {}) || 'noise_seed' in (wf[id].inputs ?? {}));
  if (seedNode) {
    mapping.seed = seedNode;
    notes.push(`Seed: node ${seedNode}`);
  } else {
    notes.push('No seed input found — the same character will not stay consistent between pictures.');
  }

  // --- size ---
  const sizeNode = findByType(wf, SIZE_NODES)[0];
  if (sizeNode) {
    mapping.size = sizeNode;
    notes.push(`Size: node ${sizeNode}`);
  } else {
    notes.push("No latent-size node found — the workflow's own resolution will be used.");
  }

  // --- optional reference image ---
  const loadImage = Object.entries(wf).find(([, n]) => n.class_type === 'LoadImage')?.[0];
  if (loadImage) {
    mapping.reference = loadImage;
    notes.push(`Reference image: node ${loadImage}`);
  }

  return { mapping, notes, usable: !!mapping.positive };
};

export interface FillRequest {
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
  seed?: number;
}

/**
 * A copy of the workflow with the reader's values written in.
 *
 * Deep-cloned: the stored workflow is the reader's own configuration and must
 * survive a generation unchanged, or every run would bake in the last prompt.
 */
export const fillWorkflow = (
  wf: Workflow,
  mapping: Partial<WorkflowMapping>,
  req: FillRequest,
): Workflow => {
  const out: Workflow = JSON.parse(JSON.stringify(wf));

  const setText = (nodeId: string | undefined, value: string) => {
    if (!nodeId || !out[nodeId]) return;
    const inputs = out[nodeId].inputs ?? (out[nodeId].inputs = {});
    // SDXL's dual-text encoder carries the same string in two fields; writing
    // only `text` leaves half the prompt as whatever was saved with the graph.
    for (const key of ['text', 'text_g', 'text_l']) {
      if (key in inputs || key === 'text') inputs[key] = value;
    }
  };

  setText(mapping.positive, req.prompt);
  if (mapping.negative) setText(mapping.negative, req.negative ?? '');

  if (mapping.seed && out[mapping.seed] && req.seed != null) {
    const inputs = out[mapping.seed].inputs ?? (out[mapping.seed].inputs = {});
    if ('noise_seed' in inputs) inputs.noise_seed = req.seed;
    else inputs.seed = req.seed;
  }

  if (mapping.size && out[mapping.size] && req.width && req.height) {
    const inputs = out[mapping.size].inputs ?? (out[mapping.size].inputs = {});
    inputs.width = req.width;
    inputs.height = req.height;
  }

  return out;
};
