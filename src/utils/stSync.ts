/**
 * Two-way sync with a SillyTavern chat file.
 *
 * The reader hands us the `.jsonl` as it stands on disk now; we hand one back
 * with their Lens edits written into it. In between, the two versions are
 * aligned so that messages ST has gained since the import come IN, edits made
 * here go OUT, and anything both sides touched is put to the reader rather than
 * resolved behind their back.
 *
 * Three decisions carry this file.
 *
 * **The file is the source of truth for everything we do not model.** Our
 * parser keeps six fields per message and throws away `send_date`, `swipe_id`,
 * `swipe_info`, `gen_started`, the rest of `extra`, `force_avatar`, and the
 * whole metadata header beyond two names — so a chat rebuilt from our `Story`
 * would load into ST having quietly lost its history. Nothing here rebuilds
 * anything. A line we did not edit is emitted as the ORIGINAL STRING, byte for
 * byte; only a line whose `mes` actually changed is re-serialised. That also
 * means we never have to keep raw lines in IndexedDB: the reader supplies the
 * file at sync time, which they are doing anyway to pull.
 *
 * **`Message.content` is the version we imported, and that is what makes a
 * three-way comparison possible.** The Lens layer is an overlay held apart in
 * `overridesByStory`, so at any moment we have both the original and the
 * reader's version of every message. With ST's current version that is three
 * sides — enough to tell "they changed it" from "we changed it" without
 * storing any sync state at all.
 *
 * **Alignment is positional with a bounded resync.** ST appends, re-swipes in
 * place, and rewinds; it does not usually splice. So walking both sides
 * together and looking a few messages ahead to recover from an insertion or a
 * deletion handles what really happens, and does it in linear time. A full diff
 * would be more general and would also happily "match" two unrelated messages
 * across a fifty-message gap, which in a chat log is worse than admitting
 * defeat.
 *
 * Pure: no store, no React, no DOM, no fetch.
 */

/* ------------------------------------------------------------------ */
/* Reading the file without losing it                                  */
/* ------------------------------------------------------------------ */

export interface StLine {
  /** Position among the file's non-empty lines. */
  index: number;
  /** Exactly as read. Emitted verbatim wherever the line is not edited. */
  raw: string;
  /** Parsed object, or null when the line was not JSON. */
  obj: Record<string, unknown> | null;
  /** The header line ST puts first: no `mes`. */
  isHeader: boolean;
  /** `mes`, for a message line. */
  mes: string;
  /** ST's own "this is hidden/narration" flags, preserved for display. */
  isUser: boolean;
  name: string;
}

/**
 * Split a chat file into lines, keeping each one's text.
 *
 * Blank lines are dropped (ST tolerates them and they carry nothing) but an
 * unparseable line is KEPT, with `obj: null` — it is somebody's data even if we
 * cannot read it, and dropping it on the way out would be the exact silent loss
 * this module exists to avoid.
 */
export const parseStFile = (text: string): StLine[] => {
  const out: StLine[] = [];
  for (const raw of (text ?? '').split('\n')) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown> | null = null;
    try {
      const p = JSON.parse(raw);
      obj = p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : null;
    } catch { obj = null; }
    const mes = obj && typeof obj.mes === 'string' ? obj.mes : '';
    out.push({
      index: out.length,
      raw,
      obj,
      isHeader: !!obj && obj.mes === undefined,
      mes,
      isUser: !!obj?.is_user,
      name: typeof obj?.name === 'string' ? obj.name : '',
    });
  }
  return out;
};

/**
 * The message lines, in order — the ones an alignment can pair up.
 *
 * Mirrors the import filter in `parser.ts` exactly: a line with no text and no
 * images is not a message there, so it must not be one here either, or every
 * index after the first empty entry is off by one and the whole alignment
 * walks a message behind.
 */
export const messageLines = (lines: readonly StLine[]): StLine[] =>
  lines.filter(l => l.obj && !l.isHeader && (l.mes.trim().length > 0 || hasImages(l.obj)));

const hasImages = (obj: Record<string, unknown>): boolean => {
  const extra = obj.extra as Record<string, unknown> | undefined;
  if (!extra) return false;
  return typeof extra.image === 'string'
    || (Array.isArray(extra.image_swipes) && extra.image_swipes.length > 0);
};

/* ------------------------------------------------------------------ */
/* Aligning the two sides                                              */
/* ------------------------------------------------------------------ */

/** One of our messages, reduced to what a sync needs to know. */
export interface OurMessage {
  id: string;
  /** What we imported. The common ancestor of both sides. */
  original: string;
  /** What the reader reads now — the Lens overlay applied, or `original`. */
  current: string;
  name: string;
}

