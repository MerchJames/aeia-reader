/**
 * Tests for the library vault.
 *
 * A backup feature has one failure mode that matters more than all the others
 * put together: appearing to work. A vault that writes cleanly and restores
 * ninety percent of a library is worse than no vault at all, because the reader
 * deleted nothing and lost everything, and found out months later.
 *
 * So the tests here are weighted towards:
 *
 * 1. **The round trip.** Anything written comes back identical, including the
 *    fields this module does not model — a story field added next year must
 *    survive a backup taken today.
 * 2. **A damaged file still restores what it can.** The case a backup exists
 *    for is a browser that died mid-write, so one bad line must cost that line
 *    and not the run.
 * 3. **A restore never deletes.** Neither mode removes a story the vault does
 *    not have, and `fill` never touches one that is already here.
 * 4. **A newer vault is refused, an older one is not.** A backup that stops
 *    working in two years is not a backup.
 *
 * Run: npx tsx src/utils/vault.test.ts
 */

import type { Story } from '../types';
import {
  VAULT_MAGIC, VAULT_VERSION, REGENERABLE_MEDIA,
  decodeLine, describeRestore, encodeLine, isEmptyPlan, makeHeader,
  planRestore, readVaultHeader, vaultFilename,
  type VaultLine,
} from './vault';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);

const story = (id: string, over: Partial<Story> = {}): Story => ({
  id,
  title: `Story ${id}`,
  format: 'sillytavern',
  messages: [{ id: `${id}-m0`, role: 'ai', name: 'Vera', content: 'The gate was open.' }],
  highlights: [],
  ...over,
} as Story);

/** Decode a whole written vault the way a restore does. */
const roundTrip = (lines: VaultLine[]) =>
  lines.map(encodeLine).join('').split('\n').filter(l => l.trim()).map(decodeLine);

/* ------------------------------------------------------------------ */
/* The round trip                                                      */
/* ------------------------------------------------------------------ */

{
  const header = makeHeader({ stories: 2, slices: 3, media: 1 }, true, 1700000000000);
  eq(header.magic, VAULT_MAGIC, 'the header is stamped');
  eq(header.version, VAULT_VERSION, 'with the current version');
  eq(header.stories, 2, 'and the counts it was given');
  ok(header.includesMedia, 'and whether media is in it');
}

{
  const written: VaultLine[] = [
    { kind: 'header', header: makeHeader({ stories: 1, slices: 1, media: 1 }, true) },
    { kind: 'settings', value: { theme: 'sepia', accent: '#0d6f60' } },
    { kind: 'story', value: story('s1') },
    { kind: 'slice', id: 'annotationsByStory::s1', value: [{ id: 'a1', note: 'here' }] },
    {
      kind: 'media', media: 'art', id: 'art1', mime: 'image/png',
      meta: { storyId: 's1', messageId: 'm0' }, data: 'AAAA',
    },
  ];

  const got = roundTrip(written);
  eq(got.filter(g => g.error).length, 0, 'a clean vault decodes with no errors');
  eq(got.length, written.length, 'every record comes back');
  eq(got.map(g => g.line!.kind), ['header', 'settings', 'story', 'slice', 'media'],
    'in the order it was written');
  eq(got[2].line, written[2], 'a story survives the round trip exactly');
  eq(got[3].line, written[3], 'and so does a slice record');
  eq(got[4].line, written[4], 'and a media record');
}

{
  /**
   * The property that makes this safe to keep for years.
   *
   * The vault stores what the databases store, not a model of it. A field this
   * build has never heard of — added by a later version, or by a feature
   * written after this backup — must come back untouched rather than being
   * quietly dropped on the way through.
   */
  // Cast, not `@ts-expect-error`: the point is a field the TYPE does not have,
  // which is exactly what a story written by a future build looks like here.
  const exotic = story('s2', {
    somethingAddedInV2: { deep: { nested: [1, 2, { three: true }] } },
    timelines: [{ id: 't1', name: 'Branch', forkIndex: 1, messages: [], addedAt: 1 }],
  } as unknown as Partial<Story>);
  const [got] = roundTrip([{ kind: 'story', value: exotic }]);
  eq(got.line, { kind: 'story', value: exotic },
    'a field this build does not model still survives a backup');
}

{
  // Every character a chat log actually contains.
  const nasty = story('s3', {
    title: 'Quotes " backslash \\ newline \n tab \t emoji 🜏 and a lone {',
    messages: [{
      id: 'm', role: 'ai', name: 'Vera',
      content: 'Line one\nLine two\r\n\t"quoted"\\escaped\u0000nul',
    }],
  });
  const [got] = roundTrip([{ kind: 'story', value: nasty }]);
  eq(got.line, { kind: 'story', value: nasty },
    'quotes, backslashes, newlines, tabs, emoji and a NUL all survive');
}

