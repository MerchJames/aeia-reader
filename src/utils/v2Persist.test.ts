/** Run: npx tsx src/utils/v2Persist.test.ts */
import {
  PERSISTED_SLICES, SliceBag, assembleSlices, diffSlices, explodeSlices, misdeclaredSlices,
  parseRecordId, pickPersisted, recordId,
} from './v2Persist';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// --- the slice table ---------------------------------------------------------
// A tripwire, not a fact: adding a store slice without declaring it here means
// it silently stops persisting. Bump this deliberately, having checked the new
// slice's `perStory` flag against its actual shape.
// 35: +libraryTagsByStory (Record<storyId, string[]>) and +recapSeen
// (Record<storyId, boolean>) — both story-keyed, so both perStory.
// 38: +artByStory (Record<storyId, Record<messageId, SceneArt[]>>),
// +appearanceByStory and +artSeedByStory (Record<storyId, Record<character, …>>)
// — all three story-keyed, so all three perStory. Note what is NOT here: the
// image BYTES, which live in their own IndexedDB (`lib/artStorage.ts`). A
// megabyte per picture in a slice would be rewritten on every debounced save.
// 39: +visitorsByStory (Record<storyId, Visitor[]>) — story-keyed, so perStory.
// 40: +emphasisMarksByStory (Record<storyId, Record<messageId, EmphasisMark[]>>)
// — story-keyed, so perStory. Sharded exactly like sfxMarksByStory, which it
// sits beside: a reader's own marking has to outlive the Director's read.
// 41: +reactionsByStory (Record<storyId, Record<messageId, ReactionRecord>>) —
// story-keyed, so perStory. Reader-only, like askByStory beside it: it is
// persisted so a re-read replays what was said, never so anything can read it.
// 43: +throughlines (Throughline[]) — GLOBAL, not perStory, and the flag is the
// whole design decision rather than an accident: a throughline is the record of
// the person the reader plays across several chats, so it belongs to the reader
// and not to any one story. Sharding it per story would give each chat its own
// private copy of a thing whose entire purpose is being shared between them.
// 44: +functionsByStory (Record<storyId, Record<messageId, { hash, fns }>>) —
// story-keyed, so perStory, and sharded exactly like sceneByStory for the same
// reason: it is a cached model READ of one passage, and one chat's labels have
// no business being rewritten when another chat is read. The `hash` inside is
// the passage fingerprint, so the cache invalidates itself on an edited or
// re-swiped message rather than describing prose it was not taken from.
// 45: +tasksByStory (Record<storyId, ZoneTask[]>) — story-keyed, so perStory,
// and sharded beside zonesByStory because a task is an ORDER over that story's
// zones and means nothing without them. What is NOT here is the document a task
// produces: that lands as a version of a pin, in pinsByStory, where the reader
// can step back through it. A task holding its own output would be a second
// copy of every document, rewritten on every run.
ok(PERSISTED_SLICES.length === 45, 'every persisted slice is declared');
ok(PERSISTED_SLICES.some(s => s.slice === 'throughlines' && !s.perStory),
  'throughlines are global — a per-story copy of a cross-story record is a contradiction');
ok(new Set(PERSISTED_SLICES.map(s => s.slice)).size === PERSISTED_SLICES.length, 'no slice is declared twice');

// --- record ids --------------------------------------------------------------
ok(recordId('sceneByStory', 'story-1') !== recordId('sceneByStory', 'story-2'), 'stories get distinct records');
ok(parseRecordId(recordId('sceneByStory', 's1')).slice === 'sceneByStory', 'the slice round-trips');
ok(parseRecordId(recordId('sceneByStory', 's1')).storyId === 's1', 'the story id round-trips');
ok(parseRecordId(recordId('codexEnabled')).storyId === undefined, 'a global record has no story id');
// A story id containing the delimiter must not be able to forge another key.
const odd = 'weird id with spaces and : colons';
ok(parseRecordId(recordId('sceneByStory', odd)).storyId === odd, 'an awkward story id round-trips intact');

// --- diffing -----------------------------------------------------------------
const s1 = { a: 1 }, s2 = { b: 2 };
const base: SliceBag = { sceneByStory: { one: s1, two: s2 }, codexEnabled: true };

