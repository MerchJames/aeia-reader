/**
 * Run: npx tsx src/utils/narrativeBlocks.test.ts
 */
import { narrativeBlocksFor, renderNarrativeBlocks } from './narrativeBlocks';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── All four channels, in document order ────────────────────────────────── */
{
  const text = '"Wait," Kara said. \'not again\' She stared. **she did not move.** '
    + '****RUN****';
  const blocks = narrativeBlocksFor(text, 'Kara', { cast: ['Kara'] });
  eq(blocks.map(b => b.kind), ['dialogue', 'thought', 'narration', 'beat', 'shout'],
    'every channel is classified, narration fills the gaps, all in order');
  eq(blocks[0].text, 'Wait', 'dialogue body has its quotes stripped');
  eq(blocks[1].text, 'not again', 'thought body has its quotes stripped');
  eq(blocks[3].speaker, 'Kara', 'a beat is attributed to the passage author');
  eq(blocks[4].speaker, 'Kara', 'so is a shout');
}

/* ── An apostrophe never becomes a thought ───────────────────────────────── */
{
  const kinds = (t: string) => narrativeBlocksFor(t, 'Kara').map(b => b.kind);
  ok(!kinds("She didn't look back.").includes('thought'), "don't is not a thought");
  ok(!kinds("Readin' by candlelight, she waited.").includes('thought'), "readin' is not a thought");
  // Only one apostrophe in the whole passage — an aside needs both an open
  // AND a close, so there is nothing here for the boundary rule to find.
  ok(!kinds("'tis a fine morning, she said.").includes('thought'),
    "'tis is an elision with no closing quote anywhere, not a thought");
  // A genuinely closed aside IS a thought — even with a trailing attribution
  // comma, and even though "she thought" is not in the attribution-verb list
  // screenplay.ts drops (so it survives as its own narration block).
  eq(kinds("'not again,' she thought"), ['thought', 'narration'], 'a closed aside is a thought');
  eq(
    narrativeBlocksFor("'not again,' she thought", 'Kara')[0].text,
    'not again',
    'its trailing attribution comma is stripped, same as dialogue',
  );
}

/* ── The four-star shout doesn't get half-eaten by the two-star rule ────── */
{
  const blocks = narrativeBlocksFor('****RUN****', 'Kara');
  eq(blocks.length, 1, 'one block, not a leftover beat plus stray asterisks');
  eq(blocks[0], { kind: 'shout', speaker: 'Kara', text: 'RUN' }, 'and it is the shout, whole');
}

/* ── Unattributed dialogue falls back to the passage's author ────────────── */
{
  const blocks = narrativeBlocksFor('"Hello there." The room was quiet.', 'Narrator');
  eq(blocks[0], { kind: 'dialogue', speaker: 'Narrator', text: 'Hello there.' },
    'no cast, no attribution clue — the author reads the line');
}

/* ── Attribution prefers the narration context over the passage's own author ─ */
{
  const blocks = narrativeBlocksFor('"Stop it," Finn snapped.', 'Kara', { cast: ['Finn'] });
  eq(blocks[0].speaker, 'Finn', 'a named, attributed speaker wins over the message author');
}

/* ── Rendering ────────────────────────────────────────────────────────────── */
{
  const rendered = renderNarrativeBlocks([
    { kind: 'dialogue', speaker: 'Kara', text: 'Wait.' },
    { kind: 'narration', speaker: 'Kara', text: 'She turned.' },
  ]);
  eq(rendered, '[Dialogue - Kara]\nWait.\n\n[Narration]\nShe turned.',
    'narration carries no speaker suffix; other kinds do');
  eq(renderNarrativeBlocks([{ kind: 'dialogue', speaker: 'Kara', text: '' }]), '',
    'an empty block prints nothing');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
