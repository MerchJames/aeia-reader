/**
 * A backup of everything, and the rules for putting it back.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A single story exports as HTML, Markdown, an audiobook, or a Cut. The reader's
 * WORK — four hundred stories, and every highlight, note, pin, sheet, Lens edit,
 * codex entry and scene image attached to them — had no way out of the browser
 * at all. One cleared site-data, one evicted origin, one reinstalled OS, and
 * years of it were gone with no recovery path. That is the gap this closes.
 *
 * ── A vault is not a Cut ───────────────────────────────────────────────────
 *
 * `cut.ts` builds something to SEND someone: it names what may never travel
 * (`NEVER_IN_A_CUT`) and leaves it out. A vault is the opposite job — it is the
 * reader's own copy of their own device, and leaving anything out of it defeats
 * the point. So a vault contains everything, crossings and private notes
 * included, and is therefore **not a thing to share**. The UI says so and the
 * filename says so; this comment says so for whoever adds the next feature.
 *
 * ── Why JSON Lines ─────────────────────────────────────────────────────────
 *
 * The obvious format is one big JSON object. It does not work here. A library
 * with scene art runs to hundreds of megabytes, and `JSON.stringify` of that is
 * a single string past V8's limit — the tab dies while trying to save the
 * backup that was meant to protect it. One record per line means:
 *
 *   - the writer pushes strings into an array and hands them to `new Blob()`,
 *     never holding one giant string;
 *   - the reader handles a record at a time and can report progress;
 *   - a truncated file is still *partly* readable. Every complete line before
 *     the cut restores. A backup that fails halfway through writing is exactly
 *     when you most want that.
 *
 * ── What goes in a line ────────────────────────────────────────────────────
 *
 * What the databases hold, not a model derived from it. The v2 slices go in as
 * the literal `{id, value}` records `lib/v2Storage` reads and writes, so a
 * restore is a straight put and nothing this file failed to understand can be
 * lost in translation. Same reasoning as `stSync` emitting untouched lines.
 *
 * Pure: no IndexedDB, no store, no React, no Blob. The I/O is in `vaultIo.ts`.
 */

import type { Story } from '../types';

/** Recognises a vault before anything is parsed out of it. */
export const VAULT_MAGIC = 'aeia-vault';

/** Bump when the SHAPE changes. A reader refuses a version it postdates. */
export const VAULT_VERSION = 1;

export const VAULT_EXTENSION = '.aeia-vault.jsonl';

/** Binary stores, each its own IndexedDB database. */
export type MediaKind = 'art' | 'font' | 'sprite' | 'backdrop';
export const MEDIA_KINDS: readonly MediaKind[] = ['art', 'font', 'sprite', 'backdrop'];

/**
 * Which media the reader can get back by other means, and which they cannot.
 *
 * Scene art is generated: losing it costs time and API credit, and it can be
 * made again. Fonts, sprites and backdrops are files the reader chose and
 * added, and if the original is gone from their disk there is no making it
 * again. So the size-saving toggle in the UI is offered over art alone —
 * offering to drop the irreplaceable half to save space would be a trap.
 */
export const REGENERABLE_MEDIA: readonly MediaKind[] = ['art'];

export interface VaultHeader {
  magic: typeof VAULT_MAGIC;
  version: number;
  /** ms since epoch, for naming and for telling two vaults apart. */
  createdAt: number;
  /** What wrote it, for a support conversation later. */
  app: string;
  stories: number;
  slices: number;
  media: number;
  /** False when the reader chose to leave scene art out. */
  includesMedia: boolean;
}