{
  // Each encoded line is exactly one line, or the whole format falls apart.
  const line = encodeLine({ kind: 'story', value: story('s4', { title: 'a\nb\nc' }) });
  eq(line.split('\n').length, 2, 'a record with newlines in it still encodes to ONE line');
  ok(line.endsWith('\n'), 'and the terminator is included, so callers cannot forget it');
}

/* ------------------------------------------------------------------ */
/* Damage                                                              */
/* ------------------------------------------------------------------ */

{
  /**
   * The scenario this whole feature exists for: a backup that died mid-write.
   */
  const good = [
    encodeLine({ kind: 'header', header: makeHeader({ stories: 3, slices: 0, media: 0 }, false) }),
    encodeLine({ kind: 'story', value: story('a') }),
    encodeLine({ kind: 'story', value: story('b') }),
  ].join('');
  // The file stops in the middle of the third story.
  const truncated = `${good}{"kind":"story","value":{"id":"c","tit`;

  const decoded = truncated.split('\n').filter(l => l.trim()).map(decodeLine);
  const plan = planRestore(decoded, new Set());

  eq(plan.added.map(s => s.id), ['a', 'b'], 'both complete stories restore from a truncated vault');
  eq(plan.damaged.length, 1, 'and the incomplete one is reported, not silently dropped');
  ok(plan.damaged[0].reason.includes('not JSON'), 'with a reason');
}

{
  const decoded = [
    encodeLine({ kind: 'story', value: story('a') }),
    'this line is garbage\n',
    encodeLine({ kind: 'story', value: story('b') }),
  ].join('').split('\n').filter(l => l.trim()).map(decodeLine);

  const plan = planRestore(decoded, new Set());
  eq(plan.added.length, 2, 'a bad line in the MIDDLE does not stop the records after it');
  eq(plan.damaged.length, 1, 'and is counted');
}

{
  eq(decodeLine('').error, 'blank line', 'a blank line is not a record');
  eq(decodeLine('   ').error, 'blank line', 'nor is whitespace');
  eq(decodeLine('[1,2,3]').error, 'not a record', 'an array is not a record');
  eq(decodeLine('"a string"').error, 'not a record', 'nor is a bare string');
  eq(decodeLine('null').error, 'not a record', 'nor null');
  ok(!!decodeLine('{"kind":"story","value":{}}').error, 'a story with no id is refused');
  ok(!!decodeLine('{"kind":"slice","value":1}').error, 'a slice with no id is refused');
  ok(!!decodeLine('{"kind":"media","id":"x","media":"art"}').error, 'media with no data is refused');
  ok(!!decodeLine('{"kind":"media","id":"x","media":"nope","data":""}').error,
    'media of an unknown kind is refused');
  ok(decodeLine('{"kind":"whatever"}').error!.includes('unknown record type'),
    'an unknown type says it is unknown rather than pretending to be damage');
}

{
  // Nothing decodable makes it throw. This runs over a file the reader chose.
  const junk = ['', '{', '}', '[]', 'undefined', '\u0000', '{"kind":null}', 'NaN', '{"kind":1}'];
  let threw = false;
  for (const j of junk) { try { decodeLine(j); } catch { threw = true; } }
  ok(!threw, 'no input makes decodeLine throw');
}

/* ------------------------------------------------------------------ */
/* The header gate                                                     */
/* ------------------------------------------------------------------ */

{
  const line = encodeLine({
    kind: 'header', header: makeHeader({ stories: 1, slices: 0, media: 0 }, false),
  });
  eq(readVaultHeader(line).header?.magic, VAULT_MAGIC, 'a good header is accepted');
  eq(readVaultHeader(line).error, undefined, 'with no error');
}

{
  ok(!!readVaultHeader('{"kind":"story","value":{"id":"a"}}').error,
    'a file that does not start with a header is refused');
  ok(readVaultHeader('{"kind":"header","header":{"magic":"something-else","version":1}}').error
    ?.includes('Not an Aeia vault'), 'a foreign magic is named as such');
  ok(!!readVaultHeader('garbage').error, 'garbage is refused');
  ok(!!readVaultHeader('').error, 'and so is an empty file');
}

{
  /**
   * Version handling, in the direction that matters.
   *
   * A vault is meant to be openable in two years, so an OLDER one must always
   * read. A NEWER one is refused rather than partially understood: silently
   * ignoring fields it cannot read would restore an incomplete library and
   * report success, which is the exact failure this module is built to avoid.
   */
  const older = `{"kind":"header","header":{"magic":"${VAULT_MAGIC}","version":1,"createdAt":0}}`;
  eq(readVaultHeader(older).error, undefined, 'an older vault is still readable');

  const newer = `{"kind":"header","header":{"magic":"${VAULT_MAGIC}","version":${VAULT_VERSION + 1},"createdAt":0}}`;
  const refusal = readVaultHeader(newer).error ?? '';
  ok(!!refusal, 'a newer vault is refused');
  ok(refusal.includes('newer version'), 'and says why in the reader’s terms');
  ok(refusal.includes('Update Aeia'), 'and what to do about it');
}

