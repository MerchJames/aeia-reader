/**
 * Run: npx tsx src/utils/markupStyles.test.ts
 *
 * Markup channels.
 *
 * Two properties carry this file.
 *
 * **The apostrophe is not a quote.** `don't`, `readin'`, `'tis` and the
 * possessive `Jonas'` are everywhere in roleplay prose, and a single-quote
 * channel that eats them turns a page of narration into a page of italics. The
 * boundary rules live in textProcessor; what lives here is the second gate —
 * an aside must be CLOSED as well as opened — and it is asserted from both
 * directions, because the failure is silent and looks like a styling bug.
 *
 * **A reader's existing library must not change shape.** The `bold` default
 * reproduces the amber that was hard-coded into MessageBlock, the dialogue
 * channel keeps its `font-medium` base, and a settings blob written by another
 * build is rebuilt rather than trusted. Each of those is a line below.
 */
import {
  MARKUP_CHANNELS, MARKUP_COLORS, MARKUP_DEFAULTS, isDefaultMarkup, isMarkupAnimation,
  isMarkupStyle, markupClass, quoteChannel, sanitizeMarkupPresets,
} from './markupStyles';
import type { MarkupPreset } from '../types';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const preset = (over: Partial<MarkupPreset> = {}): MarkupPreset =>
  ({ color: '', style: 'normal', animation: 'none', ...over });

/* ── Which channel a quoted span belongs to ──────────────────────────────── */
{
  eq(quoteChannel('"Hello."'), 'speech', 'double quotes are speech');
  eq(quoteChannel('“Hello.”'), 'speech', 'and so are curly ones');
  eq(quoteChannel('"Hello," she said'), 'speech',
    'speech with a trailing tag still opens with a quote — the historical rule');
  eq(quoteChannel("'not again'"), 'aside', 'single quotes are an aside');
  eq(quoteChannel('‘not again’'), 'aside', 'and so are curly ones');
  eq(quoteChannel("'not again,' she thought"), null,
    'an aside must CLOSE — otherwise an apostrophe opens one');

  // The whole reason the aside rule is stricter than the speech rule.
  eq(quoteChannel("'tis a fine morning"), null, "'tis is an elision, not an aside");
  eq(quoteChannel("don't look"), null, 'an apostrophe mid-word opens nothing');
  eq(quoteChannel("readin' fast"), null, 'a dropped g closes nothing');

  eq(quoteChannel('she turned away'), null, 'plain emphasis is not a quote channel');
  eq(quoteChannel(''), null, 'empty text has no channel');
  eq(quoteChannel('"'), null, 'a lone quote mark is not a span');
  eq(quoteChannel('   "Hello."  '), 'speech', 'leading space does not hide the quote');
}

/* ── The classes ─────────────────────────────────────────────────────────── */
{
  eq(markupClass(preset({ color: 'text-sky-600' })), 'text-sky-600 not-italic',
    'colour and the normal style');
  eq(markupClass(preset({ style: 'italic' })), 'italic', 'italic alone');
  eq(markupClass(preset({ style: 'bold' })), 'not-italic font-bold', 'bold alone');
  eq(markupClass(preset({ style: 'bold-italic' })), 'italic font-bold', 'both');

  // Dialogue has always rendered at font-medium under a non-bold style.
  eq(markupClass(preset({ style: 'italic' }), { baseWeight: 'font-medium' }),
    'font-medium italic', 'the base weight sits under a light style');
  ok(!markupClass(preset({ style: 'bold' }), { baseWeight: 'font-medium' }).includes('font-medium'),
    'and is dropped under a heavy one, rather than left to be merged away');

  // A span that re-animates on every streamed character reads as a glitch.
  ok(!markupClass(preset({ animation: 'zoom' })).includes('animate-'),
    'no animation class unless the caller asks for one');
  ok(markupClass(preset({ animation: 'zoom' }), { animate: true })
    .includes('animate-dialogue-zoom'),
    'and the right one when it does');
  eq(markupClass(preset({ animation: 'none' }), { animate: true }), 'not-italic',
    '"none" adds nothing even when animating');
}

