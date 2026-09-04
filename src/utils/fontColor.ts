/**
 * Colours the model wrote into the text, kept rather than thrown away.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `normalizeInlineHtml` folds the HTML an AI writes into the app's own markup
 * channels — `<b>` becomes bold, `<i>` becomes emphasis — and drops everything
 * else, keeping the words. That is right for nearly all of it: the reader's
 * styling should win over the model's, which is the entire premise of the
 * markup channels.
 *
 * `<font color=…>` is the exception, and the reason is that it is not styling,
 * it is NOTATION. An author who colours a status readout, or gives the system
 * voice its own colour, or one colour per speaker, is making a distinction the
 * prose does not otherwise carry — and stripping it silently merges things the
 * writer had separated. That is what "it throws some stuff off" is.
 *
 * ── How a colour survives markdown ─────────────────────────────────────────
 *
 * Markdown has no colour, so a colour cannot be expressed in the intermediate
 * form the whole pipeline speaks. It travels as a SENTINEL instead — the same
 * trick `textProcessor` and `bookLayout` already use to park generated HTML
 * through a markdown pass — in private-use codepoints that cannot occur in
 * prose:
 *
 * MARK_OPEN  <css colour> MARK_MID  … the coloured text … MARK_CLOSE 
 *
 * Renderers call `splitColorRuns` to get the text back as runs; anything that
 * needs plain words (speech, counting, search) calls `stripColorMarks`. Both
 * are cheap no-ops on the overwhelming majority of passages, which contain no
 * sentinel at all.
 *
 * Pure: no store, no React, no DOM.
 */

import type { FontColorMode } from '../types';

/** Opens a colour run; followed by the CSS colour and `MARK_MID`. */
export const MARK_OPEN = '\uE200';
/** Separates the colour from the text it applies to. */
export const MARK_MID = '\uE201';
/** Closes a colour run. */
export const MARK_CLOSE = '\uE202';

/** Matches one whole run, colour and body captured. */
const RUN_RE = new RegExp(`${MARK_OPEN}([^${MARK_MID}]*)${MARK_MID}([\\s\\S]*?)${MARK_CLOSE}`, 'g');
/** Any sentinel at all — the cheap "is there anything to do here" test. */
const ANY_MARK_RE = new RegExp(`[${MARK_OPEN}${MARK_MID}${MARK_CLOSE}]`);

/* ------------------------------------------------------------------ */
/* Reading a colour the model wrote                                    */
/* ------------------------------------------------------------------ */

/**
 * The 16 HTML colour names old front-ends and RP logs actually use.
 *
 * Not the full CSS list on purpose: this runs on untrusted text, the point is
 * to recognise a deliberate colour rather than to be a CSS parser, and a name
 * we do not know simply falls through to "no colour" and the words are kept.
 */
const NAMED: Record<string, string> = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080',
  white: '#ffffff', maroon: '#800000', red: '#ff0000', purple: '#800080',
  fuchsia: '#ff00ff', magenta: '#ff00ff', green: '#008000', lime: '#00ff00',
  olive: '#808000', yellow: '#ffff00', navy: '#000080', blue: '#0000ff',
  teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
  gold: '#ffd700', pink: '#ffc0cb', crimson: '#dc143c', violet: '#ee82ee',
  indigo: '#4b0082', salmon: '#fa8072', tan: '#d2b48c', brown: '#a52a2a',
};

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i;

/**
 * A colour attribute as `{r,g,b}`, or null if it is not one we recognise.
 *
 * Returning null is the safe outcome everywhere: the run is not marked, the
 * words render exactly as they did before this module existed.
 */
export const parseColor = (raw: string): { r: number; g: number; b: number } | null => {
  const v = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!v) return null;

  const named = NAMED[v];
  const hex = named ?? (HEX_RE.test(v) ? v : null);
  if (hex) {
    let h = hex.replace('#', '');
    // #rgb / #rgba — each digit doubled. The alpha digit is dropped: a
    // half-transparent word on a page whose background the model never saw is
    // a legibility bug, not a style.
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const m = RGB_RE.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(n => Math.min(255, parseInt(n, 10)));
    return { r, g, b };
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Fitting a colour to the page it landed on                           */
/* ------------------------------------------------------------------ */

const toHsl = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr
    ? ((gg - bb) / d + (gg < bb ? 6 : 0))
    : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: h * 60, s, l };
};

/**
 * The same hue, re-lit so it is readable on this page.
 *
 * A log written against a dark front-end is full of colours that vanish on a
 * light theme, and vice versa — `#111` as "the system voice" is invisible on
 * Sepia, `#ffe` is invisible on AMOLED. "Adapt" keeps the DISTINCTION the
 * author drew (the hue, which is what tells two speakers apart) and gives up
 * the exact value, which was chosen for a page this reader is not looking at.
 *
 * The saturation floor matters as much as the lightness band: a near-grey that
 * was meant to read as "dimmed" survives as a colour rather than washing out to
 * the same grey as everything else.
 */
