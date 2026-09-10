/**
 * SillyTavern chat-completion presets, read into something Aeia can use.
 *
 * ── What a preset actually is ──────────────────────────────────────────────
 *
 * Three things wearing one filename:
 *
 *   1. **Sampler settings** — temperature, top_p, penalties, a context size.
 *   2. **A pile of prompts** — `prompts[]`, every one the author ever wrote,
 *      enabled or not, in no particular order.
 *   3. **An order** — `prompt_order[]`, which says which of that pile are on
 *      and what sequence they go in.
 *
 * The pile is not the preset. Lucid Loom ships 326 prompts of which a few dozen
 * are on; reading `prompts[]` and ignoring `prompt_order[]` would hand the model
 * a preset's entire history of abandoned drafts. The order is the preset.
 *
 * ── The 100001 problem ─────────────────────────────────────────────────────
 *
 * `prompt_order` is a list of lists, keyed by `character_id`, because the same
 * file can carry a different order per character. Global orders live under a
 * made-up id, and there are TWO in circulation: `PromptManager` declares 100000
 * as its default and the chat-completion manager overrides it to 100001. Files
 * in the wild carry both — Lucid Loom has an eleven-entry 100000 list left over
 * from the base class and the real 326-entry list under 100001.
 *
 * Read the wrong one and you get eleven built-in slots and none of the author's
 * work, which looks like a preset that imported fine. `ST_ORDER_ID` is 100001
 * and `tests` pins it, because the failure is silent.
 *
 * ── Markers ────────────────────────────────────────────────────────────────
 *
 * Some entries are `marker: true`: they hold no text and stand for something
 * the host assembles — the chat history, the character's description, world
 * info. They are positions, not content. Aeia has its own answer for some of
 * those and no answer for others, and `MARKER_SLOTS` is the whole of what it
 * claims. A marker it cannot fill is dropped and *named*, because a preset
 * whose history marker silently vanished is a preset that sends no story.
 *
 * ── A Lens Completion ──────────────────────────────────────────────────────
 *
 * The point of importing more than one: pick the system prompt from here, the
 * style rules from there, the jailbreak from a third, and keep them as one
 * assembled preset. A `LensCompletion` is therefore a list of REFERENCES —
 * (which preset, which prompt) — and never a copy. If the reader re-imports a
 * preset with a fixed typo, everything built on it gets the fix. The cost is
 * that a pick can go stale, which `resolvePicks` reports rather than hides.
 *
 * Pure: no store, no React, no fetch.
 */

import type { ChatMsg, SamplerParams } from './aiClient';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * The global prompt order's character id, as the chat-completion manager
 * declares it. See the note above: 100000 is a decoy left by the base class.
 */
export const ST_ORDER_ID = 100001;

/** The base class's id, kept only so a file that has nothing else can be read. */
export const ST_LEGACY_ORDER_ID = 100000;

export interface PresetPrompt {
  /** ST's identifier — a uuid for an author's prompt, a name for a built-in. */
  identifier: string;
  name: string;
  content: string;
  role: PromptRole;
  /** Stands for content the host supplies. Holds no text of its own. */
  marker: boolean;
  /** One of ST's built-in slots (main, nsfw, jailbreak…) rather than authored. */
  builtin: boolean;
  /**
   * Injected at a depth in the chat rather than sitting in the order.
   * ST calls this `injection_position: 1` (ABSOLUTE).
   */
  absolute: boolean;
  /** How far from the end of the chat, for an absolute prompt. */
  depth: number;
  /** Tie-break among absolute prompts at the same depth. Lower goes first. */
  order: number;
  /** Whether the order has it switched on. */
  enabled: boolean;
}

export interface CcPreset {
  id: string;
  name: string;
  samplers: SamplerParams;
  /** How many tokens of context the author budgeted, if they said. */
  contextSize: number | null;
  /** Consecutive system messages get folded into one before sending. */
  squashSystem: boolean;
  /** In the author's order, enabled and disabled alike. */
  prompts: PresetPrompt[];
  /** Things in the file that are real and are not carried. Named, not hidden. */
  ignored: string[];
  importedAt: number;
}

