import { SceneDescriptor } from '../types';

/**
 * VN shot choreography — the compact, AI-optional answer to Fablekin's per-beat
 * "sequence of stage states". A VN scene shouldn't hold one frozen pose for a
 * whole message: as the reader reveals each beat (a spoken line, a paragraph of
 * narration) the camera should respond — push in on the talker, cut wide when
 * the story moves somewhere new, dim + blur the listener.
 *
 * This module is a PURE function of the current beat plus the Director's cached
 * read. It needs no AI: the heuristic backbone is derived from the text alone
 * (is this beat speech? who's talking? did we just change location?). When a
 * descriptor is present it only SHARPENS the shot — tension scales the push,
 * `shot` overrides the framing, mood arms the shake. Nothing here touches React
 * or the store; the view maps the result onto CSS classes.
 */

export type Shot = 'establishing' | 'wide' | 'mid' | 'close';
export type Focus = 'left' | 'right' | 'center';

export interface Staging {
  shot: Shot;
  focus: Focus;
  /** Blur the dimmed (non-focused) sprite — a cheap depth-of-field on close-ups. */
  dof: boolean;
}

export interface StagingInput {
  /** True when the current beat is a spoken line (vs. pure narration). */
  primaryIsSpeech: boolean;
  /** Who holds the current line — the character, the reader, or nobody. */
  speakerSide: 'char' | 'user' | null;
  /** The Director's read of this passage, when one has been enriched. */
  descriptor?: Pick<SceneDescriptor, 'mood' | 'tension' | 'shot'>;
  /** The area title card is up — we just arrived somewhere new. */
  locationJustChanged: boolean;
  /** Both leads are physically on stage (so a side-focus reads as a pan). */
  bothOnStage: boolean;
}

/**
 * Choose the framing for the beat currently on screen. Order of authority:
 * a fresh location always establishes; otherwise the Director's explicit `shot`
 * wins; otherwise the heuristic (speech pushes in, narration sits back).
 * (Screen punctuation like shake lives in the vfx layer — see utils/sceneVfx.)
 */
export const deriveStaging = (input: StagingInput): Staging => {
  const {
    primaryIsSpeech, speakerSide, descriptor, locationJustChanged, bothOnStage,
  } = input;
  const tension = descriptor?.tension ?? 0;

  // Where the eye goes: the talker's side when two leads share the stage,
  // otherwise dead center (a lone sprite is already centered).
  const focus: Focus = !bothOnStage || !primaryIsSpeech || !speakerSide
    ? 'center'
    : speakerSide === 'user' ? 'right' : 'left';

  // Arriving somewhere new always opens on an establishing beat, riding the
  // area card — no push-in until we've seen the room.
  if (locationJustChanged) {
    return { shot: 'establishing', focus: 'center', dof: false };
  }

  let shot: Shot;
  if (descriptor?.shot === 'close' || descriptor?.shot === 'wide' || descriptor?.shot === 'establishing') {
    shot = descriptor.shot;
  } else if (primaryIsSpeech) {
    shot = 'close';
  } else {
    shot = tension >= 0.66 ? 'mid' : 'wide';
  }

  return { shot, focus, dof: shot === 'close' };
};