/* ── Defaults reproduce what was hard-coded ──────────────────────────────── */
{
  eq(MARKUP_DEFAULTS.bold.color, 'text-amber-600 dark:text-amber-400',
    'the beat default is the amber MessageBlock used to hard-code');
  eq(MARKUP_DEFAULTS.bold.style, 'bold', 'and it is still bold');
  ok(MARKUP_DEFAULTS.shout.color !== MARKUP_DEFAULTS.bold.color,
    '**** is visibly not ** — the extra pair used to do nothing at all');
  eq(MARKUP_DEFAULTS.heading.color, '',
    'headings keep the prose stylesheet unless the reader says otherwise');
  ok(MARKUP_CHANNELS.every(c => MARKUP_DEFAULTS[c.id]),
    'every channel offered in the panel has a default');
  ok(MARKUP_CHANNELS.every(c => c.mark && c.hint && c.sample),
    'and something to show for itself — a channel nobody can identify is not one');
}

/* ── A stored blob is rebuilt, never trusted ─────────────────────────────── */
{
  eq(sanitizeMarkupPresets(undefined), MARKUP_DEFAULTS, 'nothing stored yet');
  eq(sanitizeMarkupPresets(null), MARKUP_DEFAULTS, 'null stored');
  eq(sanitizeMarkupPresets('nonsense'), MARKUP_DEFAULTS, 'junk stored');

  // A build that knew a channel this one does not.
  const stale = sanitizeMarkupPresets({
    bold: { color: 'text-sky-600 dark:text-sky-300', style: 'italic', animation: 'glow' },
    whisper: { color: 'text-red-600', style: 'bold', animation: 'zoom' },
  });
  eq(Object.keys(stale).sort(), MARKUP_CHANNELS.map(c => c.id).sort(),
    'the result has exactly this build’s channels, no more');
  eq(stale.bold, { color: 'text-sky-600 dark:text-sky-300', style: 'italic', animation: 'glow' },
    'a channel that survived keeps the reader’s choice');
  eq(stale.shout, MARKUP_DEFAULTS.shout, 'a channel the blob never had gets its default');

  const bad = sanitizeMarkupPresets({ aside: { color: 7, style: 'huge', animation: 'explode' } });
  eq(bad.aside, MARKUP_DEFAULTS.aside, 'every field of a corrupt channel falls back');

  const half = sanitizeMarkupPresets({ aside: { style: 'bold' } });
  eq(half.aside, { color: MARKUP_DEFAULTS.aside.color, style: 'bold', animation: 'none' },
    'a partial channel keeps what it had and fills the rest');
}

/* ── Guards, and the Reset affordance ────────────────────────────────────── */
{
  ok(isMarkupStyle('bold-italic') && !isMarkupStyle('BOLD'), 'style guard');
  ok(isMarkupAnimation('wave') && !isMarkupAnimation('waves'), 'animation guard');
  ok(isDefaultMarkup(MARKUP_DEFAULTS), 'untouched defaults offer no reset');
  ok(!isDefaultMarkup(sanitizeMarkupPresets({ shout: { style: 'italic' } })),
    'one changed field is enough to offer one');
}

/* ── Every colour offered must be a real class pair ──────────────────────── *
 * Tailwind compiles what it can SEE in the source. A colour composed at
 * runtime, or listed here but written nowhere as a literal, resolves to
 * nothing and the channel silently loses its colour — which looks exactly like
 * the setting not working. */
{
  ok(MARKUP_COLORS.some(c => c.value === ''), 'there is always a way back to the theme');
  for (const c of MARKUP_COLORS) {
    if (!c.value) continue;
    ok(/^text-[a-z-]+\d{3}(\/\d+)?( dark:text-[a-z-]+\d{3}(\/\d+)?)?$|^text-app-text\/\d+$/.test(c.value),
      `${c.label} is a plain literal class pair, not something composed`);
  }
  for (const { id } of MARKUP_CHANNELS) {
    const color = MARKUP_DEFAULTS[id].color;
    ok(!color || MARKUP_COLORS.some(c => c.value === color),
      `the ${id} default colour is one the panel can also offer`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
