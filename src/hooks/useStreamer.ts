import { useEffect } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { processText } from '../utils/textProcessor';
import { resolveContent } from '../utils/lens';
import { holdMsAt, holdSpeedScale, pacingFor, rateMultiplier } from '../utils/expressive';

/** Characters revealed per second for a 1-100 speed setting. */
export const charsPerSecond = (speed: number) => 8 + speed * 2.2;

/** Words revealed per second for a 1-100 speed setting (~50 ≈ 350 wpm). */
export const wordsPerSecond = (speed: number) => 0.8 + speed * 0.1;

/** Chars the reveal is allowed to lead the narration by, so words appear just
 *  ahead of the voice rather than trailing it. */
const TTS_LEAD_CHARS = 30;

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
        s.paragraphSpacing, s.dialogueOwnLine, s.smartTypography, s.oocHandling,
        JSON.stringify(s.autoFormatRules),
      ].join('|');
      if (cachedFullText === null || key !== cachedKey) {
        cachedFullText = processText(content, {
          hideMetadata: s.hideMetadata,
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
      // Short lines finish streaming in a blink and would vanish before
      // they can be read (worst on Stage/VN where only the current passage
      // shows) — hold them for a read-speed floor before advancing.
      const words = (useAppStore.getState().streamedText.match(/\S+/g) ?? []).length;
      const readFloor = words <= 30 ? Math.min(2400, 300 + words * 110) : 0;
      pauseTimer = setTimeout(() => {
        const st = useAppStore.getState();
        if (!st.isStreaming || st.streamingMessage?.id !== messageId) return;
        if (st.ttsEnabled && st.ttsPending) {
          // Voice is still reading this message — the TTS hook advances on end.
          st.setAwaitingAdvance(true);
          return;
        }
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

      const chain = s.chains[s.currentChainIndex];
      const speed = (chain?.starred && chain.starSettings?.speed) || s.playbackSpeed;
      const full = fullText();

      if (s.streamedText.length >= full.length) {
        scheduleAdvance();
        return; // effect re-runs for the next message
      }

      // Cinematic pacing: linger in dialogue, quicken through action, and hold a
      // beat at sentence / scene boundaries — all proportional to the reader's
      // speed so total reading time barely moves.
      const pacing = s.cinematicPacing;
      if (pacing && now < holdUntil) {
        raf = requestAnimationFrame(tick); // mid-beat — keep the loop, reveal nothing
        return;
      }
      const pacingCfg = pacingFor(s.expressiveIntensity);
      // A reader-marked "slow here" span drags the reveal to a crawl so the beat
      // (and any SFX timed to it) lands with weight.
      if (slowRanges === null) slowRanges = computeSlow(full);
      const pos = s.streamedText.length;
      const slowMul = slowRanges.some(([a, b]) => pos >= a && pos < b) ? 0.4 : 1;
      const mul = (pacing ? rateMultiplier(full, s.streamedText.length, pacingCfg) : 1) * slowMul;

      // Voice sync: while TTS narrates this message, the reveal must not outrun
      // it. Cap the reveal to the spoken position (plus a small lead so words
      // surface just ahead of the voice, not behind it).
      // Dialogue-only TTS voices just the quotes, so its progress covers only a
      // fraction of the text — never gate the reveal to it (the narration must
      // keep reading); the quotes are spoken as the reveal passes them instead.
      const ttsSync = s.ttsEnabled && s.ttsPending && !s.ttsDialogueOnly;
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

      if (end > startLen) {
        s.updateStreamedText(full.slice(0, end));
        if (pacing) {
          const hold = holdMsAt(full, Math.min(end, full.length), pacingCfg);
          if (hold > 0) holdUntil = now + hold * holdSpeedScale(speed);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (pauseTimer) clearTimeout(pauseTimer);
    };
  }, [isStreaming, reverseStream, messageId]);
};
