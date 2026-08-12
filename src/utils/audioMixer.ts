/**
 * Central audio mixer — the volume hierarchy + ducking for every sound source
 * (TTS voice, music, ambience, one-shot SFX). It does NOT own any audio node; it
 * only computes the *effective* gain a source should use, so heterogeneous
 * sources (HTMLAudio, WebAudio, Web-Speech) can all route through one policy.
 *
 * Hierarchy (loudest → quietest): voice > sfx > music > ambience. TTS is the
 * point of the reader, so while it speaks the two BEDS (music + ambience) duck
 * out of its way; SFX and voice are never ducked. Sources subscribe and re-apply
 * their volume whenever the duck state flips, so speech stays intelligible.
 */

export type MixChannel = 'voice' | 'music' | 'ambience' | 'sfx';

/** The hierarchy, as base gains. Voice on top; ambience is the floor. */
export const CHANNEL_BASE: Record<MixChannel, number> = {
  voice: 1,
  sfx: 0.7,
  music: 0.55,
  ambience: 0.3,
};

/** How far the beds duck under an active voice (music + ambience only). */
export const DUCK_FACTOR = 0.4;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

class AudioMixer {
  private voiceActive = false;
  private master = 1;
  private modulation = 1; // narrative volume envelope over the environment (not voice)
  private modRaf: ReturnType<typeof setTimeout> | null = null;
  private perfGain = 1;   // reveal-cue envelope, multiplied over the modulation
  private perfRate = 1;   // bed playback-rate factor (the tape drag)
  private perfRaf: ReturnType<typeof setTimeout> | null = null;
  private subs = new Set<() => void>();

  /** Global master (0..1) over everything. */
  setMaster(v: number) {
    const m = clamp01(v);
    if (m !== this.master) { this.master = m; this.emit(); }
  }

  /**
   * Ramp the narrative modulation toward `target` over `ms` — the story-driven
   * swell/hush ("silence fell" → quiet; "the din rose" → loud). Scales the
   * environment (music/ambience/sfx), never the voice. 1 = neutral.
   */
  rampModulation(target: number, ms = 900) {
    if (this.modRaf) { clearTimeout(this.modRaf); this.modRaf = null; }
    const to = Math.max(0, Math.min(1.5, target));
    const from = this.modulation;
    if (ms <= 0 || from === to) { this.modulation = to; this.emit(); return; }
    const t0 = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - t0) / ms);
      this.modulation = from + (to - from) * t;
      this.emit();
      this.modRaf = t < 1 ? setTimeout(step, 40) : null;
    };
    step();
  }

  /** Snap modulation back to neutral (e.g. a new message/scene). */
  resetModulation() { this.rampModulation(1, 0); }

  /**
   * The PERFORMANCE envelope — a second, independent layer over the same beds,
   * driven by the Scene Director's reveal cues (a hush before a revelation, a
   * bed dragging with a slowed line, dead air behind an interruption). It
   * multiplies with `modulation` rather than replacing it, so the reveal and
   * the story's own volume cues compose instead of fighting each other.
   *
   * `rate` is a playback-speed factor for the beds — the tape-drag that makes a
   * slowed passage FEEL slowed rather than just looking it.
   */
  rampPerform(gain: number, rate = 1, ms = 420) {
    if (this.perfRaf) { clearTimeout(this.perfRaf); this.perfRaf = null; }
    const gTo = Math.max(0, Math.min(1.5, gain));
    const rTo = Math.max(0.5, Math.min(1.6, rate));
    const gFrom = this.perfGain;
    const rFrom = this.perfRate;
    if (ms <= 0 || (gFrom === gTo && rFrom === rTo)) {
      this.perfGain = gTo; this.perfRate = rTo; this.emit(); return;
    }
    const t0 = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - t0) / ms);
      this.perfGain = gFrom + (gTo - gFrom) * t;
      this.perfRate = rFrom + (rTo - rFrom) * t;
      this.emit();
      this.perfRaf = t < 1 ? setTimeout(step, 40) : null;
    };
    step();
  }

  /** Back to neutral — a new message, or the cue's span ending. */
  resetPerform(ms = 420) { this.rampPerform(1, 1, ms); }

  /** Playback-rate factor the beds should currently run at (1 = normal). */
  rate(): number { return this.perfRate; }

  /** Mark voice (TTS) as speaking / silent — flips bed ducking. */
  setVoiceActive(on: boolean) {
    if (on !== this.voiceActive) { this.voiceActive = on; this.emit(); }
  }

  isVoiceActive(): boolean { return this.voiceActive; }

  /** Duck multiplier for a channel right now (1 = no duck). */
  duck(channel: MixChannel): number {
    return this.voiceActive && (channel === 'music' || channel === 'ambience') ? DUCK_FACTOR : 1;
  }

  /**
   * The volume a source on `channel` should apply: the channel's place in the
   * hierarchy × the source's own level (a user slider, 0..1) × any per-source
   * scale (tension, importance) × the current duck × master. Always 0..1.
   */
  volumeFor(channel: MixChannel, sourceLevel = 1, scale = 1): number {
    // The narrative modulation and the reveal envelope both shape the
    // environment, and neither ever touches the voice.
    const mod = channel === 'voice' ? 1 : this.modulation * this.perfGain;
    return clamp01(CHANNEL_BASE[channel] * sourceLevel * scale * this.duck(channel) * mod * this.master);
  }

  /** Subscribe to mix changes (duck/master). Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  private emit() { for (const fn of this.subs) fn(); }
}

/** Process-wide singleton — one mixer for the whole reader. */
export const audioMixer = new AudioMixer();
