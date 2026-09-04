/**
 * What changed between two versions of a passage.
 *
 * Written for the Lens preview: before a rewrite goes into the reader's story
 * they get to see it, and "see it" has to mean *see the change*, not read two
 * paragraphs side by side and hunt for the difference. A model asked to "make
 * her sound colder" will hand back a passage that is ninety percent identical,
 * and the ten percent is the entire decision.
 *
 * Word-level, because that is the grain a revision happens at. Line-level would
 * mark a whole paragraph changed for one swapped adjective.
 *
 * ── The property that makes it safe to render ──────────────────────────────
 *
 * Joining the parts reconstructs the inputs EXACTLY:
 *
 *     parts.filter(p => p.type !== 'add').map(p => p.text).join('') === before
 *     parts.filter(p => p.type !== 'del').map(p => p.text).join('') === after
 *
 * Whitespace travels attached to its word rather than as tokens of its own, so
 * there is no way for the diff to lose a newline or double a space and quietly
 * show the reader a passage that is not the one they are about to approve. Both
 * directions are asserted in the tests on every case.
 *
 * Pure: no store, no React, no DOM.
 */

export type DiffType = 'same' | 'add' | 'del';

export interface DiffPart {
  type: DiffType;
  /** What to RENDER. For a match this is the `after` spelling — the one being adopted. */
  text: string;
  /**
   * The `before` spelling of a matched run, present only when it differs — which
   * means: only when the whitespace differs, since the words are equal by
   * definition.
   *
   * It exists because the reconstruction guarantee has two halves and they
   * disagree here. A model that reflows a paragraph gives `"He waited.\n"` and
   * `"He waited.\n\n"` for the same word: emitting either one alone makes the
   * other half of the guarantee false, and the test caught it doing exactly
   * that. So a match keeps both spellings, renders the new one, and can still
   * rebuild the old one character for character.
   */
  was?: string;
}

/** BEFORE, rebuilt from the parts — matches in their original spelling. */
export const rebuildBefore = (parts: readonly DiffPart[]): string =>
  parts.filter(p => p.type !== 'add').map(p => p.was ?? p.text).join('');

/** AFTER, rebuilt from the parts. */
export const rebuildAfter = (parts: readonly DiffPart[]): string =>
  parts.filter(p => p.type !== 'del').map(p => p.text).join('');

/**
 * Split into comparable units, each carrying the whitespace that FOLLOWS it.
 *
 * Trailing rather than leading: a word and the space after it move together, so
 * deleting the last word of a sentence takes its space with it instead of
 * leaving a gap before the full stop.
 */
