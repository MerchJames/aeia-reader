/**
 * Scene Director — a cheap, cached AI read of each passage that later drives
 * adaptive theming, soundscapes, and emotional TTS. See docs/SCENE_DIRECTOR.md.
 *
 * This module is the enrichment core: pure helpers (hashing, prompt building,
 * response parsing, batching) plus a thin orchestrator over the existing
 * OpenAI-compatible client. It only ANNOTATES — it never rewrites prose (that's
 * Lens's job). Nothing here touches the store or React; callers cache the
 * returned descriptors.
 */

import { CardInfo, Mood, SceneDescriptor, SceneEmphasis, ScenePerformCue } from '../types';
import { PERFORM_KINDS } from './scenePerform';
import { EMPHASIS_COLORS } from './performMarkup';
import { FX_MEANING, SCENE_FX } from './livingBackground';
import { cardToPromptBlock } from './cardContext';
import { ChatMsg, SamplerParams, chatCompletion, isLocalBase, mergeSamplers } from './aiClient';
import { REASONING_HEADROOM, hasReasoning, salvageArray, stripReasoning, truncatedInReasoning } from './aiCall';
// `storyRead.ts` imports ScenePassage/hashContent from here, so the VALUE
// import must stay one-way: only `storyReadBlock` is pulled in, and the type
// is imported as a type so the cycle never exists at runtime.
import type { StoryRead } from './storyRead';
import { storyReadBlock } from './storyRead';

/** A passage handed to the Director for reading. */
export interface ScenePassage {
  messageId: string;
  /** Speaker/character name, for the speaker field. */
  name: string;
  content: string;
}

export const MOODS: readonly Mood[] = [
  'tense', 'tender', 'ominous', 'joyful', 'melancholy',
  'action', 'eerie', 'awe', 'romantic', 'neutral',
];

const TIMES = ['dawn', 'day', 'dusk', 'night', 'unknown'] as const;
const EMPHASIS_KINDS = [
  'whisper', 'shout', 'beat', 'underline', 'strike', 'color',
] as const;
const FX_KINDS = SCENE_FX;
const SHOT_KINDS = ['establishing', 'close', 'wide'] as const;
const VFX_KINDS = ['flash', 'shake', 'vignette', 'desaturate', 'glitch', 'bloom'] as const;

/** Passages per enrichment request. Small enough to keep locality + valid JSON. */
export const SCENE_BATCH_SIZE = 10;
/** Trailing passages repeated into the next batch for tonal continuity. */
export const SCENE_BATCH_OVERLAP = 1;
/** Cap per-passage text sent for reading — moods don't need the whole essay. */
const PASSAGE_CHAR_CAP = 1600;

/**
 * Reasoning, salvage and budget now live in `aiCall.ts` — every AI feature in
 * the app hit the same three walls, and the Director was simply the first to
 * climb them. Re-exported here because this module's callers (and its tests)
 * have always reached for them at this address.
 */
export { hasReasoning, stripReasoning, truncatedInReasoning } from './aiCall';

/**
 * Output tokens to allow for a batch. Measured against a fully-populated
 * descriptor (~180 tokens) with generous slack for models that pretty-print
 * their JSON; the floor covers a single-passage retry.
 *
 * The headroom for a chain of thought is asked for UP FRONT, not after a
 * thinking model has been caught mid-thought.
 *
 * It was reactive at first, which was defensible on paper — spend nothing until
 * you know you need it — and wrong in the reader's chair. `max_tokens` is a
 * CEILING, not a spend: a model that does not think is charged nothing for the
 * room, so the only thing being saved was a number in a request body. What it
 * cost was two failed batches before the Director noticed, and on a slow local
 * model those two batches are the difference between "reads the page" and
 * "sits there". `reasoning` now only survives as the flag that raises it
 * FURTHER for a model that thinks unusually long.
 */
