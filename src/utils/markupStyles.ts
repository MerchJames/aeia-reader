/**
 * Markup channels — the reader's control over what the AI's punctuation MEANS.
 *
 * Aura already let the reader dress one channel: quoted speech ("Dialogue
 * Styling"). But an RP log carries four more marks that carry meaning, and every
 * one of them was hard-coded:
 *
 *   '…'      an aside — inner thought, a quoted phrase, a name held at arm's
 *            length. Rendered identically to speech, which erased the
 *            distinction the writer made.
 *   **…**    a beat the writer wanted to land. Hard-coded amber, forever.
 *   ****…**** the same, louder. Rendered exactly like `**` — the extra pair did
 *            nothing at all.
 *   ##       a section break the AI wrote. Whatever the prose stylesheet said.
 *
 * So: one preset shape, five channels, the same three knobs the reader already
 * understands from dialogue (colour, style, animation).
 *
 * ── Why `speech` is not in `MarkupPresets` ───────────────────────────────────
 *
 * The speech channel is the EXISTING `dialogueColor` / `dialogueStyle` /
 * `dialogueAnimation` settings. Those are persisted keys with readers' choices
 * already in them; folding them into a new object would silently reset every
 * library on upgrade. They stay exactly where they are and this module treats
 * them as the speech channel at the call site instead.
 *
 * Pure: no store, no React, no JSX. The class strings are written out in full
 * (never composed from fragments) so Tailwind's source scan can see them.
 */

import {
  CharacterChannelColors, ColorableChannel, DialogueAnimation, DialogueStyle, MarkupPreset, MarkupPresets,
  StoredChannel,
} from '../types';

export type {
  CharacterChannelColors, ColorableChannel, MarkupChannel, MarkupPreset, MarkupPresets, StoredChannel,
} from '../types';

/**
 * Defaults, chosen so nothing a reader is looking at today changes shape:
 * `bold` reproduces the hard-coded amber exactly, `heading` leaves the prose
 * stylesheet alone. The two channels that had no identity of their own get one
 * — an aside reads quieter than speech, a shout reads louder than a beat —
 * because a preset nobody can see is not a preset.
 */
export const MARKUP_DEFAULTS: MarkupPresets = {
  aside: { color: '', style: 'italic', animation: 'none' },
  bold: { color: 'text-amber-600 dark:text-amber-400', style: 'bold', animation: 'none' },
  shout: { color: 'text-rose-600 dark:text-rose-400', style: 'bold', animation: 'none' },
  heading: { color: '', style: 'bold', animation: 'none' },
};

/** What each channel is, for the settings panel. `sample` is shown as written. */
export const MARKUP_CHANNELS: readonly {
  id: StoredChannel; label: string; mark: string; hint: string; sample: string;
}[] = [
  {
    id: 'aside', label: 'Aside', mark: "'…'",
    hint: 'Single-quoted — inner thought, a phrase held at arm’s length.',
    sample: "'not again', she thought",
  },
  {
    id: 'bold', label: 'Beat', mark: '**…**',
    hint: 'The writer leaning on a word.',
    sample: 'she **did not** move',
  },
  {
    id: 'shout', label: 'Shout', mark: '****…****',
    hint: 'Doubled emphasis — the loudest mark in the text.',
    sample: '****RUN****',
  },
  {
    id: 'heading', label: 'Heading', mark: '##',
    hint: 'A section break the AI wrote into the passage.',
    sample: '## Chapter Two',
  },
];

/** Colour choices offered for every channel, including the dialogue one. */
export const MARKUP_COLORS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Match theme' },
  { value: 'text-indigo-600 dark:text-indigo-300', label: 'Indigo' },
  { value: 'text-rose-600 dark:text-rose-400', label: 'Rose' },
  { value: 'text-emerald-600 dark:text-emerald-300', label: 'Emerald' },
  { value: 'text-amber-600 dark:text-amber-400', label: 'Amber' },
  { value: 'text-sky-600 dark:text-sky-300', label: 'Sky' },
  { value: 'text-violet-600 dark:text-violet-300', label: 'Violet' },
  { value: 'text-app-text/70', label: 'Muted' },
];

const STYLE_CLASS: Record<DialogueStyle, string> = {
  normal: 'not-italic',
  italic: 'italic',
  bold: 'not-italic font-bold',
  'bold-italic': 'italic font-bold',
};

/**
 * Animation classes. Written out per key rather than interpolated, so a channel
 * cannot ask for a class that was never compiled.
 */
const ANIM_CLASS: Record<DialogueAnimation, string> = {
  none: '',
  zoom: 'animate-dialogue-zoom inline-block',
  pulse: 'animate-dialogue-pulse inline-block',
  wave: 'animate-dialogue-wave inline-block',
  glow: 'animate-dialogue-glow',
  rise: 'animate-dialogue-rise',
};

export const isMarkupStyle = (v: unknown): v is DialogueStyle =>
  v === 'normal' || v === 'italic' || v === 'bold' || v === 'bold-italic';

export const isMarkupAnimation = (v: unknown): v is DialogueAnimation =>
  v === 'none' || v === 'zoom' || v === 'pulse' || v === 'wave' || v === 'glow' || v === 'rise';

/**
 * The classes for one channel.
 *
 * `baseWeight` is the weight to sit under a `normal`/`italic` style — dialogue
 * has always rendered at `font-medium`, and dropping that would change how every
 * existing library looks. `cn` runs tailwind-merge, so a `bold` style's
 * `font-bold` cleanly beats it rather than fighting it.
 *
 * Animations are suppressed while a passage is still revealing: a span that
 * zooms every time another word arrives reads as a glitch, not a performance.
 */
