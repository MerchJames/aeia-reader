/**
 * Generated pictures, on the beat they belong to.
 *
 * Renders through the SAME grid as a message's own images, because that is what
 * they are: an image attached to a passage. The difference is only where the
 * bytes live — a story's own images arrive as data URLs in the source, while
 * generated ones live in `lib/artStorage.ts` and have to be resolved to blob
 * URLs first, which is async and therefore needs a component rather than an
 * expression.
 *
 * The blob URLs are cached by id in artStorage, so a passage re-rendering forty
 * times during the reveal does not mint forty object URLs it will never revoke.
 */

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { SceneArt } from '../types';
import { artUrl } from '../lib/artStorage';

interface Props {
  art: SceneArt[];
  onImageClick: (src: string) => void;
  /** Absent while streaming, so the delete control cannot be hit mid-reveal. */
  onRemove?: (artId: string) => void;
}

export const SceneArtStrip = ({ art, onImageClick, onRemove }: Props) => {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    (async () => {
      const next: Record<string, string> = {};
      for (const a of art) {
        const url = await artUrl(a.id);
        if (url) next[a.id] = url;
      }
      if (live) setUrls(next);
    })();
    return () => { live = false; };
  }, [art]);

  if (!art.length) return null;

  return (
    <div className="reader-img-grid" data-testid="scene-art">
      {art.map(a => {
        const url = urls[a.id];
        // A picture whose bytes are missing (a half-finished delete, a cleared
        // database) shows nothing rather than a broken-image icon on someone's
        // story.
        if (!url) return null;
        return (
          <figure key={a.id} className="m-0 w-fit max-w-full">
            <img
              src={url}
              alt=""
              className="reader-img"
              loading="lazy"
              data-testid="scene-art-image"
              onClick={(e) => { e.stopPropagation(); onImageClick(url); }}
            />
            {/* The prompt, under the picture it made — this feature's whole
              * argument is that you can see what was asked for, and that stays
              * true after the modal closes.
              *
              * A caption row rather than a control floating over the corner:
              * anchored to the image, a 36px button on a small picture lands
              * outside its own box and becomes unclickable, and on a large one
              * it covers the art. Underneath, it works at every size. */}
            <figcaption className="flex items-center gap-1.5 mt-1 max-w-full">
              <span
                className="text-[10px] text-muted truncate flex-1 min-w-0 normal-case tracking-normal"
                title={a.prompt}
              >
                {a.prompt}
              </span>
              {onRemove && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                  title="Delete this picture"
                  aria-label="Delete this picture"
                  className="flex items-center justify-center min-h-9 min-w-9 shrink-0 rounded-full text-app-text/40 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
};
