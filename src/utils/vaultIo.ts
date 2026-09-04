/**
 * Reading every database out, and putting one back.
 *
 * `vault.ts` decides the format; this is the part that touches the six
 * IndexedDB databases and localStorage. Kept apart so the format has tests and
 * this has one job.
 *
 * ── The list of places the reader's work lives ─────────────────────────────
 *
 * This is the only file in the app that has to know all of them, which makes it
 * the one place a new store can be forgotten. If you add a database, add it
 * here, or the next backup will silently omit it — and nobody finds out until
 * a restore.
 *
 *   aura-reader             stories, with their messages and highlights
 *   aura-reader-v2          notes, pins, sheets, codex, Lens edits, crossings
 *   aura-reader-art         generated scene images
 *   aura-reader-fonts       fonts the reader added
 *   aura-reader-sprites     character sprites the reader added
 *   aura-reader-backdrops   backdrops the reader added
 *   localStorage            settings
 *
 * ── Memory ─────────────────────────────────────────────────────────────────
 *
 * A library with art runs to hundreds of megabytes. Two things keep that from
 * killing the tab: records are encoded one at a time into an array of strings
 * that `new Blob()` consumes without ever concatenating them, and a media
 * record's bytes are released as soon as its line is pushed. Nothing here
 * builds a whole-library string, which is the thing that cannot be done.
 */

import {
  getAllArt, putArt, type StoredArt,
} from '../lib/artStorage';
import {
  getAllBackdrops, putBackdrop, type StoredBackdrop,
} from '../lib/backdropStorage';
import { getAllFonts, putFont, type StoredFont } from '../lib/fontStorage';
import { getAllSprites, putSprite, type StoredSprite } from '../lib/spriteStorage';
import { getAllStoryMetas, getStory, putStory } from '../lib/storage';
import { applyOps, getAllV2Records } from '../lib/v2Storage';
import type { Story } from '../types';
import { alertSaveFailed } from './alerts';
import {
  encodeLine, makeHeader, vaultFilename,
  type MediaKind, type RestorePlan, type VaultLine,
} from './vault';

/** The localStorage key the settings store persists under. */
const SETTINGS_KEY = 'aura-reader-settings';

/* ------------------------------------------------------------------ */
/* Bytes ⇄ text                                                        */
/* ------------------------------------------------------------------ */

/**
 * base64 without blowing the stack.
 *
 * `String.fromCharCode(...bytes)` is the one-liner everyone reaches for and it
 * throws on anything over ~100KB — every argument becomes a stack slot. Scene
 * art is measured in megabytes, so it is chunked.
 */
const CHUNK = 0x8000;

export const bytesToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

export const base64ToBytes = (text: string): ArrayBuffer => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/* ------------------------------------------------------------------ */
/* Measuring, before committing to anything                            */
/* ------------------------------------------------------------------ */

export interface VaultEstimate {
  stories: number;
  slices: number;
  media: number;
  /** Bytes of media, before base64 — the number worth showing. */
  mediaBytes: number;
  /** Bytes of media that could be regenerated (scene art). */
  artBytes: number;
}

/**
 * What a backup would contain, and roughly how big.
 *
 * Reads only the metadata and the byte lengths, never assembling anything, so
 * the panel can show real numbers before the reader chooses whether to include
 * images.
 */
export const estimateVault = async (): Promise<VaultEstimate> => {
  const [metas, records, art, fonts, sprites, backdrops] = await Promise.all([
    getAllStoryMetas(), getAllV2Records(), getAllArt(), getAllFonts(),
    getAllSprites(), getAllBackdrops(),
  ]);

  const size = (rows: { data: ArrayBuffer }[]) =>
    rows.reduce((n, r) => n + (r.data?.byteLength ?? 0), 0);

  const artBytes = size(art);
  return {
    stories: metas.length,
    slices: records.length,
    media: art.length + fonts.length + sprites.length + backdrops.length,
    mediaBytes: artBytes + size(fonts) + size(sprites) + size(backdrops),
    artBytes,
  };
};

/* ------------------------------------------------------------------ */
/* Writing one                                                         */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  /**
   * Include generated scene art. Fonts, sprites and backdrops go in
   * regardless — see `REGENERABLE_MEDIA` in `vault.ts` for why the choice is
   * offered over art alone.
   */
  includeArt: boolean;
  /** Called with a 0..1 fraction, for a progress bar on a slow library. */
  onProgress?: (done: number, total: number) => void;
}

const mediaLine = (
  media: MediaKind,
  row: { id: string; data: ArrayBuffer; type?: string },
): VaultLine => {
  const { data, ...meta } = row as Record<string, unknown> & { data: ArrayBuffer };
  return {
    kind: 'media',
    media,
    id: row.id,
    meta,
    mime: typeof row.type === 'string' ? row.type : 'application/octet-stream',
    data: bytesToBase64(data),
  };
};

/**
 * Build the whole vault as a Blob.
 *
 * Stories are fetched one at a time rather than all at once: `getAllStoryMetas`
 * is cheap, but the full stories with all their messages are not, and holding
 * four hundred of them alongside the strings they encode into is how a backup
 * runs a device out of memory while trying to protect it.
 */
