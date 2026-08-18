import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { plainTextForSpeech, processText } from '../utils/textProcessor';
import { resolveContent } from '../utils/lens';
import { kokoroSpeak, voiceForSpeaker } from '../utils/kokoro';
import { dialogueQuotes } from '../utils/dialogueSegments';
import { emotionProsody } from '../utils/sceneMood';
import { audioMixer } from '../utils/audioMixer';
import { speechPlanFor } from '../utils/speechPlan';

export const ttsSupported = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * Effective voice rate. When "follow speed" is on, the 1–100 reading-speed
 * slider scales the voice so a faster stream reads faster (capped at the
 * browser's practical ceiling).
 */
export const ttsEffectiveRate = (
  ttsRate: number, playbackSpeed: number, followSpeed: boolean,
): number => {
  if (!followSpeed) return ttsRate;
  const factor = 0.6 + playbackSpeed * 0.028; // speed 50 ≈ 2×, speed 100 ≈ 3.4×
  return Math.min(4, Math.max(0.5, ttsRate * factor));
};

/** Available voices; updates when the browser finishes loading them. */
export const useVoices = (): SpeechSynthesisVoice[] => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  return voices;
};

/**
 * Reads the streaming message aloud via the Web Speech API. Message
 * advancement waits for speech to finish (the streamer sets
 * `awaitingAdvance` when the visual reveal completes first).
 */
