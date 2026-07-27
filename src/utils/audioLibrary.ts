/**
 * Client for the OPTIONAL local audio-generation service (aura-audio/).
 *
 * Mirrors utils/kokoro.ts: a thin fetch wrapper over the Stable Audio 3 bridge,
 * which generates SFX / ambience / music and indexes them in a searchable
 * on-disk manifest. The reader works with this off; when the server is running,
 * the Scene Director can search the library, request new clips, and reference
 * them by id in a scene cue. See aura-audio/MANIFEST.md.
 */

import { AudioCategory } from '../types';

export interface AudioAsset {
  id: string;
  file: string;
  category: AudioCategory;
  prompt: string;
  description: string;
  tags: string[];
  seconds: number;
  loop: boolean;
  model: string;
  sampleRate: number;
  createdAt: number;
}

export interface GenerateAudioInput {
  prompt: string;
  category: AudioCategory;
  seconds?: number;
  loop?: boolean;
  tags?: string[];
  description?: string;
  /** Nonce that forces a fresh, distinct clip for the same prompt (a re-roll);
   *  omit for the canonical, cache-reusable render. */
  variant?: number;
}

const DEFAULT_BASE = 'http://localhost:8899';

/** Normalize a base URL to its `/vN` API root (adds `/v1` if absent). */
const apiRoot = (base: string): string => {
  const b = (base || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
};

/** The direct URL to an asset's audio bytes (for an <audio>/WebAudio source). */
export const audioAssetUrl = (base: string, id: string): string =>
  `${apiRoot(base)}/audio/file/${encodeURIComponent(id)}`;

/** Is the audio service reachable? Cheap /health probe. */
export const audioServiceUp = async (base: string, signal?: AbortSignal): Promise<boolean> => {
  try {
    const root = (base || DEFAULT_BASE).trim().replace(/\/+$/, '');
    const res = await fetch(`${root}/health`, { signal });
    return res.ok;
  } catch {
    return false;
  }
};

/** Search the manifest (all params optional). Returns [] on any failure. */
export const searchAudioLibrary = async (
  base: string,
  params: { q?: string; category?: AudioCategory; tags?: string[] },
  signal?: AbortSignal,
): Promise<AudioAsset[]> => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category) qs.set('category', params.category);
  if (params.tags?.length) qs.set('tags', params.tags.join(','));
  try {
    const res = await fetch(`${apiRoot(base)}/audio/library?${qs.toString()}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.assets) ? data.assets : [];
  } catch {
    return [];
  }
};

/** Generate (or reuse) a clip; resolves to the manifest asset. Throws on failure. */
export const generateAudio = async (
  base: string,
  input: GenerateAudioInput,
  signal?: AbortSignal,
): Promise<AudioAsset> => {
  const res = await fetch(`${apiRoot(base)}/audio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Audio ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.asset) throw new Error('audio service returned no asset');
  return data.asset as AudioAsset;
};

/** Infer a library category from a free-text intent (music/ambience/sfx). */
export const categoryForIntent = (intent: string): AudioCategory => {
  const s = (intent || '').toLowerCase();
  if (/\b(music|score|theme|melody|underscore|song|orchestr|piano|strings|cello|synth|beat|flute|panflute|lute|harp|choir|drum|percussion|folk|folklore|ballad|hymn|chant|fiddle|violin|medieval)\b/.test(s)) {
    return 'music';
  }
  if (/\b(ambien|background|room tone|drone|wind|rain|forest|crowd|hum|atmosphere|loop|bed)\b/.test(s)) {
    return 'ambience';
  }
  return 'sfx';
};

/** Keyword vocabulary for indexing a clip — mood, setting, element, instrument.
 *  Tags make a generated clip findable so the growing library becomes a
 *  reusable palette the Director can draw an adaptive soundscape from. */
const TAG_WORDS =
  /\b(rain|storm|thunder|lightning|wind|fire|crackle|forest|jungle|ocean|sea|waves|river|stream|crowd|market|tavern|inn|battle|war|sword|clash|footsteps|door|creak|bell|clock|night|dawn|dusk|day|cave|dungeon|castle|city|village|rural|snow|desert|magic|spell|tense|calm|peaceful|eerie|creepy|ominous|somber|melancholy|joyful|triumphant|romantic|epic|heroic|sad|mysterious|panflute|flute|lute|harp|drum|fiddle|violin|piano|strings|choir|synth|folk|medieval|pastoral)\b/g;

/** Derive up to 8 index tags from a free-text intent. */
export const deriveAudioTags = (intent: string): string[] =>
  [...new Set((intent.toLowerCase().match(TAG_WORDS) ?? []))].slice(0, 8);

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * Pick the library asset that best fits an intent — tag overlap weighted over
 * prompt-word overlap — so reuse is deliberate, not just "first hit". Returns
 * null when nothing meaningfully matches (score 0), so the caller generates.
 */
export const pickBestMatch = (
  hits: AudioAsset[], intent: string, tags: string[],
): AudioAsset | null => {
  if (!hits.length) return null;
  const words = new Set(wordsOf(intent));
  const score = (a: AudioAsset): number => {
    const hay = new Set([...(a.tags ?? []).map(t => t.toLowerCase()), ...wordsOf(a.prompt), ...wordsOf(a.description ?? '')]);
    let s = 0;
    for (const t of tags) if (hay.has(t)) s += 2;
    for (const w of words) if (hay.has(w)) s += 1;
    return s;
  };
  const ranked = hits.map(a => ({ a, s: score(a) })).sort((x, y) => y.s - x.s);
  return ranked[0].s > 0 ? ranked[0].a : null;
};

/**
 * Resolve an audio asset for a director beat: REUSE the best close match from the
 * manifested library if one fits, else generate a fresh, well-tagged clip (which
 * then joins the library for next time). Returns null if the service is
 * unreachable (the caller falls back to a procedural sound). Never throws.
 */
export const resolveAudioForBeat = async (
  base: string,
  intent: string,
  signal?: AbortSignal,
): Promise<AudioAsset | null> => {
  const category = categoryForIntent(intent);
  const tags = deriveAudioTags(intent);
  try {
    const hits = await searchAudioLibrary(base, { q: intent, category, tags }, signal);
    const best = pickBestMatch(hits, intent, tags);
    if (best) return best;
    return await generateAudio(
      base,
      { prompt: intent, category, loop: category !== 'sfx', tags, description: intent },
      signal,
    );
  } catch {
    return null;
  }
};
