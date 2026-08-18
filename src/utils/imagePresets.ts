/**
 * Image prompt DIALECTS.
 *
 * "SD / Flux / Anime" are not really different models to pick between — they
 * are different languages to ask in, and asking in the wrong one is most of
 * why a generated picture comes back wrong:
 *
 *  - SD 1.5 / SDXL read a comma-separated pile of tags and lean hard on a
 *    NEGATIVE prompt; a flowing sentence gets averaged into mush.
 *  - Flux reads one natural-language sentence and IGNORES negatives entirely —
 *    a negative prompt there is dead weight the model never sees.
 *  - Pony and the anime checkpoints want their score tags at the front or the
 *    quality falls off a cliff for reasons that have nothing to do with the
 *    scene.
 *
 * So a preset is data: an instruction for the language model that writes the
 * prompt, a prefix, a default negative, and whether negatives mean anything at
 * all. No code branches per model, and a reader can add their own.
 *
 * Pure module — no store, no network.
 */

export interface ImagePreset {
  id: string;
  label: string;
  /** One line, reader-facing: which backends this is the right language for. */
  hint: string;
  /**
   * Handed to the model that writes the prompt. Describes the SHAPE of the
   * output, never the content — the content comes from the passage.
   */
  instruction: string;
  /** Prepended verbatim to whatever the model writes. */
  prefix: string;
  /** Starting negative prompt. Empty when the backend has no use for one. */
  negative: string;
  /** False for models that discard the negative prompt (Flux). */
  usesNegative: boolean;
  /** Typical native resolution, so the default is not a stretched square. */
  size: { width: number; height: number };
}

const BASE_NEGATIVE =
  'text, watermark, signature, logo, username, jpeg artifacts, lowres, blurry, '
  + 'extra limbs, extra fingers, deformed hands, bad anatomy, cropped, out of frame';

export const IMAGE_PRESETS: readonly ImagePreset[] = [
  {
    id: 'sdxl',
    label: 'SDXL',
    hint: 'SDXL, Illustrious, and most 1.0 checkpoints — comma-separated tags.',
    instruction:
      'Write a COMMA-SEPARATED list of visual tags, most important first. No sentences, '
      + 'no verbs, no story. Order: subject, what they are doing, clothing, expression, '
      + 'setting, lighting, camera framing, art style. 25-45 tags.',
    prefix: 'masterpiece, best quality, highly detailed, ',
    negative: BASE_NEGATIVE,
    usesNegative: true,
    size: { width: 1024, height: 1024 },
  },
  {
    id: 'sd15',
    label: 'SD 1.5',
    hint: 'Older 1.5 checkpoints — the same tag language, at 512px.',
    instruction:
      'Write a COMMA-SEPARATED list of visual tags, most important first. No sentences. '
      + 'Keep it to 20-30 tags; 1.5 loses the tail of a long prompt.',
    prefix: 'best quality, detailed, ',
    negative: BASE_NEGATIVE,
    usesNegative: true,
    size: { width: 512, height: 768 },
  },
  {
    id: 'flux',
    label: 'Flux',
    hint: 'Flux dev/schnell — one natural sentence. Negatives are ignored.',
    instruction:
      'Write ONE flowing natural-language paragraph of two to four sentences describing '
      + 'the picture as if to a photographer: who is in it, what they are doing, what they '
      + 'are wearing, where they are, the light, and the framing. No tag lists, no commas '
      + 'used as separators, no quality words like "masterpiece".',
    prefix: '',
    // Flux discards this. Kept empty rather than filled with tags that would
    // read as an assurance the model is doing something it is not.
    negative: '',
    usesNegative: false,
    size: { width: 1024, height: 1024 },
  },
  {
    id: 'pony',
    label: 'Pony / anime',
    hint: 'Pony, NoobAI and anime checkpoints — score tags lead, then booru tags.',
    instruction:
      'Write a COMMA-SEPARATED list of booru-style tags, most important first: subject, '
      + 'pose, clothing, expression, background, lighting. Use booru conventions '
      + '(1girl, 1boy, solo, looking at viewer). No sentences. 25-40 tags.',
    prefix: 'score_9, score_8_up, score_7_up, source_anime, ',
    negative: `score_6, score_5, score_4, worst quality, low quality, ${BASE_NEGATIVE}`,
    usesNegative: true,
    size: { width: 832, height: 1216 },
  },
  {
    id: 'plain',
    label: 'Plain description',
    hint: 'Cloud endpoints (DALL·E and friends) that read ordinary English.',
    instruction:
      'Write a single vivid sentence describing the picture in plain English. No tags, '
      + 'no quality words, no style jargon.',
    prefix: '',
    negative: '',
    usesNegative: false,
    size: { width: 1024, height: 1024 },
  },
];

export const presetById = (id: string): ImagePreset =>
  IMAGE_PRESETS.find(p => p.id === id) ?? IMAGE_PRESETS[0];

/**
 * Assemble the final positive prompt: preset prefix, the character's appearance
 * sheet, then the scene the model wrote.
 *
 * Appearance goes BEFORE the scene on purpose. Every one of these backends
 * weights the front of the prompt most heavily, and the thing that has to stay
 * constant between two pictures of the same person is what they look like — the
 * scene is allowed to vary, that is the point of a scene.
 */
export const composePrompt = (
  preset: ImagePreset,
  appearance: string,
  scene: string,
): string => {
  const parts = [preset.prefix.trim(), appearance.trim(), scene.trim()].filter(Boolean);
  // Tag dialects join on commas; prose dialects join on sentences.
  const glue = preset.usesNegative ? ', ' : ' ';
  return parts
    .map(p => p.replace(/[,\s]+$/, ''))
    .join(glue)
    .replace(/\s+/g, ' ')
    .trim();
};

/** The negative to send, or '' for a backend that would only discard it. */
export const composeNegative = (preset: ImagePreset, extra: string): string => {
  if (!preset.usesNegative) return '';
  return [preset.negative, extra.trim()].filter(Boolean).join(', ');
};
