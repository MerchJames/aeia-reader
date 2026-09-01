/**
 * What a passage is DOING, as opposed to how it is punctuated.
 *
 * [[narrativeBlocks]] already cuts a passage into typed, attributed pieces —
 * dialogue, thought, beat, shout, narration. Those are CHANNEL kinds: they come
 * from the marks the writer used, and they are the same axis the reader dresses
 * in Settings (see `markupStyles.ts`). They say who is speaking and how it was
 * written down.
 *
 * They do not say what the paragraph is FOR. Two stretches of narration can be
 * identical on that axis and be doing completely different work — one puts a
 * person on the page for the first time, the other moves the weather. This
 * module is the second axis: the narrative function of each block.
 *
 *   [Character introduction - Mara]   she arrives, we meet her
 *   [Character detail - Mara]         what she looks like, how she is
 *   [Char action - Mara]              she does something
 *   [World movement]                  the room, the weather, the hour
 *   [Speech - Mara]                   a line she says
 *   [Interiority - Mara]              what she thinks or feels
 *
 * Why it is worth having: once every block carries a function, the passage
 * stops being prose and becomes a STRUCTURE you can act on — reorder the
 * sections, give each one its own instruction in the Refinery, or state the
 * shape a passage ought to have and rewrite toward it. All three are things you
 * cannot express against a wall of text.
 *
 * ── Floor first, model second ──────────────────────────────────────────────
 *
 * Function is not derivable from punctuation, so unlike `narrativeBlocks` this
 * cannot be wholly deterministic. It follows the rule the rest of the app
 * follows anyway — `sceneDirector`, `askCharacter`, the codex: a heuristic floor
 * that always works, and a cached model read that overwrites it when an
 * endpoint is configured. Nothing here ever REQUIRES a model, because "AI is
 * optional everywhere" is a promise the reader was made on the front page.
 *
 * Pure except for `labelFunctions`, which is the one call that talks to a model
 * — and it goes through `aiCall`, like everything else.
 */

import { NarrativeBlock, NarrativeBlockKind } from './narrativeBlocks';
import { ChatMsg, SamplerParams } from './aiClient';
import { AiTarget, askJson } from './aiCall';
import { directorSamplers } from './sceneDirector';

/* ------------------------------------------------------------------ */
/* The taxonomy                                                        */
/* ------------------------------------------------------------------ */

export type NarrativeFunction =
  | 'introduction'
  | 'detail'
  | 'action'
  | 'world'
  | 'speech'
  | 'interiority';

/**
 * Canonical order, and the order a reordered passage falls into by default.
 *
 * It is also the order the Refinery's section list is drawn in, so it reads as
 * a rough narrative shape on its own: set the scene, bring the person in,
 * describe them, have them move, have them speak, then go inside them.
 */
export const NARRATIVE_FUNCTIONS: readonly NarrativeFunction[] = [
  'world', 'introduction', 'detail', 'action', 'speech', 'interiority',
];

/**
 * The label written into the block header the model reads and writes.
 *
 * These are the words that go inside the brackets, so they are also what the
 * reader sees in the Refinery. Kept as prose rather than the internal key — a
 * model classifies "Character introduction" far more reliably than "intro", and
 * the reader is choosing between narrative ideas, not enum members.
 */
export const FUNCTION_LABEL: Record<NarrativeFunction, string> = {
  world: 'World movement',
  introduction: 'Character introduction',
  detail: 'Character detail',
  action: 'Char action',
  speech: 'Speech',
  interiority: 'Interiority',
};

/** One line each, for the model's brief and the Refinery's tooltips. */
export const FUNCTION_HINT: Record<NarrativeFunction, string> = {
  world: 'The setting moves — place, weather, time, objects, the room itself.',
  introduction: 'A character appears in the story for the first time.',
  detail: 'What a character is like — appearance, bearing, condition.',
  action: 'A character physically does something.',
  speech: 'A line spoken aloud.',
  interiority: 'Thought, feeling, or judgement held inside a character.',
};

const BY_LABEL = new Map<string, NarrativeFunction>(
  NARRATIVE_FUNCTIONS.map(f => [FUNCTION_LABEL[f].toLowerCase(), f]),
);

