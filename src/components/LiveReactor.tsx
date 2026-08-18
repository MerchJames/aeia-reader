import { useEffect, useState } from 'react';
import { Phone, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useSpriteStore, spriteFor } from '../stores/useSpriteStore';
import { useLiveReaction } from '../hooks/useLiveReaction';
import { cn } from '../utils/cn';

/**
 * The companion, and what they just said.
 *
 * Docked at the reading edge rather than placed in the column, because the one
 * thing this must never do is move the words. A reaction that reflowed the
 * paragraph you were mid-sentence in would cost more than it gives, however
 * good the line is.
 *
 * It lets itself go: a reaction is a noise someone made at a screen, and leaving
 * it up turns a companion into a transcript. It stays a little longer when the
 * reader has asked the reveal to WAIT for it, since then the line is the reason
 * the page has stopped.
 */
const DWELL_MS = 6500;
const DWELL_FROZEN_MS = 9000;

export const LiveReactor = () => {
  const { line, dismiss } = useLiveReaction();
  const on = useAppStore(s => s.liveReaction);
  const frame = useAppStore(s => s.liveReactionFrame);
  const freeze = useAppStore(s => s.liveReactionFreeze);
  const story = useAppStore(s => s.currentStory);
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!line) { setShown(false); return; }
    setShown(true);
    const t = setTimeout(() => setShown(false), freeze ? DWELL_FROZEN_MS : DWELL_MS);
    return () => clearTimeout(t);
  }, [line, freeze]);

  if (!on || !line) return null;

  const portrait = spriteFor(story?.id ?? '', line.reactor, line.emotion, sprites, spriteUrls)
    ?? story?.characterAvatars?.[line.reactor]
    ?? (story?.characterName === line.reactor ? story?.characterAvatar : undefined);

  return (
    <div
      className={cn(
        // z-40, matching the Ask Character bubble and the playback bar: above
        // the reading column, BELOW every panel and modal. At a higher layer it
        // floated over the open settings drawer and covered its own controls.
        'fixed z-40 right-4 bottom-28 w-64 max-w-[80vw] pointer-events-auto',
        'transition-all duration-300',
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none',
      )}
      // The line is theirs, not the story's — say so to a screen reader too.
      role="status"
      aria-live="polite"
    >
      <div className="flex items-end gap-2">
        {portrait
          ? (
            <img
              src={portrait}
              alt=""
              className="w-11 h-11 rounded-full object-cover border border-app-border shrink-0"
            />
          )
          : (
            <div className="w-11 h-11 rounded-full bg-accent/20 text-accent border border-app-border
              grid place-items-center text-sm font-semibold shrink-0">
              {line.reactor.slice(0, 1).toUpperCase()}
            </div>
          )}
        <div className="flex-1 min-w-0 rounded-2xl rounded-bl-sm bg-surface border border-app-border
          shadow-xl px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            {frame === 'phone' && <Phone size={11} className="text-accent shrink-0" />}
            <span className="text-[11px] font-medium text-muted truncate">{line.reactor}</span>
            <button
              onClick={dismiss}
              className="ml-auto p-0.5 opacity-40 hover:opacity-100 shrink-0"
              title="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
          {/* Their words, plainly. No markdown pass: this is speech, and a stray
              asterisk should read as a stray asterisk rather than restyle the
              page. */}
          <p className="text-sm leading-snug whitespace-pre-wrap break-words">{line.text}</p>
          <p className="mt-1 text-[10px] text-muted/70 truncate" title={line.moment}>
            at “{line.moment}”
          </p>
        </div>
      </div>
    </div>
  );
};
