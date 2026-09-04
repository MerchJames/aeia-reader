/**
 * Choosing what of the reader's own material goes into a prompt.
 *
 * `promptPipeline.ts` decides where a block lands and whether it fits. This
 * decides which blocks there are — and, more importantly, in what order, since
 * the budget is spent from the top and everything past it is left out.
 *
 * ── Why this is a list of ids and not a row of checkboxes ──────────────────
 *
 * It was checkboxes first: "pins" on, "sheets" off. That is a setting for a
 * library, not for a scene. A reader with thirty pins does not want thirty pins
 * in every prompt — they want the four that matter tonight, and they want to
 * see which four. A checkbox cannot express that, and worse, it hides the
 * question: with "pins" ticked and a budget of eight thousand characters, WHICH
 * pins actually went in was decided by an ordering rule nobody could see.
 *
 * So the selection is explicit. Every id here was pointed at.
 *
 * The one exception is `activeSet`, which is a live subscription rather than a
 * choice of items: whatever the reader's current pin set marks as in-context
 * goes in, and changing the set changes the prompt. That is worth having
 * BECAUSE it moves — it is the one thing here that keeps up with the story on
 * its own.
 *
 * ── The order, and why it is that order ────────────────────────────────────
 *
 * Named things first, in the order the reader listed them, because that is
 * their stated priority. The active set after, since it is a standing rule
 * rather than a decision about this scene. Zones last: they are the largest
 * things here by an order of magnitude, and a zone that does not fit should
 * cost itself rather than four pins.
 *
 * Pure: everything it reads is passed in.
 */

import type { PromptBlock, Slot } from './promptPipeline';

/** Everything the reader can put into a prompt. */
export type MaterialKind = 'pin' | 'set' | 'sheet' | 'codex' | 'highlight' | 'zone';

/** What was picked, by id, per kind. */
export interface MaterialPick {
  pins: string[];
  /** Pin sets — each expands to the pins it marks as in-context. */
  sets: string[];
  sheets: string[];
  codex: string[];
  highlights: string[];
  zones: string[];
  /**
   * Track the ACTIVE pin set, whatever it happens to be.
   *
   * Not the same as naming that set in `sets`: this follows the reader as they
   * switch sets between scenes, which is the whole point of having sets.
   */
  activeSet: boolean;
  /** Where the blocks are placed in the prompt. */
  slot: Slot;
}

export const DEFAULT_PICK: MaterialPick = {
  pins: [],
  sets: [],
  sheets: [],
  codex: [],
  highlights: [],
  zones: [],
  activeSet: true,
  slot: 'system',
};

/**
 * A stored pick, made safe to use.
 *
 * These settings persist, and the shape has already changed once — it was a row
 * of category booleans (`pins: true`) before it was a list of ids. A stored
 * `true` reaching `for (const id of pick.pins)` throws, and an uncaught throw in
 * a render is a black screen with no message, which is exactly what it cost the
 * reader who found it.
 *
 * A migration handles the known change. This handles every other way the value
 * can be wrong — a hand-edited config, a half-written save, a version that
 * never existed — because no setting should be able to take the app down.
 */
export const normalizePick = (value: unknown): MaterialPick => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const ids = (v: unknown): string[] =>
    (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const slot = raw.slot;
  return {
    pins: ids(raw.pins),
    sets: ids(raw.sets),
    sheets: ids(raw.sheets),
    codex: ids(raw.codex),
    highlights: ids(raw.highlights),
    zones: ids(raw.zones),
    // Absent means the default (on) rather than off: this is the one that keeps
    // a prompt useful without any picking at all.
    activeSet: raw.activeSet === undefined ? true : !!raw.activeSet,
    slot: slot === 'end' || slot === 'before-last-user' ? slot : 'system',
  };
};

/** One thing the reader can choose, as the picker shows it. */
export interface MaterialItem {
  id: string;
  kind: MaterialKind;
  title: string;
  /** A line or two of what it holds, for the picker's preview. */
  preview: string;
  /** Full text as it would go into a prompt. */
  text: string;
  /** Roughly how much of the budget it would spend. */
  size: number;
}

export interface MaterialInput {
  pins: { id: string; title: string; content: string }[];
  sets: { id: string; name: string; inContext: string[] }[];
  /** Which set is active right now, for `activeSet`. */
  activeSetId?: string;
  sheets: { id: string; title: string; columns: string[]; rows: Record<string, string>[] }[];
  codex: { id: string; name: string; kind: string; summary: string }[];
  highlights: { id: string; text: string; note?: string }[];
  /** Zones already rendered to text — building one needs the story's chains. */
  zones: { id: string; name: string; body: string }[];
}

export const EMPTY_INPUT: MaterialInput = {
  pins: [], sets: [], sheets: [], codex: [], highlights: [], zones: [],
};

/** A sheet as labelled lines, which a model reads better than a grid. */
export const sheetText = (sheet: MaterialInput['sheets'][number]): string =>
  sheet.rows
    .map(row => sheet.columns.map(c => `${c}: ${row[c] ?? ''}`).join('; '))
    .join('\n');

const clip = (text: string, n = 90): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/**
 * Everything available, as a flat list the picker can render and filter.
 *
 * Built from the same inputs the prompt is built from, so the picker can never
 * offer something that would not actually go in — a list of things that
 * quietly do nothing is worse than a shorter list.
 */
