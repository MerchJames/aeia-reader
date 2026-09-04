/**
 * Run: npx tsx src/utils/codexExtractor.test.ts
 *
 * Reading a lorebook in, and getting the same one back out.
 *
 * The Codex could always WRITE SillyTavern World Info and never read it, so the
 * authored material it held was whatever a character card happened to embed. A
 * reader with a lorebook built elsewhere had no door.
 *
 * The importer's whole job is tolerance, because "World Info" is not one
 * format. Four shapes are in circulation — a keyed object of entries, an array
 * of them, a bare array, and the `character_book` lifted out of a V2/V3 card —
 * and the fields moved too (`key` vs `keys`, `comment` vs `name`). So the test
 * is mostly a table of real shapes, plus the two properties that matter more
 * than any of them:
 *
 * **A bad file yields nothing, never an exception.** This runs behind a file
 * picker. A thrown parse error there tells the reader nothing and takes the
 * panel down with it.
 *
 * **Everything imported is authored.** Lorebook entries come back marked
 * `source: 'lorebook'` and locked, which is what makes a Rebuild safe to press:
 * the scan may not overwrite them and `clearCodex` may not remove them.
 */
import { cardToEntities, codexToWorldInfo, worldInfoToEntities } from './codexExtractor';
import type { CodexEntity } from '../stores/useAuraV2Store';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const entry = (over: Record<string, unknown> = {}) => ({
  uid: 0,
  key: ['Ravenholm', 'the city'],
  comment: 'Ravenholm',
  content: 'A drowned city on the northern coast. Nobody goes there twice.',
  ...over,
});

/* ── The four shapes in circulation ──────────────────────────────────────── */
{
  const one = entry();
  const shapes: [string, string][] = [
    ['keyed object of entries', JSON.stringify({ entries: { '0': one } })],
    ['array of entries', JSON.stringify({ entries: [one] })],
    ['a bare array', JSON.stringify([one])],
    ['a card’s character_book', JSON.stringify({ character_book: { entries: [one] } })],
  ];
  for (const [what, json] of shapes) {
    const got = worldInfoToEntities(json);
    eq(got.length, 1, `${what}: one entry`);
    eq(got[0]?.name, 'Ravenholm', `${what}: with its name`);
    ok(!!got[0]?.summary.startsWith('A drowned city'), `${what}: and its content`);
  }
}

/* ── Field aliases ───────────────────────────────────────────────────────── */
{
  const keys = worldInfoToEntities(JSON.stringify([{ keys: ['Mira'], content: 'A courier.' }]));
  eq(keys[0]?.name, 'Mira', '`keys` is read as well as `key`');

  const named = worldInfoToEntities(JSON.stringify([
    { key: ['x'], name: 'The Ledger', content: 'A book of debts.' },
  ]));
  eq(named[0]?.name, 'The Ledger', '`name` is read as well as `comment`');

  const unnamed = worldInfoToEntities(JSON.stringify([
    { key: ['The Ledger', 'ledger'], content: 'A book of debts.' },
  ]));
  eq(unnamed[0]?.name, 'The Ledger', 'with no name at all, the first key is the name');
  eq(unnamed[0]?.aliases.join(','), 'ledger', 'and the rest become aliases');
}

/* ── Aliases ─────────────────────────────────────────────────────────────── */
{
  const got = worldInfoToEntities(JSON.stringify([entry()]));
  eq(got[0]?.aliases.join(','), 'the city', 'the other keys become aliases');
  ok(!got[0]?.aliases.includes('Ravenholm'), 'the name is not also an alias of itself');

  const noisy = worldInfoToEntities(JSON.stringify([
    { key: ['Mira', 'M', 'mi', 'Mira Valen'], content: 'A courier.' },
  ]));
  ok(!noisy[0]?.aliases.some(a => a.length < 3),
    'one- and two-letter keys are dropped — they match half the prose in the story');
}

/* ── A bad file is empty, not an exception ───────────────────────────────── */
{
  const junk = ['', 'not json at all', '{', 'null', '[]', '{"entries":{}}', '{"entries":null}',
    '42', '"a string"', '{"entries":[null,3,"x"]}'];
  for (const bad of junk) {
    let threw = false;
    let got: unknown[] = [];
    try { got = worldInfoToEntities(bad); } catch { threw = true; }
    ok(!threw, `${JSON.stringify(bad.slice(0, 20))} does not throw`);
    eq(got.length, 0, `${JSON.stringify(bad.slice(0, 20))} yields nothing`);
  }

  // An entry with no content is not an entry: a codex row with an empty summary
  // is a name that tells the reader nothing and clutters the list for ever.
  eq(worldInfoToEntities(JSON.stringify([{ key: ['Mira'], content: '   ' }])).length, 0,
    'an entry with no content is skipped');
  eq(worldInfoToEntities(JSON.stringify([{ key: [], content: 'orphaned' }])).length, 0,
    'and so is one with nothing to call it');
}

/* ── Everything imported is authored and protected ───────────────────────── */
{
  const got = worldInfoToEntities(JSON.stringify({ entries: { '0': entry() } }));
  eq(got[0]?.source, 'lorebook', 'imported entries are marked as authored');
  eq(got[0]?.locked, true, 'and locked, so a Rebuild keeps them');
  eq(got[0]?.firstSeenIndex, -1,
    'and available from the first line — the author meant them as up-front context');
}

/* ── A card's embedded lorebook is the same kind of thing ────────────────── */
{
  const seeded = cardToEntities({
    name: 'Mira',
    description: 'A courier who does not ask what is in the box.',
    lorebook: [{ keys: ['Ravenholm'], content: 'A drowned city.' }],
  });
  const lore = seeded.find(e => e.name === 'Ravenholm');
  const self = seeded.find(e => e.name === 'Mira');
  eq(lore?.source, 'lorebook', 'a card’s lorebook entry is marked as one');
  eq(lore?.locked, true, 'and is protected too');
  // The card's own entry is authored but NOT locked: it is re-seeded from the
  // card on the next tick, so keeping it through a rebuild would be pointless
  // and would stop a correction from ever taking.
  eq(self?.source, 'card', 'the character itself is card-sourced');
  eq(self?.locked, undefined, 'and not locked — it is re-seeded from the card anyway');
}

/* ── The round trip ──────────────────────────────────────────────────────── */
{
  const entities: CodexEntity[] = [{
    id: 'e1',
    name: 'Mira Valen',
    kind: 'character',
    aliases: ['Mira'],
    summary: 'A courier who does not ask what is in the box.',
    firstSeenIndex: 3,
    firstSeenMessageId: 'm3',
    mentions: 9,
    updatedAt: 1,
    source: 'heuristic',
  }];
  const back = worldInfoToEntities(codexToWorldInfo(entities));
  eq(back.length, 1, 'what this app exports, it can read back');
  // The exporter writes "Mira Valen (character)" into `comment`. Reading that
  // verbatim would put the kind inside the name, and a second round trip would
  // make it "Mira Valen (character) (character)".
  eq(back[0]?.name, 'Mira Valen', 'and the exported kind suffix is not part of the name');
  eq(back[0]?.kind, 'character', 'the kind survives as a kind');
  eq(back[0]?.aliases.join(','), 'Mira', 'and so do the aliases');

  const twice = worldInfoToEntities(codexToWorldInfo(
    back.map((e, i) => ({ ...e, id: `x${i}`, updatedAt: 0 })),
  ));
  eq(twice[0]?.name, 'Mira Valen', 'a second round trip is stable');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