/** A label as written in a block header (or by a model) → the function. */
export const functionFromLabel = (raw: string): NarrativeFunction | null => {
  const t = raw.trim().toLowerCase();
  if (BY_LABEL.has(t)) return BY_LABEL.get(t)!;
  // A model asked for "Character introduction" will sometimes answer
  // "introduction", and being strict about that would throw away a correct
  // classification over its phrasing.
  return (NARRATIVE_FUNCTIONS as readonly string[]).includes(t)
    ? t as NarrativeFunction
    : null;
};

export interface FunctionedBlock extends NarrativeBlock {
  fn: NarrativeFunction;
}

/* ------------------------------------------------------------------ */
/* The heuristic floor                                                 */
/* ------------------------------------------------------------------ */

/**
 * Channel kinds that ARE their function, whatever the prose says.
 *
 * A quoted line is speech and a thought is interiority — those are not guesses,
 * they are what the mark means, and no model read should be able to talk us out
 * of them. Beat and shout are the two that genuinely are ambiguous: they are
 * emphasis marks, and emphasis lands on an action as readily as on a shout, so
 * they get a starting guess here and are left open to the model.
 */
const KIND_FUNCTION: Partial<Record<NarrativeBlockKind, NarrativeFunction>> = {
  dialogue: 'speech',
  thought: 'interiority',
};

/** Emphasis marks: a defensible default that the model may overrule. */
const KIND_GUESS: Partial<Record<NarrativeBlockKind, NarrativeFunction>> = {
  shout: 'speech',
  beat: 'action',
};

/**
 * Words whose SUBJECT is the world rather than a person.
 *
 * Deliberately concrete and short. A long list of abstractions would drag
 * ordinary prose into `world` — the test is whether a sentence is about the
 * place rather than about somebody in it.
 */
const WORLD_NOUNS = [
  'room', 'door', 'window', 'hall', 'house', 'sky', 'wind', 'rain', 'snow',
  'fire', 'hearth', 'light', 'dark', 'darkness', 'shadow', 'air', 'street',
  'road', 'forest', 'water', 'sea', 'candle', 'lamp', 'floor', 'wall', 'roof',
  'night', 'morning', 'evening', 'afternoon', 'dawn', 'dusk', 'sun', 'moon',
  'storm', 'cold', 'heat', 'silence', 'town', 'city', 'garden', 'kitchen',
];

/** Verbs that put a body in motion, as opposed to describing a state. */
const ACTION_VERBS = [
  'walk', 'walked', 'walks', 'run', 'ran', 'runs', 'step', 'stepped', 'steps',
  'turn', 'turned', 'turns', 'reach', 'reached', 'reaches', 'take', 'took',
  'takes', 'put', 'puts', 'set', 'sets', 'pull', 'pulled', 'pulls', 'push',
  'pushed', 'pushes', 'open', 'opened', 'opens', 'close', 'closed', 'closes',
  'lift', 'lifted', 'lifts', 'drop', 'dropped', 'drops', 'stand', 'stood',
  'stands', 'sit', 'sat', 'sits', 'rise', 'rose', 'rises', 'move', 'moved',
  'moves', 'lean', 'leaned', 'leans', 'reached', 'grab', 'grabbed', 'grabs',
  'strike', 'struck', 'strikes', 'throw', 'threw', 'throws', 'cross', 'crossed',
];

/** Copulas and stative verbs — the mark of description rather than motion. */
const STATE_VERBS = ['was', 'were', 'is', 'are', 'seemed', 'looked', 'felt', 'had', 'has'];