export const adaptColor = (
  rgb: { r: number; g: number; b: number }, dark: boolean,
): string => {
  const { h, s, l } = toHsl(rgb);
  // A colour with no hue at all was never a hue choice — it was "lighter" or
  // "darker" than the prose. Say that in the theme's own terms.
  if (s < 0.08) return dark ? 'hsl(0 0% 72%)' : 'hsl(0 0% 38%)';
  const sat = Math.min(0.92, Math.max(0.38, s));
  const light = dark
    ? Math.min(0.78, Math.max(0.55, l))
    : Math.min(0.48, Math.max(0.26, l));
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
};

/** The CSS a run should be painted in, under the reader's chosen mode. */
export const resolveColor = (
  raw: string, mode: FontColorMode, dark: boolean,
): string | null => {
  if (mode === 'ignore') return null;
  const rgb = parseColor(raw);
  if (!rgb) return null;
  if (mode === 'adapt') return adaptColor(rgb, dark);
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
};

/* ------------------------------------------------------------------ */
/* Marking, splitting, stripping                                       */
/* ------------------------------------------------------------------ */

/**
 * Fold `<font color=…>` and `<span style="color:…">` into colour runs.
 *
 * Called from `normalizeInlineHtml` BEFORE the generic tag strip, so that when
 * the mode is 'ignore' — or the colour is unreadable — nothing happens here and
 * the tag is dropped by the existing rule, exactly as before.
 *
 * Nested runs are flattened to the innermost colour: the inner `<font>` is the
 * more specific statement, and a sentinel inside a sentinel would not survive
 * `splitColorRuns`, which is deliberately non-recursive.
 */
export const markColorRuns = (text: string, mode: FontColorMode): string => {
  if (mode === 'ignore' || !/<(?:font|span)\b/i.test(text)) return text;

  const wrap = (colour: string, body: string): string => {
    // Normalised here, once, so a run carries a colour and not the quoting
    // style of whichever front-end wrote the tag.
    const clean = colour.trim().replace(/^["']|["']$/g, '');
    if (!parseColor(clean)) return body;
    /*
     * An enclosing colour claims only what is not already claimed.
     *
     * `<font red>outer <font blue>inner</font></font>` is TWO statements, and
     * flattening it to either one loses a distinction the author drew. So the
     * outer pass wraps the plain stretches and steps over the runs the inner
     * pass already made — which is also what stops a sentinel ever nesting
     * inside a sentinel, a shape `splitColorRuns` deliberately cannot read.
     */
    return splitColorRuns(body)
      .map(run => (run.text
        ? `${MARK_OPEN}${run.color ?? clean}${MARK_MID}${run.text}${MARK_CLOSE}`
        : ''))
      .join('');
  };

  let out = text;
  // Innermost-first: the body pattern refuses to cross another opening tag, so
  // repeated passes peel nesting from the inside out.
  const FONT = /<font\b[^>]*\bcolor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>((?:(?!<font\b)[\s\S])*?)<\/font\s*>/i;
  const SPAN = /<span\b[^>]*\bstyle\s*=\s*"[^"]*\bcolor\s*:\s*([^;"]+)[^"]*"[^>]*>((?:(?!<span\b)[\s\S])*?)<\/span\s*>/i;
  for (let pass = 0; pass < 12; pass++) {
    const before = out;
    out = out.replace(FONT, (_m, colour: string, body: string) => wrap(colour, body));
    out = out.replace(SPAN, (_m, colour: string, body: string) => wrap(colour, body));
    if (out === before) break;
  }
  return out;
};

export interface ColorRun {
  text: string;
  /** The colour as the author wrote it, unresolved. Null for ordinary prose. */
  color: string | null;
}

/**
 * A marked string as alternating plain and coloured runs.
 *
 * Returns a single uncoloured run for the ordinary case, so a caller can treat
 * "no colour anywhere" and "colour here and there" the same way.
 */
export const splitColorRuns = (text: string): ColorRun[] => {
  if (!ANY_MARK_RE.test(text)) return [{ text, color: null }];
  const out: ColorRun[] = [];
  let at = 0;
  let m: RegExpExecArray | null;
  RUN_RE.lastIndex = 0;
  while ((m = RUN_RE.exec(text))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), color: null });
    out.push({ text: m[2], color: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), color: null });
  // A stray half-mark (a passage still streaming, mid-run) leaves debris that
  // must never reach the page.
  return out.filter(r => r.text).map(r => ({ ...r, text: stripColorMarks(r.text) }));
};

/** The same words with every sentinel removed. */
export const stripColorMarks = (text: string): string =>
  ANY_MARK_RE.test(text)
    ? text.replace(RUN_RE, (_m, _c: string, body: string) => body)
      .replace(new RegExp(`${MARK_OPEN}[^${MARK_MID}]*${MARK_MID}`, 'g'), '')
      .replace(new RegExp(`[${MARK_OPEN}${MARK_MID}${MARK_CLOSE}]`, 'g'), '')
    : text;

/** Does this text carry any colour run? Cheap enough to call per render. */
export const hasColorMarks = (text: string): boolean => ANY_MARK_RE.test(text);
