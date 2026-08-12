/**
 * Is the Scene Director's sandbox still a gamble?
 *
 * The complaint this measures: "it seems like a complete gamble whether or not
 * I get something good regardless of the model." A gamble has a signature you
 * can measure — a wide score distribution and a long tail of unusable builds —
 * so this builds the SAME shots under each regime and prints the distribution
 * rather than an opinion.
 *
 *   npx tsx scripts/sandbox-quality.ts <story.jsonl> \
 *     --base http://localhost:5001/v1 --model my-model [--key sk-…] \
 *     [--shots 4] [--guidance "1970s giallo horror"]
 *
 * Regimes:
 *   before   what shipped — reader's chat samplers (all null → backend creative
 *            defaults), NO max_tokens, no packet, no critic. One sample, take it.
 *   packet   design samplers + a budget + the resolved Style Packet. One sample.
 *   packet'  a REPEAT of `packet`. This is the control arm. Design sampling is
 *            deliberately not greedy, so `packet` vs `packet'` is the noise
 *            floor, and no difference smaller than that gap means anything.
 *   full     what ships now — packet, plus the critic's repair round-trip, plus
 *            the composed floor when the model cannot hit the brief.
 *
 * Read the SPREAD before the mean. The claim being tested is not "higher
 * average" but "no catastrophic outcomes": `full` should have a floor nothing
 * falls below, which is a different property from being better on average.
 *
 * Every build is scored by the same critic the app uses. That critic is a
 * proxy — it measures substance, light, palette adherence, depth, typography,
 * motion and fit, not beauty. Look at the CSS it accepts before trusting it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  ScenePlanItem, buildSceneMessages, designSamplers, generateSceneCue,
  generateScenePlan, parseSceneCue, SCENE_TOKENS,
} from '../src/utils/sandboxDirector';
import { StylePacket, derivePacket, heuristicPacket, packetBlock } from '../src/utils/stylePacket';
import { ACCEPT_SCORE, REPAIRABLE_SCORE, scoreScene } from '../src/utils/sceneQuality';
import { chatCompletion } from '../src/utils/aiClient';

const args = process.argv.slice(2);
const flag = (n: string, d = '') => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const file = args[0]?.startsWith('--') ? '' : args[0];
const base = flag('base'), model = flag('model'), key = flag('key');
const guidance = flag('guidance', '');
const wantShots = Number(flag('shots', '4'));

if (!file || !base || !model) {
  console.error('usage: npx tsx scripts/sandbox-quality.ts <story.jsonl> --base <url> --model <name> [--shots n] [--guidance "…"]');
  process.exit(1);
}

/** SillyTavern .jsonl: one JSON object per line; the first is metadata. */
const passages = (path: string): { name: string; content: string }[] => {
  const out: { name: string; content: string }[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.mes !== 'string' || r.is_user) continue;
      out.push({ name: r.name ?? 'Narrator', content: r.mes });
    } catch { /* metadata */ }
  }
  return out;
};

const cfg = { base, key, model };

/** The shipped behaviour, reproduced exactly: one sample, no budget, no packet. */
const buildBefore = async (
  input: { name: string; content: string }, item: ScenePlanItem,
): Promise<string | null> => {
  const reply = await chatCompletion(
    base, key, model,
    buildSceneMessages({ ...input, guidance: guidance || undefined }, item),
    {}, // ← what `samplerParamsFrom` on a default config amounts to
  );
  return parseSceneCue(reply, item, input.content)?.css ?? null;
};

interface Row { shot: string; score: number; origin: string; chars: number }

const stats = (rows: Row[]) => {
  const s = rows.map(r => r.score).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
    mean,
    median: s[Math.floor(s.length / 2)] ?? 0,
    spread: (s[s.length - 1] ?? 0) - (s[0] ?? 0),
    unusable: rows.filter(r => r.score < REPAIRABLE_SCORE).length,
    shippable: rows.filter(r => r.score >= ACCEPT_SCORE).length,
  };
};

const bar = (score: number) => {
  const n = Math.round(score / 5);
  return '█'.repeat(n).padEnd(20, '·');
};

const report = (label: string, rows: Row[]) => {
  const t = stats(rows);
  console.log(`\n  ${label}`);
  for (const r of rows) {
    console.log(`    ${bar(r.score)} ${String(r.score).padStart(3)}  ${r.origin.padEnd(9)} ${r.chars} chars  ${r.shot}`);
  }
  console.log(`    ── mean ${t.mean.toFixed(1)} · median ${t.median} · range ${t.min}-${t.max} (spread ${t.spread})`);
  console.log(`       unusable (<${REPAIRABLE_SCORE}): ${t.unusable}/${t.n}   shippable (>=${ACCEPT_SCORE}): ${t.shippable}/${t.n}`);
  return t;
};