export const outputBudget = (passages: number, reasoning = false): number =>
  Math.max(700, Math.round(passages * 300))
  + REASONING_HEADROOM * (reasoning ? 2 : 1);

/**
 * Sampling for a READING task, not a writing one.
 *
 * The Director shipped sending only `temperature: 0.2`, which left top_p, top_k,
 * min_p and the repetition penalty to whatever the backend defaults to — and
 * local backends default to creative-writing settings. Measured against
 * KoboldCpp on an identical 10-passage batch, three runs apart: perform cues
 * 8/9/10, emphasis 6/3/6, weather 5/1/5. Re-reading a page gave a different
 * performance every time, and "Retry page" was a slot machine.
 *
 * Greedy decoding fixes it outright — the same three runs came back byte-stable
 * on every track. A descriptor is a reading of a fixed text; there is no reason
 * for it to be creative, and every reason for it to be reproducible.
 *
 * `top_k` / `min_p` / `repetition_penalty` are not OpenAI parameters and strict
 * endpoints 400 on them, so they only go to local backends (the same rule
 * `samplerParamsFrom` already applies to the reader's advanced controls).
 */
export const directorSamplers = (base: string): SamplerParams => ({
  temperature: 0,
  top_p: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  ...(isLocalBase(base) ? { top_k: 1, min_p: 0, repetition_penalty: 1 } : {}),
});

/**
 * Fast, stable content fingerprint (djb2). Only used to detect that a passage
 * changed since it was last read — not for security. Same text → same hash.
 */
