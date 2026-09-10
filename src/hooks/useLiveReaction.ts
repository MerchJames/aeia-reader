import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { processText } from '../utils/textProcessor';

import { hashContent } from '../utils/sceneDirector';
import { notePassage, paceNote, resetPace } from '../utils/readingPace';
import { visitorBlock } from '../utils/visitor';
import { samplerParamsFrom } from '../utils/aiClient';
import {
  EARLIER_LINES, MAX_WATCHERS, Reactor, ReactionPoint, compactReaction, historyBefore,
  pickSpeaker, pointAt, reactAt, reactionKey, replyTo, resolveReactionPoints, scoutPassage,
  visibleText,
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
  /**
   * The back-and-forth after it, if the reader said something.
   *
   * Deliberately NOT persisted with the reaction. A reaction is cached so that
   * re-reading a passage is free and replays what was said; a conversation is
   * something that happened once, between two people, at a moment. Replaying it
   * on a re-read would be putting words in the reader's mouth.
   */
  exchange?: { who: 'reader' | 'them'; text: string }[];
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

  const [lines, setLines] = useState<LiveLine[]>([]);
  // The newest is what most of this hook is about — replying to it, holding it,
  // clearing it. `lines` is what the stack renders.
  const line = lines[lines.length - 1] ?? null;
  const setLine = (next: LiveLine | null | ((prev: LiveLine | null) => LiveLine | null)) => {
    setLines(prev => {
      const cur = prev[prev.length - 1] ?? null;
      const value = typeof next === 'function'
        ? (next as (p: LiveLine | null) => LiveLine | null)(cur) : next;
      if (!value) return [];
      // Same point speaking again REPLACES; a different one JOINS the room, up
      // to the cast size — five bubbles is already a wall down the page.
      const rest = prev.filter(l => l.id !== value.id);
      return [...rest, value].slice(-MAX_WATCHERS);
    });
  };
  /**
   * Clearing the bubble when the reader moves on — later, not now.
   *
   * The scout below fires on every message change and used to `setLine(null)`
   * straight away, so a line that landed near the end of a passage could be
   * wiped a blink after it appeared. The reader reported it as reactions
   * vanishing "completely and abruptly" when they moved past the message, which
   * is exactly what it was.
   *
   * A reaction belongs to the moment it was made at, so it does not survive
   * indefinitely — but it gets its `liveReactionLinger` first, and a NEW line
   * always replaces it at once (`setLine` cancels this on the next scout).
   */
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLater = () => {
    if (linger.current) clearTimeout(linger.current);
    const ms = useAppStore.getState().liveReactionLinger;
    // `|| 0` for a config stored before this setting existed.
    linger.current = setTimeout(() => setLine(null), Math.max(0, ms || 0));
  };
  useEffect(() => () => { if (linger.current) clearTimeout(linger.current); }, []);

  const points = useRef<ReactionPoint[]>([]);
  const spoken = useRef<Set<string>>(new Set());
  const fullText = useRef('');
  const busy = useRef(false);
  /**
   * How many lines each companion has had, this reading.
   *
   * Only used to break ties on a moment nobody was cast for — it never
   * overrides the scout, which is the one that actually knows whose moment it
   * is. It is not persisted: it exists to keep one evening's reading balanced,
   * not to keep a ledger across sessions.
   */
  const tally = useRef<Map<string, number>>(new Map());
  /** What to tell them about how the reader is reading, if anything. */
  const pace = useRef<string | undefined>(undefined);
  /**
   * The bubbles as they are NOW, for the callbacks.
   *
   * `Bubble` is memoised on its own line, so the handlers it was given are the
   * ones from whichever render created that bubble. Reading `lines` out of that
   * closure would mean answering a companion with a snapshot of the room from
   * several turns ago — and the second reply in one bubble would be sent
   * without the first.
   */
  const linesRef = useRef<LiveLine[]>([]);
  linesRef.current = lines;
  const token = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const active = on && screen === 'reader' && !!base && !!model;

  /**
   * Everybody watching, resolved from the reader's picks.
   *
   * `liveReactors` is the cast; an empty one falls back to the single
   * `liveReactor`, which is what a reader who never opens the list has. So the
   * one-companion path is unchanged all the way down — including the prompt.
   */
  const castNow = (): Reactor[] => {
    const picks = useAppStore.getState().liveReactors;
    const names = (picks?.length ? picks : [useAppStore.getState().liveReactor]).slice(0, MAX_WATCHERS);
    const out: Reactor[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      const r = reactorFor(n);
      if (r && !seen.has(r.name.toLowerCase())) { seen.add(r.name.toLowerCase()); out.push(r); }
    }
    return out;
  };

  /**
   * The room, as a cache key.
   *
   * Sorted and lowercased so that ticking the same three people in a different
   * order is the same room and does not re-bill the passage.
   */
  const castKey = (cast: Reactor[]): string =>
    cast.map(r => r.name.trim().toLowerCase()).sort().join('+');

  /** One watcher by name, or null. */
  const reactorFor = (pick: string): Reactor | null => {
    const s = useAppStore.getState();
    const story = s.currentStory;
    if (!story) return null;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();
    const picked = pick.trim();
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
    clearLater();          // let what they just said finish being read
    abort.current?.abort();
    abort.current = null;
    useAppStore.getState().setReactionHold(false);
    if (!active || !messageId) return;

    const s = useAppStore.getState();
    const story = s.currentStory;
    const cast = castNow();
    const reactor = cast[0];
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
    /*
     * Count the visit here, before the cache check below returns.
     *
     * A re-read is exactly the case this is for: the points are cached, the
     * scout is skipped, and the passage still needs to be recorded as having
     * been read again — otherwise the one situation a companion should notice
     * is the one situation this never sees.
     */
    const order = s.chains.flatMap(c => c.messages).findIndex(m => m.id === messageId);
    pace.current = paceNote(notePassage(messageId, order < 0 ? 0 : order));
    if (passage.trim().length < 40) return;   // too short to break in on

    const hash = hashContent(passage);
    /*
     * The casting is filed against the ROOM, not against one person.
     *
     * Points now say who each moment belongs to, so they are one answer about
     * the whole cast — and a different cast is a different answer. Keying it by
     * the sorted names means adding someone re-casts the passage (correct: they
     * might own a moment nobody else did) while re-reading with the same people
     * stays free. Lines are still filed per person, below, so each of them
     * replays their own.
     */
    const key = reactionKey(messageId, castKey(cast));
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
            cast,
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
          messageId, reactor: castKey(cast), hash, points: resolved,
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
    const cast = castNow();
    /*
     * WHO speaks is a property of the moment now, not of the app.
     *
     * The casting scout assigned it. Falling back to the first watcher keeps a
     * moment from a single-companion scout (which carries no name) working
     * unchanged, and rescues a cue whose owner has since been unticked.
     */
    /*
     * WHO speaks is a property of the moment, and of who has been quiet.
     *
     * `?? cast[0]` here was the other half of the first-companion bias: any cue
     * the casting scout left unnamed — or named someone since unticked — landed
     * on whoever happened to be first, and most passages earn one cue.
     */
    const reactor = pickSpeaker(point.who, cast, tally.current);
    if (!story || !reactor) return;
    const storyId = story.id;
    const v2 = useAuraV2Store.getState();

    // Claim it before the await, or a burst of reveal frames fires it twice.
    spoken.current.add(point.id);
    tally.current.set(reactor.name, (tally.current.get(reactor.name) ?? 0) + 1);

    const key = reactionKey(messageId, reactor.name);
    const cachedLine = v2.reactionsByStory[storyId]?.[key]?.lines[point.id];
    if (linger.current) clearTimeout(linger.current);
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
        /*
         * What the others in the room have already said about this passage.
         *
         * Taken from the bubbles actually on screen, so it is exactly what the
         * reader has heard — not what is in the cache, which on a re-read holds
         * lines from moments this reading has not reached yet. Feeding those in
         * would have someone answer a remark nobody has made.
         */
        const heard = s.liveCrossTalk
          ? linesRef.current
            .filter(l => l.reactor !== reactor.name)
            .slice(-3)
            .map(l => ({ name: l.reactor, text: l.text }))
          : undefined;
        const ask = {
            reactor,
            others: heard?.length ? heard : undefined,
            history: historyBefore(ordered, messageId),
            // The within-message clamp. At `upTo` they see exactly as far as
            // the words that landed and no further — which IS the frame.
            visible: visibleText(fullText.current, point.end, s.liveReactionVisibility),
            moment: point.text,
            userName: story.userName,
            length: s.liveReactionLength,
            // Only on `dynamic`: the other rungs are a length, and a length has
            // no way to use this except to narrate it.
            pace: s.liveReactionLength === 'dynamic' ? pace.current : undefined,
            said,
            // Their own memory shrinks as the room grows: five companions is
            // five prompts per passage, and the transcript in each of them is
            // the same size. Never below three, which is enough to not repeat
            // yourself.
            earlier: earlier.slice(-Math.max(3, Math.floor(EARLIER_LINES / Math.max(1, cast.length)))),
            mood: v2.sceneByStory[storyId]?.[messageId]?.mood,
        };
        /*
         * Only `dynamic` compacts. The other rungs send a small fixed prompt
         * and would pay the cost of measuring for nothing.
         */
        const fitted = s.liveReactionLength === 'dynamic'
          ? compactReaction(ask, s.liveReactionContext || 0)
          : { input: ask, dropped: [] as string[] };
        const answer = await reactAt(
          fitted.input,
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

  // "You have read this three times" is about THIS story, in THIS sitting.
  const storyId = useAppStore(s => s.currentStory?.id);
  useEffect(() => { resetPace(); }, [storyId]);

  /**
   * Ask again at the moment they just spoke at.
   *
   * Forgets the LINE and keeps the moment: the scout already judged this worth
   * breaking in on, and re-scouting would spend a second call to be told the
   * same thing. Clearing `spoken` lets pass 2 fire on it again.
   */
  const again = (id?: string) => {
    const s = useAppStore.getState();
    const storyId = s.currentStory?.id;
    // Whichever bubble the button belongs to. With a room on screen, "the
    // current one" is not a thing the reader can point at.
    const target = id ? linesRef.current.find(l => l.id === id) : linesRef.current.at(-1);
    const reactor = target ? reactorFor(target.reactor) : null;
    if (!storyId || !messageId || !reactor || !target) return;
    useAuraV2Store.getState()
      .clearReactions(storyId, reactionKey(messageId, reactor.name), target.id);
    spoken.current.delete(target.id);
    setLines(prev => prev.filter(l => l.id !== target.id));
  };

  /**
   * Say something back to them.
   *
   * Resolves when they have answered (or decided not to). The exchange lives on
   * the line, so dismissing it or moving on ends the conversation — which is
   * the right lifetime: this is talking about the bit you just read.
   */
  const reply = async (text: string, id?: string): Promise<void> => {
    const said = text.trim();
    const s = useAppStore.getState();
    const story = s.currentStory;
    const target = id ? linesRef.current.find(l => l.id === id) : linesRef.current.at(-1);
    const reactor = target ? reactorFor(target.reactor) : null;
    if (!said || !target || !story || !reactor || !base || !model) return;

    // Their words go up straight away — waiting for the answer to show your own
    // message makes the box feel broken on a slow model.
    // By id, not "the newest": with a room on screen the reader may be
    // answering a bubble two above the one that just arrived.
    const onTarget = (fn: (l: LiveLine) => LiveLine) =>
      setLines(prev => prev.map(l => (l.id === target.id ? fn(l) : l)));

    onTarget(l => ({
      ...l,
      exchange: [...(l.exchange ?? []), { who: 'reader', text: said }],
    }));
    if (linger.current) clearTimeout(linger.current);

    const v2 = useAuraV2Store.getState();
    const ordered = s.chains.flatMap(c => c.messages)
      .map(m => ({ id: m.id, name: m.name, content: m.content }));
    const t = token.current;
    try {
      const answer = await replyTo(
        {
          reactor,
          history: historyBefore(ordered, messageId ?? ''),
          visible: fullText.current,
          moment: target.moment,
          userName: story.userName,
          length: s.liveReactionLength,
          mood: messageId ? v2.sceneByStory[story.id]?.[messageId]?.mood : undefined,
          saidLine: target.text,
          from: said,
          exchange: target.exchange,
        },
        { base, key: s.aiApiKey, model, params: samplerParamsFrom(s.aiAdvanced) },
      );
      if (t !== token.current || !answer) return;
      onTarget(l => ({
        ...l,
        emotion: answer.emotion,
        exchange: [...(l.exchange ?? []), { who: 'them', text: answer.text }],
      }));
    } catch {
      // They did not answer. The reader's own line stays up, which reads as
      // being ignored — which is a real thing that happens and is better than
      // an error box over a story.
    }
  };

  return {
    lines,
    line,
    dismiss: (id?: string) => setLines(prev => (id ? prev.filter(l => l.id !== id) : [])),
    again,
    reply,
    rescout: () => setReroll(n => n + 1),
  };
};
