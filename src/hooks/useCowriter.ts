import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { processText } from '../utils/textProcessor';
import { hashContent } from '../utils/sceneDirector';
import { samplerParamsFrom } from '../utils/aiClient';
import { visitorBlock } from '../utils/visitor';
import { historyBefore, type Reactor } from '../utils/liveReaction';
import { noteOn } from '../utils/cowriter';
import type { LiveLine } from './useLiveReaction';

/**
 * The cowriter, driven off passages FINISHING.
 *
 * ── Why this is not `useLiveReaction` with a flag ──────────────────────────
 *
 * That hook's whole shape is the reveal: it scouts a passage for the moments a
 * companion would break in on, then watches the reveal cursor cross them. Every
 * line of it is about arriving mid-sentence.
 *
 * A note about the writing must not arrive mid-sentence, so none of that
 * machinery applies — there is no scout, no cue, no offset, no cursor. What is
 * left is much smaller: a passage ends, and somebody says one thing about it.
 * Sharing the other hook would have meant a flag threaded through every step of
 * a process this one does not use.
 *
 * What IS shared, because it should be: the companion (`Reactor`), the history
 * clamp, and the bubble it appears in.
 *
 * Notes are cached by (passage, hash) so re-reading is free and does not
 * re-bill — the same rule as the reactions next door.
 */