export const buildVault = async (opts: BuildOptions): Promise<Blob> => {
  const parts: string[] = [];
  const metas = await getAllStoryMetas();
  const records = await getAllV2Records();

  const art = opts.includeArt ? await getAllArt() : [];
  const fonts = await getAllFonts();
  const sprites = await getAllSprites();
  const backdrops = await getAllBackdrops();

  const mediaCount = art.length + fonts.length + sprites.length + backdrops.length;
  const total = metas.length + records.length + mediaCount + 2;
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);

  parts.push(encodeLine({
    kind: 'header',
    header: makeHeader(
      { stories: metas.length, slices: records.length, media: mediaCount },
      opts.includeArt,
    ),
  }));
  tick();

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) parts.push(encodeLine({ kind: 'settings', value: JSON.parse(raw) }));
  } catch { /* settings are a convenience; a backup without them is still a backup */ }
  tick();

  for (const meta of metas) {
    const full = await getStory(meta.id);
    // A meta with no story behind it is a torn write from some earlier crash.
    // Skipping it is right — there is nothing to back up — and it must not
    // stop the run.
    if (full) parts.push(encodeLine({ kind: 'story', value: full }));
    tick();
  }

  for (const record of records) {
    parts.push(encodeLine({ kind: 'slice', id: record.id, value: record.value }));
    tick();
  }

  const media: [MediaKind, { id: string; data: ArrayBuffer; type?: string }[]][] = [
    ['art', art], ['font', fonts], ['sprite', sprites], ['backdrop', backdrops],
  ];
  for (const [kind, rows] of media) {
    for (const row of rows) {
      parts.push(encodeLine(mediaLine(kind, row)));
      tick();
    }
  }

  return new Blob(parts, { type: 'application/x-ndjson' });
};

/** Hand the vault to the reader as a download. */
export const saveVault = (blob: Blob, at = Date.now()): string => {
  const name = vaultFilename(at);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on a turn of the loop: revoking synchronously can beat the download
  // starting in some browsers, and the file arrives empty.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
};

/* ------------------------------------------------------------------ */
/* Reading one                                                         */
/* ------------------------------------------------------------------ */

/** The ids this library already holds — what `planRestore` compares against. */
export const existingStoryIds = async (): Promise<Set<string>> =>
  new Set((await getAllStoryMetas()).map(m => m.id));

export interface RestoreResult {
  stories: number;
  slices: number;
  media: number;
  settings: boolean;
  /** Records that would not write, with a reason each. */
  failed: { what: string; reason: string }[];
}

const rebuildMedia = (line: Extract<VaultLine, { kind: 'media' }>) => ({
  ...line.meta,
  id: line.id,
  type: line.mime,
  data: base64ToBytes(line.data),
});

/**
 * Commit a plan.
 *
 * ── Two decisions about failure ────────────────────────────────────────────
 *
 * **It does not stop at the first error.** A restore is what someone does after
 * losing things, and giving up nine records into four thousand because one of
 * them will not write would be a cruel way to fail. Every failure is collected
 * and reported instead.
 *
 * **Stories are written first, on purpose.** Slices and media are keyed by
 * story id and mean nothing without the story; a story reads perfectly well
 * without them. So if a restore is interrupted halfway — the tab closes, the
 * disk fills — what survives is whole stories missing some annotations, rather
 * than annotations belonging to nothing.
 */
export const applyRestore = async (
  plan: RestorePlan,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreResult> => {
  const result: RestoreResult = { stories: 0, slices: 0, media: 0, settings: false, failed: [] };

  const stories: Story[] = [...plan.added, ...plan.overwritten];
  const total = stories.length + plan.slices.length + plan.media.length + 1;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  for (const story of stories) {
    try {
      await putStory(story);
      result.stories++;
    } catch (e: any) {
      result.failed.push({ what: `story “${story.title}”`, reason: String(e?.message ?? e) });
    }
    tick();
  }

  // One transaction for the slices — the same call the store itself uses, so a
  // restored record is indistinguishable from one written normally.
  if (plan.slices.length) {
    try {
      await applyOps(plan.slices.map(s => ({ op: 'put' as const, id: s.id, value: s.value })));
      result.slices = plan.slices.length;
    } catch (e: any) {
      result.failed.push({ what: 'notes, pins and edits', reason: String(e?.message ?? e) });
    }
  }
  done += plan.slices.length;
  onProgress?.(done, total);

  for (const line of plan.media) {
    try {
      const row = rebuildMedia(line);
      if (line.media === 'art') await putArt(row as unknown as StoredArt);
      else if (line.media === 'font') await putFont(row as unknown as StoredFont);
      else if (line.media === 'sprite') await putSprite(row as unknown as StoredSprite);
      else await putBackdrop(row as unknown as StoredBackdrop);
      result.media++;
    } catch (e: any) {
      result.failed.push({ what: `${line.media} ${line.id}`, reason: String(e?.message ?? e) });
    }
    tick();
  }

  if (plan.settings !== undefined) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(plan.settings));
      result.settings = true;
    } catch (e: any) {
      result.failed.push({ what: 'settings', reason: String(e?.message ?? e) });
    }
  }
  tick();

  // One alert, not one per failure — the collapse key in `alerts.ts` would
  // handle a flood, but there is no reason to make it.
  if (result.failed.length) {
    alertSaveFailed(`${result.failed.length} item${result.failed.length === 1 ? '' : 's'} `
      + 'from the vault');
  }

  return result;
};