/** One entry of an assembled preset: whose prompt, and which. */
export interface CompletionPick {
  presetId: string;
  identifier: string;
}

export interface LensCompletion {
  id: string;
  name: string;
  /** In send order. */
  picks: CompletionPick[];
  /** Whose sampler settings to start from; null means Aeia's own defaults. */
  samplerFrom: string | null;
  /**
   * Fold neighbouring system messages together before sending.
   *
   * The reader's, not inherited from the presets picked out of. Squashing is a
   * property of the endpoint — some accept only one system message — and not of
   * any one prompt; letting a single borrowed prompt from a squashing preset
   * silently refold an entire assembly would be a setting nobody chose. The
   * import panel offers it when a source preset used it, and that is all.
   */
  squashSystem: boolean;
  /** The reader's own changes on top of that. */
  samplerOverrides: SamplerParams;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

/**
 * Lucid Loom is 326 prompts and about 400 KB. These are set well clear of a
 * real preset so that hitting one means the file is not a preset.
 */
export const MAX_PRESET_CHARS = 4_000_000;
export const MAX_PROMPTS = 1000;
export const MAX_PICKS = 300;
/** A single prompt longer than this is a pasted document, not a prompt. */
export const MAX_PROMPT_CHARS = 100_000;

/* ------------------------------------------------------------------ */
/* Markers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The markers Aeia can fill, and what it fills them with.
 *
 * Deliberately short. Everything here is something the reader has actually
 * given Aeia — a story, an imported character card, their pinned material.
 * `worldInfoBefore`/`worldInfoAfter` are absent on purpose: SillyTavern's world
 * info is keyword-triggered lorebook entries chosen per turn, and pretending a
 * pin set is the same thing would put the wrong text in a slot the author
 * carefully placed.
 */
export const MARKER_SLOTS = {
  chatHistory: 'The story so far',
  charDescription: 'The character card’s description',
  charPersonality: 'The character card’s personality',
  scenario: 'The character card’s scenario',
  dialogueExamples: 'The character card’s example dialogue',
  personaDescription: 'Your persona',
} as const;

export type MarkerSlot = keyof typeof MARKER_SLOTS;

export const isFillableMarker = (identifier: string): identifier is MarkerSlot =>
  Object.prototype.hasOwnProperty.call(MARKER_SLOTS, identifier);

/* ------------------------------------------------------------------ */
/* Reading a file                                                      */
/* ------------------------------------------------------------------ */

const SAMPLER_KEYS: [string, keyof SamplerParams][] = [
  ['temperature', 'temperature'],
  ['top_p', 'top_p'],
  ['top_k', 'top_k'],
  ['min_p', 'min_p'],
  ['repetition_penalty', 'repetition_penalty'],
  ['frequency_penalty', 'frequency_penalty'],
  ['presence_penalty', 'presence_penalty'],
  ['openai_max_tokens', 'max_tokens'],
];

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const role = (v: unknown): PromptRole =>
  v === 'user' || v === 'assistant' ? v : 'system';

/**
 * Why a file cannot be read as a preset, or null when it can.
 *
 * A preset with no `prompts` is refused; a preset with no `prompt_order` is
 * not. The second happens — a hand-written or trimmed file — and there is an
 * obvious reading of it: everything, in the order it is written, using each
 * prompt's own `enabled`. The first has nothing to read at all.
 */
export const presetProblem = (text: string): string | null => {
  if (!text.trim()) return 'That file is empty.';
  if (text.length > MAX_PRESET_CHARS) {
    return 'That file is far larger than any chat completion preset — it is probably something else.';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'That is not JSON. A SillyTavern preset is a .json file exported from its preset menu.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'That JSON is not an object, so it is not a preset.';
  }
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.prompts)) {
    return 'That preset has no prompts in it. Text completion presets are a different '
      + 'format — this reads the chat completion kind.';
  }
  if (raw.prompts.length > MAX_PROMPTS) {
    return `That preset holds ${raw.prompts.length} prompts, which is more than any real one.`;
  }
  return null;
};

