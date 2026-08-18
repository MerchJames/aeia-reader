/**
 * The services Aura can talk to, and how to check each one.
 *
 * Every probe here reuses the call the feature already makes — the AI's model
 * list, Kokoro's voice list, the audio service's `/health`. Nothing invents a
 * new endpoint, because a probe that hits a route the real feature never uses
 * can report "up" for a server that cannot actually do the thing.
 */

import { useAppStore } from '../store';
import { listModels } from '../utils/aiClient';
import { KOKORO_DEFAULT_BASE } from '../utils/kokoro';
import { AUDIO_DEFAULT_BASE } from '../utils/audioLibrary';
import { apiRoot, bareRoot, getJsonOrNull } from './http';
import type { Capability, ProbeResult, ServiceDef, ServiceId } from './types';

/** Why a fetch failed, in words a person can act on. */
const reason = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'no answer at that address';
  return msg.slice(0, 120) || 'unreachable';
};

export const SERVICES: Record<ServiceId, ServiceDef> = {
  ai: {
    id: 'ai',
    label: 'AI endpoint',
    hint: 'Settings → AI',
    base: () => useAppStore.getState().aiBaseUrl,
    apiKey: () => useAppStore.getState().aiApiKey,
    async probe(base, key, signal) {
      if (!base.trim()) return { up: false, detail: 'no address set' };
      try {
        // `listModels` already walks `candidateBases` (/v1 then bare), so the
        // probe accepts exactly what the feature accepts.
        const { models } = await listModels(base, key);
        const caps: Capability[] = ['models'];
        const chosen = useAppStore.getState().aiModel;
        if (chosen && models.length && !models.includes(chosen)) {
          return { up: true, detail: `${models.length} models — "${chosen}" not among them`, capabilities: caps };
        }
        return {
          up: true,
          detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'reachable',
          capabilities: caps,
        };
      } catch (e) {
        void signal;
        return { up: false, detail: reason(e) };
      }
    },
  },

  kokoro: {
    id: 'kokoro',
    label: 'Kokoro (read aloud)',
    hint: 'Settings → Read aloud',
    defaultBase: KOKORO_DEFAULT_BASE,
    base: () => useAppStore.getState().kokoroBaseUrl,
    apiKey: () => useAppStore.getState().kokoroApiKey,
    async probe(base, key, signal) {
      const root = apiRoot(base, KOKORO_DEFAULT_BASE);
      if (!root) return { up: false, detail: 'no address set' };
      const data = await getJsonOrNull<{ voices?: unknown }>(`${root}/audio/voices`, { apiKey: key, signal });
      if (!data) return { up: false, detail: 'no answer at that address' };
      const list = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
      return { up: true, detail: list.length ? `${list.length} voices` : 'reachable' };
    },
  },

  audio: {
    id: 'audio',
    label: 'aura-audio (scene sound)',
    hint: 'Settings → Scene audio',
    defaultBase: AUDIO_DEFAULT_BASE,
    base: () => useAppStore.getState().audioBaseUrl,
    apiKey: () => '',
    async probe(base, _key, signal) {
      // `/health` sits at the bare root, NOT under /v1 — see bareRoot.
      const root = bareRoot(base, AUDIO_DEFAULT_BASE);
      if (!root) return { up: false, detail: 'no address set' };
      try {
        const res = await fetch(`${root}/health`, { signal });
        if (!res.ok) return { up: false, detail: `health returned ${res.status}` };
      } catch (e) {
        return { up: false, detail: reason(e) };
      }
      // Reachable — say how much is in the library, which is the number the
      // reader actually wants ("is it going to have to generate everything?").
      const lib = await getJsonOrNull<{ assets?: unknown[] }>(
        `${apiRoot(base, AUDIO_DEFAULT_BASE)}/audio/library`, { signal },
      );
      const n = Array.isArray(lib?.assets) ? lib.assets.length : null;
      return { up: true, detail: n === null ? 'reachable' : `${n} clip${n === 1 ? '' : 's'} in the library` };
    },
  },

  image: {
    id: 'image',
    label: 'Image generation',
    hint: 'Settings → Scene images',
    // No default port on purpose: ComfyUI is 8188, an OpenAI-compatible host is
    // anywhere, and guessing would show a red "not answering" to every reader
    // who never asked for pictures.
    base: () => useAppStore.getState().imageBaseUrl,
    apiKey: () => useAppStore.getState().imageApiKey,
    async probe(base, _key, signal) {
      if (!base.trim()) return { up: false, detail: 'no address set' };
      // Imported lazily: the adapters pull in the workflow parser and are dead
      // weight in a session where nobody generates a picture.
      const { probeImageService } = await import('./image');
      return probeImageService(signal);
    },
  },
};

export const serviceList: readonly ServiceDef[] = Object.values(SERVICES);

/** Probe a service, converting any throw into a `down` — a def must not reject. */
export const probeService = async (
  def: ServiceDef, signal?: AbortSignal,
): Promise<ProbeResult> => {
  try {
    return await def.probe(def.base(), def.apiKey(), signal);
  } catch (e) {
    return { up: false, detail: reason(e) };
  }
};
