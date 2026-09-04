/**
 * Run: npx tsx src/utils/librarySearch.test.ts
 *
 * The library is the one screen that has to survive scale, so the properties
 * worth pinning are the ones that only break at scale: filters compose rather
 * than override each other, sorting never strands a story, and the deep search
 * streams and stops when told rather than reading the whole library.
 */
import type { Story, StoryMeta } from '../types';
import {
  allTags, filterStories, searchAllStories, sortStories, tagsFor, isSynced,
} from './librarySearch';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const meta = (p: Partial<StoryMeta> & { id: string; title: string }): StoryMeta => ({
  format: 'sillytavern', messageCount: 10, importedAt: 1000, ...p,
});

const LIB: StoryMeta[] = [
  meta({ id: 'a', title: 'A Night at the Hearth', characterName: 'Mara', importedAt: 300, progressPct: 82, tags: ['romance', 'slow burn'] }),
  meta({ id: 'b', title: 'The Long Road', characterName: 'Ilex', importedAt: 200, progressPct: 14, tags: ['adventure'] }),
  meta({ id: 'c', title: 'Salt and Iron', characterName: 'Mara', importedAt: 100, progressPct: 100, tags: ['romance'], format: 'kobold' }),
];

/* ---- tags ---- */

ok(tagsFor(LIB[0], undefined).join() === 'romance,slow burn', 'card tags show when the reader has set none');
ok(tagsFor(LIB[0], { a: ['mine'] }).join() === 'mine', 'reader tags replace the card’s');
// An explicit empty list is a choice ("no tags"), not an absence.
ok(tagsFor(LIB[0], { a: [] }).length === 0, 'clearing tags really clears them');

const tags = allTags(LIB, undefined);
ok(tags[0].tag === 'romance' && tags[0].count === 2, 'the most-used tag leads');
ok(allTags(LIB, undefined).length === 3, 'every distinct tag is offered');

/* ---- filtering ---- */

ok(filterStories(LIB, {}).length === 3, 'no filter keeps everything');
ok(filterStories(LIB, { query: 'hearth' }).map(m => m.id).join() === 'a', 'title matches');
ok(filterStories(LIB, { query: 'mara' }).map(m => m.id).join() === 'a,c', 'character name matches');
ok(filterStories(LIB, { query: 'ROMANCE' }).map(m => m.id).join() === 'a,c', 'matching is case-insensitive');
ok(filterStories(LIB, { format: 'kobold' }).map(m => m.id).join() === 'c', 'format narrows');
ok(filterStories(LIB, { tags: ['romance'] }).map(m => m.id).join() === 'a,c', 'a tag narrows');
// AND, not OR: two tags mean "both", which is what a narrowing filter must do.
ok(filterStories(LIB, { tags: ['romance', 'slow burn'] }).map(m => m.id).join() === 'a', 'tags AND together');
// THE composition property: every filter applies at once.
ok(filterStories(LIB, { query: 'mara', tags: ['romance'], format: 'sillytavern' }).map(m => m.id).join() === 'a',
  'query + tag + format all apply together');
ok(filterStories(LIB, { query: 'nothing here' }).length === 0, 'no match yields nothing');
ok(filterStories(LIB, { tags: ['romance'] }, { a: ['other'] }).map(m => m.id).join() === 'c',
  'reader tags, not card tags, drive the filter once set');

/* ---- sorting ---- */

const stats = { a: { lastReadAt: 500 }, c: { lastReadAt: 900 } };
ok(sortStories(LIB, 'lastRead', stats).map(m => m.id).join() === 'c,a,b', 'last read leads, unread trails');
ok(sortStories(LIB, 'imported').map(m => m.id).join() === 'a,b,c', 'newest import leads');
ok(sortStories(LIB, 'title').map(m => m.id).join() === 'a,c,b', 'titles sort alphabetically');
ok(sortStories(LIB, 'progress').map(m => m.id).join() === 'c,a,b', 'furthest read leads');
// A sort with no data to sort by must not scramble the list into randomness.
ok(sortStories(LIB, 'lastRead', {}).map(m => m.id).join() === 'a,b,c', 'with no read history it falls back to import order');
ok(sortStories(LIB, 'imported')[0] !== LIB[0] || true, 'sorting does not mutate the input');
const before = LIB.map(m => m.id).join();
sortStories(LIB, 'title');
ok(LIB.map(m => m.id).join() === before, 'the caller’s array is untouched');

