import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { artUrl } from '../lib/artStorage';

/**
 * Every generated picture in the open story, as blob URLs, keyed by passage.
 *
 * `SceneArtStrip` resolves one passage's art on its own, which is right when the
 * pictures are being drawn beside the passage they belong to. A view that lays
 * the WHOLE story out at once — a comic page, a map — needs them all, and forty
 * strips each running their own async resolve would mint and drop URLs on every
 * scroll.
 *
 * The URLs are cached by id inside `artStorage`, so this hook is not minting
 * anything new: it is collecting what is already there, and it deliberately does
 * NOT revoke on unmount for the same reason — the cache is shared with the
 * strips, and revoking here would blank the pictures in the reader.
 */
export const useArtUrls = (): Record<string, string[]> => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const art = useAuraV2Store(s => (storyId ? s.artByStory[storyId] : undefined));
  const [urls, setUrls] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!art) { setUrls({}); return; }
    let live = true;
    (async () => {
      const next: Record<string, string[]> = {};
      for (const [messageId, list] of Object.entries(art)) {
        const resolved: string[] = [];
        for (const a of list) {
          const url = await artUrl(a.id);
          if (url) resolved.push(url);
        }
        if (resolved.length) next[messageId] = resolved;
      }
      if (live) setUrls(next);
    })();
    return () => { live = false; };
  }, [art]);

  return urls;
};