/**
 * Write text into an ST message line, keeping the line self-consistent.
 *
 * ST stores the shown text twice: in `mes`, and in `swipes[swipe_id]`. It loads
 * from `mes` and it re-reads from `swipes` the moment anyone swipes away and
 * back — so a patch that touches only `mes` looks perfect until the reader
 * presses the arrow twice, and then the edit is simply gone. That is the worst
 * class of bug this feature could ship: silent, delayed, and indistinguishable
 * from the sync never having run.
 *
 * Two cases, and the difference matters:
 *
 * - The text IS one of the existing alternates. That is a swipe choice, so
 *   `swipe_id` moves to it and every alternate is left untouched — which is
 *   exactly the operation SillyTavern will not perform on a message that is not
 *   the last one in the chat.
 * - The text is new (a Lens rewrite). `mes` and the CURRENT slot of `swipes`
 *   move together; the other alternates are left alone, so nothing the model
 *   ever generated is destroyed.
 */
export const patchLine = (
  obj: Readonly<Record<string, unknown>>, text: string,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...obj, mes: text };
  const swipes = Array.isArray(obj.swipes) ? [...(obj.swipes as unknown[])] : null;
  if (!swipes || !swipes.length) return next;

  const found = swipes.indexOf(text);
  if (found !== -1) {
    next.swipe_id = found;
    return next;
  }

  const at = typeof obj.swipe_id === 'number' && obj.swipe_id >= 0 && obj.swipe_id < swipes.length
    ? obj.swipe_id
    : 0;
  swipes[at] = text;
  next.swipes = swipes;
  return next;
};

export type SyncStatus =
  /** Both sides agree, and nobody has edited it. */
  | 'same'
  /** We have a Lens edit; ST still has what we imported. It goes out. */
  | 'ours'
  /** ST changed it (a re-swipe, an edit); we have not. It comes in. */
  | 'theirs'
  /** Both changed it, differently. The reader decides. */
  | 'conflict'
  /** Already in sync: ST has our edit, from an earlier push. */
  | 'pushed'
  /** ST has a message we have never seen. It comes in. */
  | 'added-there'
  /** We have a message ST no longer does — a rewind, or a delete. */
  | 'missing-there';

export interface SyncRow {
  status: SyncStatus;
  /** Our message, when the row has one. */
  ours?: OurMessage;
  /** The file's line, when the row has one. */
  theirs?: StLine;
  /** Reader's choice on a conflict; unset until they pick. */
  resolution?: 'ours' | 'theirs';
}

/** How far ahead to look when the two sides fall out of step. */
export const RESYNC_WINDOW = 8;

const classify = (ours: OurMessage, theirs: StLine): SyncStatus => {
  const weEdited = ours.current !== ours.original;
  const theyDiffer = theirs.mes !== ours.original;
  if (!theyDiffer) return weEdited ? 'ours' : 'same';
  // They differ from the import. If they now match what WE read, an earlier
  // push already landed — that is agreement, not a conflict, and calling it one
  // would make every synced message a decision on the next run.
  if (theirs.mes === ours.current) return 'pushed';
  return weEdited ? 'conflict' : 'theirs';
};

/**
 * Pair our messages against the file's, in order.
 *
 * Walks both together. When the pair disagrees it looks ahead on each side for
 * the other's ORIGINAL text: finding ours further along means ST inserted, and
 * finding theirs further along means ST deleted. Only the original is ever
 * matched on — matching on the Lens version would let an edit that happens to
 * equal a later message drag the alignment onto it.
 */
export const alignSync = (
  ourMessages: readonly OurMessage[],
  theirLines: readonly StLine[],
  window = RESYNC_WINDOW,
): SyncRow[] => {
  const theirs = messageLines(theirLines);
  const rows: SyncRow[] = [];
  let i = 0;
  let j = 0;

  while (i < ourMessages.length && j < theirs.length) {
    const a = ourMessages[i];
    const b = theirs[j];
    if (b.mes === a.original || sameEnough(a, b)) {
      rows.push({ status: classify(a, b), ours: a, theirs: b });
      i++; j++;
      continue;
    }

    // Out of step. Which side gained something?
    const foundAhead = theirs.slice(j + 1, j + 1 + window).findIndex(l => l.mes === a.original);
    const oursAhead = ourMessages.slice(i + 1, i + 1 + window).findIndex(m => m.original === b.mes);

    if (foundAhead !== -1 && (oursAhead === -1 || foundAhead <= oursAhead)) {
      // ST has messages we do not, sitting before ours resumes.
      for (let k = 0; k <= foundAhead; k++) rows.push({ status: 'added-there', theirs: theirs[j + k] });
      j += foundAhead + 1;
      continue;
    }
    if (oursAhead !== -1) {
      // ST dropped messages we still hold.
      for (let k = 0; k <= oursAhead; k++) rows.push({ status: 'missing-there', ours: ourMessages[i + k] });
      i += oursAhead + 1;
      continue;
    }

    // Neither side resynced inside the window: treat this position as a
    // straight edit rather than guessing at a splice we cannot see the end of.
    rows.push({ status: classify(a, b), ours: a, theirs: b });
    i++; j++;
  }

  for (; j < theirs.length; j++) rows.push({ status: 'added-there', theirs: theirs[j] });
  for (; i < ourMessages.length; i++) rows.push({ status: 'missing-there', ours: ourMessages[i] });
  return rows;
};

