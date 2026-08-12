/**
 * A/B the Scene Director with and without the whole-story read.
 *
 * The story pass is the one v3 workstream that can fail on QUALITY rather than
 * correctness: a green test suite proves the read is parsed, grounded and
 * cached, and proves nothing at all about whether it makes the Director direct
 * better. So this runs both paths over the same passages against your own
 * endpoint and prints what actually changed.
 *
 * Usage:
 *   npx tsx scripts/director-ab.ts <story.jsonl> \
 *     --base http://localhost:5001/v1 --model my-model [--key sk-…] [--passages 30]
 *
 * What to look for, in order:
 * Sampling is now greedy (see `directorSamplers`), so the run-to-run noise floor
 * is zero and a single comparison is conclusive. It was not always: the first
 * version of this harness had no control arm, and two `without` runs differed by
 * more than the effect being measured — 13 vs 19 perform cues on identical input.
 *
 * What to look for, in order:
 *  1. Abstention should go UP. The point of the read is that the Director can
 *     tell a quiet passage from a pivotal one; if it cues just as much, it has
 *     only learned new words for the same reflexes.
 *  2. The cues it KEEPS should cluster on turns and callbacks, not spread evenly.
 *  3. Weather should not get louder. If `fx` rises, the read is being mined for
 *     atmosphere instead of weight — that is the failure mode to cut on.
 */

import { readFileSync } from 'node:fs';
import {
  ScenePassage, buildEnrichMessages, directorSamplers, outputBudget, parseDescriptors,
} from '../src/utils/sceneDirector';
import { readStory, storyReadBlock } from '../src/utils/storyRead';
import { chatCompletion } from '../src/utils/aiClient';
import type { SceneDescriptor } from '../src/types';

const args = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const file = args[0]?.startsWith('--') ? '' : args[0];
const base = flag('base');
const model = flag('model');
const key = flag('key');
const limit = Number(flag('passages', '30'));

if (!file || !base || !model) {
  console.error('usage: npx tsx scripts/director-ab.ts <story.jsonl> --base <url> --model <name> [--key k] [--passages n]');
  process.exit(1);
}

/** SillyTavern .jsonl: one JSON object per line; the first is metadata. */
const loadPassages = (path: string): ScenePassage[] => {
  const out: ScenePassage[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.mes !== 'string' || row.is_user) continue;
      out.push({ messageId: `m${out.length}`, name: row.name ?? 'Narrator', content: row.mes });
    } catch { /* metadata line */ }
  }
  return out;
};

interface Tally {
  passages: number;
  read: number;
  perform: number;
  emphasis: number;
  fx: number;
  vfx: number;
  /** Passages the Director deliberately left alone — no cue of any kind. */
  quiet: number;
  cuedIds: string[];
}

const tally = (ds: SceneDescriptor[], total: number): Tally => {
  const t: Tally = {
    passages: total, read: ds.length, perform: 0, emphasis: 0, fx: 0, vfx: 0, quiet: 0, cuedIds: [],
  };
  for (const d of ds) {
    const perform = d.perform?.length ?? 0;
    const emphasis = d.emphasis?.length ?? 0;
    t.perform += perform;
    t.emphasis += emphasis;
    if (d.fx) t.fx++;
    if (d.vfx) t.vfx++;
    if (!perform && !emphasis && !d.fx && !d.vfx) t.quiet++;
    else if (perform) t.cuedIds.push(d.messageId);
  }
  return t;
};

const run = async (passages: ScenePassage[], storyRead?: Parameters<typeof storyReadBlock>[0]) => {
  const out: SceneDescriptor[] = [];
  for (let i = 0; i < passages.length; i += 10) {
    const batch = passages.slice(i, i + 10);
    const reply = await chatCompletion(
      base, key, model,
      buildEnrichMessages(batch, undefined, undefined, storyRead),
      { ...directorSamplers(base), max_tokens: outputBudget(batch.length) },
    );
    out.push(...parseDescriptors(reply, batch));
  }
  return out;
};

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

const main = async () => {
  const all = loadPassages(file);
  const passages = all.slice(0, limit);
  console.log(`${all.length} AI passages in the story; reading ${passages.length}.\n`);

  console.log('— taking the story read —');
  const storyRead = await readStory(all, { base, key, model });
  if (!storyRead) {
    console.error('The story read failed or came back empty. That is itself a result:');
    console.error('this model cannot produce the grounding, so the pass is dead weight for it.');
    process.exit(2);
  }
  const block = storyReadBlock(storyRead);
  console.log(block);
  console.log(`\n(grounding block: ${block.length} chars, ~${Math.round(block.length / 4)} tokens on EVERY batch)\n`);

  console.log('— reading passages WITHOUT the story read —');
  const without = tally(await run(passages), passages.length);
  console.log('— reading passages WITH the story read —');
  const with_ = tally(await run(passages, storyRead), passages.length);

  const row = (label: string, a: number, b: number) =>
    console.log(`  ${label.padEnd(22)} ${String(a).padStart(5)} → ${String(b).padStart(5)}  ${b > a ? '↑' : b < a ? '↓' : '='}`);

  console.log('\n=== without → with ===');
  row('passages read', without.read, with_.read);
  row('perform cues', without.perform, with_.perform);
  row('emphasis spans', without.emphasis, with_.emphasis);
  row('weather (fx)', without.fx, with_.fx);
  row('screen vfx', without.vfx, with_.vfx);
  row('left alone (quiet)', without.quiet, with_.quiet);
  console.log(`\n  quiet rate: ${pct(without.quiet, without.read)} → ${pct(with_.quiet, with_.read)}`);

  const a = new Set(without.cuedIds), b = new Set(with_.cuedIds);
  const kept = [...b].filter(id => a.has(id));
  console.log(`  passages cued: ${a.size} → ${b.size} (${kept.length} the same, `
    + `${[...b].filter(id => !a.has(id)).length} new, ${[...a].filter(id => !b.has(id)).length} dropped)`);
  console.log('\nRead the two cue sets yourself before trusting the numbers — the question');
  console.log('is not "fewer cues" but "cues on the passages that actually mattered".');
};

void main().catch(e => { console.error(e); process.exit(1); });