export const tokenize = (text: string): string[] => {
  const out: string[] = [];
  const re = /\s*\S+\s*/g;
  // Leading whitespace belongs to nothing, so it is its own token — otherwise a
  // passage that starts with a blank line would lose it on reconstruction.
  const lead = /^\s+/.exec(text);
  let from = 0;
  if (lead && lead[0].length && /\S/.test(text)) {
    out.push(lead[0]);
    from = lead[0].length;
  }
  const body = text.slice(from);
  if (!/\S/.test(body)) {
    if (body) out.push(body);
    return out;
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  const inner = /\S+\s*/g;
  while ((m = inner.exec(body)) !== null) out.push(m[0]);
  return out;
};

/** The key a token is matched on: whitespace runs differ, words do not. */
const key = (tok: string): string => tok.trim();

/**
 * Beyond this many DP cells the exact diff is abandoned for a paragraph-level
 * one. A message is a few hundred words and lands nowhere near it; a whole pin
 * pasted against another whole pin would be tens of millions of cells and would
 * lock the tab, which is not a trade worth making for a preview.
 */
export const MAX_CELLS = 1_200_000;

/** Longest common subsequence table walk — the classic, on trimmed input. */
const lcsDiff = (a: string[], b: string[]): DiffPart[] => {
  const n = a.length;
  const m = b.length;
  // One row at a time would be enough for the LENGTH, but the walk back needs
  // the whole table, so this is where MAX_CELLS earns its keep.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(a[i]) === key(b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      // Same word, possibly different spacing. Render the AFTER spelling, keep
      // the BEFORE one so the passage can still be rebuilt from the parts.
      out.push(a[i] === b[j]
        ? { type: 'same', text: b[j] }
        : { type: 'same', text: b[j], was: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
};

/** Merge neighbouring parts of the same type so the render is not a word soup. */
const coalesce = (parts: DiffPart[]): DiffPart[] => {
  const out: DiffPart[] = [];
  for (const p of parts) {
    if (!p.text && !p.was) continue;
    const last = out[out.length - 1];
    if (last && last.type === p.type) {
      // Both spellings have to be carried across the merge, or a run that
      // happens to contain a reflow loses it and BEFORE no longer rebuilds.
      const lastWas = last.was ?? last.text;
      const pWas = p.was ?? p.text;
      last.text += p.text;
      if (lastWas + pWas !== last.text) last.was = lastWas + pWas;
      else delete last.was;
    } else out.push({ ...p });
  }
  return out;
};

/**
 * Word-level difference from `before` to `after`.
 *
 * Common prefix and suffix are trimmed before the table is built. On a revision
 * that touches one clause this is most of the passage, and it is what keeps a
 * long message well inside `MAX_CELLS`.
 */
export const diffWords = (before: string, after: string): DiffPart[] => {
  if (before === after) return before ? [{ type: 'same', text: before }] : [];
  if (!before) return after ? [{ type: 'add', text: after }] : [];
  if (!after) return [{ type: 'del', text: before }];

  const a = tokenize(before);
  const b = tokenize(after);

  let head = 0;
  while (head < a.length && head < b.length && key(a[head]) === key(b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && key(a[a.length - 1 - tail]) === key(b[b.length - 1 - tail])
  ) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  // Prefix and suffix are matches, so they follow the same rule as any other:
  // rendered in the AFTER spelling, carrying the BEFORE one when they differ.
  const matched = (aPart: string, bPart: string): DiffPart[] =>
    (bPart || aPart)
      ? [aPart === bPart
          ? { type: 'same', text: bPart }
          : { type: 'same', text: bPart, was: aPart }]
      : [];
  const pre = matched(a.slice(0, head).join(''), b.slice(0, head).join(''));
  const post = matched(a.slice(a.length - tail).join(''), b.slice(b.length - tail).join(''));

  const middle = (midA.length + 1) * (midB.length + 1) > MAX_CELLS
    ? diffParagraphs(midA.join(''), midB.join(''))
    : lcsDiff(midA, midB);

  return coalesce([...pre, ...middle, ...post]);
};

/**
 * The fallback for two texts too large to diff word by word: same algorithm, one
 * paragraph per unit. Coarse, but it still tells the reader WHERE to look, which
 * is more than "everything changed" does.
 */
export const diffParagraphs = (before: string, after: string): DiffPart[] => {
  const split = (t: string) => t.split(/(?<=\n)/);
  const a = split(before);
  const b = split(after);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    // Two enormous texts with no paragraph breaks. Nothing useful to say.
    return coalesce([{ type: 'del', text: before }, { type: 'add', text: after }]);
  }
  return lcsDiff(a, b);
};

/** How much of the passage actually moved, 0..1 — for a one-line "N% changed". */
export const changeRatio = (parts: readonly DiffPart[]): number => {
  let same = 0;
  let moved = 0;
  for (const p of parts) {
    const n = p.text.trim().length;
    if (p.type === 'same') same += n;
    else moved += n;
  }
  const total = same + moved;
  return total ? moved / total : 0;
};

/** Words added and removed — the count a review header shows. */
export const diffStats = (parts: readonly DiffPart[]): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    const words = p.text.trim() ? p.text.trim().split(/\s+/).length : 0;
    if (p.type === 'add') added += words;
    else if (p.type === 'del') removed += words;
  }
  return { added, removed };
};

/**
 * True when a "rewrite" is not one.
 *
 * A model handed a passage it has nothing to add to will echo it back, sometimes
 * with the whitespace reflowed. Applying that writes a Lens override that says
 * nothing, and the reader gets an edit badge on a message nobody edited — so the
 * comparison ignores whitespace entirely.
 */
export const isNoopChange = (before: string, after: string): boolean =>
  before.replace(/\s+/g, ' ').trim() === after.replace(/\s+/g, ' ').trim();