/**
 * A cheap tolerance for the whitespace a round trip through two apps adds.
 *
 * Only ever used to decide that two messages are the SAME position — never to
 * decide their content is equal, which is why `classify` still compares
 * exactly. Without it a trailing newline somebody's editor added desynchronises
 * the whole file.
 */
const sameEnough = (a: OurMessage, b: StLine): boolean =>
  a.original.trim() === b.mes.trim() && a.original.trim().length > 0;

/* ------------------------------------------------------------------ */
/* Writing the file back                                               */
/* ------------------------------------------------------------------ */

export interface MergeResult {
  /** The file to hand back, ready to write. */
  text: string;
  /** Lines whose `mes` we rewrote. */
  patched: number;
  /** Conflicts still awaiting a decision — a merge refuses while any remain. */
  unresolved: number;
  /** Messages ST has that we should pull in. */
  incoming: number;
}

/**
 * Rebuild the file with our edits in it.
 *
 * Only lines that actually change are re-serialised; every other line — header,
 * untouched message, unparseable junk — is emitted as the string we read. That
 * is what makes this safe to point at a real chat: the bytes we do not
 * understand come out exactly as they went in.
 */
export const mergeToFile = (
  lines: readonly StLine[],
  rows: readonly SyncRow[],
): MergeResult => {
  const patch = new Map<number, string>();
  let unresolved = 0;
  let incoming = 0;

  for (const row of rows) {
    if (row.status === 'added-there') { incoming++; continue; }
    if (row.status === 'conflict' && !row.resolution) { unresolved++; continue; }
    if (!row.ours || !row.theirs) continue;
    const take = row.status === 'ours'
      || (row.status === 'conflict' && row.resolution === 'ours');
    if (take && row.theirs.mes !== row.ours.current) {
      patch.set(row.theirs.index, row.ours.current);
    }
    if (row.status === 'theirs' || (row.status === 'conflict' && row.resolution === 'theirs')) {
      incoming++;
    }
  }

  const out = lines.map(line => {
    const next = patch.get(line.index);
    if (next === undefined || !line.obj) return line.raw;
    // Key order is insertion order in JS, and this object came from
    // JSON.parse of the original, so the shape ST wrote is the shape it
    // gets back. `patchLine` keeps `mes` and `swipes` agreeing.
    return JSON.stringify(patchLine(line.obj, next));
  });

  return {
    // ST's own writer ends the file with a newline; matching it keeps a diff
    // against the original to just the lines that changed.
    text: `${out.join('\n')}\n`,
    patched: patch.size,
    unresolved,
    incoming,
  };
};

/* ------------------------------------------------------------------ */
/* Telling the reader what they are about to do                        */
/* ------------------------------------------------------------------ */

export interface SyncSummary {
  same: number;
  ours: number;
  theirs: number;
  conflict: number;
  pushed: number;
  addedThere: number;
  missingThere: number;
  /** Nothing to do in either direction. */
  clean: boolean;
}

export const summarize = (rows: readonly SyncRow[]): SyncSummary => {
  const n = (s: SyncStatus) => rows.filter(r => r.status === s).length;
  const s: SyncSummary = {
    same: n('same'),
    ours: n('ours'),
    theirs: n('theirs'),
    conflict: n('conflict'),
    pushed: n('pushed'),
    addedThere: n('added-there'),
    missingThere: n('missing-there'),
    clean: false,
  };
  s.clean = s.ours + s.theirs + s.conflict + s.addedThere === 0;
  return s;
};

/**
 * Does this file even belong to this story?
 *
 * Syncing the wrong chat is the one mistake here with no undo — it would offer
 * to write a stranger's messages over the reader's. Agreement on the opening
 * stretch is the test, because that is the part two versions of the same chat
 * always share however far they have diverged since.
 */
export const looksLikeSameChat = (rows: readonly SyncRow[], need = 3): boolean => {
  const paired = rows.filter(r => r.ours && r.theirs);
  if (!paired.length) return false;
  const anchored = paired.filter(
    r => r.status === 'same' || r.status === 'ours' || r.status === 'pushed',
  ).length;
  return anchored >= Math.min(need, paired.length);
};