export const useTTS = () => {
  const enabled = useAppStore(s => s.ttsEnabled);
  const engine = useAppStore(s => s.ttsEngine);
  const messageId = useAppStore(s => s.streamingMessage?.id);
  const isStreaming = useAppStore(s => s.isStreaming);
  const dialogueOnly = useAppStore(s => s.ttsDialogueOnly);
  // Dialogue-only reacts to the reveal position and to reveal-completion.
  const streamedText = useAppStore(s => s.streamedText);
  const awaitingAdvance = useAppStore(s => s.awaitingAdvance);

  // Kokoro playback lives outside React so we can pause/cancel it precisely.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  // Dialogue-only queue: each quote, its speaker, and its playback state. Filled
  // when the message begins; a quote turns `ready` as the reveal reaches it and
  // `done` once spoken. `token` supersedes an in-flight drain on message change.
  interface DlgItem { anchor: string; text: string; speaker: string; ready: boolean; done: boolean }
  const dlg = useRef<DlgItem[]>([]);
  const dlgToken = useRef(0);
  const dlgDraining = useRef(false);
  const dlgPrevLen = useRef(0); // reveal length last seen — a drop = a replay

  const stopKokoro = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    audioMixer.setVoiceActive(false); // stop ducking the beds
  };

  // --- Dialogue-only helpers -------------------------------------------------
  // Speak ONE quote in its speaker's voice and resolve when it finishes (or is
  // superseded/fails). Works for both engines.
  const speakDlg = (item: DlgItem, t: number): Promise<void> => new Promise((resolve) => {
    if (t !== dlgToken.current) return resolve();
    const s = useAppStore.getState();
    const userName = (s.currentStory?.userName ?? '').trim().toLowerCase();
    const rate = ttsEffectiveRate(s.ttsRate, s.playbackSpeed, s.ttsFollowSpeed);
    if (s.ttsEngine === 'kokoro') {
      const voice = voiceForSpeaker({
        role: item.speaker.trim().toLowerCase() === userName ? 'user' : 'ai',
        name: item.speaker,
        kokoroVoice: s.kokoroVoice, kokoroUserVoice: s.kokoroUserVoice,
        ttsVoiceByCharacter: s.ttsVoiceByCharacter,
        primaryName: s.currentStory?.characterName,
        autoCast: true, // dialogue-only always casts per speaker
      });
      const controller = new AbortController();
      abortRef.current = controller;
      kokoroSpeak(s.kokoroBaseUrl, s.kokoroApiKey, voice, item.text, rate, controller.signal)
        .then((blob) => {
          if (t !== dlgToken.current || controller.signal.aborted) return resolve();
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          const audio = audioRef.current ?? new Audio();
          audioRef.current = audio;
          audio.src = url;
          audio.volume = audioMixer.volumeFor('voice');
          audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
          audio.onerror = () => resolve();
          void audio.play().catch(() => resolve());
        })
        .catch(() => resolve());
    } else if (ttsSupported()) {
      const utt = new SpeechSynthesisUtterance(item.text);
      const voice = speechSynthesis.getVoices().find(v => v.voiceURI === s.ttsVoiceURI);
      if (voice) utt.voice = voice;
      utt.rate = rate;
      utt.pitch = s.ttsPitch;
      utt.volume = audioMixer.volumeFor('voice');
      utt.onend = () => resolve();
      utt.onerror = () => resolve();
      speechSynthesis.speak(utt);
    } else resolve();
  });

  // Once every quote has been spoken AND the visual reveal has finished, release
  // the streamer to advance (dialogue-only keeps ttsPending so it waits for us).
  const maybeFinishDlg = (t: number) => {
    if (t !== dlgToken.current || !dlg.current.every(d => d.done)) return;
    const st = useAppStore.getState();
    st.setTtsProgress(1);
    if (st.awaitingAdvance && st.isStreaming && st.streamingMessage?.id === messageId) {
      st.setTtsPending(false);
      st.setAwaitingAdvance(false);
      st.advanceMessage();
    }
  };

  // Play every ready-but-unspoken quote in reading order, one at a time. New
  // quotes that become ready mid-drain are picked up on the next loop.
  const drainDlg = async () => {
    if (dlgDraining.current) return;
    dlgDraining.current = true;
    const t = dlgToken.current;
    audioMixer.setVoiceActive(true); // duck the beds while a line speaks
    try {
      for (;;) {
        if (t !== dlgToken.current) return;
        const next = dlg.current.find(d => d.ready && !d.done);
        if (!next) break;
        await speakDlg(next, t);
        if (t !== dlgToken.current) return;
        next.done = true;
      }
    } finally {
      dlgDraining.current = false;
      audioMixer.setVoiceActive(false);
      maybeFinishDlg(t);
    }
  };

  // One utterance/clip per streaming message.
  useEffect(() => {
    if (!enabled || !messageId) return;
    const s = useAppStore.getState();
    const msg = s.streamingMessage;
    if (!msg || !s.isStreaming) return;

    const storyId = s.currentStory?.id;
    const v2 = useAuraV2Store.getState();
    const content = resolveContent(
      msg,
      storyId ? v2.overridesByStory[storyId] : undefined,
      !!storyId && !!v2.lensOnByStory[storyId],
    );

    const { processedText } = processText(content, {
      hideMetadata: s.hideMetadata,
      repairFormatting: false,
      substituteNames: s.substituteNames,
      characterName: s.currentStory?.characterName,
      userName: s.currentStory?.userName,
      role: msg.role,
    });
    const plain = plainTextForSpeech(processedText);
    if (!plain) return;

    // --- Dialogue-only: plan the quotes; speak each as the reveal reaches it. ---
    if (dialogueOnly) {
      const cast = [...new Set(useAppStore.getState().chains.flatMap(c => c.messages).map(m => m.name))];
      const attribution = storyId ? v2.sceneByStory[storyId]?.[msg.id]?.dialogue : undefined;
      // Merge-independent extraction: a solo character's quotes survive (they'd
      // collapse into narration in buildSpeechPlan and lose their identity).
      const quotes = dialogueQuotes(plain, { author: msg.name, cast, dialogue: attribution });
      ++dlgToken.current;
      dlgPrevLen.current = 0;
      dlg.current = quotes.map(q => ({
        // A verbatim slice of the quote is the reveal anchor (mirrors useSceneSfx).
        anchor: q.text.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase(),
        text: q.text, speaker: q.speaker, ready: false, done: false,
      }));
      if (dlg.current.length === 0) return; // no dialogue → stay silent, reveal advances itself
      // Keep the streamer waiting for the spoken quotes, but leave the reveal
      // ungated (the streamer guards ttsSync on !ttsDialogueOnly).
      s.setTtsPending(true);
      s.setTtsProgress(0);
      return () => {
        dlgToken.current++; // supersede any in-flight drain
        stopKokoro();
        if (ttsSupported()) speechSynthesis.cancel();
        audioMixer.setVoiceActive(false);
        const st = useAppStore.getState();
        st.setTtsPending(false);
        st.setTtsProgress(1);
      };
    }

    const baseRate = ttsEffectiveRate(s.ttsRate, s.playbackSpeed, s.ttsFollowSpeed);
    // Emotional TTS: shape rate/pitch by the Scene Director's read of this
    // passage (speaker emotion + tension), when a descriptor exists.
    const descriptor = s.emotionalTts && storyId
      ? v2.sceneByStory[storyId]?.[msg.id]
      : undefined;
    const prosody = descriptor
      ? emotionProsody(descriptor.speaker?.emotion, descriptor.tension)
      : { rate: 1, pitch: 1 };
    const rate = baseRate * prosody.rate;
    const finish = () => {
      const st = useAppStore.getState();
      audioMixer.setVoiceActive(false); // voice done — un-duck the beds
      // Release the reveal so any un-narrated tail can complete + advance.
      st.setTtsProgress(1);
      st.setTtsPending(false);
      if (st.awaitingAdvance) {
        st.setAwaitingAdvance(false);
        if (st.isStreaming && st.streamingMessage?.id === messageId) {
          st.advanceMessage();
        }
      }
    };

    // --- Kokoro engine: fetch synthesized audio, per-character voice. ---
    if (engine === 'kokoro') {
      const controller = new AbortController();
      abortRef.current = controller;

      // Multi-voice: read narration in the message's voice and each character's
      // dialogue in their own cast voice; single-voice reads the whole message.
      const cast = [...new Set(useAppStore.getState().chains.flatMap(c => c.messages).map(m => m.name))];
      // The plan comes from the shared module, so the audiobook render and
      // what you hear live can never drift apart.
      const plan = speechPlanFor(msg, {
        cast,
        characterName: s.currentStory?.characterName,
        userName: s.currentStory?.userName,
        overrides: storyId ? v2.overridesByStory[storyId] : undefined,
        lensOn: !!storyId && !!v2.lensOnByStory[storyId],
        hideMetadata: s.hideMetadata,
        substituteNames: s.substituteNames,
        multiVoice: s.ttsMultiVoice,
        kokoroVoice: s.kokoroVoice,
        kokoroUserVoice: s.kokoroUserVoice,
        ttsVoiceByCharacter: s.ttsVoiceByCharacter,
        autoCastVoices: s.autoCastVoices,
      }, storyId ? v2.sceneByStory[storyId]?.[msg.id] : undefined);
      const voiceForSegment = (seg: { voice: string }): string => seg.voice;

      s.setTtsPending(true);
      s.setTtsProgress(0);
      audioMixer.setVoiceActive(true); // duck the beds under the narration
      const totalChars = plan.reduce((n, seg) => n + seg.text.length, 0) || 1;
      let doneChars = 0;

      const playBlob = (blob: Blob, chars: number) => new Promise<void>(resolve => {
        if (controller.signal.aborted) return resolve();
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.volume = audioMixer.volumeFor('voice');
        // Real clip position → reveal progress, weighted across the whole plan.
        audio.ontimeupdate = () => {
          const d = audio.duration;
          if (d && Number.isFinite(d)) {
            useAppStore.getState().setTtsProgress(Math.min(1, (doneChars + (audio.currentTime / d) * chars) / totalChars));
          }
        };
        audio.onended = () => { doneChars += chars; URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });

      (async () => {
        for (const seg of plan) {
          if (controller.signal.aborted) break;
          let blob: Blob;
          try {
            blob = await kokoroSpeak(s.kokoroBaseUrl, s.kokoroApiKey, voiceForSegment(seg), seg.text, rate, controller.signal);
          } catch (err) {
            if (controller.signal.aborted) return; // superseded — stay silent
            console.warn('Kokoro TTS failed', err);
            doneChars += seg.text.length; // skip this span, keep the plan moving
            continue;
          }
          if (controller.signal.aborted) return;
          await playBlob(blob, seg.text.length);
        }
        if (!controller.signal.aborted) finish();
      })();

      return () => {
        stopKokoro();
        const st = useAppStore.getState();
        st.setTtsPending(false);
        st.setTtsProgress(1);
      };
    }

    // --- Browser engine: Web Speech API. ---
    if (!ttsSupported()) return;
    const utterance = new SpeechSynthesisUtterance(plain);
    const voice = speechSynthesis.getVoices().find(v => v.voiceURI === s.ttsVoiceURI);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = s.ttsPitch * prosody.pitch;
    utterance.volume = audioMixer.volumeFor('voice');
    utterance.onend = finish;
    utterance.onerror = finish;
    audioMixer.setVoiceActive(true); // duck the beds under the narration

    // Track spoken position so the visual reveal can follow the voice. Some
    // browsers never fire `boundary` — a watchdog lifts the gate if so.
    const total = plain.length || 1;
    let sawBoundary = false;
    utterance.onboundary = (e) => {
      sawBoundary = true;
      useAppStore.getState().setTtsProgress(Math.min(1, (e.charIndex ?? 0) / total));
    };
    const watchdog = setTimeout(() => {
      if (!sawBoundary) useAppStore.getState().setTtsProgress(1);
    }, 1500);

    s.setTtsPending(true);
    s.setTtsProgress(0);
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);

    return () => {
      clearTimeout(watchdog);
      speechSynthesis.cancel();
      audioMixer.setVoiceActive(false);
      const st = useAppStore.getState();
      st.setTtsPending(false);
      st.setTtsProgress(1);
    };
  }, [enabled, engine, messageId, dialogueOnly]);

  // Dialogue-only: as the reveal advances, mark each quote it has reached ready
  // and drain the queue so lines are voiced in sync with the reading, not upfront.
  useEffect(() => {
    if (!enabled || !dialogueOnly || !dlg.current.length) return;
    const st = useAppStore.getState();
    // Replay: the reveal jumped back toward the start (same message re-run) —
    // re-arm the queue and the advance gate so the lines speak again.
    if (streamedText.length < dlgPrevLen.current) {
      dlgToken.current++;
      stopKokoro();
      if (ttsSupported()) speechSynthesis.cancel();
      for (const d of dlg.current) { d.ready = false; d.done = false; }
      st.setTtsPending(true);
      st.setTtsProgress(0);
    }
    dlgPrevLen.current = streamedText.length;
    if (!useAppStore.getState().ttsPending) return;
    const hay = streamedText.toLowerCase();
    let woke = false;
    for (const d of dlg.current) {
      if (!d.ready && hay.includes(d.anchor)) { d.ready = true; woke = true; }
    }
    if (woke) void drainDlg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamedText, enabled, dialogueOnly]);

  // Dialogue-only: when the visual reveal completes, every remaining quote has
  // been shown — force any un-matched ones ready so the final lines still speak,
  // then let the last drain release the advance.
  useEffect(() => {
    if (!enabled || !dialogueOnly || !awaitingAdvance || !dlg.current.length) return;
    for (const d of dlg.current) d.ready = true;
    void drainDlg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingAdvance, enabled, dialogueOnly]);

  // Pause/resume together with playback.
  useEffect(() => {
    if (!enabled) return;
    if (engine === 'kokoro') {
      const a = audioRef.current;
      if (!a) return;
      if (isStreaming) void a.play().catch(() => {});
      else a.pause();
    } else if (ttsSupported()) {
      if (isStreaming) speechSynthesis.resume();
      else speechSynthesis.pause();
    }
  }, [enabled, engine, isStreaming]);

  // Full stop when TTS is switched off.
  useEffect(() => {
    if (!enabled) {
      if (ttsSupported()) speechSynthesis.cancel();
      stopKokoro();
      audioMixer.setVoiceActive(false);
      const st = useAppStore.getState();
      st.setTtsPending(false);
      st.setTtsProgress(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
};
