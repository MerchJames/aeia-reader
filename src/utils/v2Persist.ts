/**
 * What the v2 store persists, and how to work out the smallest write.
 *
 * The old layer re-serialized EVERY persisted slice — codex, overrides, sheets,
 * annotations, marks, pins, zones, threads, descriptors, sandbox treatments — as
 * one JSON blob on every `set()`, then wrote it to localStorage. A codex-scan
 * tick or a panel toggle paid for the whole library, and localStorage's ~5MB
 * ceiling failed by silently dropping the write.
 *
 * So: shard. Global slices are one record; per-story slices are one record PER
 * STORY, so writing a scene descriptor touches that story's descriptors and
 * nothing else. `diffSlices` works out which records actually changed, by
 * reference — which is exactly what an immutable store update gives us for free.
 *
 * Pure: no IndexedDB, no store, no React. The I/O lives in `lib/v2Storage.ts`.
 */

/**
 * Every persisted slice, and whether it is keyed by story id at the top level.
 *
 * Deliberately an explicit table rather than a `name.endsWith('ByStory')` rule:
 * a slice sharded the wrong way either writes the whole library on every keypress
 * (bad) or silently splits a global record per story (worse), and a naming
 * accident should not be able to cause either.
 */
export const PERSISTED_SLICES: readonly { slice: string; perStory: boolean }[] = [
  { slice: 'codexByStory', perStory: true },
  { slice: 'scanProgress', perStory: true },
  { slice: 'statsByStory', perStory: true },
  { slice: 'libraryTagsByStory', perStory: true },
  // Was in-memory only, so the "Previously…" card came back on every reload
  // of a story you had already dismissed it for.
  { slice: 'recapSeen', perStory: true },
  { slice: 'overridesByStory', perStory: true },
  { slice: 'lensOnByStory', perStory: true },
  { slice: 'sheetsByStory', perStory: true },
  { slice: 'annotationsByStory', perStory: true },
  { slice: 'sfxMarksByStory', perStory: true },
  { slice: 'artByStory', perStory: true },
  { slice: 'visitorsByStory', perStory: true },
  { slice: 'appearanceByStory', perStory: true },
  { slice: 'artSeedByStory', perStory: true },
  { slice: 'emphasisMarksByStory', perStory: true },
  { slice: 'performMarksByStory', perStory: true },
  { slice: 'pinsByStory', perStory: true },
  { slice: 'pinSetsByStory', perStory: true },
  { slice: 'activePinSetByStory', perStory: true },
  { slice: 'zonesByStory', perStory: true },
  { slice: 'chatThreadsByStory', perStory: true },
  { slice: 'activeThreadByStory', perStory: true },
  { slice: 'sceneByStory', perStory: true },
  { slice: 'storyReadByStory', perStory: true },
  { slice: 'sandboxByStory', perStory: true },
  { slice: 'sandboxEnabledByStory', perStory: true },
  { slice: 'sandboxPaletteByStory', perStory: true },
  { slice: 'sandboxCuesByStory', perStory: true },
  { slice: 'sandboxSceneByStory', perStory: true },
  { slice: 'sandboxGuidanceByStory', perStory: true },
  { slice: 'sandboxPacketByStory', perStory: true },
  { slice: 'askByStory', perStory: true },
  { slice: 'reactionsByStory', perStory: true },
  { slice: 'directorEnabledByStory', perStory: true },
  { slice: 'summaryPinByStory', perStory: true },
  // Story-keyed despite the names — `Record<storyId, StyleConfig[]>` and
  // `Record<storyId, SandboxActive>`.
  { slice: 'sandboxConfigs', perStory: true },
  { slice: 'sandboxActive', perStory: true },
  { slice: 'cowritePresets', perStory: false },
  { slice: 'codexEnabled', perStory: false },
  { slice: 'codexUseAI', perStory: false },
  { slice: 'codexHighlight', perStory: false },
];

export type SliceBag = Record<string, unknown>;

/** One stored record: a whole global slice, or one story's share of one. */
export interface V2Record {
  id: string;
  value: unknown;
}

export type DiffOp =
  | { op: 'put'; id: string; value: unknown }
  | { op: 'delete'; id: string };