ok(diffSlices(base, base).length === 0, 'an unchanged snapshot writes nothing');

// THE point of the whole change: touching one story must not rewrite the others.
const touched: SliceBag = { ...base, sceneByStory: { one: { a: 2 }, two: s2 } };
const ops = diffSlices(base, touched);
ok(ops.length === 1, 'editing one story writes exactly one record');
ok(ops[0].op === 'put' && ops[0].id === recordId('sceneByStory', 'one'), 'and it is that story’s record');

// A new story adds only its own record.
const added = diffSlices(base, { ...base, sceneByStory: { ...base.sceneByStory as object, three: { c: 3 } } });
ok(added.length === 1 && added[0].id === recordId('sceneByStory', 'three'), 'a new story adds one record');

// A deleted story must take its records with it, or the DB grows forever.
const removed = diffSlices(base, { ...base, sceneByStory: { two: s2 } });
ok(removed.length === 1 && removed[0].op === 'delete', 'a removed story is deleted, not orphaned');
ok(removed[0].id === recordId('sceneByStory', 'one'), 'the right record is deleted');

// Global slices are whole records.
const flag = diffSlices(base, { ...base, codexEnabled: false });
ok(flag.length === 1 && flag[0].id === 'codexEnabled', 'a global slice writes one whole record');

// `undefined` means "no opinion yet" — during the boot window it must never be
// written over good stored data.
ok(diffSlices(base, { sceneByStory: undefined, codexEnabled: undefined }).length === 0,
  'an absent slice writes nothing, rather than erasing what is stored');
// But an explicitly EMPTY slice is a real edit: it deletes the stories it lost.
const emptied = diffSlices(base, { ...base, sceneByStory: {} });
ok(emptied.length === 2 && emptied.every(o => o.op === 'delete'), 'clearing a slice deletes its records');

// A per-story slice holding something that isn't a record must not shard on its
// indices — the failure mode `misdeclaredSlices` exists to catch.
ok(diffSlices({}, { sceneByStory: null }).length === 0, 'a null per-story slice writes nothing');

// --- assembling --------------------------------------------------------------
const roundTrip = assembleSlices(explodeSlices(base));
ok(JSON.stringify(roundTrip.sceneByStory) === JSON.stringify(base.sceneByStory), 'per-story slices round-trip');
ok(roundTrip.codexEnabled === true, 'global slices round-trip');
ok(Object.keys(assembleSlices([])).length === 0, 'no records means no state, not a crash');

// A record from a newer build names a slice we don't know. Dropping it on read
// is fine (we can't render it); what matters is we don't crash or half-apply it.
const unknown = assembleSlices([
  { id: 'someFutureSlice', value: 1 },
  { id: recordId('codexEnabled'), value: false },
]);
ok(unknown.codexEnabled === false && unknown.someFutureSlice === undefined,
  'an unknown slice is ignored without disturbing the known ones');

// A malformed id (per-story slice, no story) must not become a bogus entry.
ok(assembleSlices([{ id: 'sceneByStory', value: { x: 1 } }]).sceneByStory === undefined,
  'a per-story record with no story id is skipped');

// --- pickPersisted -----------------------------------------------------------
const full: SliceBag = { ...base, codexOpen: true, multiverseOpen: false };
const picked = pickPersisted(full);
ok(picked.codexOpen === undefined, 'transient UI state is never persisted');
ok(picked.sceneByStory !== undefined && picked.codexEnabled === true, 'persisted slices are kept');

// --- the sharding guard ------------------------------------------------------
ok(misdeclaredSlices(base).length === 0, 'a correct snapshot reports no problems');
// This is the exact mistake that shipped in the first draft: a story-keyed slice
// declared global reads fine, but a global slice declared per-story shards on
// array indices. Catch it loudly at hydration.
ok(misdeclaredSlices({ sceneByStory: ['nope'] }).includes('sceneByStory'),
  'an array in a per-story slice is reported');
ok(misdeclaredSlices({ sceneByStory: 7 }).includes('sceneByStory'), 'a primitive is reported');
ok(misdeclaredSlices({ cowritePresets: [] }).length === 0, 'a global array slice is fine');
ok(misdeclaredSlices({ sceneByStory: undefined }).length === 0, 'an absent slice is not a problem');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