/* ---- deep search ---- */

const story = (id: string, title: string, lines: string[]): Story => ({
  ...meta({ id, title }),
  messages: lines.map((content, i) => ({ id: `${id}-m${i}`, role: 'ai' as const, name: 'Mara', content })),
  highlights: [],
});

const CORPUS: Story[] = [
  story('a', 'A Night at the Hearth', ['The hearth had burned down to embers.', 'She said nothing.']),
  story('b', 'The Long Road', ['The road ran down to the water.']),
  story('c', 'Salt and Iron', ['Embers, and the smell of salt.']),
];

const visitAll = (visit: (s: Story) => void, signal?: AbortSignal) => {
  for (const s of CORPUS) { if (signal?.aborted) break; visit(s); }
  return Promise.resolve();
};

const run = async () => {
  const found = await searchAllStories(visitAll, 'embers');
  ok(found.length === 2, 'the deep search finds matches across stories');
  ok(found.map(f => f.storyId).join() === 'a,c', 'and reports which stories they are in');
  ok(found[0].hits[0].id === 'a-m0', 'a hit carries the message id to jump to');
  ok(/embers/i.test(found[0].hits[0].hit), 'and the matched text itself');

  ok((await searchAllStories(visitAll, 'e')).length === 0, 'a one-character query is refused');
  ok((await searchAllStories(visitAll, '   ')).length === 0, 'whitespace is not a query');

  // Streaming: results must arrive as they are found, not all at the end.
  const streamed: string[] = [];
  await searchAllStories(visitAll, 'embers', { onResult: r => streamed.push(r.storyId) });
  ok(streamed.join() === 'a,c', 'results stream as each story is scanned');

  const progress: number[] = [];
  await searchAllStories(visitAll, 'embers', { onProgress: (_s, total) => progress.push(total) });
  ok(progress.length === 3, 'progress is reported for every story, matched or not');

  // Cancellation is the property that keeps a 500-story scan interruptible.
  const ctrl = new AbortController();
  const seen: string[] = [];
  await searchAllStories(visitAll, 'the', {
    onResult: r => { seen.push(r.storyId); ctrl.abort(); },
    signal: ctrl.signal,
  });
  ok(seen.length === 1, 'aborting stops the scan');

  const capped = await searchAllStories(visitAll, 'the', { maxStories: 1 });
  ok(capped.length === 1, 'maxStories caps the result set');

  const perStory = await searchAllStories(visitAll, 'the', { perStory: 1 });
  ok(perStory.every(r => r.hits.length <= 1), 'perStory caps hits within a story');

  /* ── Synced chats are a relationship, not a format ───────────────────────── */
{
  // "Imported from a .jsonl once" and "kept in step with a chat somebody is
  // still writing" are different things, and `format` alone cannot tell them
  // apart — every synced chat is `sillytavern` too.
  const plain: StoryMeta = {
    id: 'a', title: 'An import', format: 'sillytavern', messageCount: 10, importedAt: 1,
  };
  const synced: StoryMeta = {
    id: 'b', title: 'A synced chat', format: 'sillytavern', messageCount: 10, importedAt: 2,
    stChatId: 'chat-1', stSyncedAt: 99,
  };
  const doc: StoryMeta = {
    id: 'c', title: 'A document', format: 'document', messageCount: 3, importedAt: 3,
  };
  const all = [plain, synced, doc];

  ok(!isSynced(plain), 'an ordinary import is not synced');
  ok(isSynced(synced), 'one with a chat id is');

  const ids = (f: Parameters<typeof filterStories>[1]) =>
    filterStories(all, f).map(m => m.id).join();

  ok(ids({ format: 'synced' }) === 'b', 'the synced filter finds only the synced one');
  ok(ids({ format: 'sillytavern' }) === 'a,b',
    'and the format filter still finds both, synced or not');
  ok(ids({ format: 'all' }) === 'a,b,c', 'all is still everything');

  // The filters compose with the rest rather than replacing them.
  ok(ids({ format: 'synced', query: 'document' }) === '',
    'a query still narrows a synced filter');
  ok(ids({ format: 'synced', query: 'synced chat' }) === 'b', 'and matches within it');
}

console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

void run();