export const useCowriter = () => {
  const on = useAppStore(s => s.cowriter);
  const screen = useAppStore(s => s.screen);
  const base = useAppStore(s => s.aiBaseUrl);
  const model = useAppStore(s => s.aiModel);
  const who = useAppStore(s => s.cowriterWho);
  /**
   * The passage that has just SETTLED.
   *
   * `revealComplete` is the signal — the words have all landed. Watching
   * `streamingMessage` instead would fire on the passage starting, which is the
   * one moment a note is certainly not wanted.
   */
  const complete = useAppStore(s => s.revealComplete);
  const messageId = useAppStore(s => s.streamingMessage?.id);

  const [note, setNote] = useState<LiveLine | null>(null);
  const busy = useRef(false);
  const token = useRef(0);
  const done = useRef(new Set<string>());

  const active = on && screen === 'reader' && !!base && !!model;

  /** The cowriter, resolved. Mirrors the reader companion's resolution. */
  const writerNow = (): Reactor | null => {
    const s = useAppStore.getState();
    const story = s.currentStory;
    if (!story) return null;
    const v2 = useAuraV2Store.getState();
    const picked = (s.cowriterWho || '').trim();
    const guest = (v2.visitorsByStory[story.id] ?? [])
      .find(g => g.name.toLowerCase() === picked.toLowerCase());
    if (guest) {
      return { name: guest.name, dossier: visitorBlock(guest, story.characterName), frame: 'room' };
    }
    const name = picked || story.characterName || '';
    if (!name) return null;
    const isLead = !!story.characterName
      && name.toLowerCase() === story.characterName.toLowerCase();
    return { name, card: isLead ? story.card : undefined, frame: 'room' };
  };

  useEffect(() => {
    if (!active || !complete || !messageId || busy.current) return;
    if (done.current.has(messageId)) return;

    const s = useAppStore.getState();
    const story = s.currentStory;
    const writer = writerNow();
    const msg = s.streamingMessage;
    if (!story || !writer || !msg) return;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();

    // The passage as the author reads it, whole — see `utils/cowriter`.
    const passage = processText(
      resolveContent(msg, v2.overridesByStory[storyId], !!v2.lensOnByStory[storyId]),
      {
        hideMetadata: s.hideMetadata && !msg.hidden,
        repairFormatting: false,
        oocHandling: s.oocHandling,
        autoFormat: s.autoFormat,
        autoFormatRules: s.autoFormatRules,
        paragraphSpacing: s.paragraphSpacing,
        dialogueOwnLine: s.dialogueOwnLine,
        smartTypography: s.smartTypography,
        styleQuotes: s.styleQuotes,
        substituteNames: s.substituteNames,
        characterName: story.characterName,
        userName: story.userName,
        role: msg.role,
      },
    ).processedText;
    /*
     * Short enough that there is nothing to say about the craft of it.
     *
     * 80, not 120: a single sentence can absolutely earn a note — "this line is
     * doing two jobs" — and a great many passages in a dialogue-heavy story are
     * one line long. A threshold set by eye at 120 silently switched the whole
     * feature off for those stories, which is the worst way for a setting to be
     * wrong: it looks like the model having nothing to say.
     */
    if (passage.trim().length < 80) return;

    done.current.add(messageId);
    if (linger.current) clearTimeout(linger.current);
    const hash = hashContent(passage);
    const key = `note::${messageId}::${writer.name.toLowerCase()}`;
    const cached = v2.reactionsByStory[storyId]?.[key];
    const stored = cached?.hash === hash ? Object.values(cached.lines)[0] : undefined;
    if (stored) {
      setNote({
        id: key, reactor: writer.name, text: stored.text, emotion: stored.emotion,
        moment: 'this passage',
      });
      return;
    }

    const t = ++token.current;
    busy.current = true;
    const ordered = s.chains.flatMap(c => c.messages)
      .map(m => ({ id: m.id, name: m.name, content: m.content }));
    void (async () => {
      try {
        /*
         * The author's own material.
         *
         * Only what they put IN CONTEXT — the same opt-in the assistant honours.
         * A cowriter that read every pin would be reading their scratch paper.
         */
        const pins = (v2.pinsByStory[storyId] ?? [])
          .filter(p => p.inContext)
          .slice(0, 6)
          .map(p => `${p.title}: ${p.content}`.slice(0, 400));
        const byKey = v2.reactionsByStory[storyId] ?? {};
        const said = Object.entries(byKey)
          .filter(([k]) => k.startsWith('note::') && k !== key)
          .flatMap(([, rec]) => Object.values(rec.lines).map(l => l.text))
          .slice(-4);

        const answer = await noteOn(
          {
            reactor: writer,
            passage,
            targetId: messageId,
            history: historyBefore(ordered, messageId),
            userName: story.userName,
            pins: pins.length ? pins : undefined,
            said: said.length ? said : undefined,
            mood: v2.sceneByStory[storyId]?.[messageId]?.mood,
          },
          { base, key: s.aiApiKey, model, params: samplerParamsFrom(s.aiAdvanced) },
        );
        if (t !== token.current || !answer) return;
        useAuraV2Store.getState().setReactionPoints(storyId, key, {
          messageId, reactor: writer.name, hash, points: [],
        });
        useAuraV2Store.getState().addReactionLine(storyId, key, 'note', {
          text: answer.text, emotion: answer.emotion, at: Date.now(),
        });
        setNote({
          id: key, reactor: writer.name, text: answer.text, emotion: answer.emotion,
          moment: 'this passage',
        });
      } catch {
        // Silence. A note that failed to arrive is a passage read in peace.
      } finally {
        busy.current = false;
      }
    })();
  }, [active, complete, messageId, base, model, who]);

  /*
   * A note belongs to the passage it is about — but not to the millisecond.
   *
   * Clearing it the moment `messageId` changed meant the note lived exactly as
   * long as the pause between passages: it arrived when the words finished and
   * was gone before it could be read. Same treatment as the reactions next
   * door, and the same setting, because it is the same complaint.
   *
   * A floor of four seconds regardless: a note is longer than a gasp and takes
   * longer to read, so "off" here would mean the feature never worked.
   */
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showing = useRef<LiveLine | null>(null);
  showing.current = note;

  useEffect(() => {
    /*
     * The linger belongs to the note being LEFT, not to the passage arriving.
     *
     * The first version of this armed the timer on every `messageId` change,
     * including the change that STARTS a passage — so a four-second fuse was lit
     * before the note for that passage existed, and then went off underneath it.
     * On a short passage the note appeared a second in and was gone three
     * seconds later, which read as it disappearing instantly.
     *
     * So: capture which note is being retired, and clear only that one. A new
     * passage's note has a different id (`note::<messageId>::<name>`), so a
     * fuse lit for the old one can never take the new one with it.
     */
    const leaving = showing.current?.id;
    if (!leaving) return;
    if (linger.current) clearTimeout(linger.current);
    const ms = Math.max(4000, useAppStore.getState().liveReactionLinger || 0);
    linger.current = setTimeout(
      () => setNote(n => (n && n.id === leaving ? null : n)),
      ms,
    );
    return () => { if (linger.current) clearTimeout(linger.current); };
  }, [messageId]);

  return { note, dismiss: () => setNote(null) };
};
