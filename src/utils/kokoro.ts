/**
 * Kokoro TTS client. Talks to a Kokoro-FastAPI server, which exposes an
 * OpenAI-compatible `/v1/audio/speech` endpoint (plus `/v1/audio/voices`).
 * Everything stays local — the audio bytes come back and play in the reader.
 *
 * URL normalizing, auth and error text come from `services/http` — this file
 * used to carry its own copy of all three, character-for-character identical to
 * the one in `audioLibrary.ts`.
 */

import { apiRoot, getJsonOrNull, postForBlob } from '../services/http';

/** Where a Kokoro-FastAPI server listens unless told otherwise. */
export const KOKORO_DEFAULT_BASE = 'http://localhost:8880';

/** Standard Kokoro v1.0 voice set — used as a fallback when the server
 *  doesn't answer `/v1/audio/voices`. */
export const KNOWN_KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_alloy', 'af_aoede',
  'af_jessica', 'af_kore', 'af_nova', 'af_river',
  'am_adam', 'am_michael', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_onyx',
  'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

/** Synthesize speech; resolves to an audio Blob (mp3). */
export const kokoroSpeak = async (
  base: string,
  apiKey: string,
  voice: string,
  text: string,
  speed: number,
  signal?: AbortSignal,
): Promise<Blob> =>
  postForBlob(`${apiRoot(base, KOKORO_DEFAULT_BASE)}/audio/speech`, {
    model: 'kokoro',
    input: text,
    voice,
    response_format: 'mp3',
    speed: Math.min(2, Math.max(0.5, speed)),
  }, { apiKey, signal, label: 'Kokoro' });

/** List the server's available voices, falling back to the known set. */
export const listKokoroVoices = async (base: string, apiKey: string): Promise<string[]> => {
  const data = await getJsonOrNull<{ voices?: unknown[] }>(
    `${apiRoot(base, KOKORO_DEFAULT_BASE)}/audio/voices`, { apiKey },
  );
  const list = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
  return list.length ? list.map(String) : KNOWN_KOKORO_VOICES;
};

/** Speaker names that are narration, not a distinct character to cast. */
const NARRATION_NAMES = new Set(['', 'story', 'narrator', 'system', 'prompt', 'note']);

/** Stable djb2 hash → deterministic voice pick per character name. */
const hashName = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
};

/**
 * Pick the Kokoro voice for a speaker. Precedence: the reader's own voice for
 * user turns → an explicit per-character assignment → (auto-cast) a distinct,
 * stable voice for a named side character → the default narrator voice. The
 * protagonist (`primaryName`) and plain narration always keep the narrator
 * voice, so auto-cast only differentiates the supporting cast.
 */
export const voiceForSpeaker = (cfg: {
  role: string;
  name?: string;
  kokoroVoice: string;
  kokoroUserVoice: string;
  ttsVoiceByCharacter: Record<string, string>;
  primaryName?: string;
  autoCast?: boolean;
}): string => {
  if (cfg.role === 'user') return cfg.kokoroUserVoice || cfg.kokoroVoice;
  const name = cfg.name?.trim();
  if (name && cfg.ttsVoiceByCharacter[name]) return cfg.ttsVoiceByCharacter[name];

  if (cfg.autoCast && name) {
    const lower = name.toLowerCase();
    const isPrimary = !!cfg.primaryName && lower === cfg.primaryName.trim().toLowerCase();
    if (!isPrimary && !NARRATION_NAMES.has(lower)) {
      const pool = KNOWN_KOKORO_VOICES.filter(
        v => v !== cfg.kokoroVoice && v !== cfg.kokoroUserVoice,
      );
      if (pool.length) return pool[hashName(lower) % pool.length];
    }
  }
  return cfg.kokoroVoice;
};