export const markupClass = (
  preset: MarkupPreset,
  opts: { animate?: boolean; baseWeight?: string } = {},
): string => {
  const heavy = preset.style === 'bold' || preset.style === 'bold-italic';
  return [
    preset.color,
    !heavy && opts.baseWeight ? opts.baseWeight : '',
    STYLE_CLASS[preset.style] ?? STYLE_CLASS.normal,
    opts.animate ? (ANIM_CLASS[preset.animation] ?? '') : '',
  ].filter(Boolean).join(' ');
};

/* ── Which channel a quoted emphasis span belongs to ────────────────────────
 *
 * `styleQuotes` wraps quoted speech in `*…*` so it arrives here as an emphasis
 * node; this decides whether it was double-quoted (speech) or single-quoted
 * (an aside).
 *
 * Speech keeps the historical open-only rule — `"Hello," she said` is one span
 * whose closing quote is in the middle, and thousands of stored passages read
 * that way. An aside must be closed as well as opened, because the single quote
 * is also the apostrophe: `*'tis a fine morning*` opens like an aside and is
 * not one, and only the missing closer tells them apart.
 */
const OPENS_SPEECH = /^["“]/;
const OPENS_ASIDE = /^['‘]/;
const CLOSES_ASIDE = /['’]$/;

export const quoteChannel = (raw: string): 'speech' | 'aside' | null => {
  const t = raw.trim();
  if (t.length < 2) return null;
  if (OPENS_SPEECH.test(t)) return 'speech';
  if (OPENS_ASIDE.test(t) && CLOSES_ASIDE.test(t)) return 'aside';
  return null;
};

/** One preset, made safe to render — an unknown value falls back to the default. */
const sanitizePreset = (raw: unknown, fallback: MarkupPreset): MarkupPreset => {
  const o = (raw ?? {}) as Partial<MarkupPreset>;
  return {
    color: typeof o.color === 'string' ? o.color : fallback.color,
    style: isMarkupStyle(o.style) ? o.style : fallback.style,
    animation: isMarkupAnimation(o.animation) ? o.animation : fallback.animation,
  };
};

/**
 * A stored settings blob, made safe to render.
 *
 * Persisted settings outlive the code that wrote them: a channel added in a
 * later build is missing from an older reader's blob, and a channel removed
 * leaves junk behind. Rebuild from the default table every time so the result
 * always has exactly the channels this build knows about.
 */
export const sanitizeMarkupPresets = (raw: unknown): MarkupPresets => {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out = {} as MarkupPresets;
  for (const { id } of MARKUP_CHANNELS) out[id] = sanitizePreset(o[id], MARKUP_DEFAULTS[id]);
  return out;
};

/** True when the reader has changed nothing — lets the panel offer a Reset. */
export const isDefaultMarkup = (presets: MarkupPresets): boolean =>
  MARKUP_CHANNELS.every(({ id }) => {
    const a = presets[id]; const b = MARKUP_DEFAULTS[id];
    return a.color === b.color && a.style === b.style && a.animation === b.animation;
  });

/* ── Per-character color, optional and layered on top of the channel color ──
 *
 * A channel (speech/aside/bold/shout) has ONE configured color by default.
 * A reader can turn on "color by character" so each character's marks use a
 * color of their own instead — auto-assigned unless they pick one, and
 * skippable per character even while the feature is on for everyone else.
 */

/** Sentinel stored for a character explicitly opted out of auto/manual color. */
export const CHARACTER_COLOR_NONE = 'none';

/** The auto-assign palette: the same real colors offered in every color
 *  picker, minus "Match theme" (not a color) and "Muted" (too low-contrast
 *  to stand in for an un-chosen identity). */
const AUTO_CHARACTER_PALETTE = MARKUP_COLORS
  .filter(c => c.value && c.value !== 'text-app-text/70')
  .map(c => c.value);

const hashString = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

/** Deterministic default color for a character with no explicit choice. */
export const autoCharacterColor = (name: string): string =>
  AUTO_CHARACTER_PALETTE[hashString(name.trim().toLowerCase()) % AUTO_CHARACTER_PALETTE.length];

/**
 * A character's color for ONE channel, or `undefined` to keep that channel's
 * own configured color untouched.
 *
 * Resolution order: an explicit per-channel-per-character color (advanced,
 * including an explicit "No color" for just that channel) → the character's
 * own general color (auto-assigned unless overridden, or "No color") → the
 * channel's global color.
 */
export const characterColor = (
  name: string | undefined,
  channel: ColorableChannel,
  colors: Record<string, string> | undefined,
  channelColors: CharacterChannelColors | undefined,
  enabled: boolean,
): string | undefined => {
  if (!enabled || !name) return undefined;
  const perChannel = channelColors?.[name]?.[channel];
  if (perChannel === CHARACTER_COLOR_NONE) return undefined;
  if (perChannel) return perChannel;
  const stored = colors?.[name];
  if (stored === CHARACTER_COLOR_NONE) return undefined;
  return stored || autoCharacterColor(name);
};

/** All four colorable channels for one character/speaker, resolved once so
 *  callers make a single call instead of one per channel. */
export interface CharColorBundle {
  speech?: string; aside?: string; bold?: string; shout?: string;
}

export const resolveCharColors = (
  name: string | undefined,
  colors: Record<string, string> | undefined,
  channelColors: CharacterChannelColors | undefined,
  enabled: boolean,
): CharColorBundle | undefined => {
  if (!enabled || !name) return undefined;
  const at = (ch: ColorableChannel) => characterColor(name, ch, colors, channelColors, enabled);
  return { speech: at('speech'), aside: at('aside'), bold: at('bold'), shout: at('shout') };
};
