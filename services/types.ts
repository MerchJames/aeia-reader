/**
 * What an optional backend looks like to the rest of the app.
 *
 * Aura is AI-optional and server-optional by design: every feature that talks
 * to a service has a working path with that service off. What was missing was
 * anywhere to ASK. Features gated themselves by reading config
 * (`store.aiBaseUrl && store.aiModel` in ReaderDisplay), which answers "has the
 * reader filled in a URL" — a different question from "is it answering", and
 * the gap between the two is where a button that looks fine throws on click.
 *
 * A service declares how to reach it and how to check it. Everything else —
 * caching, debouncing, the status dot, the disabled-button explanation — is
 * built once on top of that.
 */

/**
 * Every optional backend Aura can talk to. Adding one is a single entry in
 * `registry.ts` plus a member here.
 */
export type ServiceId = 'ai' | 'kokoro' | 'audio' | 'image';

/**
 * Optional extras a backend may or may not support, discovered rather than
 * assumed. Image generation is the reason this exists: a ComfyUI workflow can
 * take a seed and a reference image, `/v1/images/generations` cannot, and the
 * feature has to degrade quietly instead of sending a field that 400s.
 */
export type Capability = 'seed' | 'img2img' | 'negative' | 'models';

export interface ProbeResult {
  up: boolean;
  /** One short line for the reader: "12 voices", "no route to host". */
  detail?: string;
  capabilities?: Capability[];
}

export interface ServiceDef {
  id: ServiceId;
  /** Reader-facing name, e.g. "Kokoro (read aloud)". */
  label: string;
  /** Where its settings live, for the "not running" message. */
  hint: string;
  /** Default base URL, used when the reader leaves the field empty. */
  defaultBase?: string;
  /** Current base URL from config — read fresh, never captured. */
  base(): string;
  apiKey(): string;
  /** Must resolve, never throw. A rejected probe is a bug in the def. */
  probe(base: string, apiKey: string, signal?: AbortSignal): Promise<ProbeResult>;
}

/**
 * `unset` is not a failure — it is the honest default state of an app whose
 * every backend is optional, and it must never be rendered as a problem.
 */
export type ServiceState = 'unset' | 'checking' | 'up' | 'down';

export interface ServiceStatus {
  state: ServiceState;
  detail?: string;
  capabilities: ReadonlySet<Capability>;
  /** When this was last determined, for "checked 2m ago". */
  at: number;
}

export const UNKNOWN: ServiceStatus = {
  state: 'unset', capabilities: new Set(), at: 0,
};