const main = async () => {
  const all = passages(file);
  // The longest passage in the first stretch — the one with room for real shots.
  const passage = all.slice(0, 12).sort((a, b) => b.content.length - a.content.length)[0];
  if (!passage) { console.error('no AI passages found in that file'); process.exit(2); }
  console.log(`Staging ${passage.name}'s ${passage.content.length}-char passage.`);
  console.log(`Guidance: ${guidance || '(none — the packet is derived from the material)'}\n`);

  console.log('— resolving the style packet —');
  const packet: StylePacket = await derivePacket(guidance, [passage.content.slice(0, 600)], cfg);
  console.log(packetBlock(packet));
  const floorPacket = heuristicPacket(guidance);
  console.log(`\n  (source: ${packet.source}; the AI-free floor for this guidance would be "${floorPacket.preset}")`);
  console.log(`  (block is ${packetBlock(packet).length} chars, ~${Math.round(packetBlock(packet).length / 4)} tokens on EVERY build)\n`);

  // ONE plan, reused by every regime. Plan variance is a separate question and
  // would otherwise be measured as build quality.
  console.log('— planning the shot list (once, shared by all regimes) —');
  const plan = (await generateScenePlan({ ...passage, guidance: guidance || undefined, packet }, cfg))
    .slice(0, wantShots);
  if (!plan.length) { console.error('no usable plan came back — nothing to build'); process.exit(2); }
  for (const s of plan) console.log(`    ${s.kind.padEnd(5)} @ "${s.anchor}" — ${s.intent.slice(0, 70)}`);

  // Each shot's slice, so the critic judges typography against what it displays.
  const hay = passage.content.toLowerCase();
  const scenes = plan.filter(s => s.kind === 'scene')
    .map(s => ({ id: s.id, start: hay.indexOf(s.anchor.toLowerCase()) }))
    .filter(s => s.start >= 0).sort((a, b) => a.start - b.start);
  const sliceOf = (item: ScenePlanItem): string => {
    const i = scenes.findIndex(x => x.id === item.id);
    if (i < 0) return passage.content;
    const end = i < scenes.length - 1 ? scenes[i + 1].start : passage.content.length;
    return passage.content.slice(scenes[i].start, end);
  };
  const buildable = plan.filter(s => s.kind === 'scene');
  if (!buildable.length) { console.error('the plan has no scene beats — nothing to score'); process.exit(2); }

  const kept: Record<string, string> = {};

  const runBefore = async (): Promise<Row[]> => {
    const rows: Row[] = [];
    for (const item of buildable) {
      const slice = sliceOf(item);
      let css: string | null = null;
      try { css = await buildBefore(passage, item); } catch (e) { console.error('   build failed:', (e as Error).message); }
      const score = css ? scoreScene(css, packet, slice.length).score : 0;
      if (css) kept[`before-${item.id}`] = css;
      rows.push({ shot: item.anchor, score, origin: css ? 'ai' : 'LOST', chars: css?.length ?? 0 });
    }
    return rows;
  };

  const runNew = async (label: string, withCritic: boolean): Promise<Row[]> => {
    const rows: Row[] = [];
    for (const item of buildable) {
      const slice = sliceOf(item);
      const input = { ...passage, guidance: guidance || undefined, packet };
      if (withCritic) {
        const out = await generateSceneCue(input, { ...item, slice }, cfg);
        if (out?.cue.css) kept[`${label}-${item.id}`] = out.cue.css;
        rows.push({
          shot: item.anchor, score: out?.score ?? 0,
          origin: out?.origin ?? 'LOST', chars: out?.cue.css?.length ?? 0,
        });
      } else {
        // One sample under the new regime, critic bypassed — isolates how much
        // of the gain is the packet and how much is the repair loop.
        let css: string | null = null;
        try {
          const reply = await chatCompletion(
            base, key, model, buildSceneMessages(input, { ...item, slice }),
            { ...designSamplers(base), max_tokens: SCENE_TOKENS },
          );
          css = parseSceneCue(reply, item, passage.content)?.css ?? null;
        } catch (e) { console.error('   build failed:', (e as Error).message); }
        if (css) kept[`${label}-${item.id}`] = css;
        rows.push({
          shot: item.anchor, score: css ? scoreScene(css, packet, slice.length).score : 0,
          origin: css ? 'ai' : 'LOST', chars: css?.length ?? 0,
        });
      }
    }
    return rows;
  };

  console.log('\n— building each shot under every regime —');
  const before = await runBefore();
  const packetOnly = await runNew('packet', false);
  const control = await runNew('packet2', false);   // the noise floor
  const full = await runNew('full', true);

  const tBefore = report('before   (what shipped: chat samplers, no budget, no packet, no critic)', before);
  const tPacket = report('packet   (design samplers + budget + style packet, one sample)', packetOnly);
  const tControl = report("packet'  (CONTROL — a repeat of the line above; this is the noise floor)", control);
  const tFull = report('full     (packet + critic repair + composed floor — what ships now)', full);

  const noise = Math.abs(tPacket.mean - tControl.mean);
  console.log('\n=== read this before the table ===');
  console.log(`  Noise floor: two identical runs of the same regime differed by ${noise.toFixed(1)} points`);
  console.log(`  on the mean. Any difference smaller than that is not a result.\n`);

  const delta = (a: number, b: number) => `${a.toFixed(1)} → ${b.toFixed(1)}  ${b > a ? '↑' : b < a ? '↓' : '='}`;
  console.log(`  mean score        ${delta(tBefore.mean, tFull.mean)}`);
  console.log(`  worst case        ${tBefore.min} → ${tFull.min}   ← the gamble lives here`);
  console.log(`  spread            ${tBefore.spread} → ${tFull.spread}   ← and here`);
  console.log(`  unusable builds   ${tBefore.unusable}/${tBefore.n} → ${tFull.unusable}/${tFull.n}`);
  console.log(`  outright lost     ${before.filter(r => r.origin === 'LOST').length} → ${full.filter(r => r.origin === 'LOST').length}`);
  console.log(`  origins (full)    ${['ai', 'repaired', 'composed', 'LOST']
    .map(o => `${o} ${full.filter(r => r.origin === o).length}`).join(' · ')}`);

  const out = 'test-results/sandbox-quality.json';
  try {
    writeFileSync(out, JSON.stringify({ packet, plan, before, packetOnly, control, full, css: kept }, null, 2));
    console.log(`\n  Every stylesheet written to ${out} — READ THEM. The critic scores`);
    console.log('  substance, light, palette, depth, type, motion and fit. It cannot see taste.');
  } catch { /* no test-results dir — the numbers above are the point */ }
};

void main().catch(e => { console.error(e); process.exit(1); });
