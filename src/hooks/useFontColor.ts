/**
 * The two things every renderer needs to paint an author's colour: which mode
 * the reader chose, and whether the page they are on is dark.
 *
 * A hook rather than two selectors copied into eight views, because getting the
 * SECOND one wrong is invisible — `resolveTheme` needs the custom-theme colours
 * to answer `isDark`, and a view that forgets them silently reports the wrong
 * answer, which only shows up as "adapt made my text unreadable on this one
 * theme". One place to be right.
 */
import { useMemo } from 'react';
import { useAppStore } from '../store';
import { resolveTheme } from '../themes';
import type { FontColorMode } from '../types';

export interface FontColorContext {
  mode: FontColorMode;
  dark: boolean;
}

export const useFontColor = (): FontColorContext => {
  const mode = useAppStore(s => s.fontColorMode);
  const dark = useAppStore(s => resolveTheme(s.theme, s.bgColor, s.textColor).isDark);
  // Stable while the two primitives are, so a caller can put it in a dep array
  // without re-laying-out the book on every render.
  return useMemo(() => ({ mode, dark }), [mode, dark]);
};
