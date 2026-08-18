/**
 * How a message becomes speech, in one place.
 *
 * `useTTS` built this inline from live store state, which was fine while
 * speaking was the only thing that read a message aloud. The audiobook renders
 * the same story offline, and if it rebuilt the plan its own way the file would
 * quietly disagree with what you hear in the app — different voices, different
 * narration/dialogue split, different text after the Lens. So the plan is
 * computed here and both callers use it.
 *
 * Pure: everything it needs is passed in. That makes the voice casting and the
 * narration/dialogue split testable without a store, a hook or an endpoint.
 */

import type { Message, SceneDescriptor, Story } from '../types';
import type { MessageOverride } from '../types';
import { SpeechSegment, buildSpeechPlan } from './dialogueSegments';
import { resolveContent } from './lens';
import { plainTextForSpeech, processText } from './textProcessor';
import { voiceForSpeaker } from './kokoro';

export interface SpeechContext {
  /** Every name in the story, for dialogue attribution. */
  cast: string[];
  characterName?: string;
  userName?: string;
  /** Lens layer. */
  overrides?: MessageOverride[];
  lensOn?: boolean;
  /** Passed to `processText`, so speech matches the page. */
  hideMetadata?: boolean;
  substituteNames?: boolean;
  /** Read each speaker in their own voice. */
  multiVoice?: boolean;
  /** Voice configuration. */
  kokoroVoice: string;
  kokoroUserVoice: string;
  ttsVoiceByCharacter: Record<string, string>;
  autoCastVoices?: boolean;
}

/** One segment with the voice that should read it. */
export interface VoicedSegment extends SpeechSegment {
  voice: string;
}

/** The speakable text of a message, Lens- and processText-resolved. */
export const speechTextFor = (
  msg: Message,
  ctx: SpeechContext,
): string => {
  const content = resolveContent(msg, ctx.overrides, ctx.lensOn ?? false);
  const { processedText } = processText(content, {
    hideMetadata: ctx.hideMetadata,
    repairFormatting: false,
    substituteNames: ctx.substituteNames,
    characterName: ctx.characterName,
    userName: ctx.userName,
    role: msg.role,
  });
  return plainTextForSpeech(processedText);
};

/**
 * Split a message into voiced segments.
 *
 * Single-voice reads the whole message in the speaker's voice; multi-voice
 * narrates in the author's and gives each quoted character their own. The
 * Director's per-quote attribution wins over the heuristic when present.
 */
export const speechPlanFor = (
  msg: Message,
  ctx: SpeechContext,
  descriptor?: SceneDescriptor,
): VoicedSegment[] => {
  const plain = speechTextFor(msg, ctx);
  if (!plain) return [];

  const plan: SpeechSegment[] = ctx.multiVoice
    ? buildSpeechPlan(plain, {
      author: msg.name, cast: ctx.cast, dialogue: descriptor?.dialogue,
      // The Director stored these verbatim from the RAW message; the text here
      // has been through processText. `speechKey` reconciles the two.
      characterName: ctx.characterName, userName: ctx.userName,
    })
    : [{ text: plain, speaker: msg.name, isDialogue: false }];

  const userName = (ctx.userName ?? '').trim().toLowerCase();
  return plan.map(seg => ({
    ...seg,
    voice: voiceForSpeaker({
      role: !seg.isDialogue ? msg.role : (seg.speaker.trim().toLowerCase() === userName ? 'user' : 'ai'),
      name: seg.isDialogue ? seg.speaker : msg.name,
      kokoroVoice: ctx.kokoroVoice,
      kokoroUserVoice: ctx.kokoroUserVoice,
      ttsVoiceByCharacter: ctx.ttsVoiceByCharacter,
      primaryName: ctx.characterName,
      // Multi-voice forces auto-casting so NPC lines always differentiate.
      autoCast: ctx.autoCastVoices || ctx.multiVoice,
    }),
  }));
};

/** Every distinct name → voice pairing a story will use. For a cast list. */
export const voiceCastFor = (story: Story, ctx: SpeechContext): { name: string; voice: string }[] => {
  const seen = new Map<string, string>();
  for (const name of ctx.cast) {
    const isUser = name.trim().toLowerCase() === (ctx.userName ?? '').trim().toLowerCase();
    seen.set(name, voiceForSpeaker({
      role: isUser ? 'user' : 'ai',
      name,
      kokoroVoice: ctx.kokoroVoice,
      kokoroUserVoice: ctx.kokoroUserVoice,
      ttsVoiceByCharacter: ctx.ttsVoiceByCharacter,
      primaryName: story.characterName,
      autoCast: ctx.autoCastVoices || ctx.multiVoice,
    }));
  }
  return [...seen].map(([name, voice]) => ({ name, voice }));
};