const words = (text: string): string[] =>
  text.toLowerCase().match(/[a-z']+/g) ?? [];

const hasAny = (ws: string[], list: string[]): boolean => ws.some(w => list.includes(w));

/** Context the floor needs that a single block cannot know on its own. */
export interface FloorContext {
  /** Everyone who might appear — the same roster the bubbles and TTS use. */
  cast?: string[];
  /**
   * Names already introduced EARLIER in the story.
   *
   * Owned by the caller and mutated as it walks forward, because "first
   * appearance" is a fact about the story so far, not about this passage. Read
   * a chat from the top and a name is introduced exactly once; jump into the
   * middle and nothing is, which is the honest answer rather than calling every
   * passage an introduction.
   */
  introduced?: Set<string>;
}

/**
 * A function for one block, with no model involved.
 *
 * Mutates `ctx.introduced` when it decides a name has just been introduced, so
 * the second mention of a character is a detail rather than a second
 * introduction.
 */
export const floorFunction = (
  block: NarrativeBlock, ctx: FloorContext = {},
): NarrativeFunction => {
  const fixed = KIND_FUNCTION[block.kind];
  if (fixed) return fixed;

  const ws = words(block.text);
  const cast = (ctx.cast ?? []).map(c => c.trim()).filter(Boolean);
  const introduced = ctx.introduced;

  // A cast name appearing here for the first time in the story is somebody
  // arriving on the page. Checked before everything else because an
  // introduction is usually also an action or a description, and which of the
  // three it is called should be decided by what is NEW about it.
  const fresh = cast.find(name => {
    const key = name.toLowerCase();
    if (introduced?.has(key)) return false;
    return ws.includes(key) || key.split(/\s+/).every(part => ws.includes(part));
  });
  if (fresh && introduced) {
    introduced.add(fresh.toLowerCase());
    return 'introduction';
  }

  const guess = KIND_GUESS[block.kind];
  if (guess) return guess;

  const namesHere = cast.some(c => ws.includes(c.toLowerCase()));
  const person = namesHere || hasAny(ws, ['he', 'she', 'they', 'him', 'her', 'them', 'i', 'me']);

  // Somebody moving is an action; somebody merely BEING is a detail. The
  // distinction is the verb, which is why the two lists are separate.
  if (person && hasAny(ws, ACTION_VERBS)) return 'action';
  if (hasAny(ws, WORLD_NOUNS) && !person) return 'world';
  if (person && hasAny(ws, STATE_VERBS)) return 'detail';
  // Nothing claimed it: prose about the place it is set in.
  return hasAny(ws, WORLD_NOUNS) ? 'world' : 'detail';
};

/** The floor across a whole passage, threading the introduced-names set. */
export const floorFunctions = (
  blocks: NarrativeBlock[], ctx: FloorContext = {},
): FunctionedBlock[] => {
  const introduced = ctx.introduced ?? new Set<string>();
  return blocks.map(b => ({ ...b, fn: floorFunction(b, { ...ctx, introduced }) }));
};

/* ------------------------------------------------------------------ */
/* The round trip                                                      */
/* ------------------------------------------------------------------ */

/**
 * Blocks → the labelled text a model reads and writes.
 *
 * Same shape as `renderNarrativeBlocks`, with the function in the bracket
 * instead of the channel. World movement carries no speaker: it is nobody's
 * line, and naming an owner for the weather invites the model to give it one.
 */
export const renderFunctionBlocks = (blocks: FunctionedBlock[]): string =>
  blocks
    .filter(b => b.text)
    .map(b => (b.fn === 'world'
      ? `[${FUNCTION_LABEL[b.fn]}]\n${b.text}`
      : `[${FUNCTION_LABEL[b.fn]} - ${b.speaker}]\n${b.text}`))
    .join('\n\n');

const HEADER_RE = /^\[([^\]\n]+?)(?:\s+-\s+([^\]\n]+))?\]\s*$/;

/**
 * The labelled text → blocks again.
 *
 * `renderNarrativeBlocks` was one-way, which is precisely why nothing could be
 * DONE with the structure it produced: you could show a model the shape of a
 * passage but never read a shape back, so reordering and shape-enforcement had
 * nowhere to stand. Parsing back is the whole of the difference.
 *
 * Deliberately forgiving. This parses text a model wrote, so anything before
 * the first header is kept as narration rather than dropped — losing prose
 * because a model forgot to label its opening paragraph would be the worst
 * possible failure for a feature whose promise is that nothing is invented or
 * lost.
 */
export const parseFunctionBlocks = (
  text: string, fallbackSpeaker = 'Narrator',
): FunctionedBlock[] => {
  const out: FunctionedBlock[] = [];
  let fn: NarrativeFunction | null = null;
  let speaker = fallbackSpeaker;
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;
    out.push({
      kind: fn === 'speech' ? 'dialogue' : fn === 'interiority' ? 'thought' : 'narration',
      speaker: fn === 'world' ? fallbackSpeaker : speaker,
      text: body,
      fn: fn ?? 'detail',
    });
  };

  for (const line of text.split('\n')) {
    const m = line.match(HEADER_RE);
    const parsed = m ? functionFromLabel(m[1]) : null;
    if (m && parsed) {
      flush();
      fn = parsed;
      speaker = (m[2] ?? fallbackSpeaker).trim() || fallbackSpeaker;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
};

/**
 * Reorder a passage's blocks into a target shape.
 *
 * Stable within each function, so the sentences that belong together keep the
 * order they were written in — the gesture is "move the weather to the front",
 * never "shuffle the paragraphs". A function missing from `order` keeps its
 * place relative to the rest by sorting last rather than being dropped, because
 * silently deleting a section the reader did not list would be the one
 * unrecoverable outcome here.
 */
export const reorderByFunction = (
  blocks: FunctionedBlock[], order: readonly NarrativeFunction[],
): FunctionedBlock[] => {
  const rank = new Map(order.map((f, i) => [f, i]));
  const at = (f: NarrativeFunction) => rank.get(f) ?? order.length;
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => at(x.b.fn) - at(y.b.fn) || x.i - y.i)
    .map(({ b }) => b);
};

