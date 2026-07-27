/**
 * A looping audio layer that CROSSFADES between clips — so a scene change
 * (forest → mountain) blends instead of hard-cutting. Two <audio> elements swap
 * roles: the incoming one fades up while the outgoing fades down (equal-power,
 * so the perceived loudness stays constant through the blend). A separate
 * "ceiling" (set by the mixer's duck/volume) scales whatever is currently up.
 *
 * Pure playback plumbing — no React, no store. SceneSoundscape drives it.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export class CrossfadePlayer {
  private a: HTMLAudioElement;
  private b: HTMLAudioElement;
  private cur: HTMLAudioElement; // the element currently "up"
  private curUrl: string | null = null;
  private ceiling = 1; // volume cap from the mixer (duck × level)
  private fadeMs: number;
  private raf: ReturnType<typeof setTimeout> | null = null;

  constructor(fadeMs = 1500) {
    this.a = new Audio();
    this.b = new Audio();
    this.a.loop = this.b.loop = true;
    this.a.volume = this.b.volume = 0;
    this.cur = this.a;
    this.fadeMs = fadeMs;
  }

  /** The clip currently playing (null = silent). */
  current(): string | null { return this.curUrl; }

  /** Set the volume cap (0..1). Applies immediately to the clip that's up. */
  setCeiling(v: number) {
    this.ceiling = clamp01(v);
    if (!this.raf) this.cur.volume = this.curUrl ? this.ceiling : 0;
  }

  /**
   * Crossfade to `url` (or fade to silence when null). No-op if it's already
   * the clip that's up, except the ceiling is re-applied.
   */
  play(url: string | null) {
    if (url === this.curUrl) { this.setCeiling(this.ceiling); return; }
    this.cancel();
    const outgoing = this.cur;
    const incoming = this.cur === this.a ? this.b : this.a;

    if (url) {
      if (incoming.src !== url) incoming.src = url;
      incoming.volume = 0;
      void incoming.play().catch(() => {});
    }
    this.cur = incoming;
    this.curUrl = url;

    const outStart = outgoing.volume;
    const t0 = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / this.fadeMs);
      // Equal-power: sin/cos keeps combined power ~constant across the blend.
      incoming.volume = url ? clamp01(this.ceiling * Math.sin((t * Math.PI) / 2)) : 0;
      outgoing.volume = clamp01(outStart * Math.cos((t * Math.PI) / 2));
      if (t < 1) { this.raf = setTimeout(tick, 32); }
      else {
        this.raf = null;
        outgoing.pause();
        incoming.volume = url ? this.ceiling : 0;
        if (!url) incoming.pause();
      }
    };
    tick();
  }

  /** Resume playback after a user gesture (autoplay policies). */
  resume() { if (this.curUrl) void this.cur.play().catch(() => {}); }

  private cancel() { if (this.raf) { clearTimeout(this.raf); this.raf = null; } }

  stop() { this.play(null); }

  dispose() {
    this.cancel();
    for (const el of [this.a, this.b]) { el.pause(); el.src = ''; }
  }
}
