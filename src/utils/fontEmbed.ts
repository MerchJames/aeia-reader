/**
 * Turning the reader's font into bytes the exported file can carry.
 *
 * Aura's ten built-in faces come from Google's CDN, so a `font-family` alone
 * only looks right on a machine that happens to have that font — which is
 * almost none of them. Embedding the woff2 as a data URI is the only way a
 * shared file reads the way it did on the machine it came from, and it keeps
 * the export self-contained, which is the whole promise.
 *
 * Three sources, all handled here:
 *  - **Uploaded fonts** — bytes are already in IndexedDB. No network at all.
 *  - **Press Start 2P** — bundled in `public/fonts`, fetched from our own origin.
 *  - **Google's faces** — fetched at export time. The CSS API answers with
 *    `src: url(…woff2)` and both hops are CORS-permissive.
 *
 * Everything degrades: a failed fetch drops that face and leaves the stack, so
 * the worst case is the old behaviour rather than a broken export. Nothing here
 * runs at reading time — only when someone exports.
 */

import type { FontFamily } from '../types';
import { getAllFonts } from '../lib/fontStorage';

/** Mirrors the `--font-*` variables in index.css. Keep the two in step. */
export const FONT_STACKS: Record<Exclude<FontFamily, 'theme'>, string> = {
  sans: '"Inter", ui-sans-serif, system-ui, sans-serif',
  serif: '"Playfair Display", ui-serif, Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
  handwriting: '"Caveat", cursive',
  typewriter: '"Special Elite", monospace',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", sans-serif',
  rounded: '"Nunito", ui-rounded, "Segoe UI", sans-serif',
  slab: '"Roboto Slab", ui-serif, Georgia, serif',
  medieval: '"MedievalSharp", "Papyrus", fantasy',
  comic: '"Comic Neue", "Comic Sans MS", cursive',
};

/**
 * What to ask Google for, per family.
 *
 * Deliberately narrow: latin, regular and bold, plus italic only where the
 * prose actually uses it. Every extra axis is another 20–60KB in a file someone
 * has to send, and a display face like MedievalSharp ships one weight anyway.
 */
const GOOGLE_SPECS: Record<string, string | null> = {
  sans: 'Inter:wght@400;500;700',
  serif: 'Playfair+Display:ital,wght@0,400;0,700;1,400',
  mono: 'JetBrains+Mono',
  handwriting: 'Caveat:wght@400;700',
  typewriter: 'Special+Elite',
  rounded: 'Nunito:wght@400;600;800',
  slab: 'Roboto+Slab:wght@400;600;700',
  medieval: 'MedievalSharp',
  comic: 'Comic+Neue:wght@400;700',
  // OpenDyslexic comes from a different CDN and is a large face; the stack's
  // Comic Sans fallback is the point of it anyway.
  dyslexic: null,
};

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // font-sized array.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const guessFormat = (url: string): string =>
  /\.woff2(\?|$)/i.test(url) ? 'woff2'
    : /\.woff(\?|$)/i.test(url) ? 'woff'
      : /\.otf(\?|$)/i.test(url) ? 'opentype' : 'truetype';

const mimeFor = (format: string): string =>
  format === 'woff2' ? 'font/woff2'
    : format === 'woff' ? 'font/woff'
      : format === 'opentype' ? 'font/otf' : 'font/ttf';

/**
 * Themes whose CSS overrides the declared font with the bundled pixel face.
 *
 * They all say `font: 'mono'` in `themes.ts`, but `.stock-font.theme-*` in
 * index.css puts Press Start 2P on top — so trusting `themeDef.font` alone
 * exported a Game Boy chat in JetBrains Mono, which is exactly the kind of
 * quiet mismatch this whole module exists to prevent. Only applies when the
 * reader is following the theme, which is what `.stock-font` means.
 */
const PIXEL_THEMES = new Set(['pixelchat', 'pixelrpg', 'gameboy']);

export interface ResolvedFont {
  /** The CSS stack to put on `body`. */
  stack: string;
  /** Built-in key to fetch from Google, or null (custom/bundled/none). */
  googleKey: Exclude<FontFamily, 'theme'> | null;
  /** A bundled face to inline from our own origin, or null. */
  localFace: 'Press Start 2P' | null;
  /** An uploaded family to inline from IndexedDB, or null. */
  customFamily: string | null;
}

/**
 * What the reader is ACTUALLY looking at, resolved the way the app resolves it:
 * `'theme'` follows the theme's signature face, an explicit choice always wins,
 * and an uploaded font wins over both.
 */
export const resolveExportFont = (
  themeId: string,
  themeFont: FontFamily | undefined,
  fontFamily: FontFamily,
  customFamily: string | null,
): ResolvedFont => {
  if (customFamily) {
    return {
      stack: `"${customFamily}", ${FONT_STACKS.sans}`,
      googleKey: null,
      localFace: null,
      customFamily,
    };
  }

  const followingTheme = fontFamily === 'theme';
  if (followingTheme && PIXEL_THEMES.has(themeId)) {
    return {
      stack: '"Press Start 2P", ui-monospace, monospace',
      googleKey: null,
      localFace: 'Press Start 2P',
      customFamily: null,
    };
  }

  const key = (followingTheme ? (themeFont ?? 'sans') : fontFamily) as Exclude<FontFamily, 'theme'>;
  return {
    stack: FONT_STACKS[key] ?? FONT_STACKS.sans,
    googleKey: key,
    localFace: null,
    customFamily: null,
  };
};

