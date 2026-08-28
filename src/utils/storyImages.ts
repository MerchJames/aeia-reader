/**
 * The pictures belonging to a passage.
 *
 * A story carries images two ways and they are not interchangeable:
 *
 *   · **attached** — `Message.images`, which is where SillyTavern and Kobold put
 *     a generated or pasted picture
 *   · **inline** — a markdown `![](…)` the writer put in the prose itself
 *
 * Stage and VN each had their own copy of the walk that finds both, and neither
 * knew about the third source that arrived later: art the reader generated for a
 * beat, which lives in `artByStory` and has to be resolved from IndexedDB first.
 * Four more views then needed the same thing. So it lives here once.
 *
 * Pure: no DOM, no store, no React. Generated art arrives already resolved to
 * URLs, because resolving it is async and belongs to a hook.
 */

/**
 * A markdown image in the prose.
 *
 * Two regexes, deliberately. `matchAll` needs the global flag, and `test` on a
 * global regex advances `lastIndex` and answers differently the second time it
 * is asked — which in a render path means a passage that has a picture reports
 * that it does not, on every other render, forever. One flag per job.
 */
const INLINE_IMG_ALL = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const INLINE_IMG = /!\[[^\]]*\]\(([^)\s]+)\)/;

export interface ImageSource {
  images?: string[];
  content: string;
}

/**
 * Every picture in one passage, attached first then inline.
 *
 * Attached first because that is the order they were added in: a picture
 * attached to the message is the one the model or the reader produced FOR it,
 * while an inline one is part of the prose and reads in its place.
 */
export const imagesOf = (m: ImageSource, generated?: string[]): string[] => {
  const inline = [...m.content.matchAll(INLINE_IMG_ALL)].map(match => match[1]);
  const all = [...(m.images ?? []), ...inline, ...(generated ?? [])];
  // The same URL twice is one picture. It happens: an inline image the reader
  // also attached, or a re-roll that produced an identical blob URL.
  return [...new Set(all.filter(Boolean))];
};

/** True when a passage has anything to show. Cheap enough for a render path. */
export const hasImage = (m: ImageSource, generated?: string[]): boolean =>
  !!(m.images?.length || generated?.length || INLINE_IMG.test(m.content));

/**
 * The pictures from the LAST passage in a run that has any.
 *
 * The rule Stage and VN already follow, written down: a scene image stays on
 * screen until a newer one replaces it, rather than blinking out on every
 * passage that happens not to have one. A backdrop that vanishes between two
 * lines of dialogue reads as a bug, not as an absence.
 */
export const latestImages = <T extends ImageSource>(
  timeline: T[],
  generatedFor?: (m: T) => string[] | undefined,
): string[] => {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const imgs = imagesOf(timeline[i], generatedFor?.(timeline[i]));
    if (imgs.length) return imgs;
  }
  return [];
};

/** Every picture across a run, in reading order, deduped. */
export const imagesAcross = <T extends ImageSource>(
  timeline: T[],
  generatedFor?: (m: T) => string[] | undefined,
): string[] => {
  const out: string[] = [];
  for (const m of timeline) {
    for (const src of imagesOf(m, generatedFor?.(m))) {
      if (!out.includes(src)) out.push(src);
    }
  }
  return out;
};
