import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query from React.
 *
 * Most of Aura's responsive work belongs in Tailwind breakpoints — CSS is
 * cheaper and cannot desync from the paint. This hook is for the cases CSS
 * genuinely cannot express: when the *same* element has to move to a different
 * parent (the view bar drops to its own row on a phone) and duplicating it
 * would duplicate its ref and outside-click handler, or when a behaviour rather
 * than a style has to change (hover reveals become taps on a touch screen).
 *
 * useSyncExternalStore rather than useState + useEffect, so the first render is
 * already correct — a layout that flips on the second frame is a visible jump.
 */
export const useMediaQuery = (query: string): boolean => {
  // Both callbacks must be stable, or useSyncExternalStore tears down and
  // re-adds the listener on every render.
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  // SSR/prerender: assume the desktop layout, which is the one that has always
  // shipped. Never consulted in the Tauri or browser app.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};

/** Tailwind's `sm` breakpoint. Below it, Aura uses the phone layout. */
export const useIsMobile = () => !useMediaQuery('(min-width: 640px)');

/**
 * True on a device whose primary input cannot hover — a phone or tablet.
 * Distinct from `useIsMobile`: a small desktop window still has a mouse, and a
 * large tablet still has no hover. Reveal-on-hover affordances need this one.
 */
export const useIsTouch = () => useMediaQuery('(hover: none) and (pointer: coarse)');