/* ------------------------------------------------------------------ */
/* Restore never deletes                                               */
/* ------------------------------------------------------------------ */

const three = [
  { kind: 'story', value: story('a') },
  { kind: 'story', value: story('b') },
  { kind: 'slice', id: 'annotationsByStory::a', value: [{ id: 'n1' }] },
] as VaultLine[];

{
  const decoded = three.map(line => ({ line }));
  const plan = planRestore(decoded, new Set(['a']), 'fill');

  eq(plan.added.map(s => s.id), ['b'], 'fill adds only what is missing');
  eq(plan.overwritten, [], 'and overwrites nothing');
  eq(plan.kept, 1, 'reporting the one it left alone');
  eq(plan.slices.length, 1, 'slices come across regardless');
}

{
  const decoded = three.map(line => ({ line }));
  const plan = planRestore(decoded, new Set(['a']), 'replace');

  eq(plan.added.map(s => s.id), ['b'], 'replace still adds what is missing');
  eq(plan.overwritten.map(s => s.id), ['a'], 'and names what it would overwrite');
  eq(plan.kept, 0, 'nothing is being kept in this mode');
}

{
  /**
   * The property, stated as a property.
   *
   * A story this library has that the vault does not know about is never
   * mentioned by a plan in either mode — there is no field for it, so there is
   * nothing a caller could act on to delete it. A restore is not a mirror.
   */
  const decoded = three.map(line => ({ line }));
  for (const mode of ['fill', 'replace'] as const) {
    const plan = planRestore(decoded, new Set(['a', 'not-in-the-vault', 'nor-this']), mode);
    const named = new Set([...plan.added, ...plan.overwritten].map(s => s.id));
    ok(!named.has('not-in-the-vault') && !named.has('nor-this'),
      `${mode} never names a story the vault does not contain — a restore cannot delete`);
  }
}

{
  const plan = planRestore([], new Set());
  ok(isEmptyPlan(plan), 'an empty vault plans nothing');
  eq(plan.damaged, [], 'and reports no damage');
  ok(describeRestore(plan).includes('nothing this library is missing'),
    'and says so rather than offering a button that does nothing');
}

/* ------------------------------------------------------------------ */
/* What the reader is told before pressing                             */
/* ------------------------------------------------------------------ */

{
  const plan = planRestore(three.map(line => ({ line })), new Set(['a']), 'fill');
  const said = describeRestore(plan);
  ok(said.includes('add 1 story'), 'the count of new stories is stated');
  ok(said.includes('left exactly as it is'),
    'and the reader is told the story they still have will not be touched — '
    + 'which is the thing they are actually afraid of');
  ok(!said.includes('OVERWRITE'), 'fill does not threaten an overwrite it will not do');
}

{
  const plan = planRestore(three.map(line => ({ line })), new Set(['a']), 'replace');
  ok(describeRestore(plan).includes('OVERWRITE 1 you already have'),
    'replace says plainly, and loudly, that it overwrites');
}

{
  const withDamage = planRestore(
    [...three.map(line => ({ line })), { error: 'not JSON' }, { error: 'not JSON' }],
    new Set(),
  );
  ok(describeRestore(withDamage).includes('2 records'),
    'damaged records are surfaced before the restore, not discovered after');
}

/* ------------------------------------------------------------------ */
/* Filename                                                            */
/* ------------------------------------------------------------------ */

{
  const name = vaultFilename(new Date(2026, 8, 4, 14, 5).getTime());
  eq(name, 'aeia-library-2026-09-04-1405.aeia-vault.jsonl', 'the filename is dated and sortable');
  ok(!name.includes(':'), 'and holds no colon — Windows refuses the save without a word');
  ok(/^[\w.-]+$/.test(name), 'and nothing else a filesystem would object to');
}

/* ------------------------------------------------------------------ */
/* The media policy                                                    */
/* ------------------------------------------------------------------ */

{
  /**
   * A tripwire on a judgement call.
   *
   * Only scene art may be offered as a size-saving omission, because only scene
   * art can be made again. Fonts, sprites and backdrops are files the reader
   * supplied; if this list grows to include one of them, someone is about to
   * ship a checkbox that quietly drops the irreplaceable half of a backup.
   */
  eq([...REGENERABLE_MEDIA], ['art'],
    'only generated art is treated as regenerable — user-supplied files never are');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