/**
 * The order list to use: the chat-completion manager's, then the base class's,
 * then whichever is longest.
 *
 * The last fallback exists for files saved by forks that chose their own id.
 * Longest rather than first because the decoy lists are the short ones — the
 * eleven built-in slots — and a preset's real order is its long one.
 */
const pickOrder = (lists: unknown): { identifier: string; enabled: boolean }[] | null => {
  if (!Array.isArray(lists) || !lists.length) return null;
  const entries = lists
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map(l => ({
      id: num(l.character_id),
      order: Array.isArray(l.order) ? l.order : [],
    }))
    .filter(l => l.order.length);
  if (!entries.length) return null;

  const chosen =
    entries.find(e => e.id === ST_ORDER_ID)
    ?? entries.find(e => e.id === ST_LEGACY_ORDER_ID)
    ?? entries.slice().sort((a, b) => b.order.length - a.order.length)[0];

  return chosen.order
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map(o => ({ identifier: str(o.identifier), enabled: o.enabled !== false }))
    .filter(o => o.identifier);
};

/**
 * Read a preset. Call `presetProblem` first — this assumes it passed.
 *
 * The returned `prompts` are in SEND ORDER, which is the order's order and not
 * the file's. Entries the order names but the pile does not hold are dropped
 * (an order can outlive a deleted prompt); entries the pile holds but the order
 * does not name are appended, disabled, so the reader can still find and pick
 * them for a Lens Completion. That second rule is the whole reason a 326-prompt
 * preset is worth importing rather than just running.
 */
export const readCcPreset = (text: string, name: string, id: string): CcPreset => {
  const raw = JSON.parse(text) as Record<string, unknown>;

  const samplers: SamplerParams = {};
  for (const [from, to] of SAMPLER_KEYS) {
    const value = num(raw[from]);
    if (value !== null) samplers[to] = value;
  }

  const pile = new Map<string, PresetPrompt>();
  for (const entry of raw.prompts as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const identifier = str(p.identifier);
    if (!identifier || pile.has(identifier)) continue;
    const content = str(p.content);
    pile.set(identifier, {
      identifier,
      name: str(p.name) || identifier,
      content: content.length > MAX_PROMPT_CHARS ? content.slice(0, MAX_PROMPT_CHARS) : content,
      role: role(p.role),
      marker: p.marker === true,
      builtin: p.system_prompt === true,
      absolute: num(p.injection_position) === 1,
      depth: num(p.injection_depth) ?? 4,
      order: num(p.injection_order) ?? 100,
      // Overwritten below by the order, which is the authority. This is the
      // fallback for a file that has no order at all.
      enabled: p.enabled === true,
    });
  }

  const order = pickOrder(raw.prompt_order);
  const prompts: PresetPrompt[] = [];
  const placed = new Set<string>();

  if (order) {
    for (const entry of order) {
      const found = pile.get(entry.identifier);
      if (!found) continue;
      prompts.push({ ...found, enabled: entry.enabled });
      placed.add(entry.identifier);
    }
  }
  for (const [identifier, prompt] of pile) {
    if (placed.has(identifier)) continue;
    // Off, whatever the file said: a prompt the order does not mention is not
    // part of this preset. It is kept so it can be picked, not so it can fire.
    prompts.push({ ...prompt, enabled: order ? false : prompt.enabled });
  }

  const ignored: string[] = [];
  const extensions = raw.extensions as Record<string, unknown> | undefined;
  if (extensions && Array.isArray(extensions.regex_scripts) && extensions.regex_scripts.length) {
    ignored.push(
      `${extensions.regex_scripts.length} regex script(s) — Aeia has its own force-format rules`,
    );
  }
  if (str(raw.assistant_prefill)) ignored.push('an assistant prefill');
  if (str(raw.impersonation_prompt)) ignored.push('the impersonation prompt');
  if (str(raw.continue_nudge_prompt)) ignored.push('the continue nudge');
  if (raw.function_calling === true) ignored.push('function calling');
  if (raw.enable_web_search === true) ignored.push('web search');

  return {
    id,
    name: name.trim() || 'Imported preset',
    samplers,
    contextSize: num(raw.openai_max_context),
    squashSystem: raw.squash_system_messages === true,
    prompts,
    ignored,
    importedAt: Date.now(),
  };
};

