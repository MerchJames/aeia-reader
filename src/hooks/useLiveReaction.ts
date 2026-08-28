import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { processText } from '../utils/textProcessor';

import { hashContent } from '../utils/sceneDirector';
import { visitorBlock } from '../utils/visitor';
import { samplerParamsFrom } from '../utils/aiClient';
import {
  EARLIER_LINES, Reactor, ReactionPoint, historyBefore, pointAt, reactAt, reactionKey,
  resolveReactionPoints, scoutPassage, visibleText,
} from '../utils/liveReaction';
import type { EmotionBucket } from '../lib/spriteStorage';

/** What the bubble is showing right now. */
export interface LiveLine {
  id: string;
  reactor: string;
  text: string;
  emotion: EmotionBucket;
  /** The words they were reacting to, for the tooltip. */
  moment: string;
}

/**
 * Live Reaction, driven off the reveal.
 *
 * Two passes, and the ORDER is the feature (see `utils/liveReaction.ts`): when a
 * passage starts streaming, the scout marks the moments this companion would
 * break in on; the reveal crossing one of those offsets is what makes them
 * speak. A reaction therefore lands mid-sentence, where a person would actually
 * say it, instead of arriving at the end of the passage like a review.
 *
 * Three things this hook is careful about:
 *
 *  - **It fails silent.** A scout that errors, a service that is down, a reply
 *    that parses to nothing — all of them mean the reader reads in peace. A
 *    companion is a garnish; nothing about the reading may depend on one.
 *  - **The token guard.** Every async step re-checks that the message it
 *    started for is still the one on screen. Skipping a beat while a request is
 *    in flight would otherwise put the last passage's reaction on this one.
 *  - **It never re-bills a re-read.** Points and spoken lines are cached per
 *    (message, reactor) and keyed by a hash of the passage, so scrolling back
 *    replays what was said rather than asking again.
 */
