import { useEffect } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { processText } from '../utils/textProcessor';
import { resolveContent } from '../utils/lens';
import { dwellMs, holdMsAt, holdSpeedScale, pacingFor, rateMultiplier } from '../utils/expressive';
import {
  PerformRange, derivePerformCues, mergePerformCues, nextPerformBoundary, performAudioAt,
  performEnterMs, performExitMs, performHoldMs, performRateAt, rangeAt, resolvePerformRanges,
} from '../utils/scenePerform';
import { audioMixer } from '../utils/audioMixer';

/** Characters revealed per second for a 1-100 speed setting. */
export const charsPerSecond = (speed: number) => 8 + speed * 2.2;

/** Words revealed per second for a 1-100 speed setting (~50 ≈ 350 wpm). */
export const wordsPerSecond = (speed: number) => 0.8 + speed * 0.1;

/** Chars the reveal is allowed to lead the narration by, so words appear just
 *  ahead of the voice rather than trailing it. */
const TTS_LEAD_CHARS = 30;

/** Shared empty cue list — the reveal performs nothing this frame. */
const NO_PERFORM: PerformRange[] = [];

const nextWordEnd = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
};

/**
 * Drives the reveal animation. One rAF loop per streaming message —
 * progress is tracked with a time accumulator instead of restarting the
 * loop on every store update.
 */