export const listMaterial = (input: MaterialInput): MaterialItem[] => {
  const out: MaterialItem[] = [];
  const add = (id: string, kind: MaterialKind, title: string, text: string) => {
    if (!text.trim()) return;
    out.push({ id, kind, title: title || kind, preview: clip(text), text, size: text.length });
  };

  for (const p of input.pins) add(p.id, 'pin', p.title, p.content);
  for (const s of input.sets) {
    const held = s.inContext.length;
    // A set is shown by what it holds rather than by its own text, because it
    // has none — picking one is picking its pins.
    out.push({
      id: s.id,
      kind: 'set',
      title: s.name || 'Set',
      preview: `${held} pin${held === 1 ? '' : 's'} in context`,
      text: '',
      size: input.pins.filter(p => s.inContext.includes(p.id))
        .reduce((n, p) => n + p.content.length, 0),
    });
  }
  for (const s of input.sheets) add(s.id, 'sheet', s.title, sheetText(s));
  for (const c of input.codex) add(c.id, 'codex', c.name, c.summary);
  for (const h of input.highlights) {
    add(h.id, 'highlight', clip(h.text, 40), h.note ? `${h.text}\n${h.note}` : h.text);
  }
  for (const z of input.zones) add(z.id, 'zone', z.name, z.body);
  return out;
};

/** How many things are picked, for a one-line summary. */
export const pickCount = (raw: MaterialPick): number => {
  const pick = normalizePick(raw);
  return pick.pins.length + pick.sets.length + pick.sheets.length
    + pick.codex.length + pick.highlights.length + pick.zones.length;
};

/** Is this item picked? */
export const isPicked = (raw: MaterialPick, item: Pick<MaterialItem, 'id' | 'kind'>): boolean =>
  listFor(normalizePick(raw), item.kind).includes(item.id);

const listFor = (pick: MaterialPick, kind: MaterialKind): string[] => ({
  pin: pick.pins,
  set: pick.sets,
  sheet: pick.sheets,
  codex: pick.codex,
  highlight: pick.highlights,
  zone: pick.zones,
}[kind]);

const KEY: Record<MaterialKind, keyof MaterialPick> = {
  pin: 'pins', set: 'sets', sheet: 'sheets',
  codex: 'codex', highlight: 'highlights', zone: 'zones',
};

/** Add or remove one item, returning a new pick. */
export const togglePick = (
  raw: MaterialPick, item: Pick<MaterialItem, 'id' | 'kind'>,
): MaterialPick => {
  const pick = normalizePick(raw);
  const key = KEY[item.kind];
  const list = listFor(pick, item.kind);
  return {
    ...pick,
    [key]: list.includes(item.id)
      ? list.filter(id => id !== item.id)
      // Appended, not sorted: the order the reader picked things in IS the
      // priority order, and the budget is spent from the top.
      : [...list, item.id],
  };
};

/**
 * The blocks to offer the pipeline, best first.
 *
 * Nothing is filtered for relevance. The reader pointed at these; a silent
 * relevance filter on top of an explicit choice is the kind of helpfulness that
 * makes a feature untrustworthy. The budget does the cutting, visibly.
 */
export const gatherBlocks = (input: MaterialInput, stored: MaterialPick): PromptBlock[] => {
  const pick = normalizePick(stored);
  const out: PromptBlock[] = [];
  const seen = new Set<string>();
  const slot = pick.slot;

  const push = (id: string, title: string, text: string) => {
    if (seen.has(id) || !text.trim()) return;
    seen.add(id);
    out.push({ id, title, text, slot });
  };

  const pinById = new Map(input.pins.map(p => [p.id, p]));

  // Named things first, in the order they were picked.
  for (const id of pick.pins) {
    const pin = pinById.get(id);
    if (pin) push(pin.id, pin.title || 'Pin', pin.content);
  }
  for (const id of pick.sets) {
    const set = input.sets.find(s => s.id === id);
    for (const pinId of set?.inContext ?? []) {
      const pin = pinById.get(pinId);
      if (pin) push(pin.id, pin.title || 'Pin', pin.content);
    }
  }
  for (const id of pick.sheets) {
    const sheet = input.sheets.find(s => s.id === id);
    if (sheet) push(sheet.id, sheet.title || 'Sheet', sheetText(sheet));
  }
  for (const id of pick.codex) {
    const entry = input.codex.find(c => c.id === id);
    if (entry) push(entry.id, entry.name || 'Codex', entry.summary);
  }
  for (const id of pick.highlights) {
    const hi = input.highlights.find(h => h.id === id);
    if (hi) push(hi.id, 'Highlight', hi.note ? `${hi.text}\n${hi.note}` : hi.text);
  }

  // The standing rule, after the deliberate choices for this scene.
  if (pick.activeSet) {
    const active = input.sets.find(s => s.id === input.activeSetId);
    for (const pinId of active?.inContext ?? []) {
      const pin = pinById.get(pinId);
      if (pin) push(pin.id, pin.title || 'Pin', pin.content);
    }
  }

  // Zones last: the largest things here by an order of magnitude, and one that
  // does not fit should cost itself rather than four pins.
  for (const id of pick.zones) {
    const zone = input.zones.find(z => z.id === id);
    if (zone) push(zone.id, zone.name || 'Zone', zone.body);
  }

  return out;
};