export const hashContent = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export const SCENE_SYSTEM_PROMPT = [
  'You are a scene director for an interactive story reader.',
  'For each numbered passage, read it and return a compact JSON descriptor of',
  'its cinematic qualities. You ANNOTATE only — never rewrite or summarize the',
  'prose. Return ONLY a JSON array, one object per passage, in order:',
  '',
  '[{',
  '  "i": <passage number>,',
  `  "mood": one of ${MOODS.join('|')},`,
  '  "tension": number 0..1,',
  '  "location": short phrase, or null when the place has NOT changed,',
  '  "timeOfDay": one of dawn|day|dusk|night|unknown,',
  '  "speaker": { "name": string, "emotion": short word } or null,',
  '  "dialogue": [ { "text": <verbatim quoted line, WITHOUT the quote marks>, "speaker": who says it } ],',
  '  "emphasis": [ { "text": <verbatim substring of the passage>, "kind":'
  + ' whisper|shout|beat|underline|strike|color, "color": <only for kind "color">'
  + ` one of ${EMPHASIS_COLORS.join('|')} } ],`,
  '  "perform": [ { "text": <verbatim substring>, "kind": '
  + `${PERFORM_KINDS.join('|')}, "strength": 0.25..1.5 } ],`,
  `  "fx": one of ${FX_KINDS.join('|')} or null,`,
  '  "fxLevel": 0..1 — how hard it is coming down (0.3 faint, 1 overwhelming),',
  `  "shot": one of ${SHOT_KINDS.join('|')} or null,`,
  `  "vfx": one of ${VFX_KINDS.join('|')} or null`,
  '}]',
  '',
  'MOOD — pick the DOMINANT emotional register, not the surface activity:',
  '- "action" is for physical conflict, combat, a chase, urgent danger — NOT for',
  '  emotional intensity. A charged, breathless, or passionate scene is NOT action.',
  '- "romantic" for romance, passion, desire, intimacy, a charged connection;',
  '  "tender" for gentle warmth, affection, comfort. Prefer these over "action"',
  '  or "tense" whenever the heat is emotional/physical intimacy, not danger.',
  '- "awe" for wonder/the sublime; "eerie"/"ominous" for dread; "melancholy" for',
  '  grief/loss. When unsure, choose the register a reader would FEEL, not the verbs.',
  '',
  'LOCATION CONTINUITY: the story stays in one place until it clearly MOVES.',
  'Only name a location when a passage establishes or travels to one; otherwise',
  'set location to null and the reader carries the previous one forward. NEVER',
  'invent a place unrelated to the story so far — if a PREVIOUS LOCATION is given,',
  'you are still there unless the passage explicitly leaves it.',
  '',
  'DIALOGUE ATTRIBUTION: list every quoted line and WHO speaks it. text = the words',
  'inside the quotes, copied verbatim (no quote marks). Attribute to the ACTUAL',
  'speaker — an NPC the narrator voices, a script tag ("Kara:"), a "said X". A name',
  'that is merely ADDRESSED ("turned to Elara", "Elara, come here") is the listener,',
  'NOT the speaker — never attribute a line to its addressee. If truly unknown, use',
  "the passage's own character. At most 8 entries; omit or [] when there is no speech.",
  '',
  'PERFORMANCE: the reader streams the prose in a word at a time, and you direct',
  'HOW it arrives. Each cue names a verbatim span and how to play it:',
  '- "slow": drag the words out — a revelation, dread, a line that must land.',
  '- "rush": tumble them out fast — panic, a blur of motion.',
  '- "stagger": one. word. at. a. time. — hard stops, a vow, a threat.',
  '- "hold": a beat of SILENCE just before this span appears.',
  '- "swell": the words bloom larger, then settle back — awe, a name spoken.',
  '- "tremble": the words shake — fear, fury, a voice breaking.',
  '- "drop": each word lands heavy — finality, a verdict, a door closing.',
  '- "fade": the words come in faint — a whisper dying, a memory slipping.',
  '- "cut": speech broken off — the words race at the interruption and stop dead.',
  '  Mark the few words running INTO the break, not the whole line.',
  '- "unwrite": the words are written, then dissolve off the page — a retraction,',
  '  a memory going, something the story takes back. Use it very rarely.',
  'Use this SPARINGLY: at most 2 cues per passage, only on the moment that',
  'genuinely earns it, and NEVER on a whole paragraph — a cue is a few words to',
  'one short sentence. Most passages deserve none: return [] and let the prose',
  'read at its natural pace. Overusing this makes the reader feel gimmicky.',
  '',
  '',
  'EMPHASIS: how a span is SET on the page. The first three are how it SOUNDS —',
  '"whisper" for a line barely voiced, "shout" for one at full volume, "beat" for',
  'a pause held on a span. The last three are typographic and carry no volume:',
  '- "underline": stress. Weight on a few words without raising the voice.',
  '- "strike": said and taken back, or written and unsaid — the words stay, struck',
  '  through. For a retraction the prose itself performs, not for a mere mistake.',
  '- "color": the words are lit differently from the prose around them — a name',
  `  that carries dread, a flash of something. Name a "color" from ${EMPHASIS_COLORS.join('|')};`,
  '  omit it and the reader\'s own accent is used.',
  'These three are decoration until they are earned. A page with a coloured word',
  'in every paragraph reads as a ransom note; one on the right span reads as a',
  'held breath. Most passages want none.',
  '',
  'Rules: emphasis.text and perform.text MUST be exact substrings copied from the',
  'passage. Keep emphasis to at most 3 spans per passage.',
  '',
  'WEATHER (fx): set it ONLY when the prose actually shows that thing in the air',
  'right now — never from a metaphor ("her eyes burned" is not embers) and never',
  'to decorate a mood. Otherwise null. What each one means:',
  ...SCENE_FX.map(k => `- "${k}": ${FX_MEANING[k]}`),
  'fxLevel says how hard: a thin haze or a few motes is ~0.3, ordinary weather',
  '~0.65, a downpour / whiteout / choking smoke is 1.',
  'Set shot to signal the camera framing ONLY when the passage clearly calls for',
  'it: "establishing" when it opens on a place/vista, "close" for an intimate or',
  'charged one-on-one beat, "wide" for a sweeping or crowded moment — otherwise',
  'null and the reader frames it automatically. Set vfx ONLY for a genuinely',
  'charged beat: "flash" on a sudden impact/blow, "shake" on a jolt or blast,',
  '"glitch" for the uncanny/broken, "vignette" to close in on dread, "desaturate"',
  'for despair or loss, "bloom" for a radiant or wondrous moment — otherwise null.',
  '',
  'STORY READ: you may be given a short read of the WHOLE story — its shape, who',
  'is in it and how they speak, the places it returns to, and its recurring',
  'images. Use it to judge WEIGHT, not facts: a line that pays off a motif, comes',
  'back to a place that mattered, or turns the arc has earned a cue; an ordinary',
  'beat has not. Direct ONLY what is in the passage in front of you — never add a',
  'mood, a location or a speaker that the passage itself does not show.',
  '',
  'RESTRAINT: with the story in view you can tell a quiet passage from a pivotal',
  'one, so say so. Most passages are quiet: return [] for perform and emphasis,',
  'and null for fx, shot and vfx. Doing nothing is a real answer and often the',
  'right one — a cue spent on an ordinary beat is the cue you did not have when',
  'the story finally turned.',
  'Output nothing but the JSON array.',
].join('\n');