/**
 * Record ids. A NUL separator can't occur in a slice name or a story id, so a
 * story id containing our delimiter can never forge another slice's key.
 */
const SEP = '\u0000';
export const recordId = (slice: string, storyId?: string): string =>
  storyId === undefined ? slice : `${slice}${SEP}${storyId}`;
export const parseRecordId = (id: string): { slice: string; storyId?: string } => {
  const i = id.indexOf(SEP);
  return i === -1 ? { slice: id } : { slice: id.slice(0, i), storyId: id.slice(i + 1) };
};

const asBag = (v: unknown): SliceBag =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as SliceBag : {};

/**
 * The records that changed between two store snapshots.
 *
 * Compares by REFERENCE, which is what makes this cheap: an immutable update
 * replaces only the objects it touched, so an untouched story's descriptors are
 * the same object and produce no write. A deep compare would cost more than the
 * write it saves.
 */
export const diffSlices = (prev: SliceBag, next: SliceBag): DiffOp[] => {
  const ops: DiffOp[] = [];
  for (const { slice, perStory } of PERSISTED_SLICES) {
    if (!perStory) {
      // `undefined` means "the store has no opinion yet" — never write it over
      // a good stored value during the boot window.
      if (next[slice] !== undefined && prev[slice] !== next[slice]) {
        ops.push({ op: 'put', id: recordId(slice), value: next[slice] });
      }
      continue;
    }
    if (next[slice] === undefined) continue;
    const p = asBag(prev[slice]);
    const n = asBag(next[slice]);
    for (const storyId of Object.keys(n)) {
      if (p[storyId] !== n[storyId]) {
        ops.push({ op: 'put', id: recordId(slice, storyId), value: n[storyId] });
      }
    }
    // A deleted story must take its records with it, or the database grows
    // forever with data no story can reach.
    for (const storyId of Object.keys(p)) {
      if (!(storyId in n)) ops.push({ op: 'delete', id: recordId(slice, storyId) });
    }
  }
  return ops;
};

/** Rebuild the store's persisted shape from flat records. */
export const assembleSlices = (records: readonly V2Record[]): SliceBag => {
  const known = new Map(PERSISTED_SLICES.map(s => [s.slice, s.perStory]));
  const out: SliceBag = {};
  for (const { id, value } of records) {
    const { slice, storyId } = parseRecordId(id);
    // A record written by a NEWER build. Leaving it alone is the honest move:
    // we can't render it, and dropping it would destroy the newer build's data.
    if (!known.has(slice)) continue;
    if (storyId === undefined) {
      if (!known.get(slice)) out[slice] = value;
      continue;
    }
    if (!known.get(slice)) continue;
    const bag = (out[slice] ??= {}) as SliceBag;
    bag[storyId] = value;
  }
  return out;
};

/** Flatten a whole snapshot into records — used to seed an empty database. */
export const explodeSlices = (state: SliceBag): V2Record[] =>
  diffSlices({}, state).flatMap(op => (op.op === 'put' ? [{ id: op.id, value: op.value }] : []));

/**
 * Slices whose declared sharding disagrees with their actual shape.
 *
 * The table above is hand-maintained, and getting it wrong is quiet: a slice
 * wrongly marked per-story is stored one record per KEY of whatever it holds,
 * which for an array means one record per index. `sandboxConfigs` and
 * `sandboxActive` were both mis-declared on the first pass — their names read as
 * global but they are story-keyed — so this check exists because the mistake is
 * easy and invisible. Run at hydration; a name here means data is being written
 * to the wrong shape of key.
 */
export const misdeclaredSlices = (state: SliceBag): string[] =>
  PERSISTED_SLICES
    .filter(({ slice, perStory }) => {
      const v = state[slice];
      if (v === undefined || v === null) return false;
      const isRecord = typeof v === 'object' && !Array.isArray(v);
      return perStory && !isRecord;
    })
    .map(s => s.slice);

/** Keep only the persisted slices of a full store state. */
export const pickPersisted = (state: SliceBag): SliceBag => {
  const out: SliceBag = {};
  for (const { slice } of PERSISTED_SLICES) {
    if (state[slice] !== undefined) out[slice] = state[slice];
  }
  return out;
};