export type VaultLine =
  | { kind: 'header'; header: VaultHeader }
  | { kind: 'settings'; value: unknown }
  | { kind: 'story'; value: Story }
  /** One `lib/v2Storage` record, verbatim. */
  | { kind: 'slice'; id: string; value: unknown }
  | {
    kind: 'media';
    media: MediaKind;
    id: string;
    /** The record's own fields minus the blob — storyId, name, emotion, … */
    meta: Record<string, unknown>;
    mime: string;
    /** base64, no data: prefix. */
    data: string;
  };

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export const makeHeader = (
  counts: { stories: number; slices: number; media: number },
  includesMedia: boolean,
  now = Date.now(),
): VaultHeader => ({
  magic: VAULT_MAGIC,
  version: VAULT_VERSION,
  createdAt: now,
  app: 'Aeia Reader',
  stories: counts.stories,
  slices: counts.slices,
  media: counts.media,
  includesMedia,
});

/**
 * One record as one line.
 *
 * The newline is part of what this returns, so a caller assembling a Blob does
 * not have to remember to add it — forgetting once would join two records into
 * one unparseable line and lose both.
 */
export const encodeLine = (line: VaultLine): string => `${JSON.stringify(line)}\n`;

/**
 * A filename that sorts by date and says what it is.
 *
 * Dated because a reader keeps several, and the one question they will have is
 * "which is the newest". `-` rather than `:` because Windows will not accept a
 * colon in a filename and silently fails the save.
 */