/** Build the [system, user] messages that read a batch of passages. */
export const buildEnrichMessages = (
  passages: ScenePassage[],
  card?: CardInfo,
  prevLocation?: string,
  storyRead?: StoryRead,
  /** The reader's own marks, rendered by `tasteBlock`. '' when they have made
   *  none, and then nothing about the prompt changes. */
  taste?: string,
): ChatMsg[] => {
  const cardBlock = cardToPromptBlock(card);
  const body = passages
    .map((p, i) => {
      const text = p.content.length > PASSAGE_CHAR_CAP
        ? `${p.content.slice(0, PASSAGE_CHAR_CAP).trimEnd()}…`
        : p.content;
      return `#${i + 1} — ${p.name}\n${text}`;
    })
    .join('\n\n');

  // Grounding first, passages in the middle, the task restated last —
  // the app's U-shaped placement rule (see docs/SCENE_DIRECTOR.md §4).
  const readBlock = storyReadBlock(storyRead);
  const user = [
    cardBlock && `STORY CONTEXT (for grounding only):\n${cardBlock}`,
    readBlock && `STORY READ (for weighting only):\n${readBlock}`,
    prevLocation && `PREVIOUS LOCATION: ${prevLocation} — the story is here now; keep it unless a passage clearly moves elsewhere.`,
    `PASSAGES:\n${body}`,
    // After the passages and before the task: this shapes HOW to choose, so it
    // wants the tail of the U, not the grounding at the head. The examples are
    // spans from other passages and the block says so — and `cleanEmphasis` /
    // `cleanPerform` drop anything that is not a verbatim substring of the
    // passage in hand, so a model that copies one fails closed.
    taste,
    'Return the JSON array of descriptors, one per passage, in order.',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: SCENE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
};

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
};

const asMood = (m: unknown): Mood =>
  (typeof m === 'string' && (MOODS as readonly string[]).includes(m)) ? (m as Mood) : 'neutral';

const asTime = (t: unknown): SceneDescriptor['timeOfDay'] =>
  (typeof t === 'string' && (TIMES as readonly string[]).includes(t))
    ? (t as SceneDescriptor['timeOfDay']) : undefined;

