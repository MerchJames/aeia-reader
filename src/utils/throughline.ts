/**
 * Throughlines — one life, told across several chats.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * A chat is one character and one user. That is the grain the format has, and
 * fighting it produces group chats nobody enjoys reading. But it means every
 * story a reader keeps revolves around a different sole character, and the
 * person who appears in ALL of them — the reader's own — is the one thing the
 * app has no record of. `userName` and `userAvatar` are per-story. Open a
 * second chat and you are a stranger again.
 *
 * A throughline inverts the unit of continuity. The story stops being the spine
 * and the PROTAGONIST becomes it: chats hang off them as arcs, in order, each
 * with its own focal character. Nothing about how a chat is written changes.
 * What changes is that arc four can know what happened to you in arcs one to
 * three.
 *
 * ── What travels, and what must not ────────────────────────────────────────
 *
 * Not the transcript. `utils/visitor` sets out why at length and every word of
 * it applies here: another arc's raw text blows the budget, gets quoted back
 * verbatim, and — worst — manufactures a shared history, because nothing in a
 * transcript says a thing did not happen. The absence is not IN the payload.
 *
 * So what travels is a **brief per arc**: a short account of what happened to
 * the protagonist there, compiled once and then editable. The reader reading
 * the payload is the control, exactly as it is for a visitor. When two arcs
 * disagree about a fact, the reader settles it by editing — there is no
 * automatic merge, because an automatic merge is a machine deciding which of
 * someone's memories is true.
 *
 * ── The clamp ──────────────────────────────────────────────────────────────
 *
 * `arcsBefore` is the load-bearing function in this file. An arc is only ever
 * told about arcs ORDERED BEFORE IT. Without that, opening arc two hands the
 * model the end of arc five, which is not a context feature, it is a spoiler
 * with extra steps — the same reason a visitor dossier is anchored at a beat
 * rather than written from the whole story.
 *
 * Pure: no DOM, no store, no React, except for the injected completion.
 */

import { ChatMsg } from './aiClient';

/** What a protagonist record holds, in the order it renders. */
export const PROTAGONIST_FIELDS = ['who', 'look', 'wants', 'fears', 'voice'] as const;
export type ProtagonistField = (typeof PROTAGONIST_FIELDS)[number];

export const PROTAGONIST_LABEL: Record<ProtagonistField, string> = {
  who: 'WHO THEY ARE',
  look: 'WHAT THEY LOOK LIKE',
  wants: 'WHAT THEY WANT',
  fears: 'WHAT THEY FEAR',
  voice: 'HOW THEY TALK',
};

export interface Protagonist {
  name: string;
  /** Other names they go by — what a chat's `{{user}}` might have been set to. */
  aliases: string[];
  fields: Record<ProtagonistField, string>;
  avatar?: string;
  /** The reader's own note, appended verbatim. The escape hatch for everything. */
  note?: string;
}

export interface Arc {
  storyId: string;
  title: string;
  /** Where this sits in the protagonist's own chronology. */
  order: number;
  /** The chat's focal character — whose story this arc is. */
  character?: string;
  /**
   * What happened to the protagonist here, in a paragraph or two.
   *
   * Empty until compiled. This is the ONLY thing that travels to a later arc,
   * and it is editable, because it is also the only thing a later arc will
   * believe.
   */
  brief: string;
  /** True once the reader has changed the brief, so the UI can stop nagging. */
  edited?: boolean;
  compiledAt?: number;
  /** Off means this arc is in the throughline but does not travel. */
  active: boolean;
}

export interface Throughline {
  id: string;
  name: string;
  protagonist: Protagonist;
  arcs: Arc[];
  createdAt: number;
}

export const emptyProtagonistFields = (): Record<ProtagonistField, string> =>
  Object.fromEntries(PROTAGONIST_FIELDS.map(f => [f, ''])) as Record<ProtagonistField, string>;

export const emptyProtagonist = (name = ''): Protagonist => ({
  name,
  aliases: [],
  fields: emptyProtagonistFields(),
});

/** A protagonist worth sending: a name, and something said about them. */
export const isUsable = (p: Protagonist | undefined): boolean =>
  !!p?.name.trim() && PROTAGONIST_FIELDS.some(f => !!p.fields[f]?.trim());

/* ------------------------------------------------------------------ */
/* Order, and the clamp                                                */
/* ------------------------------------------------------------------ */

/**
 * The arcs in the protagonist's own chronology.
 *
 * Ties break on title so the order is total and stable: two arcs at the same
 * position must not swap places between renders, or "what happened before this"
 * changes depending on when you asked.
 */
export const orderedArcs = (t: Throughline): Arc[] =>
  [...t.arcs].sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));

/** Where a story sits, or -1 when it is not part of this throughline. */
export const arcIndex = (t: Throughline, storyId: string): number =>
  orderedArcs(t).findIndex(a => a.storyId === storyId);