/** One line for the import confirmation. Counts, because counts are checkable. */
export const describePreset = (preset: CcPreset): string => {
  const on = preset.prompts.filter(p => p.enabled).length;
  const markers = preset.prompts.filter(p => p.enabled && p.marker).length;
  const parts = [
    `${on} prompt${on === 1 ? '' : 's'} on`,
    `${preset.prompts.length} in the file`,
  ];
  if (markers) parts.push(`${markers} placeholder${markers === 1 ? '' : 's'}`);
  return `${preset.name} — ${parts.join(', ')}.`;
};

/* ------------------------------------------------------------------ */
/* Assembling across presets                                           */
/* ------------------------------------------------------------------ */

let seq = 0;
export const completionId = (): string =>
  `lc${Date.now().toString(36)}${(seq++).toString(36)}`;

export const emptyCompletion = (name: string): LensCompletion => ({
  id: completionId(),
  name: name.trim() || 'Untitled',
  picks: [],
  samplerFrom: null,
  squashSystem: false,
  samplerOverrides: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

export interface ResolvedPick {
  pick: CompletionPick;
  prompt: PresetPrompt;
  /** The preset it came from, for the UI to say so. */
  presetName: string;
}

export interface Resolution {
  picks: ResolvedPick[];
  /** Picks whose preset or prompt is gone, described for the reader. */
  stale: string[];
}

/**
 * Turn picks into prompts.
 *
 * A pick is a reference, so it can dangle — the reader deleted the preset, or
 * re-imported one whose author had removed a prompt. Both are reported by name
 * rather than dropped quietly, because a Lens Completion silently missing its
 * system prompt still produces text, and the text is just worse.
 *
 * `enabled` is deliberately NOT consulted here. A pick is the reader saying "I
 * want this one", which outranks whether the preset it came from had it on —
 * picking a prompt out of the 300 an author left switched off is the point.
 */
export const resolvePicks = (
  completion: LensCompletion,
  presets: readonly CcPreset[],
): Resolution => {
  const byId = new Map(presets.map(p => [p.id, p]));
  const out: ResolvedPick[] = [];
  const stale: string[] = [];

  for (const pick of completion.picks) {
    const preset = byId.get(pick.presetId);
    if (!preset) {
      stale.push(`a prompt from a preset that is no longer imported`);
      continue;
    }
    const prompt = preset.prompts.find(p => p.identifier === pick.identifier);
    if (!prompt) {
      stale.push(`“${pick.identifier}” is no longer in ${preset.name}`);
      continue;
    }
    out.push({ pick, prompt, presetName: preset.name });
  }
  return { picks: out, stale };
};

/** Add a pick, refusing a duplicate and the cap. Returns the same list if neither applies. */
export const addPick = (
  completion: LensCompletion,
  pick: CompletionPick,
): LensCompletion => {
  const already = completion.picks.some(
    p => p.presetId === pick.presetId && p.identifier === pick.identifier,
  );
  if (already || completion.picks.length >= MAX_PICKS) return completion;
  return { ...completion, picks: [...completion.picks, pick], updatedAt: Date.now() };
};

export const removePick = (completion: LensCompletion, at: number): LensCompletion => {
  if (at < 0 || at >= completion.picks.length) return completion;
  const picks = completion.picks.slice();
  picks.splice(at, 1);
  return { ...completion, picks, updatedAt: Date.now() };
};

/** Move a pick. Out-of-range is a no-op rather than a wrap-around. */
export const movePick = (
  completion: LensCompletion, from: number, to: number,
): LensCompletion => {
  const n = completion.picks.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return completion;
  const picks = completion.picks.slice();
  const [moved] = picks.splice(from, 1);
  picks.splice(to, 0, moved);
  return { ...completion, picks, updatedAt: Date.now() };
};

/**
 * The sampler settings a completion asks for.
 *
 * The reader's own overrides win over the borrowed preset's, and a null in the
 * overrides is not an override — the same rule `mergeSamplers` uses, for the
 * same reason: a form with an empty temperature box must not mean "no
 * temperature", it means "I did not say".
 */
export const samplersFor = (
  completion: LensCompletion,
  presets: readonly CcPreset[],
): SamplerParams => {
  const base = completion.samplerFrom
    ? presets.find(p => p.id === completion.samplerFrom)?.samplers ?? {}
    : {};
  const out: SamplerParams = { ...base };
  for (const [key, value] of Object.entries(completion.samplerOverrides)) {
    if (value == null || (typeof value === 'number' && Number.isNaN(value))) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Building the request                                                */
/* ------------------------------------------------------------------ */

/** What the caller can put in a marker's place. Missing is allowed and reported. */
export type MarkerFill = Partial<Record<MarkerSlot, string>>;

export interface BuiltPrompt {
  messages: ChatMsg[];
  /**
   * Prompts that asked for something and got nothing: an unfillable marker, a
   * fillable one the caller had no content for, or an empty prompt. Named, so
   * the panel can say "this preset wants world info and Aeia has none".
   */
  dropped: string[];
}

/**
 * The messages to send.
 *
 * Absolute-position prompts are a real part of the format and are NOT supported
 * as depth injections here: Aeia builds its own history and has no equivalent
 * of "four messages from the end". They are placed in order instead, sorted by
 * their `injection_order`, and reported — putting them somewhere sensible and
 * saying so beats dropping an author's rule on the floor.
 */
export const buildPrompt = (
  prompts: readonly PresetPrompt[],
  fill: MarkerFill,
  squashSystem = false,
): BuiltPrompt => {
  const messages: ChatMsg[] = [];
  const dropped: string[] = [];

  // Relative first in their own order, then absolutes by injection_order —
  // which is at least the sequence the author wrote them to run in.
  const relative = prompts.filter(p => !p.absolute);
  const absolute = prompts.filter(p => p.absolute).sort((a, b) => a.order - b.order);

  for (const prompt of [...relative, ...absolute]) {
    if (prompt.marker) {
      if (!isFillableMarker(prompt.identifier)) {
        dropped.push(`${prompt.name} (Aeia has nothing for “${prompt.identifier}”)`);
        continue;
      }
      const content = (fill[prompt.identifier] ?? '').trim();
      if (!content) {
        dropped.push(`${prompt.name} (nothing to put in it)`);
        continue;
      }
      messages.push({ role: prompt.role, content });
      continue;
    }
    const content = prompt.content.trim();
    if (!content) {
      dropped.push(`${prompt.name} (empty)`);
      continue;
    }
    messages.push({ role: prompt.role, content });
  }

  return { messages: squashSystem ? squash(messages) : messages, dropped };
};

/**
 * Fold runs of same-role messages into one, blank line between.
 *
 * ST's `squash_system_messages`, and it is not cosmetic: some endpoints accept
 * only one system message, and several charge or truncate per message. Only
 * consecutive ones — a system prompt after the history is in a different place
 * and must stay there.
 */
export const squash = (messages: readonly ChatMsg[]): ChatMsg[] => {
  const out: ChatMsg[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role && message.role === 'system') {
      out[out.length - 1] = { role: last.role, content: `${last.content}\n\n${message.content}` };
      continue;
    }
    out.push({ ...message });
  }
  return out;
};

/**
 * Did any preset a completion draws on use squashing? Not applied — offered.
 * The panel uses this to suggest the setting when the reader assembles from a
 * preset whose author relied on it.
 */
export const sourcesSquash = (
  completion: LensCompletion,
  presets: readonly CcPreset[],
): boolean => resolvePicks(completion, presets).picks
  .some(p => presets.find(x => x.id === p.pick.presetId)?.squashSystem === true);

/** What a Lens Completion will send, without sending it. */
export const previewCompletion = (
  completion: LensCompletion,
  presets: readonly CcPreset[],
  fill: MarkerFill,
): BuiltPrompt & { stale: string[] } => {
  const { picks, stale } = resolvePicks(completion, presets);
  const built = buildPrompt(picks.map(p => p.prompt), fill, completion.squashSystem);
  return { ...built, stale };
};