/** Which functions a passage actually contains, in canonical order. */
export const functionsPresent = (blocks: FunctionedBlock[]): NarrativeFunction[] =>
  NARRATIVE_FUNCTIONS.filter(f => blocks.some(b => b.fn === f && b.text));

/* ------------------------------------------------------------------ */
/* The model read                                                      */
/* ------------------------------------------------------------------ */

export const FUNCTION_SYSTEM_PROMPT = [
  'You label the narrative function of each numbered block of a story passage.',
  'Answer with a JSON array of strings, one per block, in order, and nothing else.',
  'Use exactly these labels:',
  ...NARRATIVE_FUNCTIONS.map(f => `- "${FUNCTION_LABEL[f]}": ${FUNCTION_HINT[f]}`),
  'A character is INTRODUCED only the first time they appear; later blocks about',
  'the same character are detail, action, or speech.',
  'Do not rewrite, quote, summarise or explain the blocks. Labels only.',
].join('\n');

/** The messages for one passage. Pure, so the prompt is testable on its own. */
export const buildFunctionMessages = (blocks: NarrativeBlock[]): ChatMsg[] => [
  { role: 'system', content: FUNCTION_SYSTEM_PROMPT },
  {
    role: 'user',
    content: blocks
      .map((b, i) => `${i + 1}. (${b.kind}, ${b.speaker}) ${b.text}`)
      .join('\n\n'),
  },
];

/**
 * Roughly 8 tokens a label plus JSON punctuation, floored so a one-block
 * passage still has room to answer. Sized here rather than left to the endpoint
 * because a labelling reply is tiny and an unbounded one invites a model to
 * explain itself instead.
 */
export const functionBudget = (count: number): number => 64 + count * 12;

/**
 * Read the reply into a label per block.
 *
 * Anything the model returned that is not a known label becomes `null`, and the
 * caller keeps its floor for that block — a partly-usable answer is worth more
 * than discarding the whole passage over one bad entry.
 */
export const parseFunctionLabels = (
  reply: unknown, count: number,
): (NarrativeFunction | null)[] => {
  const out: (NarrativeFunction | null)[] = new Array(count).fill(null);
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i < Math.min(count, reply.length); i++) {
    out[i] = typeof reply[i] === 'string' ? functionFromLabel(reply[i] as string) : null;
  }
  return out;
};

export interface LabelOptions extends FloorContext {
  signal?: AbortSignal;
  /** The reader's advanced sampler settings, passed through to `aiCall`. */
  reader?: SamplerParams;
}

/**
 * Label a passage, model first and floor underneath.
 *
 * Greedy sampling (`directorSamplers`) for the same reason the Scene Director
 * uses it: re-reading a page must label it the same way twice, or every feature
 * built on top of the labels moves under the reader.
 *
 * Never throws and never returns fewer blocks than it was given — the floor
 * covers every block the model did not label, so the caller always gets a
 * complete passage back whatever the endpoint did.
 */
export const labelFunctions = async (
  blocks: NarrativeBlock[],
  target: AiTarget | null,
  opts: LabelOptions = {},
): Promise<FunctionedBlock[]> => {
  const floor = floorFunctions(blocks, opts);
  if (!target?.base || !target.model || blocks.length === 0) return floor;

  const reply = await askJson<unknown[]>(target, buildFunctionMessages(blocks), {
    label: 'Reading structure',
    shape: 'array',
    params: directorSamplers(target.base),
    reader: opts.reader,
    budget: functionBudget(blocks.length),
    signal: opts.signal,
  }).catch(() => null);

  const labels = parseFunctionLabels(reply, blocks.length);
  return floor.map((b, i) => {
    const fn = labels[i];
    // The channel-fixed kinds are not the model's to change: a quoted line is
    // speech because it is in quotes, not because a model agreed.
    if (!fn || KIND_FUNCTION[b.kind]) return b;
    return { ...b, fn };
  });
};