/**
 * Everything the protagonist had already lived through when this arc began.
 *
 * The clamp. Strictly BEFORE — an arc never learns its own brief either, which
 * would be the model reading a summary of the scene it is in the middle of.
 *
 * A story that is not in the throughline at all gets nothing rather than
 * everything: failing closed is the only safe direction, because the failure in
 * the other direction is handing someone the end of a story they have not read.
 */
export const arcsBefore = (t: Throughline, storyId: string): Arc[] => {
  const ordered = orderedArcs(t);
  const at = ordered.findIndex(a => a.storyId === storyId);
  if (at < 0) return [];
  return ordered.slice(0, at).filter(a => a.active && a.brief.trim());
};

/** The throughline a story belongs to, if any. */
export const throughlineFor = (
  throughlines: Throughline[] | undefined,
  storyId: string | undefined,
): Throughline | undefined =>
  storyId ? (throughlines ?? []).find(t => t.arcs.some(a => a.storyId === storyId)) : undefined;

/* ------------------------------------------------------------------ */
/* The prompt block                                                    */
/* ------------------------------------------------------------------ */

const clamp = (s: string, max: number): string =>
  (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** How much of one arc's brief travels. Generous — there are few of them. */
export const ARC_BRIEF_CHARS = 900;

/**
 * The protagonist, and what has already happened to them.
 *
 * Fenced like every other block in this family (`cardToPromptBlock`,
 * `visitorsToPromptBlock`) because the story's own transcript follows it, and a
 * brief that bleeds into the story reads as part of the story.
 *
 * Two lines do the load-bearing work, and both are about NEGATIVE space:
 *
 *   · the arcs are named as *other stories*, twice, because the commonest
 *     failure is a model folding them into this one and referring to events
 *     "earlier" that happened in a different chat entirely
 *   · what is not in a brief did not happen — stated outright, because a model
 *     handed a partial history will cheerfully fill the gaps
 */
export const throughlineBlock = (
  t: Throughline | undefined,
  storyId: string | undefined,
  hostName?: string,
): string => {
  if (!t || !storyId || !isUsable(t.protagonist)) return '';
  const p = t.protagonist;
  const before = arcsBefore(t, storyId);

  const lines: string[] = [
    '--- WHO THE READER IS PLAYING ---',
    `This is the same person across several stories the reader keeps. ${hostName ?? 'This story'}`,
    'has its own character; the person below is the one the reader plays, here and',
    'elsewhere.',
    '',
    `=== ${p.name.toUpperCase()}${p.aliases.length ? ` (also: ${p.aliases.join(', ')})` : ''} ===`,
  ];
  for (const f of PROTAGONIST_FIELDS) {
    const value = p.fields[f]?.trim();
    if (value) lines.push(`${PROTAGONIST_LABEL[f]}: ${clamp(value, 600)}`);
  }
  if (p.note?.trim()) lines.push(`THE READER ADDS: ${clamp(p.note.trim(), 600)}`);
  lines.push(`=== END ${p.name.toUpperCase()} ===`);

  if (before.length) {
    lines.push(
      '',
      `WHAT HAS ALREADY HAPPENED TO ${p.name.toUpperCase()}, in other stories,`,
      'before this one begins. These are OTHER stories — not scenes from this one,',
      'and not things the characters here were present for:',
    );
    before.forEach((a, i) => {
      const who = a.character ? ` — with ${a.character}` : '';
      lines.push(`  ${i + 1}. "${a.title}"${who}: ${clamp(a.brief.trim(), ARC_BRIEF_CHARS)}`);
    });
    lines.push(
      '',
      'That is the whole of it. Anything not written above has not happened to them,',
      'and nobody in this story knows any of it unless this story says so.',
    );
  } else {
    lines.push(
      '',
      `Nothing has happened to ${p.name} yet outside this story. Do not invent a past.`,
    );
  }
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* Compiling one arc's brief                                           */
/* ------------------------------------------------------------------ */

export interface ArcBriefInput {
  protagonist: Protagonist;
  /** The arc's title, for the model to refer to it by. */
  title: string;
  /** The focal character of the arc. */
  character?: string;
  /** The arc's own text, already clamped to a budget by the caller. */
  history: string;
}

/**
 * The prompt that writes one arc's brief.
 *
 * Asked for what happened to the PROTAGONIST specifically, not "summarise this
 * chat". A chat summary is about the chat's character — that is who most of the
 * words are about — and a throughline needs the other half: what the reader's
 * own person did, learned, lost and became. Ask for a summary and you get a
 * paragraph in which the protagonist barely appears.
 */
export const buildArcBriefMessages = (input: ArcBriefInput): ChatMsg[] => {
  const { protagonist: p, title, character, history } = input;
  return [
    {
      role: 'system',
      content: [
        'You write continuity notes for a reader who plays the same person across',
        'several separate stories.',
        '',
        `In the story below ("${title}")${character ? `, opposite ${character},` : ','}`,
        `the reader plays ${p.name}. Write what happened TO ${p.name} in it —`,
        'what they did, what they learned, what changed for them, how it ended for',
        'them. Not a summary of the story: the story is mostly about somebody else.',
        '',
        'Rules:',
        `- Two short paragraphs at most. This is read alongside other stories'`,
        '  notes, so length here costs the others room.',
        `- Past tense, third person, ${p.name} as the subject.`,
        '- Only what the text shows. If their feelings are never stated, do not',
        '  state them. A note that invents is worse than a short one.',
        '- Name the other people involved, so a later story can recognise them.',
        '- No preamble, no heading, no bullet points. Just the note.',
      ].join('\n'),
    },
    { role: 'user', content: history },
  ];
};

/** Trim a model's note down to what belongs in a brief. */
export const parseArcBrief = (raw: string): string =>
  raw
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    // Models like to announce themselves however firmly they are told not to.
    .replace(/^\s*(here(?:'s| is)[^\n:]*:|summary:|note:|continuity note:)\s*/i, '')
    .trim();

/* ------------------------------------------------------------------ */
/* Making stored data safe to render                                   */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A string, or the fallback when there is nothing to show.
 *
 * An EMPTY string counts as nothing here. `str` alone let `name: ''` through,
 * which put a blank row in the throughline list — technically a string, and
 * useless to look at.
 */
const named = (v: unknown, fallback: string): string => (str(v).trim() ? str(v) : fallback);

const sanitizeProtagonist = (raw: unknown): Protagonist => {
  const o = (raw ?? {}) as Partial<Protagonist>;
  const fields = emptyProtagonistFields();
  for (const f of PROTAGONIST_FIELDS) fields[f] = str((o.fields as never)?.[f]);
  return {
    name: str(o.name),
    aliases: Array.isArray(o.aliases) ? o.aliases.filter(a => typeof a === 'string' && a.trim()) : [],
    fields,
    avatar: typeof o.avatar === 'string' ? o.avatar : undefined,
    note: typeof o.note === 'string' ? o.note : undefined,
  };
};

const sanitizeArc = (raw: unknown, i: number): Arc | null => {
  const o = (raw ?? {}) as Partial<Arc>;
  if (!o.storyId || typeof o.storyId !== 'string') return null;
  return {
    storyId: o.storyId,
    title: named(o.title, 'Untitled'),
    order: Number.isFinite(o.order) ? Number(o.order) : i,
    character: typeof o.character === 'string' ? o.character : undefined,
    brief: str(o.brief),
    edited: o.edited === true,
    compiledAt: Number.isFinite(o.compiledAt) ? Number(o.compiledAt) : undefined,
    // Absent means active: an arc added by an older build predates the flag,
    // and defaulting it off would silently empty somebody's continuity.
    active: o.active !== false,
  };
};

/**
 * A stored throughline, made safe to render and to send.
 *
 * Persisted data outlives the build that wrote it, and this one reaches a
 * PROMPT — so a malformed record must not be able to put junk in front of a
 * model. A story listed twice is collapsed to its first entry, because two arcs
 * with one story id make `arcsBefore` non-deterministic.
 */
export const sanitizeThroughline = (raw: unknown): Throughline | null => {
  const o = (raw ?? {}) as Partial<Throughline>;
  if (!o.id || typeof o.id !== 'string') return null;
  const seen = new Set<string>();
  const arcs: Arc[] = [];
  (Array.isArray(o.arcs) ? o.arcs : []).forEach((a, i) => {
    const arc = sanitizeArc(a, i);
    if (!arc || seen.has(arc.storyId)) return;
    seen.add(arc.storyId);
    arcs.push(arc);
  });
  return {
    id: o.id,
    name: named(o.name, 'Throughline'),
    protagonist: sanitizeProtagonist(o.protagonist),
    arcs,
    createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now(),
  };
};

export const sanitizeThroughlines = (raw: unknown): Throughline[] =>
  (Array.isArray(raw) ? raw : [])
    .map(sanitizeThroughline)
    .filter((t): t is Throughline => !!t);

/** Renumber after a move, so `order` stays 0..n-1 with no gaps or ties. */
export const renumber = (arcs: Arc[]): Arc[] =>
  arcs.map((a, i) => ({ ...a, order: i }));

/** Move one arc up (-1) or down (+1) the chronology. No-op at the ends. */
export const moveArc = (t: Throughline, storyId: string, direction: -1 | 1): Arc[] => {
  const ordered = orderedArcs(t);
  const at = ordered.findIndex(a => a.storyId === storyId);
  const target = at + direction;
  if (at === -1 || target < 0 || target >= ordered.length) return t.arcs;
  const next = [...ordered];
  [next[at], next[target]] = [next[target], next[at]];
  return renumber(next);
};

/** How much of the throughline is written up — for the panel's nudge. */
export const briefProgress = (t: Throughline): { done: number; total: number } => ({
  done: t.arcs.filter(a => a.brief.trim()).length,
  total: t.arcs.length,
});
