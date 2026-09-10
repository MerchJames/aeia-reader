import { useAppStore } from '../store';
import { useSpriteStore, spriteFor } from '../stores/useSpriteStore';
import { useCowriter } from '../hooks/useCowriter';
import { CompanionBubble } from './CompanionBubble';

/**
 * The cowriter's note, on the other side of the page.
 *
 * LEFT, where the reader's companions are on the right — because they are
 * different things and the reader should never have to read a line to find out
 * which of the two said it. One note at a time: this speaks once a passage, and
 * a stack of craft notes is a review, which is the thing `utils/cowriter` is
 * most careful not to be.
 *
 * No reply box. Answering back is a conversation about a moment, which is what
 * the reader's companion is for; a note is about the work, and the answer to it
 * is editing the work.
 */
export const CowriterHost = () => {
  const { note, dismiss } = useCowriter();
  const on = useAppStore(s => s.cowriter);
  const story = useAppStore(s => s.currentStory);
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);

  if (!on || !note) return null;

  const portrait = spriteFor(story?.id ?? '', note.reactor, note.emotion, sprites, spriteUrls)
    ?? story?.characterAvatars?.[note.reactor]
    ?? (story?.characterName === note.reactor ? story?.characterAvatar : undefined);

  return (
    <div
      className="fixed z-40 left-5 bottom-[10.5rem] flex flex-col items-start gap-2
        max-h-[calc(100dvh-13rem)] overflow-hidden justify-end pointer-events-none"
      data-testid="cowriter-stack"
    >
      <CompanionBubble
        line={note}
        frame="room"
        freeze={false}
        portrait={portrait}
        stance="writer"
        sticky
        onDismiss={dismiss}
        onAgain={dismiss}
        onReply={async () => { /* a note is not a conversation — see above */ }}
      />
    </div>
  );
};
