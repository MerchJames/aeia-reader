import { useAppStore } from '../store';
import { useSpriteStore, spriteFor } from '../stores/useSpriteStore';
import { useLiveReaction, type LiveLine } from '../hooks/useLiveReaction';
import { CompanionBubble } from './CompanionBubble';
import { cn } from '../utils/cn';

/**
 * The people watching with you, and what they just said.
 *
 * Docked at the reading edge rather than placed in the column, because the one
 * thing this must never do is move the words. A reaction that reflowed the
 * paragraph you were mid-sentence in would cost more than it gives, however
 * good the line is.
 *
 * ── A stack, since there can be a room ─────────────────────────────────────
 *
 * Up to five people can watch, and on a passage that lands they may speak one
 * after another — so this is a column, oldest at the top, newest nearest the
 * reader's eye. Each bubble keeps its OWN dwell, hover-hold and reply box: they
 * arrived at different moments and a shared timer would take the newest away
 * with the oldest, which is the one you were reading.
 */
const DWELL_MS = 16_000;
const DWELL_FROZEN_MS = 22_000;

/**
 * How many bubbles may be on screen at once.
 *
 * Five people can watch, but the column grows UPWARD from a fixed point near
 * the bottom of the window — so the third one ran off the top of the viewport
 * and the fourth and fifth were simply not on the page. A stack that leaves the
 * window is worse than a shorter stack: the line you cannot see is usually the
 * newest one, because that is the end it grows from.
 *
 * Three, and the height is bounded as well. Everyone still SPEAKS; the oldest
 * bubbles just leave a little early, which they were going to do anyway — they
 * carry a sixteen-second dwell.
 */
const VISIBLE = 3;

export const LiveReactor = () => {
  const { lines, dismiss, again, reply } = useLiveReaction();
  const on = useAppStore(s => s.liveReaction);
  const frame = useAppStore(s => s.liveReactionFrame);
  const freeze = useAppStore(s => s.liveReactionFreeze);
  const story = useAppStore(s => s.currentStory);
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);

  if (!on || !lines.length) return null;

  const portraitFor = (l: LiveLine) =>
    spriteFor(story?.id ?? '', l.reactor, l.emotion, sprites, spriteUrls)
    ?? story?.characterAvatars?.[l.reactor]
    ?? (story?.characterName === l.reactor ? story?.characterAvatar : undefined);

  return (
    <div
      className={cn(
        // z-40, matching the Ask Character bubble and the playback bar: above
        // the reading column, BELOW every panel and modal. At a higher layer it
        // floated over the open settings drawer and covered its own controls.
        //
        // Stacked ABOVE the Ask Character bubble (right-5 bottom-32) rather than
        // beside it. They are the same idea pointed in opposite directions and
        // they sat on top of each other — the companion covering the button you
        // press to ask a question.
        'fixed z-40 right-5 bottom-[10.5rem] flex flex-col items-end gap-2',
        // Oldest at the top, so a new line arrives nearest the reader's eye and
        // nothing already on screen moves under it.
        'pointer-events-none',
        // …and it can never grow past the top of the window. `justify-end`
        // keeps the newest anchored at the bottom, so what gets cut when the
        // window is short is the oldest line rather than the one just said.
        'max-h-[calc(100dvh-13rem)] overflow-hidden justify-end',
      )}
      data-testid="live-reaction-stack"
    >
      {lines.slice(-VISIBLE).map(l => (
        <CompanionBubble
          key={l.id}
          line={l}
          frame={frame}
          freeze={freeze}
          portrait={portraitFor(l)}
          onDismiss={() => dismiss(l.id)}
          onAgain={() => again(l.id)}
          onReply={(text) => reply(text, l.id)}
        />
      ))}
    </div>
  );
};
