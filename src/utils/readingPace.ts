/**
 * How the reader is moving through the story.
 *
 * ── Why a companion needs this ─────────────────────────────────────────────
 *
 * Everything else the Live Reaction feature knows is about the PAGE: the
 * passage, the moment, what has been said. None of it is about the person. So a
 * companion could sit through you reading the same paragraph four times and
 * react to it identically each time, which is the single most obviously
 * not-a-person thing they do — anyone actually beside you would have said
 * "you've read that bit three times now" on the third.
 *
 * This is that missing half: not what is on screen, but what the reader is
 * doing with it. Going back, lingering, running the same beat again.
 *
 * Deliberately tiny and framework-free. It is a session's worth of counting —
 * not persisted, because "you have read this before" across months is a
 * different and much creepier claim than "you just read that twice".
 */

export interface Pace {
  /** Times this passage has begun revealing, this session. 1 on a first read. */
  visits: number;
  /** They arrived here from LATER in the story — they went back. */
  wentBack: boolean;
  /** How far they jumped to get here, in passages. Negative is backwards. */
  jump: number;
}

let visits = new Map<string, number>();
let lastOrder: number | null = null;

/**
 * Record that a passage has started, and say how the reader got here.
 *
 * `order` is the passage's index in the flattened story, which is what makes
 * "backwards" answerable at all — message ids say nothing about sequence.
 */
export const notePassage = (id: string, order: number): Pace => {
  const seen = (visits.get(id) ?? 0) + 1;
  visits.set(id, seen);
  const jump = lastOrder === null ? 0 : order - lastOrder;
  lastOrder = order;
  return { visits: seen, wentBack: jump < 0, jump };
};

/** Start again — a different story, or the feature being switched off. */
export const resetPace = (): void => {
  visits = new Map();
  lastOrder = null;
};

/**
 * The pace, as something a person could remark on. `undefined` when there is
 * nothing worth remarking on, which is most of the time.
 *
 * Only the shapes a companion would actually notice. A single step forward is
 * "reading", and telling a model about it would invite it to comment on the
 * reader simply reading, which is the failure mode this has to avoid: someone
 * who narrates your behaviour back at you is not company, they are a nuisance.
 */
export const paceNote = (p: Pace): string | undefined => {
  const notes: string[] = [];
  if (p.visits === 2) notes.push('They have just gone over this passage a second time.');
  else if (p.visits >= 3) {
    notes.push(`They have now read this same passage ${p.visits} times.`);
  }
  if (p.wentBack) {
    notes.push(p.jump <= -3
      ? 'They jumped back from much later in the story to re-read this.'
      : 'They just went back a passage to read this again.');
  }
  return notes.length ? notes.join(' ') : undefined;
};
