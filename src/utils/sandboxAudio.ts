/**
 * Sandbox scene cues — procedural sound effects, synthesised in WebAudio.
 *
 * No bundled audio assets: every sound is a tiny oscillator/noise patch built on
 * the fly. That keeps the app asset-free (nothing to license, nothing to ship)
 * and matches the local-first ethos. A single AudioContext is created lazily on
 * the first play (which is always a user-driven playback gesture, so autoplay
 * policies are satisfied). Failures are swallowed — sound is a garnish.
 */

import { SoundKind } from '../types';

let ctx: AudioContext | null = null;

const audio = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};

/** A short noise burst (for whoosh/thud texture). */
const noiseBuffer = (ac: AudioContext, seconds: number): AudioBuffer => {
  const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
};

/** One enveloped tone: osc → gain(ramped) → destination. */
const tone = (
  ac: AudioContext, type: OscillatorType, from: number, to: number, dur: number,
  peak: number, delay = 0,
) => {
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

/** Filtered noise burst (whoosh/thud). */
const noise = (ac: AudioContext, dur: number, freq: number, peak: number, hp = false) => {
  const t0 = ac.currentTime;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur);
  const filt = ac.createBiquadFilter();
  filt.type = hp ? 'highpass' : 'lowpass';
  filt.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(ac.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
};

const patches: Record<SoundKind, (ac: AudioContext) => void> = {
  clink: (ac) => { tone(ac, 'triangle', 2400, 1800, 0.12, 0.18); tone(ac, 'sine', 3600, 3000, 0.09, 0.08, 0.01); },
  boom: (ac) => { tone(ac, 'sine', 120, 40, 0.6, 0.5); noise(ac, 0.5, 220, 0.25); },
  whoosh: (ac) => noise(ac, 0.45, 1200, 0.22, true),
  chime: (ac) => { tone(ac, 'sine', 880, 880, 0.5, 0.16); tone(ac, 'sine', 1320, 1320, 0.5, 0.1, 0.02); tone(ac, 'sine', 1760, 1760, 0.45, 0.07, 0.04); },
  heartbeat: (ac) => { tone(ac, 'sine', 70, 45, 0.16, 0.5); tone(ac, 'sine', 70, 45, 0.16, 0.42, 0.28); },
  thud: (ac) => { tone(ac, 'sine', 160, 55, 0.22, 0.5); noise(ac, 0.18, 320, 0.3); },
  shimmer: (ac) => { for (let i = 0; i < 4; i++) tone(ac, 'sine', 2000 + i * 600, 2600 + i * 600, 0.5, 0.05, i * 0.05); },
};

/** Play one procedural cue sound. No-op if WebAudio is unavailable. */
export const playSound = (kind: SoundKind): void => {
  try {
    const ac = audio();
    if (ac) patches[kind]?.(ac);
  } catch { /* sound is a garnish — never let it break playback */ }
};