/** Keep only emphasis spans that are genuine substrings of the passage. */
const cleanEmphasis = (raw: unknown, passageText: string): SceneEmphasis[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: SceneEmphasis[] = [];
  for (const e of raw) {
    const text = typeof e?.text === 'string' ? e.text.trim() : '';
    const kind = e?.kind;
    if (!text || !(EMPHASIS_KINDS as readonly string[]).includes(kind)) continue;
    if (!passageText.includes(text)) continue; // verbatim only — locate by indexOf later
    // A colour outside the palette is NOT a reason to drop the span: the model
    // judged the words worth lighting and only got the name wrong, so the mark
    // stands and falls back to the reader's accent (see emphasisKindKey).
    const color = kind === 'color' && typeof e?.color === 'string'
      && EMPHASIS_COLORS.includes(e.color.trim().toLowerCase())
      ? e.color.trim().toLowerCase() : undefined;
    out.push(color ? { text, kind, color } : { text, kind });
    if (out.length >= 3) break;
  }
  return out.length ? out : undefined;
};

/**
 * Keep only performance cues that name a known direction over a span really
 * present in the passage. Spans are also capped in length — a cue is a beat,
 * not a paragraph, and a runaway cue would drag the whole reveal to a crawl.
 */
const MAX_PERFORM_CHARS = 160;
/** Matches what the prompt asks for — the two disagreed, and the prompt lost. */
const MAX_PERFORM_CUES = 2;
const cleanPerform = (raw: unknown, passageText: string): ScenePerformCue[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: ScenePerformCue[] = [];
  for (const p of raw) {
    const text = typeof p?.text === 'string' ? p.text.trim() : '';
    const kind = p?.kind;
    if (text.length < 2 || text.length > MAX_PERFORM_CHARS) continue;
    if (!(PERFORM_KINDS as readonly string[]).includes(kind)) continue;
    if (!passageText.includes(text)) continue; // verbatim only — located at reveal time
    if (out.some(o => o.text === text)) continue;
    const s = Number(p?.strength);
    out.push({
      text,
      kind: kind as ScenePerformCue['kind'],
      ...(Number.isFinite(s) ? { strength: Math.max(0.25, Math.min(1.5, s)) } : {}),
    });
    if (out.length >= MAX_PERFORM_CUES) break;
  }
  return out.length ? out : undefined;
};

/** Keep only dialogue entries whose quoted text is really in the passage and
 *  that name a speaker. Quote marks are stripped so matching is lenient. */