export const vaultFilename = (at = Date.now()): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}`;
  return `aeia-library-${stamp}${VAULT_EXTENSION}`;
};

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read one line, refusing anything malformed rather than throwing.
 *
 * A restore walks thousands of these. One bad line must cost that line and not
 * the run — a vault written by a browser that died mid-save is the case this
 * feature exists for, and aborting on the first damaged record would throw away
 * every good one after it.
 */
export const decodeLine = (text: string): { line?: VaultLine; error?: string } => {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'blank line' };

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { error: 'not JSON' }; }
  if (!isObj(parsed)) return { error: 'not a record' };

  switch (parsed.kind) {
    case 'header':
      return isObj(parsed.header)
        ? { line: parsed as VaultLine }
        : { error: 'header has no header' };
    case 'settings':
      return { line: parsed as VaultLine };
    case 'story':
      return isObj(parsed.value) && typeof parsed.value.id === 'string'
        ? { line: parsed as VaultLine }
        : { error: 'story has no id' };
    case 'slice':
      return typeof parsed.id === 'string' && parsed.id
        ? { line: parsed as VaultLine }
        : { error: 'slice has no id' };
    case 'media':
      if (typeof parsed.id !== 'string' || !parsed.id) return { error: 'media has no id' };
      if (typeof parsed.data !== 'string') return { error: 'media has no data' };
      if (!MEDIA_KINDS.includes(parsed.media as MediaKind)) return { error: 'unknown media kind' };
      return { line: parsed as VaultLine };
    default:
      // Forward compatibility: a later version may add kinds. Say so rather
      // than treating it as damage, so the count of "broken lines" a reader is
      // shown means what it says.
      return { error: `unknown record type "${String(parsed.kind)}"` };
  }
};

/**
 * Validate the first line before reading any of the rest.
 *
 * The version check is one-directional on purpose: an OLDER vault is readable
 * by a newer app and must stay so, because the whole point of a backup is that
 * it still works in two years. A NEWER one is refused, because silently
 * ignoring fields it does not understand would restore a partial library and
 * report success.
 */
export const readVaultHeader = (text: string): { header?: VaultHeader; error?: string } => {
  const { line, error } = decodeLine(text);
  if (error || !line) return { error: error ?? 'unreadable' };
  if (line.kind !== 'header') {
    return { error: 'This file does not start with a vault header — is it a different export?' };
  }
  const h = line.header;
  if (h.magic !== VAULT_MAGIC) return { error: 'Not an Aeia vault.' };
  if (typeof h.version !== 'number' || h.version < 1) return { error: 'Vault version is missing.' };
  if (h.version > VAULT_VERSION) {
    return {
      error: `This vault was written by a newer version of Aeia (format ${h.version}, `
        + `this build reads ${VAULT_VERSION}). Update Aeia and try again.`,
    };
  }
  return { header: h };
};

/* ------------------------------------------------------------------ */
/* Putting it back                                                     */
/* ------------------------------------------------------------------ */

/**
 * What to do about a story that is already here.
 *
 * `fill` is the default and the safe one: add what is missing, touch nothing
 * that exists. It is what a reader wants after losing *some* of their library,
 * and it cannot destroy work done since the backup was taken.
 *
 * `replace` overwrites a matching story with the backup's copy. It is what a
 * reader wants after a fresh install, and it is destructive — anything they did
 * to that story since the vault was written is gone. The UI names it plainly
 * and does not preselect it.
 *
 * Note what neither mode does: **delete**. A story here that is not in the
 * vault stays, under both. A restore is never a mirror.
 */
export type RestoreMode = 'fill' | 'replace';

export interface RestorePlan {
  /** Stories in the vault that this library does not have. */
  added: Story[];
  /** Stories in both. Written only when the mode is `replace`. */
  overwritten: Story[];
  /** Stories in both, left alone. Non-empty only when the mode is `fill`. */
  kept: number;
  slices: { id: string; value: unknown }[];
  media: Extract<VaultLine, { kind: 'media' }>[];
  settings?: unknown;
  /** Lines that could not be read, with a reason each. */
  damaged: { at: number; reason: string }[];
  mode: RestoreMode;
}

/**
 * Work out what a restore would do, without doing any of it.
 *
 * Takes decoded lines and the ids this library already holds. The panel shows
 * the counts, the reader presses the button, and only then does anything write
 * — so a vault can be opened, inspected and closed again having changed
 * nothing.
 */
export const planRestore = (
  lines: readonly { line?: VaultLine; error?: string }[],
  existingStoryIds: ReadonlySet<string>,
  mode: RestoreMode = 'fill',
): RestorePlan => {
  const plan: RestorePlan = {
    added: [], overwritten: [], kept: 0, slices: [], media: [], damaged: [], mode,
  };

  lines.forEach((entry, at) => {
    if (entry.error || !entry.line) {
      plan.damaged.push({ at, reason: entry.error ?? 'unreadable' });
      return;
    }
    const line = entry.line;
    switch (line.kind) {
      case 'header': break;
      case 'settings': plan.settings = line.value; break;
      case 'story':
        if (!existingStoryIds.has(line.value.id)) plan.added.push(line.value);
        else if (mode === 'replace') plan.overwritten.push(line.value);
        else plan.kept++;
        break;
      case 'slice': plan.slices.push({ id: line.id, value: line.value }); break;
      case 'media': plan.media.push(line); break;
    }
  });

  return plan;
};

/** Nothing to do — used to keep the button from being pressable for no reason. */
export const isEmptyPlan = (p: RestorePlan): boolean =>
  p.added.length === 0 && p.overwritten.length === 0
  && p.slices.length === 0 && p.media.length === 0;

/**
 * A sentence for the button that commits it.
 *
 * Leads with what changes and names what does not. A reader about to restore is
 * afraid of exactly one thing — that this will overwrite what they still have —
 * and the answer belongs in front of them, not in a help page.
 */
export const describeRestore = (p: RestorePlan): string => {
  if (isEmptyPlan(p)) return 'This vault holds nothing this library is missing.';

  const parts: string[] = [];
  if (p.added.length) parts.push(`add ${p.added.length} stor${p.added.length === 1 ? 'y' : 'ies'}`);
  if (p.overwritten.length) {
    parts.push(`OVERWRITE ${p.overwritten.length} you already have`);
  }
  if (p.slices.length) parts.push('restore your notes, pins and edits');
  if (p.media.length) parts.push(`${p.media.length} image${p.media.length === 1 ? '' : 's'} and files`);

  let s = `Will ${parts.join(', ')}.`;
  if (p.kept) {
    s += ` ${p.kept} stor${p.kept === 1 ? 'y' : 'ies'} already here will be left exactly as `
      + `${p.kept === 1 ? 'it is' : 'they are'}.`;
  }
  if (p.damaged.length) {
    s += ` ${p.damaged.length} record${p.damaged.length === 1 ? '' : 's'} in the file could not `
      + 'be read and will be skipped.';
  }
  return s;
};