export const useLiveReaction = () => {
  const on = useAppStore(s => s.liveReaction);
  const screen = useAppStore(s => s.screen);
  const messageId = useAppStore(s => s.streamingMessage?.id);
  const streamedText = useAppStore(s => s.streamedText);
  const base = useAppStore(s => s.aiBaseUrl);
  const model = useAppStore(s => s.aiModel);
  // Watched, so switching companions re-scouts. Without it the effect never
  // re-ran and a second reactor simply never spoke — the feature looked broken
  // rather than busy.
  const picked = useAppStore(s => s.liveReactor);
  const [reroll, setReroll] = useState(0);

  const [line, setLine] = useState<LiveLine | null>(null);
  const points = useRef<ReactionPoint[]>([]);
  const spoken = useRef<Set<string>>(new Set());
  const fullText = useRef('');
  const busy = useRef(false);
  const token = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const active = on && screen === 'reader' && !!base && !!model;

  /** Who is watching, resolved from the reader's pick. Null when nobody is. */
  const reactorNow = (): Reactor | null => {
    const s = useAppStore.getState();
    const story = s.currentStory;
    if (!story) return null;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();
    const picked = s.liveReactor.trim();
    // A visitor first — they were brought in by hand, so a name collision with
    // the cast should resolve to the one the reader went to the trouble of
    // adding.
    const guest = (v2.visitorsByStory[storyId] ?? [])
      .find(g => g.name.toLowerCase() === picked.toLowerCase());
    if (guest) {
      return {
        name: guest.name,
        dossier: visitorBlock(guest, story.characterName),
        frame: s.liveReactionFrame,
      };
    }
    const name = picked || story.characterName || '';
    if (!name) return null;
    // The story's own lead is the one case where the card belongs to them.
    const isLead = !!story.characterName
      && name.toLowerCase() === story.characterName.toLowerCase();
    return { name, card: isLead ? story.card : undefined, frame: s.liveReactionFrame };
  };

  // ----- pass 1: scout the passage that just began ------------------------
  useEffect(() => {
    const t = ++token.current;
    points.current = [];
    spoken.current = new Set();
    fullText.current = '';
    setLine(null);
    abort.current?.abort();
    abort.current = null;
    useAppStore.getState().setReactionHold(false);
    if (!active || !messageId) return;

    const s = useAppStore.getState();
    const story = s.currentStory;
    const reactor = reactorNow();
    if (!story || !reactor) return;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();
    const msg = s.streamingMessage;
    if (!msg) return;
    // Deliberately NOT skipping the reactor's own passages. The first version
    // did — "you don't react to your own line" — and with the story's lead as
    // the default companion that silenced every passage in the story, because
    // the lead is who most of them are. It is also the wrong instinct: watching
    // a story you are IN is the most interesting version of this, and it is the
    // frame the app already uses next door, where Ask Character puts it as an
    // actor stepping off set to talk about the scene they just shot.

    // The passage exactly as the READER will see it — the offsets are matched
    // against what is on screen, so anything that changes the letters between
    // here and the render breaks every cue. (The Director learned this one the
    // hard way: it read raw content while the reader rendered processed text.)
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
    fullText.current = passage;
    if (passage.trim().length < 40) return;   // too short to break in on

    const hash = hashContent(passage);
    const key = reactionKey(messageId, reactor.name);
    const cached = v2.reactionsByStory[storyId]?.[key];
    if (cached && cached.hash === hash) {
      points.current = cached.points;
      // Deliberately NOT seeding `spoken` from the cache. `spoken` is the
      // fire-once set for THIS reading, and pre-filling it made a re-read
      // silent: the moments were known, marked as already said, and never fired
      // again. The cache is meant to make a second reading FREE, not empty —
      // the point still fires, and pass 2 serves the stored line instead of
      // asking for a new one.
      return;
    }

    const ordered = s.chains.flatMap(c => c.messages)
      .map(m => ({ id: m.id, name: m.name, content: m.content }));

    void (async () => {
      try {
        const cues = await scoutPassage(
          {
            reactor,
            passage,
            history: historyBefore(ordered, messageId),
            userName: story.userName,
            mood: v2.sceneByStory[storyId]?.[messageId]?.mood,
          },
          { base, key: useAppStore.getState().aiApiKey, model, params: samplerParamsFrom(s.aiAdvanced) },
        );
        if (t !== token.current) return;              // the reader moved on
        const resolved = resolveReactionPoints(passage, cues);
        points.current = resolved;
        useAuraV2Store.getState().setReactionPoints(storyId, key, {
          messageId, reactor: reactor.name, hash, points: resolved,
        });
      } catch {
        // Silence is the correct failure: the reader reads on, undisturbed.
      }
    })();
  }, [active, messageId, base, model, picked, reroll]);

  // ----- pass 2: speak when the reveal reaches a moment --------------------
  useEffect(() => {
    if (!active || !messageId || busy.current) return;
    const revealed = streamedText.length;
    const point = pointAt(points.current, revealed, spoken.current);
    if (!point) return;

    const s = useAppStore.getState();
    const story = s.currentStory;
    const reactor = reactorNow();
    if (!story || !reactor) return;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();

    // Claim it before the await, or a burst of reveal frames fires it twice.
    spoken.current.add(point.id);

    const key = reactionKey(messageId, reactor.name);
    const cachedLine = v2.reactionsByStory[storyId]?.[key]?.lines[point.id];
    if (cachedLine) {
      setLine({
        id: point.id, reactor: reactor.name, text: cachedLine.text,
        emotion: cachedLine.emotion, moment: point.text,
      });
      return;
    }

    const ordered = s.chains.flatMap(c => c.messages)
      .map(m => ({ id: m.id, name: m.name, content: m.content }));
    const t = token.current;
    busy.current = true;
    if (s.liveReactionFreeze) s.setReactionHold(true);
    abort.current = new AbortController();
    void (async () => {
      try {
        const byKey = v2.reactionsByStory[storyId] ?? {};
        const said = Object.values(byKey[key]?.lines ?? {}).map(l => l.text);
        // What they have said EARLIER in the story, in reading order — their own
        // lines only, so the companion has a memory without the prompt carrying
        // a second copy of the transcript.
        const stop = ordered.findIndex(m => m.id === messageId);
        const earlier: string[] = [];
        for (let i = 0; i < (stop < 0 ? 0 : stop); i++) {
          const rec = byKey[reactionKey(ordered[i].id, reactor.name)];
          if (!rec) continue;
          for (const p of rec.points) {
            const l = rec.lines[p.id];
            if (l) earlier.push(l.text);
          }
        }
        const answer = await reactAt(
          {
            reactor,
            history: historyBefore(ordered, messageId),
            // The within-message clamp. At `upTo` they see exactly as far as
            // the words that landed and no further — which IS the frame.
            visible: visibleText(fullText.current, point.end, s.liveReactionVisibility),
            moment: point.text,
            userName: story.userName,
            said,
            earlier: earlier.slice(-EARLIER_LINES),
            mood: v2.sceneByStory[storyId]?.[messageId]?.mood,
          },
          { base, key: s.aiApiKey, model, params: samplerParamsFrom(s.aiAdvanced) },
          abort.current!.signal,
        );
        if (t !== token.current || !answer) return;
        useAuraV2Store.getState().addReactionLine(storyId, key, point.id, {
          text: answer.text, emotion: answer.emotion, at: Date.now(),
        });
        setLine({
          id: point.id, reactor: reactor.name, text: answer.text,
          emotion: answer.emotion, moment: point.text,
        });
      } catch {
        // Nothing came back. They were quiet; the reading is unaffected.
      } finally {
        busy.current = false;
        // ALWAYS release the reveal, on every path. A companion whose request
        // failed must not leave the reader staring at a frozen page.
        useAppStore.getState().setReactionHold(false);
      }
    })();
  }, [active, messageId, streamedText, base, model]);

  // A freeze must not outlive the feature being switched off mid-sentence.
  useEffect(() => {
    if (!active) useAppStore.getState().setReactionHold(false);
  }, [active]);

  /**
   * Ask again at the moment they just spoke at.
   *
   * Forgets the LINE and keeps the moment: the scout already judged this worth
   * breaking in on, and re-scouting would spend a second call to be told the
   * same thing. Clearing `spoken` lets pass 2 fire on it again.
   */
  const again = () => {
    const s = useAppStore.getState();
    const storyId = s.currentStory?.id;
    const reactor = reactorNow();
    if (!storyId || !messageId || !reactor || !line) return;
    useAuraV2Store.getState()
      .clearReactions(storyId, reactionKey(messageId, reactor.name), line.id);
    spoken.current.delete(line.id);
    setLine(null);
  };

  return { line, dismiss: () => setLine(null), again, rescout: () => setReroll(n => n + 1) };
};