const cleanDialogue = (raw: unknown, passageText: string): { text: string; speaker: string }[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const hay = passageText.toLowerCase();
  const out: { text: string; speaker: string }[] = [];
  for (const d of raw) {
    const text = typeof d?.text === 'string' ? d.text.replace(/^["'“”]+|["'“”]+$/g, '').trim() : '';
    const speaker = typeof d?.speaker === 'string' ? d.speaker.trim() : '';
    if (!text || !speaker || text.length < 2) continue;
    if (!hay.includes(text.toLowerCase())) continue; // verbatim only — matched at play time
    out.push({ text, speaker });
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
};

/**
 * How much of a batch may carry each discretionary track.
 *
 * The prompt says "Most passages deserve none" and models simply do not obey it:
 * measured on KoboldCpp with greedy decoding, a 10-passage batch came back with
 * 10 perform cues, 5 weather calls and 3 screen effects, leaving ONE passage
 * alone. Turning the sampler down made that perfectly reproducible rather than
 * smaller — it is not noise, it is the model using every tool it was shown.
 *
 * So restraint stops being a request. This codebase already treats prompts as
 * requests and validators as rules — that is why emphasis spans are checked
 * verbatim instead of trusted — and this is the same move for quantity.
 */
export const TRACK_BUDGET: Record<'perform' | 'emphasis' | 'fx' | 'vfx', number> = {
  perform: 0.35,
  emphasis: 0.3,
  fx: 0.3,
  vfx: 0.25,
};

/**
 * Keep each discretionary track to its share of the batch, dropping the weakest
 * claims first.
 *
 * "Weakest" = lowest tension, which is the Director's OWN read of what matters,
 * so the budget spends the model's judgement rather than overriding it with
 * ours. Ties keep the earlier passage, so a re-read of the same text always
 * drops the same cues.
 *
 * A batch of one or two is left alone: a budget of "0.35 of 2" would silence a
 * genuinely charged single passage, and the point is proportion across a page,
 * not a quota on every request.
 */
export const applyBatchBudget = (descriptors: SceneDescriptor[]): SceneDescriptor[] => {
  if (descriptors.length < 4) return descriptors;
  const ranked = descriptors
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (b.d.tension - a.d.tension) || (a.i - b.i));

  for (const track of ['perform', 'emphasis', 'fx', 'vfx'] as const) {
    const cap = Math.max(1, Math.ceil(descriptors.length * TRACK_BUDGET[track]));
    let kept = 0;
    for (const { d } of ranked) {
      const value = d[track];
      const has = Array.isArray(value) ? value.length > 0 : !!value;
      if (!has) continue;
      if (kept < cap) { kept++; continue; }
      delete d[track];
      // Weather strength is meaningless without weather.
      if (track === 'fx') delete d.fxLevel;
    }
  }
  return descriptors;
};

/**
 * Parse a model reply into validated descriptors, matched back to their
 * passages by 1-based index `i` (falling back to array order). Malformed or
 * unmatched entries are dropped — never throws — so one bad passage can't sink
 * the batch.
 */
export const parseDescriptors = (
  raw: string,
  passages: ScenePassage[],
  now = Date.now(),
  prevLocation?: string,
): SceneDescriptor[] => {
  const arr = salvageArray(raw);
  if (!arr) return [];
  const out: SceneDescriptor[] = [];
  arr.forEach((item, order) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const idx = Number.isFinite(rec.i as number) ? (rec.i as number) - 1 : order;
    const passage = passages[idx];
    if (!passage) return;
    const speakerRaw = rec.speaker as Record<string, unknown> | null | undefined;
    const speaker = speakerRaw && typeof speakerRaw.name === 'string' && speakerRaw.name.trim()
      ? { name: speakerRaw.name.trim(), emotion: String(speakerRaw.emotion ?? '').trim() || 'neutral' }
      : undefined;
    out.push({
      messageId: passage.messageId,
      hash: hashContent(passage.content),
      v: DESCRIPTOR_VERSION,
      mood: asMood(rec.mood),
      tension: clamp01(rec.tension),
      location: typeof rec.location === 'string' && rec.location.trim() ? rec.location.trim() : undefined,
      timeOfDay: asTime(rec.timeOfDay),
      speaker,
      dialogue: cleanDialogue(rec.dialogue, passage.content),
      emphasis: cleanEmphasis(rec.emphasis, passage.content),
      perform: cleanPerform(rec.perform, passage.content),
      fx: typeof rec.fx === 'string' && (FX_KINDS as readonly string[]).includes(rec.fx)
        ? (rec.fx as SceneDescriptor['fx'])
        : undefined,
      fxLevel: Number.isFinite(Number(rec.fxLevel))
        ? Math.max(0.1, Math.min(1, Number(rec.fxLevel)))
        : undefined,
      shot: typeof rec.shot === 'string' && (SHOT_KINDS as readonly string[]).includes(rec.shot)
        ? (rec.shot as SceneDescriptor['shot'])
        : undefined,
      vfx: typeof rec.vfx === 'string' && (VFX_KINDS as readonly string[]).includes(rec.vfx)
        ? (rec.vfx as SceneDescriptor['vfx'])
        : undefined,
      createdAt: now,
    });
  });
  // Location continuity: a passage that names no new place STAYS where the story
  // was — carry the last known location forward (seeded by the prior batch), so
  // the soundscape/scene never jumps to an unrelated place mid-thread.
  let last = prevLocation?.trim() || undefined;
  for (const d of out) {
    if (d.location) last = d.location;
    else if (last) d.location = last;
  }
  return applyBatchBudget(out);
};

/** Split passages into overlapping batches for enrichment. */
export const batchPassages = (
  passages: ScenePassage[],
  size = SCENE_BATCH_SIZE,
  overlap = SCENE_BATCH_OVERLAP,
): ScenePassage[][] => {
  if (passages.length === 0) return [];
  const step = Math.max(1, size - overlap);
  const batches: ScenePassage[][] = [];
  for (let i = 0; i < passages.length; i += step) {
    batches.push(passages.slice(i, i + size));
    if (i + size >= passages.length) break;
  }
  return batches;
};

export interface EnrichConfig {
  base: string;
  key: string;
  model: string;
  card?: CardInfo;
  params?: SamplerParams;
}

export interface EnrichOptions {
  signal?: AbortSignal;
  /** The story's location entering this run — seeds location continuity so the
   *  first passage doesn't jump to an unrelated place. */
  prevLocation?: string;
  /** The cached whole-story read, if one has been taken — grounds cue weight. */
  storyRead?: StoryRead;
  /**
   * The reader's own marks as few-shot examples (see `tasteBlock.ts`).
   *
   * Passed in already rendered rather than as raw entries, so this module stays
   * free of the store's shapes and the block can be built once per run instead
   * of once per batch.
   */
  taste?: string;
  /**
   * Called after each batch with that batch's descriptors plus running counts:
   * `done` = unique passages read so far, `total` = passages requested,
   * `unread` = passages the model was asked about but gave nothing usable for
   * (after the split-retry). Lets the caller persist + show progress
   * incrementally, and say plainly when a model just can't do the job.
   */
  onBatch?: (descriptors: SceneDescriptor[], done: number, total: number, unread: number) => void;
}

/**
 * Read a set of passages and return their descriptors. Batches internally with
 * a 1-passage overlap for continuity; the overlap means a passage may be read
 * twice, so results de-dupe by `messageId` (last write wins). Never throws on a
 * bad batch — it logs and skips so a long run always makes progress.
 */
export const enrichPassages = async (
  passages: ScenePassage[],
  cfg: EnrichConfig,
  opts: EnrichOptions = {},
): Promise<SceneDescriptor[]> => {
  const { signal, onBatch } = opts;
  const byId = new Map<string, SceneDescriptor>();
  // The place the story was in at the end of the last batch — seeds continuity
  // so the first passage of a batch doesn't guess a fresh, unrelated location.
  let lastLocation = opts.prevLocation;
  // Every passage we've sent, so "unread" stays exact even though batches
  // overlap by one (a passage missed in one batch can land in the next).
  const attempted = new Set<string>();
  // Set the first time a reply carries a chain of thought. From then on every
  // request in this run is budgeted for one.
  let reasoning = false;

  /**
   * One request. Never throws: `threw` distinguishes "the endpoint failed"
   * (retrying smaller is pointless) from "the model replied but we couldn't use
   * it" (a smaller batch often works).
   */
  const readBatch = async (
    batch: ScenePassage[],
  ): Promise<{ got: SceneDescriptor[]; threw: boolean; cut?: boolean }> => {
    try {
      const reply = await chatCompletion(
        cfg.base, cfg.key, cfg.model,
        buildEnrichMessages(batch, cfg.card, lastLocation, opts.storyRead, opts.taste),
        // Budget the reply by BATCH SIZE. A fully-populated descriptor (mood,
        // location, speaker, up to 8 dialogue lines, emphasis, performance cues,
        // weather, shot, vfx) runs ~180 tokens, so a flat cap silently truncated
        // full batches — the Director looked like it was doing nothing.
        // Reader's advanced settings still win — this only replaces the
        // defaults nobody chose.
        // mergeSamplers, not a spread: an all-null reader config would otherwise
        // overwrite this regime with nulls and hand the batch back to the
        // backend's creative-writing defaults. See aiClient.mergeSamplers.
        mergeSamplers(
          { ...directorSamplers(cfg.base), max_tokens: outputBudget(batch.length, reasoning) },
          cfg.params,
        ),
        signal,
        `Reading ${batch.length} passage${batch.length === 1 ? '' : 's'}`,
      );
      // A model that thinks needs room to think NEXT time too — one detection
      // fixes the whole run rather than every batch paying the same toll.
      if (hasReasoning(reply)) reasoning = true;
      const cut = truncatedInReasoning(reply);
      return {
        got: parseDescriptors(stripReasoning(reply), batch, Date.now(), lastLocation),
        threw: false,
        cut,
      };
    } catch (e) {
      if (!signal?.aborted) console.error('[SceneDirector] batch failed', e);
      return { got: [], threw: true };
    }
  };

  /**
   * Read a batch, and if the model REPLIED but gave back nothing usable, split
   * it and try the halves. A small local model that chokes on ten passages will
   * usually manage five, so one weak reply costs a retry instead of the whole
   * page. A thrown request (endpoint down, aborted) is not retried smaller —
   * that would just multiply the failures.
   */
  const readOrSplit = async (batch: ScenePassage[]): Promise<SceneDescriptor[]> => {
    const attempt = await readBatch(batch);
    let { got } = attempt;
    // Cut off mid-thought: the cost was the THINKING, not the passages, so
    // splitting would fail the same way. `reasoning` is now set, which means
    // this retry carries the headroom — try the same batch once more before
    // giving up on it.
    if (!got.length && !attempt.threw && attempt.cut && !signal?.aborted) {
      got = (await readBatch(batch)).got;
    }
    const threw = attempt.threw;
    if (got.length || threw || batch.length < 4 || signal?.aborted) return got;
    const mid = Math.ceil(batch.length / 2);
    const first = await readOrSplit(batch.slice(0, mid));
    if (signal?.aborted) return first;
    return [...first, ...await readOrSplit(batch.slice(mid))];
  };

  for (const batch of batchPassages(passages)) {
    if (signal?.aborted) break;
    const descriptors = await readOrSplit(batch);
    for (const d of descriptors) byId.set(d.messageId, d);
    const withLoc = descriptors.filter(d => d.location);
    if (withLoc.length) lastLocation = withLoc[withLoc.length - 1].location;
    // What the model simply couldn't read, so the UI can say so instead of
    // sitting at a progress number that never reaches the total.
    for (const p of batch) attempted.add(p.messageId);
    let unread = 0;
    for (const id of attempted) if (!byId.has(id)) unread++;
    onBatch?.(descriptors, byId.size, passages.length, unread);
  }
  return [...byId.values()];
};

/**
 * What the Director can read TODAY. Bump this whenever the descriptor gains a
 * track the reader renders, so passages read by an older build are treated as
 * stale and picked up again — otherwise a story enriched last month stays
 * frozen at the old feature set forever and none of the new direction ever
 * reaches it. The old descriptor keeps working (and keeps rendering) until its
 * replacement lands, so nothing regresses mid-upgrade.
 *
 * 1 = mood/tension/location/speaker/emphasis/dialogue/fx/shot/vfx
 * 2 = + performance cues, weather strength (fxLevel), widened weather vocabulary
 * 3 = + read against a whole-story pass (see `storyRead.ts`): cues are weighted
 *     by the arc and its motifs, and the Director is told it may abstain
 */
export const DESCRIPTOR_VERSION = 3;

/**
 * True when a cached descriptor no longer matches the passage's text, or was
 * produced before the Director could read what the reader now renders.
 */
export const isStale = (descriptor: SceneDescriptor | undefined, content: string): boolean =>
  !descriptor
  || descriptor.hash !== hashContent(content)
  || (descriptor.v ?? 1) < DESCRIPTOR_VERSION;

/** Passages that are missing from the cache or whose text has changed. */
export const selectStale = (
  passages: ScenePassage[],
  cache: Record<string, SceneDescriptor> | undefined,
): ScenePassage[] => passages.filter(p => isStale(cache?.[p.messageId], p.content));