export const useStreamer = () => {
  const isStreaming = useAppStore(s => s.isStreaming);
  const reverseStream = useAppStore(s => s.reverseStream);
  const messageId = useAppStore(s => s.streamingMessage?.id);

  useEffect(() => {
    if (!isStreaming && !reverseStream) return;
    if (!messageId) {
      // Nothing left to stream.
      if (isStreaming) useAppStore.getState().setIsStreaming(false);
      return;
    }

    let raf = 0;
    let pauseTimer: ReturnType<typeof setTimeout> | null = null;
    let last = performance.now();
    // When this passage started revealing — the read floor is a floor on total
    // time on screen, so it has to know how much of that time the reveal spent.
    const revealStart = last;
    let acc = 0;
    // Cinematic pacing: suppress reveals until this timestamp for a dramatic beat.
    let holdUntil = 0;
    let cachedFullText: string | null = null;
    let cachedKey = '';
    // Reader-authored "slow the reveal here" spans (highlight → SFX marks) —
    // resolved to offsets once the full text is known.
    let slowRanges: [number, number][] | null = null;
    const computeSlow = (full: string): [number, number][] => {
      const s = useAppStore.getState();
      const storyId = s.currentStory?.id;
      if (!storyId) return [];
      const marks = useAuraV2Store.getState().sfxMarksByStory[storyId]?.[messageId] ?? [];
      const hay = full.toLowerCase();
      const out: [number, number][] = [];
      for (const m of marks) {
        if (!m.slow || !m.text) continue;
        const i = hay.indexOf(m.text.toLowerCase());
        if (i >= 0) out.push([i, i + m.text.length]);
      }
      return out;
    };

    // The Director's performance track for this passage, resolved to offsets in
    // the text on screen. With no cached cues (or the Director off) we read a
    // performance off the punctuation instead, so pacing works AI-free.
    let perfRanges: PerformRange[] | null = null;
    // Which cue the beds are currently voiced for ('' = neutral).
    let audioCue = '';
    const computePerform = (full: string): PerformRange[] => {
      const s = useAppStore.getState();
      if (!s.scenePerformance) return [];
      const storyId = s.currentStory?.id;
      const v2 = useAuraV2Store.getState();
      const cues = storyId
        ? mergePerformCues(
          v2.performMarksByStory[storyId]?.[messageId],
          v2.sceneByStory[storyId]?.[messageId]?.perform,
        )
        : undefined;
      return resolvePerformRanges(full, cues?.length ? cues : derivePerformCues(full));
    };

    /** Reveal speed in force — a starred chain may override the global slider. */
    const speedNow = () => {
      const s = useAppStore.getState();
      const chain = s.chains[s.currentChainIndex];
      return (chain?.starred && chain.starSettings?.speed) || s.playbackSpeed;
    };

    const fullText = () => {
      const s = useAppStore.getState();
      const msg = s.streamingMessage;
      if (!msg) return '';
      const v2 = useAuraV2Store.getState();
      const storyId = s.currentStory?.id;
      const content = resolveContent(
        msg,
        storyId ? v2.overridesByStory[storyId] : undefined,
        !!storyId && !!v2.lensOnByStory[storyId],
      );
      const key = [
        msg.id, content, s.hideMetadata, s.autoFormat, s.styleQuotes, s.substituteNames,
        s.paragraphSpacing, s.dialogueOwnLine, s.smartTypography, s.oocHandling, s.fontColorMode,
        JSON.stringify(s.autoFormatRules),
      ].join('|');
      if (cachedFullText === null || key !== cachedKey) {
        cachedFullText = processText(content, {
          hideMetadata: s.hideMetadata,
          // The streaming text is the SAME string the page renders once the
          // passage settles, so it has to carry the colour runs too — without
          // this a coloured passage recolours itself the moment it finishes.
          fontColorMode: s.fontColorMode,
          repairFormatting: false,
          oocHandling: s.oocHandling,
          autoFormat: s.autoFormat,
          autoFormatRules: s.autoFormatRules,
          paragraphSpacing: s.paragraphSpacing,
          dialogueOwnLine: s.dialogueOwnLine,
          smartTypography: s.smartTypography,
          styleQuotes: s.styleQuotes,
          substituteNames: s.substituteNames,
          characterName: s.currentStory?.characterName,
          userName: s.currentStory?.userName,
          role: msg.role,
        }).processedText;
        cachedKey = key;
      }
      return cachedFullText;
    };

    const scheduleAdvance = () => {
      const s = useAppStore.getState();
      // Commit the PROCESSED text we just revealed (not raw source) so the
      // finished message keeps its formatting and full last word.
      s.finishCurrentMessage(fullText());
      // A passage owes the reader a minimum time ON SCREEN — see `dwellMs`. The
      // reveal has been showing these words the whole time it was typing them,
      // so what's left to wait is the floor MINUS the time that already took.
      const words = (useAppStore.getState().streamedText.match(/\S+/g) ?? []).length;
      const readFloor = dwellMs(words, speedNow()) - (performance.now() - revealStart);
      pauseTimer = setTimeout(() => {
        const st = useAppStore.getState();
        if (!st.isStreaming || st.streamingMessage?.id !== messageId) return;
        if (st.ttsEnabled && st.ttsPending) {
          // Voice is still reading this message — the TTS hook advances on end.
          st.setAwaitingAdvance(true);
          return;
        }
        // The reader drives. Checked AFTER the voice, so a narrated passage is
        // never cut off mid-sentence by a keypress gate that arrived first —
        // the voice finishes, then the wait begins.
        if (st.pressToAdvance || st.viewHold) { st.setAwaitingInput(true); return; }
        st.advanceMessage();
      }, Math.max(0, s.messagePause, readFloor));
    };

    const tick = (now: number) => {
      const s = useAppStore.getState();
      const dt = Math.min(now - last, 250); // clamp away tab-switch jumps
      last = now;

      if (s.reverseStream) {
        acc += (dt / 1000) * charsPerSecond(s.playbackSpeed) * 2;
        const remove = Math.floor(acc);
        if (remove >= 1 && s.streamedText.length > 0) {
          acc -= remove;
          s.updateStreamedText(s.streamedText.slice(0, Math.max(0, s.streamedText.length - remove)));
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      if (!s.isStreaming || !s.streamingMessage) return;

      const speed = speedNow();
      const full = fullText();

      if (s.streamedText.length >= full.length) {
        scheduleAdvance();
        return; // effect re-runs for the next message
      }

      // Cinematic pacing: linger in dialogue, quicken through action, and hold a
      // beat at sentence / scene boundaries — all proportional to the reader's
      // speed so total reading time barely moves.
      const pacing = s.cinematicPacing;
      // Voice sync: while TTS narrates the whole passage the reveal is paced to
      // the voice, so the performance track must NOT bend it — dragging or
      // holding here would only make the words trail behind the narration.
      // (Dialogue-only TTS voices the quotes as the reveal passes them, so the
      // reveal is free — and stays free to perform.)
      const ttsSync = s.ttsEnabled && s.ttsPending && !s.ttsDialogueOnly;
      // A companion is mid-sentence and the reader asked for the reveal to wait
      // for them. Deliberately checked BEFORE `holdUntil` rather than folded
      // into it: this hold has no known duration — it ends when the line lands
      // or the request fails — so it cannot be expressed as a timestamp.
      if (s.reactionHold) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // Mid-beat — whether the hold came from cinematic pacing or from a
      // Director cue, the reveal simply waits it out.
      if (now < holdUntil) {
        raf = requestAnimationFrame(tick); // keep the loop, reveal nothing
        return;
      }
      const pacingCfg = pacingFor(s.expressiveIntensity);
      // A reader-marked "slow here" span drags the reveal to a crawl so the beat
      // (and any SFX timed to it) lands with weight.
      if (slowRanges === null) slowRanges = computeSlow(full);
      if (perfRanges === null) {
        perfRanges = computePerform(full);
        // A cue on the passage's very first words has no earlier reveal to hang
        // its entrance beat on — hold it here, before anything appears.
        const opening = performEnterMs(perfRanges, 0, s.expressiveIntensity);
        if (!ttsSync && opening > 0 && s.streamedText.length === 0) {
          holdUntil = now + opening * holdSpeedScale(speed);
        }
      }
      // The cues in force this frame — none while the voice leads the reveal.
      const perf = ttsSync ? NO_PERFORM : perfRanges;
      const pos = s.streamedText.length;

      // Ride the beds with the cue: a hush before a revelation, a tape-drag
      // through a slowed line, dead air behind an interruption. Only fires when
      // the span under the reveal actually changes, so the mix never chatters.
      const inCue = rangeAt(perf, pos);
      const cueKey = inCue ? `${inCue.start}:${inCue.kind}` : '';
      if (cueKey !== audioCue) {
        audioCue = cueKey;
        if (inCue) {
          const a = performAudioAt(perf, pos, s.expressiveIntensity);
          // Snap into a cut (it's an interruption), ease into everything else.
          audioMixer.rampPerform(a.gain, a.rate, inCue.kind === 'cut' ? 90 : 380);
        } else {
          audioMixer.resetPerform(520);
        }
      }
      const slowMul = slowRanges.some(([a, b]) => pos >= a && pos < b) ? 0.4 : 1;
      // The Director's performance track bends the rate through its span.
      const perfMul = performRateAt(perf, pos, s.expressiveIntensity);
      const mul = (pacing ? rateMultiplier(full, s.streamedText.length, pacingCfg) : 1)
        * slowMul * perfMul;

      // Voice sync: while TTS narrates this message, the reveal must not outrun
      // it. Cap the reveal to the spoken position (plus a small lead so words
      // surface just ahead of the voice, not behind it).
      // Dialogue-only TTS voices just the quotes, so its progress covers only a
      // fraction of the text — never gate the reveal to it (the narration must
      // keep reading); the quotes are spoken as the reveal passes them instead.
      const voiceCap = ttsSync
        ? Math.ceil(s.ttsProgress * full.length) + TTS_LEAD_CHARS
        : Infinity;
      if (ttsSync && s.streamedText.length >= voiceCap) {
        raf = requestAnimationFrame(tick); // caught up to the voice — wait for it
        return;
      }

      const startLen = s.streamedText.length;
      let end = startLen;
      if (s.revealMode === 'word') {
        acc += (dt / 1000) * wordsPerSecond(speed) * mul;
        const words = Math.floor(acc);
        if (words >= 1) {
          acc -= words;
          for (let w = 0; w < words; w++) end = nextWordEnd(full, end);
        }
      } else {
        acc += (dt / 1000) * charsPerSecond(speed) * mul;
        const reveal = Math.floor(acc);
        if (reveal >= 1) {
          acc -= reveal;
          end = startLen + reveal;
        }
      }

      if (end > voiceCap) {
        end = Math.max(startLen, voiceCap);
        acc = 0; // don't bank a burst while waiting for the narration
      }

      // Never stream across a cue edge: stop on it, so the entrance beat, the
      // span's own rate, and the dead air behind it all land where they were
      // marked instead of being swallowed by a long frame.
      const cueStop = nextPerformBoundary(perf, startLen);
      if (cueStop > startLen && end > cueStop) {
        end = cueStop;
        acc = 0;
      }

      if (end > startLen) {
        s.updateStreamedText(full.slice(0, end));
        const capped = Math.min(end, full.length);
        // Beats owed by the performance track: the silence before a cue, the
        // per-word stop that gives "In. the. end." its cadence, and the dead
        // air behind an interruption or an erasure.
        const cueHold = Math.max(
          performEnterMs(perf, capped, s.expressiveIntensity),
          performExitMs(perf, capped, s.expressiveIntensity),
          performHoldMs(full, perf, capped, s.expressiveIntensity),
        );
        const hold = Math.max(cueHold, pacing ? holdMsAt(full, capped, pacingCfg) : 0);
        if (hold > 0) holdUntil = now + hold * holdSpeedScale(speed);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (pauseTimer) clearTimeout(pauseTimer);
      // Never leave the beds ducked or dragging into the next passage.
      if (audioCue) audioMixer.resetPerform(300);
    };
  }, [isStreaming, reverseStream, messageId]);
};