export interface EmbedResult {
  /** `@font-face` rules with the bytes inlined. May be empty. */
  css: string;
  /** How many faces were embedded, for an honest note in the UI. */
  faces: number;
  /** True when something could not be fetched and the stack has to carry it. */
  incomplete: boolean;
}

const EMPTY: EmbedResult = { css: '', faces: 0, incomplete: false };

/**
 * Drop the character subsets the story never uses.
 *
 * Google splits every family by `unicode-range` — latin, latin-ext, cyrillic,
 * greek, vietnamese — and serves a file per subset per weight. Embedding all of
 * them made a 43-word story a 318KB download, nearly all of it alphabets nobody
 * in that chat writes in. Keeping only the ranges the text actually touches
 * roughly halves the file with no visible difference.
 *
 * Errs toward keeping: a block with no `unicode-range` at all covers everything
 * and always stays, so a face that is not subset is never mangled.
 */
export const pruneSubsets = (css: string, sample: string): string => {
  const chars = new Set<number>();
  // Distinct characters saturate almost immediately — a few thousand
  // characters of prose already contains every alphabet the story uses. Cap
  // the scan so a very long story does not walk megabytes to learn the same
  // thing, and stop once the set stops growing.
  const LIMIT = 200_000;
  let seen = 0;
  for (const ch of sample) {
    chars.add(ch.codePointAt(0)!);
    if (++seen >= LIMIT) break;
  }
  if (!chars.size) return css;

  const covered = (range: string): boolean =>
    range.split(',').some(part => {
      const m = /U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
      if (!m) return true;                       // unparseable → keep the block
      const lo = parseInt(m[1], 16);
      const hi = m[2] ? parseInt(m[2], 16) : lo;
      for (const c of chars) if (c >= lo && c <= hi) return true;
      return false;
    });

  return css
    .split(/(?=@font-face)/)
    .filter(block => {
      if (!block.includes('@font-face')) return true;   // preamble/comments
      const m = /unicode-range:\s*([^;}]+)/.exec(block);
      return m ? covered(m[1]) : true;
    })
    .join('');
};

/**
 * Fetch Google's CSS for a family and inline every `url()` it names.
 *
 * The `@font-face` blocks come back with their `font-weight`/`font-style`
 * descriptors intact, so replacing only the URL preserves the whole family —
 * bold and italic keep working rather than collapsing to one weight.
 */
const embedGoogle = async (
  spec: string, sample: string, signal?: AbortSignal,
): Promise<EmbedResult> => {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  const res = await fetch(cssUrl, { signal });
  if (!res.ok) throw new Error(`font css ${res.status}`);
  // Prune BEFORE fetching the files — the point is not to download them.
  let css = pruneSubsets(await res.text(), sample);

  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m => m[1]))];
  let faces = 0;
  let incomplete = false;

  for (const url of urls) {
    try {
      const font = await fetch(url, { signal });
      if (!font.ok) throw new Error(`font ${font.status}`);
      const format = guessFormat(url);
      const data = `data:${mimeFor(format)};base64,${b64(await font.arrayBuffer())}`;
      css = css.split(url).join(data);
      faces++;
    } catch {
      incomplete = true;
    }
  }
  // Any face we could not inline still points at the network — drop those
  // blocks entirely rather than ship a file that phones home.
  if (incomplete) {
    css = css.split(/(?=@font-face)/).filter(block => !/url\(https?:/.test(block)).join('');
  }
  return { css, faces, incomplete };
};

/** Our own bundled face, served from this origin. */
const embedLocal = async (family: string, path: string, signal?: AbortSignal): Promise<EmbedResult> => {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(`font ${res.status}`);
  const data = `data:font/woff2;base64,${b64(await res.arrayBuffer())}`;
  return {
    css: `@font-face{font-family:"${family}";src:url(${data}) format("woff2");font-display:swap}`,
    faces: 1,
    incomplete: false,
  };
};

/** An uploaded font, straight out of IndexedDB. Never touches the network. */
export const embedCustomFont = async (family: string): Promise<EmbedResult> => {
  const stored = (await getAllFonts()).find(f => f.family === family);
  if (!stored) return { ...EMPTY, incomplete: true };
  const data = `data:font/ttf;base64,${b64(stored.data)}`;
  return {
    css: `@font-face{font-family:"${family}";src:url(${data});font-display:swap}`,
    faces: 1,
    incomplete: false,
  };
};

/** Every `@font-face` the exported page needs, with the bytes inlined. */
/**
 * @param sample the story's text, used to decide which character subsets to
 *   keep. Pass the whole story; only its distinct characters matter.
 */
export const embedFontsFor = async (
  font: ResolvedFont,
  sample: string,
  signal?: AbortSignal,
): Promise<EmbedResult> => {
  const parts: EmbedResult[] = [];

  if (font.customFamily) {
    parts.push(await embedCustomFont(font.customFamily).catch(() => ({ ...EMPTY, incomplete: true })));
  } else if (font.localFace) {
    parts.push(
      await embedLocal(font.localFace, '/fonts/press-start-2p-latin.woff2', signal)
        .catch(() => ({ ...EMPTY, incomplete: true })),
    );
  } else if (font.googleKey) {
    const spec = GOOGLE_SPECS[font.googleKey];
    if (spec) {
      parts.push(await embedGoogle(spec, sample, signal).catch(() => ({ ...EMPTY, incomplete: true })));
    }
  }

  return {
    css: parts.map(p => p.css).join('\n'),
    faces: parts.reduce((n, p) => n + p.faces, 0),
    incomplete: parts.some(p => p.incomplete),
  };
};
